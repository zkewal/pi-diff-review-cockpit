import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseReviewAnalysisJson } from "./analysis.js";
import type { ReviewDataset } from "./sources/types.js";
import type {
  AiReviewChapterProgress,
  AiReviewProgress,
  ApprovalPacket,
  ReviewAnalysis,
  ReviewChapter,
  ReviewFile,
  ReviewFinding,
  ReviewLineRange,
} from "./types.js";

const MAX_PATCH_CHARS_PER_FILE = 24_000;
const MAX_CHAPTER_PATCH_CHARS = 90_000;
const DEFAULT_PARALLEL_CHAPTER_REVIEWS = 3;

const SCOUT_SYSTEM_PROMPT = `You are a PI review scout for a code review cockpit.

Return strict JSON only: {"summary":"..."}.

Summarize the highest-value parallel review strategy from the provided PR metadata and chapter map. Do not invent bugs. Keep it concise.`;

const CHAPTER_REVIEW_SYSTEM_PROMPT = `You are a PI review subagent reviewing one chapter of a diff.

Return strict JSON only. Do not wrap the response in Markdown. The JSON object must contain exactly these top-level keys:
- "chapters": an array with exactly one chapter object
- "findings": an array of findings
- "approvalPacket": an approval packet object

Only create findings for concrete, actionable concerns supported by the provided diff patches. Prefer no finding over a speculative finding. Do not invent files, file ids, paths, or line numbers.

The chapter object must use the input chapter id, title, summary, risk, and fileIds. Its findingIds must reference only findings you create.

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

The approvalPacket must summarize this chapter only. If there are no concrete findings, return an empty findings array.`;

interface ChapterReviewResult {
  chapterId: string;
  analysis: ReviewAnalysis;
}

export interface RunAiReviewOptions {
  getFilePatch(file: ReviewFile): Promise<string>;
  onProgress(progress: AiReviewProgress): void;
  onPartialResult?(result: { chapterId: string; analysis: ReviewAnalysis; progress: AiReviewProgress }): void;
  maxParallelChapterReviews?: number;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} character(s)]`;
}

function emptyProgress(analysis: ReviewAnalysis): AiReviewProgress {
  return {
    status: "idle",
    phase: "idle",
    message: "AI review has not run.",
    scoutSummary: "",
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

export function normalizeChapterReviewJson(text: string, chapter: ReviewChapter): string {
  const parsed = parseJsonObject(text);
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
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
      risk: chapter.risk,
      fileIds: chapter.fileIds,
      findingIds,
    }],
    findings,
    approvalPacket: {
      summary: `Review ${chapter.title}.`,
      reviewedChapters: [chapter.id],
      acceptedRisks: [],
      unresolvedFindings: findingIds,
      suggestedVerdict: "comment",
      body: `PI subagent reviewed ${chapter.title}.`,
    },
  });
}

function buildScoutInput(dataset: ReviewDataset, analysis: ReviewAnalysis): string {
  return JSON.stringify({
    source: dataset.source,
    chapters: analysis.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      summary: chapter.summary,
      risk: chapter.risk,
      fileCount: chapter.fileIds.length,
      changedLines: {
        original: chapter.ranges.filter((range) => range.side === "original").reduce((total, range) => total + range.endLine - range.startLine + 1, 0),
        modified: chapter.ranges.filter((range) => range.side === "modified").reduce((total, range) => total + range.endLine - range.startLine + 1, 0),
      },
    })),
  });
}

async function completeTextJson(ctx: ExtensionCommandContext, systemPrompt: string, input: string): Promise<string> {
  if (!ctx.model) {
    throw new Error("No Pi model is selected.");
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error);
  }

  const userMessage: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{ type: "text", text: input }],
  };

  const response = await complete(
    ctx.model,
    { systemPrompt, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers },
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

async function runScout(ctx: ExtensionCommandContext, dataset: ReviewDataset, analysis: ReviewAnalysis): Promise<string> {
  try {
    const text = await completeTextJson(ctx, SCOUT_SYSTEM_PROMPT, buildScoutInput(dataset, analysis));
    const parsed = JSON.parse(text) as unknown;
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { summary?: unknown }).summary === "string") {
      return (parsed as { summary: string }).summary;
    }
  } catch {}

  return `Review ${analysis.chapters.length} chapter(s), prioritizing high-risk chapters and changed hunks with schema, API, service, and test impact.`;
}

function fileStatus(file: ReviewFile): string | null {
  return file.gitDiff?.status ?? file.worktreeStatus;
}

async function buildChapterReviewInput(options: {
  dataset: ReviewDataset;
  chapter: ReviewChapter;
  files: ReviewFile[];
  getFilePatch(file: ReviewFile): Promise<string>;
}): Promise<string> {
  let remainingChars = MAX_CHAPTER_PATCH_CHARS;
  const files = [];

  for (const file of options.files) {
    const rawPatch = await options.getFilePatch(file);
    const patch = truncateText(rawPatch, Math.max(0, Math.min(MAX_PATCH_CHARS_PER_FILE, remainingChars)));
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
    chapter: {
      id: options.chapter.id,
      title: options.chapter.title,
      summary: options.chapter.summary,
      risk: options.chapter.risk,
      fileIds: options.chapter.fileIds,
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

async function reviewChapter(ctx: ExtensionCommandContext, dataset: ReviewDataset, chapter: ReviewChapter, options: RunAiReviewOptions): Promise<ChapterReviewResult> {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const files = chapter.fileIds.map((fileId) => fileById.get(fileId)).filter((file): file is ReviewFile => file != null);
  const input = await buildChapterReviewInput({ dataset, chapter, files, getFilePatch: options.getFilePatch });
  const text = await completeTextJson(ctx, CHAPTER_REVIEW_SYSTEM_PROMPT, input);
  return {
    chapterId: chapter.id,
    analysis: parseReviewAnalysisJson(normalizeChapterReviewJson(text, chapter), datasetForChapter(dataset, chapter)),
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
    message: message ?? `AI review complete: ${findings.length} finding(s) from ${results.length} PI subagent(s).`,
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
  if (!ctx.model) {
    throw new Error("No Pi model is selected.");
  }

  let progress: AiReviewProgress = {
    ...emptyProgress(analysis),
    status: "running" as const,
    phase: "scout" as const,
    message: "Scout is planning the AI review.",
  };
  options.onProgress(progress);

  const scoutSummary = await runScout(ctx, dataset, analysis);
  progress = {
    ...progress,
    phase: "chapter-review",
    message: "PI subagents are reviewing changed hunks in parallel.",
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
        message: "PI subagent reviewing changed hunks.",
      });
      options.onProgress(progress);

      try {
        const result = await reviewChapter(ctx, dataset, chapter, options);
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
          `AI review running: ${findingCount} finding(s) from ${results.length}/${analysis.chapters.length} PI subagent(s).`,
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

  const parallelism = Math.max(1, Math.min(options.maxParallelChapterReviews ?? DEFAULT_PARALLEL_CHAPTER_REVIEWS, analysis.chapters.length));
  await Promise.all(Array.from({ length: parallelism }, () => runNextChapter()));

  const failedChapterCount = progress.chapters.filter((chapter) => chapter.status === "failed").length;
  if (analysis.chapters.length > 0 && failedChapterCount === analysis.chapters.length) {
    const message = "AI review failed for every chapter.";
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
    message: "Validating and merging AI findings.",
  };
  options.onProgress(progress);

  const nextAnalysis = mergeChapterResults(analysis, dataset, results, scoutSummary);
  if (failedChapterCount > 0) {
    nextAnalysis.message = `${nextAnalysis.message} ${failedChapterCount} chapter agent(s) failed.`;
  }
  progress = completeProgress(progress, "done", nextAnalysis.message);
  return { analysis: nextAnalysis, progress };
}

export function createAiReviewFailedProgress(analysis: ReviewAnalysis, message: string): AiReviewProgress {
  return completeProgress({
    ...emptyProgress(analysis),
    status: "failed",
    phase: "done",
    message,
  }, "failed", message);
}
