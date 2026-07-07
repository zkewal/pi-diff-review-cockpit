import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseReviewAnalysisJson } from "./analysis.js";
import type { ReviewDataset } from "./sources/types.js";
import type { ReviewAnalysis, ReviewFile, ReviewSessionRestoreStatus, ReviewSessionSnapshot } from "./types.js";

const SESSION_VERSION = 1;
const SESSION_DIR = "pi-diff-review-cockpit";

export interface ReviewFileFingerprint {
  fileId: string;
  path: string;
  displayPath: string;
  status: string | null;
  oldPath: string | null;
  newPath: string | null;
  patchHash: string;
}

export interface ReviewDiffFingerprint {
  version: 1;
  sourceKey: string;
  sourceKind: string;
  baseRevision: string | null;
  headRevision: string | null;
  fileCount: number;
  files: ReviewFileFingerprint[];
  hash: string;
}

export interface ReviewSessionRecord {
  version: 1;
  sourceKey: string;
  fingerprint: ReviewDiffFingerprint;
  snapshot: ReviewSessionSnapshot;
  updatedAt: string;
}

export interface ReviewSessionDescriptor {
  sourceKey: string;
  storagePath: string;
}

export interface ReviewSessionResolution {
  status: ReviewSessionRestoreStatus;
  message: string;
  snapshot: ReviewSessionSnapshot | null;
  analysis: ReviewAnalysis | null;
  updatedAt: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string): string {
  const segment = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || "review";
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.keys(item as Record<string, unknown>).sort().reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = (item as Record<string, unknown>)[key];
      return sorted;
    }, {});
  });
}

function sourceKeyForDataset(dataset: ReviewDataset): string {
  const github = dataset.source.github;
  if (github) {
    return `github:${github.owner.toLowerCase()}/${github.repo.toLowerCase()}:pull/${github.number}`;
  }

  return `local:${dataset.repoRoot}:${dataset.source.kind}`;
}

function sessionDirectoryName(sourceKey: string): string {
  const label = safeSegment(sourceKey).slice(0, 80);
  return `${label}-${sha256(sourceKey).slice(0, 16)}`;
}

async function runGitAllowFailure(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | null> {
  const result = await pi.exec("git", args, { cwd });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function resolveRevision(pi: ExtensionAPI, cwd: string, revision: string | null): Promise<string | null> {
  if (revision == null) return null;
  return await runGitAllowFailure(pi, cwd, ["rev-parse", "--verify", revision]) ?? revision;
}

async function gitCommonDir(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const value = await runGitAllowFailure(pi, repoRoot, ["rev-parse", "--git-common-dir"]);
  if (value == null) {
    return join(repoRoot, ".git");
  }
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function analysisFiles(dataset: ReviewDataset): ReviewFile[] {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const selected = dataset.analysisFileIds
    .map((fileId) => fileById.get(fileId))
    .filter((file): file is ReviewFile => file != null);
  return selected.length > 0 ? selected : dataset.files;
}

function comparisonForFingerprint(file: ReviewFile) {
  return file.gitDiff ?? file.lastCommit ?? Object.values(file.commitComparisons)[0] ?? null;
}

async function buildFileFingerprint(file: ReviewFile, getFilePatch: (file: ReviewFile) => Promise<string>): Promise<ReviewFileFingerprint> {
  const comparison = comparisonForFingerprint(file);
  const patch = await getFilePatch(file);
  const structuralFallback = {
    id: file.id,
    path: file.path,
    worktreeStatus: file.worktreeStatus,
    comparison,
  };

  return {
    fileId: file.id,
    path: file.path,
    displayPath: comparison?.displayPath ?? file.path,
    status: comparison?.status ?? file.worktreeStatus,
    oldPath: comparison?.oldPath ?? null,
    newPath: comparison?.newPath ?? null,
    patchHash: sha256(patch.length > 0 ? patch : stableJson(structuralFallback)),
  };
}

export async function buildReviewDiffFingerprint(
  pi: ExtensionAPI,
  dataset: ReviewDataset,
  getFilePatch: (file: ReviewFile) => Promise<string>,
): Promise<ReviewDiffFingerprint> {
  const sourceKey = sourceKeyForDataset(dataset);
  const files = await Promise.all(analysisFiles(dataset).map((file) => buildFileFingerprint(file, getFilePatch)));
  files.sort((left, right) => left.fileId.localeCompare(right.fileId));

  const baseRevision = await resolveRevision(pi, dataset.repoRoot, dataset.source.baseRevision);
  const headRevision = await resolveRevision(pi, dataset.repoRoot, dataset.source.headRevision);
  const hashInput = {
    sourceKey,
    sourceKind: dataset.source.kind,
    baseRevision,
    headRevision,
    files,
  };

  return {
    version: SESSION_VERSION,
    sourceKey,
    sourceKind: dataset.source.kind,
    baseRevision,
    headRevision,
    fileCount: files.length,
    files,
    hash: sha256(stableJson(hashInput)),
  };
}

export async function getReviewSessionDescriptor(pi: ExtensionAPI, dataset: ReviewDataset): Promise<ReviewSessionDescriptor> {
  const sourceKey = sourceKeyForDataset(dataset);
  const commonDir = await gitCommonDir(pi, dataset.repoRoot);
  return {
    sourceKey,
    storagePath: join(commonDir, SESSION_DIR, "reviews", sessionDirectoryName(sourceKey), "session.json"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isSessionRecord(value: unknown): value is ReviewSessionRecord {
  if (!isRecord(value)) return false;
  if (value.version !== SESSION_VERSION) return false;
  if (typeof value.sourceKey !== "string") return false;
  if (!isRecord(value.fingerprint) || typeof value.fingerprint.hash !== "string") return false;
  if (!isRecord(value.snapshot)) return false;
  return typeof value.updatedAt === "string";
}

export async function loadReviewSession(storagePath: string): Promise<ReviewSessionRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(storagePath, "utf8")) as unknown;
    return isSessionRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveReviewSession(storagePath: string, record: ReviewSessionRecord): Promise<void> {
  await mkdir(dirname(storagePath), { recursive: true });
  const tempPath = `${storagePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tempPath, storagePath);
}

export function buildReviewSessionRecord(options: {
  sourceKey: string;
  fingerprint: ReviewDiffFingerprint;
  analysis: ReviewAnalysis;
  snapshot?: ReviewSessionSnapshot | null;
}): ReviewSessionRecord {
  const updatedAt = new Date().toISOString();
  return {
    version: SESSION_VERSION,
    sourceKey: options.sourceKey,
    fingerprint: options.fingerprint,
    snapshot: {
      ...(options.snapshot ?? {}),
      analysis: options.analysis,
      updatedAt,
    },
    updatedAt,
  };
}

export function reviveSessionAnalysis(snapshot: ReviewSessionSnapshot | null | undefined, dataset: ReviewDataset): ReviewAnalysis | null {
  const analysis = snapshot?.analysis;
  if (!analysis) return null;

  try {
    const parsed = parseReviewAnalysisJson(JSON.stringify({
      chapters: analysis.chapters,
      findings: analysis.findings,
      approvalPacket: analysis.approvalPacket,
    }), dataset);
    return {
      ...parsed,
      status: analysis.status,
      message: analysis.message,
    };
  } catch {
    return null;
  }
}

export function resolveReviewSession(options: {
  stored: ReviewSessionRecord | null;
  sourceKey: string;
  currentFingerprint: ReviewDiffFingerprint;
  dataset: ReviewDataset;
}): ReviewSessionResolution {
  const { stored, sourceKey, currentFingerprint, dataset } = options;
  if (stored == null || stored.sourceKey !== sourceKey) {
    return {
      status: "new",
      message: "No saved review session.",
      snapshot: null,
      analysis: null,
      updatedAt: null,
    };
  }

  const analysis = stored.fingerprint.hash === currentFingerprint.hash
    ? reviveSessionAnalysis(stored.snapshot, dataset)
    : null;

  if (stored.fingerprint.hash === currentFingerprint.hash && analysis != null) {
    return {
      status: "restored",
      message: "Review session restored.",
      snapshot: stored.snapshot,
      analysis,
      updatedAt: stored.updatedAt,
    };
  }

  if (stored.fingerprint.hash === currentFingerprint.hash) {
    return {
      status: "refreshed",
      message: "Saved review map was invalid, so it was refreshed.",
      snapshot: stored.snapshot,
      analysis: null,
      updatedAt: stored.updatedAt,
    };
  }

  return {
    status: "stale",
    message: "Diff changed since the last review; saved comments were restored and generated analysis was refreshed.",
    snapshot: stored.snapshot,
    analysis: null,
    updatedAt: stored.updatedAt,
  };
}
