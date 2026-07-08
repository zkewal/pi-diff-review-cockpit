import { completeSimple, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseReviewAnalysisJson } from "./analysis.js";
import type { ReviewDataset } from "./sources/types.js";
import type {
  AiReviewPhase,
  AiReviewChapterProgress,
  AiReviewProgress,
  AiReviewRuntimeConfig,
  ApprovalPacket,
  ReviewAnalysis,
  ReviewChapter,
  ReviewFile,
  ReviewFinding,
  ReviewLineRange,
  ReviewFindingSeverity,
} from "./types.js";

const SCOUT_SYSTEM_PROMPT = `You are a PI review scout for a code review cockpit.

Return strict JSON only: {"summary":"..."}.

Summarize the highest-value parallel review strategy from the provided PR metadata and chapter map. Include priority areas, context each chapter agent should care about, and likely test areas. Do not invent bugs. Keep it concise.`;

const CHAPTER_REVIEW_SYSTEM_PROMPT = `You are a PI review subagent reviewing one chapter of a diff.

Return strict JSON only. Do not wrap the response in Markdown. The JSON object must contain exactly these top-level keys:
- "chapters": an array with exactly one chapter object
- "findings": an array of findings
- "approvalPacket": a review summary object

Only create findings for concrete, actionable concerns supported by the provided diff patches. Prefer no finding over a speculative finding. Do not invent files, file ids, paths, or line numbers.

You are reviewing as one subagent in a larger cycle: scout -> chapter agents -> validation critic -> synthesis. Your findings are candidates and must be evidence-backed enough to survive validation.

The chapter object must use the input chapter id, title, summary, priority, attentionTags, fileIds, and ranges. Its findingIds must reference only findings you create.

Each finding must have:
- id: stable kebab-case string
- kind: one of "bug", "security", "migration-risk", "api-contract", "test-gap", "performance", "question", "informational"
- severity: one of "critical", "high", "medium", "low", "info"
- confidence: one of "critical", "high", "medium", "low", "info"
- title: concise title
- explanation: why this matters and what evidence in the diff supports it
- suggestedComment: a ready-to-post reviewer comment
- locations: array of locations using only input file ids and paths, side one of "original", "modified", "file", and a changed line number or null when unsure
- status: "new"

The approvalPacket object must summarize this chapter only. If there are no concrete findings, return an empty findings array.`;

const VALIDATION_SYSTEM_PROMPT = `You are the validation critic for a PI diff review cycle.

Return strict JSON only: {"decisions":[...]}.

Each decision must contain:
- id: the candidate finding id
- action: "keep", "drop", or "adjust"
- reason: concise validation reason
- severity: optional corrected severity, one of "critical", "high", "medium", "low", "info"
- confidence: optional corrected confidence, one of "critical", "high", "medium", "low", "info"
- title: optional corrected title
- explanation: optional corrected explanation
- suggestedComment: optional corrected ready-to-post reviewer comment

Keep only findings that are concrete, actionable, tied to a real changed line or file in the input, and supported by the candidate's own evidence. Drop speculative, duplicate, vague, or unverifiable claims.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are synthesizing a PI diff review after scout, chapter subagents, and validation.

Return strict JSON only:
{
  "summary": "one sentence",
  "suggestedVerdict": "approve" | "comment" | "request-changes",
  "acceptedRisks": ["..."],
  "body": "markdown review summary"
}

The body should be concise, human-reviewer friendly, and grounded in the validated findings. Do not invent issues or claim tests ran unless the input says so.`;

interface ChapterReviewResult {
  chapterId: string;
  analysis: ReviewAnalysis;
}

export interface RunAiReviewOptions {
  getFilePatch(file: ReviewFile): Promise<string>;
  onProgress(progress: AiReviewProgress): void;
  onPartialResult?(result: { chapterId: string; analysis: ReviewAnalysis; progress: AiReviewProgress }): void;
  config: AiReviewRuntimeConfig;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} character(s)]`;
}

function emptyProgress(analysis: ReviewAnalysis, config?: AiReviewRuntimeConfig): AiReviewProgress {
  return {
    status: "idle",
    phase: "idle",
    message: "AI review has not run.",
    scoutSummary: "",
    ...(config ? { config: config.public } : {}),
    chapters: analysis.chapters.map((chapter) => ({
      chapterId: chapter.id,
      title: chapter.title,
      status: "queued",
      message: "Queued.",
      findingCount: 0,
    })),
  };
}

function updateChapterProgress(progress: AiReviewProgress, chapterId: string, update: Partial<AiReviewChapterProgress>): AiReviewProgress {
  return {
    ...progress,
    chapters: progress.chapters.map((chapter) => chapter.chapterId === chapterId ? { ...chapter, ...update } : chapter),
  };
}

function completeProgress(progress: AiReviewProgress, status: AiReviewProgress["status"], message: string): AiReviewProgress {
  return {
    ...progress,
    status,
    phase: status === "done" || status === "failed" ? "done" : progress.phase,
    message,
  };
}

export function refreshProgressFindingCounts(progress: AiReviewProgress, analysis: ReviewAnalysis): AiReviewProgress {
  const countByChapterId = new Map(analysis.chapters.map((chapter) => [chapter.id, chapter.findingIds.length] as const));
  return {
    ...progress,
    chapters: progress.chapters.map((chapter) => ({
      ...chapter,
      findingCount: countByChapterId.get(chapter.chapterId) ?? chapter.findingCount,
    })),
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  if (fenced?.[1]) {
    const parsed = JSON.parse(fenced[1]) as unknown;
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }

  throw new Error("AI review returned malformed JSON.");
}

export function normalizeChapterReviewJson(text: string, chapter: ReviewChapter, maxFindings = Number.POSITIVE_INFINITY): string {
  const parsed = parseJsonObject(text);
  const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).slice(0, maxFindings);
  const findingIds = findings
    .map((finding) => {
      if (finding == null || typeof finding !== "object" || Array.isArray(finding)) return null;
      const id = (finding as { id?: unknown }).id;
      return typeof id === "string" ? id : null;
    })
    .filter((id): id is string => id != null);

  return JSON.stringify({
    chapters: [{
      id: chapter.id,
      title: chapter.title,
      summary: chapter.summary,
      priority: chapter.priority,
      attentionTags: chapter.attentionTags,
      fileIds: chapter.fileIds,
      ranges: chapter.ranges,
      findingIds,
    }],
    findings,
    approvalPacket: {
      summary: `Review ${chapter.title}.`,
      reviewedChapters: [chapter.id],
      acceptedRisks: [],
      unresolvedFindings: findingIds,
      suggestedVerdict: "comment",
      body: `AI review checked ${chapter.title}.`,
    },
  });
}

function buildScoutInput(dataset: ReviewDataset, analysis: ReviewAnalysis, config: AiReviewRuntimeConfig): string {
  return JSON.stringify({
    source: dataset.source,
    reviewDepth: config.depth,
    maxFindingsPerChapter: config.maxFindingsPerChapter,
    chapters: analysis.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      summary: chapter.summary,
      priority: chapter.priority,
      attentionTags: chapter.attentionTags,
      fileCount: chapter.fileIds.length,
      changedLines: {
        original: chapter.ranges.filter((range) => range.side === "original").reduce((total, range) => total + range.endLine - range.startLine + 1, 0),
        modified: chapter.ranges.filter((range) => range.side === "modified").reduce((total, range) => total + range.endLine - range.startLine + 1, 0),
      },
    })),
  });
}

async function completeTextJson(ctx: ExtensionCommandContext, config: AiReviewRuntimeConfig, phase: AiReviewPhase, systemPrompt: string, input: string): Promise<string> {
  const phaseConfig = config.phases[phase];
  const model = phaseConfig.model;
  if (!model) {
    throw new Error(`No Pi model is selected for ${phase}.`);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}.` : auth.error);
  }

  const userMessage: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: input }],
  };

  const response = await completeSimple(
    model,
    { systemPrompt, messages: [userMessage] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      ...(phaseConfig.reasoning ? { reasoning: phaseConfig.reasoning } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      metadata: {
        feature: "pi-diff-review-cockpit",
        phase,
        depth: config.depth,
      },
    },
  );

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (response.stopReason !== "stop" || text.length === 0) {
    throw new Error("AI review did not complete cleanly.");
  }

  return text;
}

async function runScout(ctx: ExtensionCommandContext, dataset: ReviewDataset, analysis: ReviewAnalysis, config: AiReviewRuntimeConfig): Promise<string> {
  try {
    const text = await completeTextJson(ctx, config, "scout", SCOUT_SYSTEM_PROMPT, buildScoutInput(dataset, analysis, config));
    const parsed = JSON.parse(text) as unknown;
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { summary?: unknown }).summary === "string") {
      return (parsed as { summary: string }).summary;
    }
  } catch {}

  return `Review ${analysis.chapters.length} chapter(s), prioritizing review-first chapters and changed hunks with schema, API, service, and test impact.`;
}

function fileStatus(file: ReviewFile): string | null {
  return file.gitDiff?.status ?? file.worktreeStatus;
}

async function buildChapterReviewInput(options: {
  dataset: ReviewDataset;
  chapter: ReviewChapter;
  files: ReviewFile[];
  getFilePatch(file: ReviewFile): Promise<string>;
  config: AiReviewRuntimeConfig;
  scoutSummary: string;
}): Promise<string> {
  let remainingChars = options.config.maxChapterPatchChars;
  const files = [];

  for (const file of options.files) {
    const rawPatch = await options.getFilePatch(file);
    const patch = truncateText(rawPatch, Math.max(0, Math.min(options.config.maxPatchCharsPerFile, remainingChars)));
    remainingChars -= patch.length;
    files.push({
      id: file.id,
      path: file.path,
      status: fileStatus(file),
      displayPath: file.gitDiff?.displayPath ?? file.path,
      commentableOriginalLines: file.gitDiff?.commentableOriginalLines ?? [],
      commentableModifiedLines: file.gitDiff?.commentableModifiedLines ?? [],
      patch,
    });
    if (remainingChars <= 0) break;
  }

  return JSON.stringify({
    source: options.dataset.source,
    reviewDepth: options.config.depth,
    maxFindings: options.config.maxFindingsPerChapter,
    scoutSummary: options.scoutSummary,
    chapter: {
      id: options.chapter.id,
      title: options.chapter.title,
      summary: options.chapter.summary,
      priority: options.chapter.priority,
      attentionTags: options.chapter.attentionTags,
      fileIds: options.chapter.fileIds,
      ranges: options.chapter.ranges,
    },
    files,
  });
}

function datasetForChapter(dataset: ReviewDataset, chapter: ReviewChapter): ReviewDataset {
  return {
    ...dataset,
    analysisFileIds: chapter.fileIds,
  };
}

async function reviewChapter(ctx: ExtensionCommandContext, dataset: ReviewDataset, chapter: ReviewChapter, scoutSummary: string, options: RunAiReviewOptions): Promise<ChapterReviewResult> {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const files = chapter.fileIds.map((fileId) => fileById.get(fileId)).filter((file): file is ReviewFile => file != null);
  const input = await buildChapterReviewInput({ dataset, chapter, files, getFilePatch: options.getFilePatch, config: options.config, scoutSummary });
  const text = await completeTextJson(ctx, options.config, "chapter", CHAPTER_REVIEW_SYSTEM_PROMPT, input);
  return {
    chapterId: chapter.id,
    analysis: parseReviewAnalysisJson(normalizeChapterReviewJson(text, chapter, options.config.maxFindingsPerChapter), datasetForChapter(dataset, chapter)),
  };
}

function lineInRanges(line: number, ranges: ReviewLineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function sanitizeFindingLocations(finding: ReviewFinding, fileById: Map<string, ReviewFile>): ReviewFinding {
  return {
    ...finding,
    locations: finding.locations.map((location) => {
      if (location.side === "file" || location.line == null) return location;
      const file = fileById.get(location.fileId);
      const ranges = location.side === "original"
        ? file?.gitDiff?.commentableOriginalLines ?? []
        : file?.gitDiff?.commentableModifiedLines ?? [];
      if (lineInRanges(location.line, ranges)) return location;
      return { ...location, line: null };
    }),
  };
}

function uniqueFindingId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }

  let index = 2;
  while (usedIds.has(`${baseId}-${index}`)) {
    index += 1;
  }
  const id = `${baseId}-${index}`;
  usedIds.add(id);
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isSeverity(value: unknown): value is ReviewFindingSeverity {
  return value === "critical" || value === "high" || value === "medium" || value === "low" || value === "info";
}

function isVerdict(value: unknown): value is ApprovalPacket["suggestedVerdict"] {
  return value === "approve" || value === "comment" || value === "request-changes";
}

export interface AiReviewValidationDecision {
  id: string;
  action: "keep" | "drop" | "adjust";
  reason: string;
  severity?: ReviewFindingSeverity;
  confidence?: ReviewFindingSeverity;
  title?: string;
  explanation?: string;
  suggestedComment?: string;
}

export function normalizeValidationDecisionsJson(text: string, findingIds: Set<string>): AiReviewValidationDecision[] {
  const parsed = parseJsonObject(text);
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const normalized: AiReviewValidationDecision[] = [];

  for (const decision of decisions) {
    if (!isRecord(decision)) continue;
    const id = typeof decision.id === "string" ? decision.id : "";
    if (!findingIds.has(id)) continue;
    const action = decision.action === "drop" || decision.action === "adjust" ? decision.action : "keep";
    normalized.push({
      id,
      action,
      reason: typeof decision.reason === "string" && decision.reason.trim().length > 0 ? decision.reason.trim() : "Validated by AI review.",
      ...(isSeverity(decision.severity) ? { severity: decision.severity } : {}),
      ...(isSeverity(decision.confidence) ? { confidence: decision.confidence } : {}),
      ...(typeof decision.title === "string" && decision.title.trim().length > 0 ? { title: decision.title.trim() } : {}),
      ...(typeof decision.explanation === "string" && decision.explanation.trim().length > 0 ? { explanation: decision.explanation.trim() } : {}),
      ...(typeof decision.suggestedComment === "string" && decision.suggestedComment.trim().length > 0 ? { suggestedComment: decision.suggestedComment.trim() } : {}),
    });
  }

  return normalized;
}

function rebuildFindingReferences(analysis: ReviewAnalysis, findings: ReviewFinding[]): ReviewAnalysis {
  const findingIds = new Set(findings.map((finding) => finding.id));
  const chapters = analysis.chapters.map((chapter) => ({
    ...chapter,
    findingIds: chapter.findingIds.filter((findingId) => findingIds.has(findingId)),
  }));
  const unresolvedFindings = findings.filter((finding) => finding.severity !== "info").map((finding) => finding.id);
  const suggestedVerdict = findings.some((finding) => finding.severity === "critical" || finding.severity === "high")
    ? "request-changes"
    : findings.length > 0
      ? "comment"
      : "comment";
  return {
    ...analysis,
    chapters,
    findings,
    approvalPacket: {
      ...analysis.approvalPacket,
      unresolvedFindings,
      reviewedChapters: chapters.filter((chapter) => chapter.findingIds.length > 0 || analysis.approvalPacket.reviewedChapters.includes(chapter.id)).map((chapter) => chapter.id),
      suggestedVerdict,
    },
  };
}

function verdictForFindings(findings: ReviewFinding[], fallback: ApprovalPacket["suggestedVerdict"]): ApprovalPacket["suggestedVerdict"] {
  return findings.some((finding) => finding.severity === "critical" || finding.severity === "high")
    ? "request-changes"
    : findings.length > 0
      ? "comment"
      : fallback;
}

function refreshApprovalPacketForFindings(analysis: ReviewAnalysis, scoutSummary: string): ReviewAnalysis {
  const unresolvedFindings = analysis.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.id);
  const body = [
    "## AI review summary",
    scoutSummary,
    "",
    analysis.findings.length === 0
      ? "No concrete AI findings were produced from the changed hunks."
      : analysis.findings.map((finding, index) => `${index + 1}. ${finding.title} (${finding.severity}, ${finding.confidence} confidence)`).join("\n"),
  ].join("\n").trim();

  return {
    ...analysis,
    approvalPacket: {
      ...analysis.approvalPacket,
      summary: analysis.findings.length === 0
        ? "AI review found no concrete issues in changed hunks."
        : `AI review produced ${analysis.findings.length} validated finding(s).`,
      unresolvedFindings,
      suggestedVerdict: verdictForFindings(analysis.findings, "comment"),
      body,
    },
  };
}

export function applyValidationDecisions(analysis: ReviewAnalysis, decisions: AiReviewValidationDecision[]): ReviewAnalysis {
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision] as const));
  const findings: ReviewFinding[] = [];

  for (const finding of analysis.findings) {
    const decision = decisionsById.get(finding.id);
    if (decision?.action === "drop") continue;
    findings.push({
      ...finding,
      ...(decision?.severity ? { severity: decision.severity } : {}),
      ...(decision?.confidence ? { confidence: decision.confidence } : {}),
      ...(decision?.title ? { title: decision.title } : {}),
      ...(decision?.explanation ? { explanation: decision.explanation } : {}),
      ...(decision?.suggestedComment ? { suggestedComment: decision.suggestedComment } : {}),
    });
  }

  return rebuildFindingReferences(analysis, findings);
}

function buildValidationInput(dataset: ReviewDataset, analysis: ReviewAnalysis, scoutSummary: string): string {
  return JSON.stringify({
    source: dataset.source,
    scoutSummary,
    coverage: analysis.coverage,
    chapters: analysis.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      priority: chapter.priority,
      attentionTags: chapter.attentionTags,
      fileIds: chapter.fileIds,
      ranges: chapter.ranges,
      findingIds: chapter.findingIds,
    })),
    candidateFindings: analysis.findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      severity: finding.severity,
      confidence: finding.confidence,
      title: finding.title,
      explanation: finding.explanation,
      suggestedComment: finding.suggestedComment,
      locations: finding.locations,
    })),
  });
}

async function validateFindings(ctx: ExtensionCommandContext, dataset: ReviewDataset, analysis: ReviewAnalysis, scoutSummary: string, config: AiReviewRuntimeConfig): Promise<ReviewAnalysis> {
  if (analysis.findings.length === 0) return analysis;
  const findingIds = new Set(analysis.findings.map((finding) => finding.id));
  const text = await completeTextJson(ctx, config, "validation", VALIDATION_SYSTEM_PROMPT, buildValidationInput(dataset, analysis, scoutSummary));
  const decisions = normalizeValidationDecisionsJson(text, findingIds);
  return refreshApprovalPacketForFindings(applyValidationDecisions(analysis, decisions), scoutSummary);
}

export interface AiReviewSynthesisJson {
  summary: string;
  suggestedVerdict: ApprovalPacket["suggestedVerdict"];
  acceptedRisks: string[];
  body: string;
}

export function normalizeSynthesisJson(text: string, fallback: ApprovalPacket): AiReviewSynthesisJson {
  const parsed = parseJsonObject(text);
  return {
    summary: typeof parsed.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary.trim() : fallback.summary,
    suggestedVerdict: isVerdict(parsed.suggestedVerdict) ? parsed.suggestedVerdict : fallback.suggestedVerdict,
    acceptedRisks: Array.isArray(parsed.acceptedRisks) ? parsed.acceptedRisks.filter((risk): risk is string => typeof risk === "string" && risk.trim().length > 0).map((risk) => risk.trim()) : fallback.acceptedRisks,
    body: typeof parsed.body === "string" && parsed.body.trim().length > 0 ? parsed.body.trim() : fallback.body,
  };
}

function buildSynthesisInput(dataset: ReviewDataset, analysis: ReviewAnalysis, scoutSummary: string, failedChapterCount: number, config: AiReviewRuntimeConfig): string {
  return JSON.stringify({
    source: dataset.source,
    reviewDepth: config.depth,
    scoutSummary,
    failedChapterCount,
    coverage: analysis.coverage,
    chapters: analysis.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      summary: chapter.summary,
      priority: chapter.priority,
      attentionTags: chapter.attentionTags,
      fileCount: chapter.fileIds.length,
      ranges: chapter.ranges,
      findingIds: chapter.findingIds,
    })),
    findings: analysis.findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      severity: finding.severity,
      confidence: finding.confidence,
      title: finding.title,
      explanation: finding.explanation,
      suggestedComment: finding.suggestedComment,
      locations: finding.locations,
    })),
  });
}

async function synthesizeReview(ctx: ExtensionCommandContext, dataset: ReviewDataset, analysis: ReviewAnalysis, scoutSummary: string, failedChapterCount: number, config: AiReviewRuntimeConfig): Promise<ReviewAnalysis> {
  const text = await completeTextJson(ctx, config, "synthesis", SYNTHESIS_SYSTEM_PROMPT, buildSynthesisInput(dataset, analysis, scoutSummary, failedChapterCount, config));
  const synthesis = normalizeSynthesisJson(text, analysis.approvalPacket);
  return {
    ...analysis,
    approvalPacket: {
      ...analysis.approvalPacket,
      summary: synthesis.summary,
      acceptedRisks: synthesis.acceptedRisks,
      suggestedVerdict: synthesis.suggestedVerdict,
      body: synthesis.body,
    },
  };
}

function mergeChapterResults(baseAnalysis: ReviewAnalysis, dataset: ReviewDataset, results: ChapterReviewResult[], scoutSummary: string, message?: string): ReviewAnalysis {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const resultByChapterId = new Map(results.map((result) => [result.chapterId, result.analysis] as const));
  const usedFindingIds = new Set<string>();
  const findings: ReviewFinding[] = [];
  const reviewedChapterIds: string[] = [];

  const chapters = baseAnalysis.chapters.map((chapter) => {
    const result = resultByChapterId.get(chapter.id);
    if (!result) return { ...chapter, findingIds: [] };
    reviewedChapterIds.push(chapter.id);

    const findingIds: string[] = [];
    for (const finding of result.findings) {
      const findingId = uniqueFindingId(`${chapter.id}-${finding.id}`, usedFindingIds);
      findings.push(sanitizeFindingLocations({
        ...finding,
        id: findingId,
        status: "new",
      }, fileById));
      findingIds.push(findingId);
    }
    return { ...chapter, findingIds };
  });

  const unresolvedFindings = findings.filter((finding) => finding.severity !== "info").map((finding) => finding.id);
  const suggestedVerdict: ApprovalPacket["suggestedVerdict"] = findings.some((finding) => finding.severity === "critical" || finding.severity === "high")
    ? "request-changes"
    : findings.length > 0
      ? "comment"
      : baseAnalysis.approvalPacket.suggestedVerdict;
  const body = [
    baseAnalysis.approvalPacket.body,
    "",
    "## AI review summary",
    scoutSummary,
    "",
    findings.length === 0
      ? "No concrete AI findings were produced from the changed hunks."
      : findings.map((finding, index) => `${index + 1}. ${finding.title} (${finding.severity}, ${finding.confidence} confidence)`).join("\n"),
  ].join("\n").trim();

  return {
    ...baseAnalysis,
    status: "ready",
    message: message ?? `AI review complete: ${findings.length} finding(s) across ${results.length} review area(s).`,
    chapters,
    findings,
    approvalPacket: {
      ...baseAnalysis.approvalPacket,
      summary: findings.length === 0
        ? `${baseAnalysis.approvalPacket.summary} AI review found no concrete issues in changed hunks.`
        : `${baseAnalysis.approvalPacket.summary} AI review produced ${findings.length} concrete finding(s).`,
      reviewedChapters: reviewedChapterIds,
      unresolvedFindings,
      suggestedVerdict,
      body,
    },
  };
}

export async function runAiReview(ctx: ExtensionCommandContext, dataset: ReviewDataset, analysis: ReviewAnalysis, options: RunAiReviewOptions): Promise<{ analysis: ReviewAnalysis; progress: AiReviewProgress }> {
  if (!options.config.phases.chapter.model) {
    throw new Error("No Pi model is selected.");
  }

  let progress: AiReviewProgress = {
    ...emptyProgress(analysis, options.config),
    status: "running" as const,
    phase: "scout" as const,
    message: "Preparing AI review.",
  };
  options.onProgress(progress);

  const scoutSummary = await runScout(ctx, dataset, analysis, options.config);
  progress = {
    ...progress,
    phase: "chapter-review",
    message: "AI review is checking changed hunks.",
    scoutSummary,
  };
  options.onProgress(progress);

  const results: ChapterReviewResult[] = [];
  let nextChapterIndex = 0;
  const runNextChapter = async (): Promise<void> => {
    while (nextChapterIndex < analysis.chapters.length) {
      const chapter = analysis.chapters[nextChapterIndex];
      nextChapterIndex += 1;
      if (!chapter) continue;

      progress = updateChapterProgress(progress, chapter.id, {
        status: "running",
        message: "Reviewing changed hunks.",
      });
      options.onProgress(progress);

      try {
        const result = await reviewChapter(ctx, dataset, chapter, scoutSummary, options);
        results.push(result);
        progress = updateChapterProgress(progress, chapter.id, {
          status: "done",
          message: `Done. ${result.analysis.findings.length} finding(s).`,
          findingCount: result.analysis.findings.length,
        });
        options.onProgress(progress);
        const findingCount = results.reduce((total, item) => total + item.analysis.findings.length, 0);
        const partialAnalysis = mergeChapterResults(
          analysis,
          dataset,
          results,
          scoutSummary,
          `AI review running: ${findingCount} candidate finding(s) from ${results.length}/${analysis.chapters.length} review area(s). Validation will refine them.`,
        );
        options.onPartialResult?.({ chapterId: chapter.id, analysis: partialAnalysis, progress });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progress = updateChapterProgress(progress, chapter.id, {
          status: "failed",
          message,
        });
        options.onProgress(progress);
      }
    }
  };

  const parallelism = Math.max(1, Math.min(options.config.parallelChapterReviews, analysis.chapters.length));
  await Promise.all(Array.from({ length: parallelism }, () => runNextChapter()));

  const failedChapterCount = progress.chapters.filter((chapter) => chapter.status === "failed").length;
  if (analysis.chapters.length > 0 && failedChapterCount === analysis.chapters.length) {
    const message = "AI review failed for every review area.";
    return {
      analysis: {
        ...analysis,
        status: "failed",
        message,
      },
      progress: completeProgress(progress, "failed", message),
    };
  }

  progress = {
    ...progress,
    phase: "validation",
    message: "Validation critic is checking candidate findings.",
  };
  options.onProgress(progress);

  let nextAnalysis = mergeChapterResults(analysis, dataset, results, scoutSummary);
  const finalNotes: string[] = [];
  try {
    nextAnalysis = await validateFindings(ctx, dataset, nextAnalysis, scoutSummary, options.config);
    progress = {
      ...refreshProgressFindingCounts(progress, nextAnalysis),
      message: `Validation complete: ${nextAnalysis.findings.length} finding(s) kept.`,
    };
    options.onProgress(progress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalNotes.push(`Validation critic failed: ${message}`);
    progress = {
      ...progress,
      message: "Validation failed; using structurally valid findings.",
    };
    options.onProgress(progress);
  }

  progress = {
    ...progress,
    phase: "synthesis",
    message: "Preparing review summary.",
  };
  options.onProgress(progress);

  try {
    nextAnalysis = await synthesizeReview(ctx, dataset, nextAnalysis, scoutSummary, failedChapterCount, options.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalNotes.push(`Synthesis failed: ${message}`);
  }

  nextAnalysis.message = `AI review complete: ${nextAnalysis.findings.length} validated finding(s) across ${results.length} review area(s).`;
  if (finalNotes.length > 0) {
    nextAnalysis.message = `${nextAnalysis.message} ${finalNotes.join(" ")}`;
  }
  if (failedChapterCount > 0) {
    nextAnalysis.message = `${nextAnalysis.message} ${failedChapterCount} review area(s) failed.`;
  }
  progress = refreshProgressFindingCounts(progress, nextAnalysis);
  progress = completeProgress(progress, "done", nextAnalysis.message);
  return { analysis: nextAnalysis, progress };
}

export function createAiReviewFailedProgress(analysis: ReviewAnalysis, message: string, config?: AiReviewRuntimeConfig): AiReviewProgress {
  return completeProgress({
    ...emptyProgress(analysis, config),
    status: "failed",
    phase: "done",
    message,
  }, "failed", message);
}
