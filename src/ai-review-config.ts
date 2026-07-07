import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewDataset } from "./sources/types.js";
import type {
  AiReviewDepth,
  AiReviewPhase,
  AiReviewResolvedConfig,
  AiReviewResolvedPhaseConfig,
  AiReviewRuntimeConfig,
} from "./types.js";

const CONFIG_ENV_VAR = "PI_DIFF_REVIEW_COCKPIT_CONFIG";

const PHASES: AiReviewPhase[] = ["scout", "chapter", "validation", "synthesis"];

const DEFAULT_REASONING_BY_DEPTH: Record<AiReviewDepth, Record<AiReviewPhase, ThinkingLevel>> = {
  fast: {
    scout: "minimal",
    chapter: "low",
    validation: "low",
    synthesis: "low",
  },
  standard: {
    scout: "low",
    chapter: "medium",
    validation: "high",
    synthesis: "high",
  },
  deep: {
    scout: "medium",
    chapter: "high",
    validation: "high",
    synthesis: "high",
  },
};

const DEPTH_LIMITS: Record<AiReviewDepth, {
  parallelChapterReviews: number;
  maxPatchCharsPerFile: number;
  maxChapterPatchChars: number;
  maxFindingsPerChapter: number;
}> = {
  fast: {
    parallelChapterReviews: 4,
    maxPatchCharsPerFile: 12_000,
    maxChapterPatchChars: 45_000,
    maxFindingsPerChapter: 4,
  },
  standard: {
    parallelChapterReviews: 3,
    maxPatchCharsPerFile: 24_000,
    maxChapterPatchChars: 90_000,
    maxFindingsPerChapter: 8,
  },
  deep: {
    parallelChapterReviews: 2,
    maxPatchCharsPerFile: 48_000,
    maxChapterPatchChars: 180_000,
    maxFindingsPerChapter: 12,
  },
};

type RawConfig = {
  aiReview?: RawAiReviewConfig;
} | RawAiReviewConfig;

interface RawAiReviewConfig {
  depth?: unknown;
  parallelChapterReviews?: unknown;
  maxPatchCharsPerFile?: unknown;
  maxChapterPatchChars?: unknown;
  maxFindingsPerChapter?: unknown;
  phases?: Partial<Record<AiReviewPhase, RawPhaseConfig>>;
}

interface RawPhaseConfig {
  provider?: unknown;
  model?: unknown;
  reasoning?: unknown;
}

interface NormalizedPhaseConfig {
  provider?: string;
  model?: string;
  reasoning?: "off" | ThinkingLevel;
}

interface NormalizedConfig {
  depth?: AiReviewDepth;
  parallelChapterReviews?: number;
  maxPatchCharsPerFile?: number;
  maxChapterPatchChars?: number;
  maxFindingsPerChapter?: number;
  phases: Partial<Record<AiReviewPhase, NormalizedPhaseConfig>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isDepth(value: unknown): value is AiReviewDepth {
  return value === "fast" || value === "standard" || value === "deep";
}

function isReasoning(value: unknown): value is "off" | ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function configBody(raw: RawConfig): RawAiReviewConfig {
  if (isRecord(raw) && isRecord(raw.aiReview)) {
    return raw.aiReview as RawAiReviewConfig;
  }
  return raw as RawAiReviewConfig;
}

function normalizeConfig(raw: RawConfig): NormalizedConfig {
  const body = configBody(raw);
  const phases: Partial<Record<AiReviewPhase, NormalizedPhaseConfig>> = {};
  const rawPhases = isRecord(body.phases) ? body.phases : {};

  for (const phase of PHASES) {
    const rawPhase = rawPhases[phase];
    if (!isRecord(rawPhase)) continue;
    phases[phase] = {
      ...(typeof rawPhase.provider === "string" && rawPhase.provider.trim().length > 0 ? { provider: rawPhase.provider.trim() } : {}),
      ...(typeof rawPhase.model === "string" && rawPhase.model.trim().length > 0 ? { model: rawPhase.model.trim() } : {}),
      ...(isReasoning(rawPhase.reasoning) ? { reasoning: rawPhase.reasoning } : {}),
    };
  }

  return {
    ...(isDepth(body.depth) ? { depth: body.depth } : {}),
    parallelChapterReviews: positiveInteger(body.parallelChapterReviews),
    maxPatchCharsPerFile: positiveInteger(body.maxPatchCharsPerFile),
    maxChapterPatchChars: positiveInteger(body.maxChapterPatchChars),
    maxFindingsPerChapter: positiveInteger(body.maxFindingsPerChapter),
    phases,
  };
}

function mergeConfig(left: NormalizedConfig, right: NormalizedConfig): NormalizedConfig {
  const mergedPhases = Object.fromEntries(PHASES.map((phase) => [
    phase,
    {
      ...(left.phases[phase] ?? {}),
      ...(right.phases[phase] ?? {}),
    },
  ])) as Partial<Record<AiReviewPhase, NormalizedPhaseConfig>>;

  return {
    ...(left.depth ? { depth: left.depth } : {}),
    ...(right.depth ? { depth: right.depth } : {}),
    parallelChapterReviews: right.parallelChapterReviews ?? left.parallelChapterReviews,
    maxPatchCharsPerFile: right.maxPatchCharsPerFile ?? left.maxPatchCharsPerFile,
    maxChapterPatchChars: right.maxChapterPatchChars ?? left.maxChapterPatchChars,
    maxFindingsPerChapter: right.maxFindingsPerChapter ?? left.maxFindingsPerChapter,
    phases: mergedPhases,
  };
}

async function readConfigFile(path: string): Promise<RawConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RawConfig;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${error.message}`);
    }
    return null;
  }
}

function candidateConfigPaths(dataset: ReviewDataset): string[] {
  const paths = [
    join(homedir(), ".config", "pi-diff-review-cockpit", "config.json"),
    join(dataset.repoRoot, ".pi-diff-review-cockpit", "config.json"),
    join(dataset.repoRoot, "pi-diff-review-cockpit.config.json"),
  ];
  const envPath = process.env[CONFIG_ENV_VAR];
  if (envPath && envPath.trim().length > 0) {
    paths.push(resolve(envPath.trim()));
  }
  return [...new Set(paths.map((path) => resolve(path)))];
}

async function loadConfig(dataset: ReviewDataset): Promise<{ config: NormalizedConfig; paths: string[]; warnings: string[] }> {
  let config = normalizeConfig({});
  const paths: string[] = [];
  const warnings: string[] = [];

  for (const path of candidateConfigPaths(dataset)) {
    try {
      const raw = await readConfigFile(path);
      if (raw == null) continue;
      config = mergeConfig(config, normalizeConfig(raw));
      paths.push(path);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { config, paths, warnings };
}

function describeModel(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function supportsReasoningLevel(model: Model<Api>, reasoning: ThinkingLevel): boolean {
  return getSupportedThinkingLevels(model).includes(reasoning);
}

function resolveModel(ctx: ExtensionCommandContext, phase: AiReviewPhase, config: NormalizedPhaseConfig | undefined, warnings: string[]): Model<Api> | null {
  const fallbackModel = ctx.model ?? null;
  if (!config?.model) return fallbackModel;

  if (config.provider) {
    const model = ctx.modelRegistry.find(config.provider, config.model);
    if (model) return model;
    warnings.push(`AI review ${phase} model ${config.provider}/${config.model} was not found; using active PI model instead.`);
    return fallbackModel;
  }

  const matches = ctx.modelRegistry.getAll().filter((model) => model.id === config.model);
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    warnings.push(`AI review ${phase} model "${config.model}" is ambiguous; set provider as well. Using active PI model instead.`);
  } else {
    warnings.push(`AI review ${phase} model "${config.model}" was not found; using active PI model instead.`);
  }
  return fallbackModel;
}

function resolvePhaseConfig(
  ctx: ExtensionCommandContext,
  phase: AiReviewPhase,
  config: NormalizedConfig & { depth: AiReviewDepth },
  warnings: string[],
): { runtime: AiReviewRuntimeConfig["phases"][AiReviewPhase]; resolved: AiReviewResolvedPhaseConfig } {
  const phaseConfig = config.phases[phase];
  const model = resolveModel(ctx, phase, phaseConfig, warnings);
  const defaultReasoning = DEFAULT_REASONING_BY_DEPTH[config.depth][phase];
  const configuredReasoning = phaseConfig?.reasoning ?? defaultReasoning;
  const reasoning = configuredReasoning === "off" || !model?.reasoning || (model != null && !supportsReasoningLevel(model, configuredReasoning)) ? undefined : configuredReasoning;
  if (configuredReasoning !== "off" && model && !model.reasoning) {
    warnings.push(`AI review ${phase} requested ${configuredReasoning} reasoning, but ${describeModel(model)} does not support reasoning.`);
  }
  if (configuredReasoning !== "off" && model?.reasoning && !supportsReasoningLevel(model, configuredReasoning)) {
    warnings.push(`AI review ${phase} requested ${configuredReasoning} reasoning, but ${describeModel(model)} does not support that level.`);
  }

  return {
    runtime: {
      model,
      reasoning,
      modelLabel: model ? describeModel(model) : "No active PI model",
    },
    resolved: {
      model: model ? describeModel(model) : null,
      reasoning: reasoning ?? "off",
    },
  };
}

export async function loadAiReviewRuntimeConfig(ctx: ExtensionCommandContext, dataset: ReviewDataset): Promise<AiReviewRuntimeConfig> {
  const loaded = await loadConfig(dataset);
  const depth = loaded.config.depth ?? "standard";
  const config = {
    ...loaded.config,
    depth,
  };
  const limits = DEPTH_LIMITS[depth];
  const warnings = [...loaded.warnings];
  const resolvedPhases = PHASES.map((phase) => {
    const resolved = resolvePhaseConfig(ctx, phase, config, warnings);
    return { phase, ...resolved };
  });
  const phases = Object.fromEntries(resolvedPhases.map(({ phase, runtime }) => [phase, runtime])) as AiReviewRuntimeConfig["phases"];
  const publicPhases = Object.fromEntries(resolvedPhases.map(({ phase, resolved }) => [phase, resolved])) as AiReviewResolvedConfig["phases"];

  const parallelChapterReviews = clamp(config.parallelChapterReviews ?? limits.parallelChapterReviews, 1, 12);
  const maxPatchCharsPerFile = clamp(config.maxPatchCharsPerFile ?? limits.maxPatchCharsPerFile, 1_000, 200_000);
  const maxChapterPatchChars = clamp(config.maxChapterPatchChars ?? limits.maxChapterPatchChars, 5_000, 500_000);
  const maxFindingsPerChapter = clamp(config.maxFindingsPerChapter ?? limits.maxFindingsPerChapter, 1, 50);

  return {
    depth,
    parallelChapterReviews,
    maxPatchCharsPerFile,
    maxChapterPatchChars,
    maxFindingsPerChapter,
    phases,
    public: {
      depth,
      parallelChapterReviews,
      maxPatchCharsPerFile,
      maxChapterPatchChars,
      maxFindingsPerChapter,
      configPaths: loaded.paths,
      warnings: [...new Set(warnings)],
      phases: publicPhases,
    },
  };
}
