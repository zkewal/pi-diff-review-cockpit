import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewDataset } from "./sources/types.js";
import type {
  ApprovalPacket,
  CommentSide,
  ReviewAnalysis,
  ReviewChapter,
  ReviewFinding,
  ReviewFindingKind,
  ReviewFindingSeverity,
  ReviewFindingStatus,
  ReviewLocation,
} from "./types.js";

const ANALYSIS_SYSTEM_PROMPT = `You are a senior code reviewer preparing a review map for a human reviewer.

Return strict JSON only. Do not wrap the response in Markdown. The JSON object must contain exactly these top-level keys:
- "chapters": an array of review chapters
- "findings": an array of findings
- "approvalPacket": an approval packet object

Group files into chapters in the order a reviewer should read them. Prefer domain-oriented chapters such as schema and migrations, API surface, service behavior, data models, tests, and miscellaneous changes. Each chapter must have:
- id: stable kebab-case string
- title: concise human-readable title
- summary: one or two sentences explaining what to review
- risk: one of "critical", "high", "medium", "low", "info"
- fileIds: array of file ids from the input only
- findingIds: array of finding ids from your findings

Separate high-confidence bugs from informational explanations. Only create findings for concrete, actionable review concerns. Do not invent files, file ids, paths, or line numbers. When you are unsure about the exact line, set line to null. Each finding must have:
- id: stable kebab-case string
- kind: one of "bug", "security", "migration-risk", "api-contract", "test-gap", "performance", "question", "informational"
- severity: one of "critical", "high", "medium", "low", "info"
- confidence: one of "critical", "high", "medium", "low", "info"
- title: concise title
- explanation: why this matters
- suggestedComment: a ready-to-post reviewer comment
- locations: array of locations using only input file ids and paths, side one of "original", "modified", "file", and line number or null
- status: "new"

The approvalPacket must have:
- summary: concise summary of the review scope
- reviewedChapters: array of chapter ids that should be reviewed
- acceptedRisks: array of risks that can be explicitly accepted if no findings remain
- unresolvedFindings: array of finding ids that require action
- suggestedVerdict: one of "comment", "request-changes", "approve"
- body: final review text suitable for the reviewer to edit before submitting

If the input does not contain enough information to identify a concrete bug, keep findings empty and make the approval packet summarize the review areas.`;

function chapterIdFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "changes";
}

function inferChapterTitle(path: string): string {
  if (path.includes("migration")) return "Schema and migrations";
  if (path.includes("/tests/") || path.startsWith("tests/")) return "Tests";
  if (path.includes("/api/")) return "API surface";
  if (path.includes("/models/")) return "Data models";
  if (path.includes("/services/")) return "Service behavior";
  return "Miscellaneous changes";
}

function getAnalysisFiles(dataset: ReviewDataset) {
  const fileById = new Map(dataset.files.map((file) => [file.id, file] as const));
  const selectedFiles = dataset.analysisFileIds
    .map((fileId) => fileById.get(fileId))
    .filter((file): file is ReviewDataset["files"][number] => file != null);

  return selectedFiles.length > 0 ? selectedFiles : dataset.files;
}

export function createFallbackAnalysis(dataset: ReviewDataset, message: string): ReviewAnalysis {
  const chaptersByTitle = new Map<string, ReviewChapter>();
  const analysisFiles = getAnalysisFiles(dataset);

  for (const file of analysisFiles) {
    const title = inferChapterTitle(file.path);
    const existing = chaptersByTitle.get(title);
    if (existing) {
      existing.fileIds.push(file.id);
      continue;
    }

    chaptersByTitle.set(title, {
      id: chapterIdFromTitle(title),
      title,
      summary: `Review ${title.toLowerCase()} before marking this source complete.`,
      risk: title === "Schema and migrations" ? "high" : "medium",
      fileIds: [file.id],
      findingIds: [],
    });
  }

  const chapterTitles = [...chaptersByTitle.values()].map((chapter) => chapter.title);
  const approvalPacket: ApprovalPacket = {
    summary: `${dataset.source.label} contains ${analysisFiles.length} reviewable change file(s).`,
    reviewedChapters: [],
    acceptedRisks: [],
    unresolvedFindings: [],
    suggestedVerdict: "comment",
    body: [`Reviewed ${dataset.source.label}.`, "", "Chapters:", ...chapterTitles.map((title) => `- ${title}`)].join("\n"),
  };

  return {
    status: "fallback",
    message,
    chapters: [...chaptersByTitle.values()],
    findings: [],
    approvalPacket,
  };
}

function buildAnalysisInput(dataset: ReviewDataset): string {
  return JSON.stringify({
    source: dataset.source,
    files: getAnalysisFiles(dataset).map((file) => ({
      id: file.id,
      path: file.path,
      status: file.gitDiff?.status ?? file.worktreeStatus,
      displayPath: file.gitDiff?.displayPath ?? file.path,
      inGitDiff: file.inGitDiff,
      inLastCommit: file.inLastCommit,
    })),
  });
}

const REVIEW_FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const satisfies readonly ReviewFindingSeverity[];
const REVIEW_FINDING_KINDS = [
  "bug",
  "security",
  "migration-risk",
  "api-contract",
  "test-gap",
  "performance",
  "question",
  "informational",
] as const satisfies readonly ReviewFindingKind[];
const REVIEW_FINDING_STATUSES = ["new", "accepted-comment", "dismissed", "accepted-risk"] as const satisfies readonly ReviewFindingStatus[];
const COMMENT_SIDES = ["original", "modified", "file"] as const satisfies readonly CommentSide[];
const SUGGESTED_VERDICTS = ["comment", "request-changes", "approve"] as const satisfies readonly ApprovalPacket["suggestedVerdict"][];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`AI analysis JSON has invalid ${field}.`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`AI analysis JSON has invalid ${field}.`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`AI analysis JSON has invalid ${field}.`);
  }
  return [...value];
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`AI analysis JSON has invalid ${field}.`);
  }
  return value as T;
}

function normalizeChapter(value: unknown, index: number): ReviewChapter {
  const chapter = requireRecord(value, `chapters[${index}]`);

  return {
    id: requireString(chapter.id, `chapters[${index}].id`),
    title: requireString(chapter.title, `chapters[${index}].title`),
    summary: requireString(chapter.summary, `chapters[${index}].summary`),
    risk: requireOneOf(chapter.risk, REVIEW_FINDING_SEVERITIES, `chapters[${index}].risk`),
    fileIds: requireStringArray(chapter.fileIds, `chapters[${index}].fileIds`),
    findingIds: requireStringArray(chapter.findingIds, `chapters[${index}].findingIds`),
  };
}

function normalizeLocation(value: unknown, findingIndex: number, locationIndex: number): ReviewLocation {
  const location = requireRecord(value, `findings[${findingIndex}].locations[${locationIndex}]`);
  const line = location.line;
  let normalizedLine: number | null;
  if (line === null) {
    normalizedLine = null;
  } else if (typeof line === "number" && Number.isInteger(line) && line > 0) {
    normalizedLine = line;
  } else {
    throw new Error(`AI analysis JSON has invalid findings[${findingIndex}].locations[${locationIndex}].line.`);
  }

  return {
    fileId: requireString(location.fileId, `findings[${findingIndex}].locations[${locationIndex}].fileId`),
    path: requireString(location.path, `findings[${findingIndex}].locations[${locationIndex}].path`),
    side: requireOneOf(location.side, COMMENT_SIDES, `findings[${findingIndex}].locations[${locationIndex}].side`),
    line: normalizedLine,
  };
}

function normalizeLocations(value: unknown, findingIndex: number): ReviewLocation[] {
  if (!Array.isArray(value)) {
    throw new Error(`AI analysis JSON has invalid findings[${findingIndex}].locations.`);
  }
  return value.map((location, locationIndex) => normalizeLocation(location, findingIndex, locationIndex));
}

function normalizeFinding(value: unknown, index: number): ReviewFinding {
  const finding = requireRecord(value, `findings[${index}]`);
  const status = finding.status ?? "new";

  return {
    id: requireString(finding.id, `findings[${index}].id`),
    kind: requireOneOf(finding.kind, REVIEW_FINDING_KINDS, `findings[${index}].kind`),
    severity: requireOneOf(finding.severity, REVIEW_FINDING_SEVERITIES, `findings[${index}].severity`),
    confidence: requireOneOf(finding.confidence, REVIEW_FINDING_SEVERITIES, `findings[${index}].confidence`),
    title: requireString(finding.title, `findings[${index}].title`),
    explanation: requireString(finding.explanation, `findings[${index}].explanation`),
    suggestedComment: requireString(finding.suggestedComment, `findings[${index}].suggestedComment`),
    locations: normalizeLocations(finding.locations, index),
    status: normalizeAiFindingStatus(status, `findings[${index}].status`),
  };
}

function normalizeAiFindingStatus(value: unknown, field: string): ReviewFindingStatus {
  if (value === "new" || (typeof value === "string" && REVIEW_FINDING_STATUSES.includes(value as ReviewFindingStatus))) {
    return "new";
  }
  throw new Error(`AI analysis JSON has invalid ${field}.`);
}

function normalizeApprovalPacket(value: unknown): ApprovalPacket {
  const packet = requireRecord(value, "approvalPacket");

  return {
    summary: requireString(packet.summary, "approvalPacket.summary"),
    reviewedChapters: requireStringArray(packet.reviewedChapters, "approvalPacket.reviewedChapters"),
    acceptedRisks: requireStringArray(packet.acceptedRisks, "approvalPacket.acceptedRisks"),
    unresolvedFindings: requireStringArray(packet.unresolvedFindings, "approvalPacket.unresolvedFindings"),
    suggestedVerdict: requireOneOf(packet.suggestedVerdict, SUGGESTED_VERDICTS, "approvalPacket.suggestedVerdict"),
    body: requireString(packet.body, "approvalPacket.body"),
  };
}

function requireUniqueIds(values: readonly { id: string }[], field: "chapters" | "findings"): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      throw new Error(`AI analysis JSON has duplicate ${field}[${index}].id.`);
    }
    seen.add(value.id);
  }
}

function validateAnalysisRelationships(analysis: ReviewAnalysis, dataset: ReviewDataset): void {
  const analysisFiles = getAnalysisFiles(dataset);
  const fileById = new Map(analysisFiles.map((file) => [file.id, file] as const));
  requireUniqueIds(analysis.chapters, "chapters");
  requireUniqueIds(analysis.findings, "findings");

  const findingIds = new Set(analysis.findings.map((finding) => finding.id));
  const chapterIds = new Set(analysis.chapters.map((chapter) => chapter.id));
  const coveredFileIds = new Set<string>();

  for (const [chapterIndex, chapter] of analysis.chapters.entries()) {
    for (const [fileIdIndex, fileId] of chapter.fileIds.entries()) {
      if (!fileById.has(fileId)) {
        throw new Error(`AI analysis JSON references unknown chapters[${chapterIndex}].fileIds[${fileIdIndex}].`);
      }
      if (coveredFileIds.has(fileId)) {
        throw new Error(`AI analysis JSON has duplicate chapters[${chapterIndex}].fileIds[${fileIdIndex}].`);
      }
      coveredFileIds.add(fileId);
    }

    for (const [findingIdIndex, findingId] of chapter.findingIds.entries()) {
      if (!findingIds.has(findingId)) {
        throw new Error(`AI analysis JSON references unknown chapters[${chapterIndex}].findingIds[${findingIdIndex}].`);
      }
    }
  }

  for (const [fileIndex, file] of analysisFiles.entries()) {
    if (!coveredFileIds.has(file.id)) {
      throw new Error(`AI analysis JSON omits analysis file ${fileIndex} from chapters.`);
    }
  }

  for (const [findingIndex, finding] of analysis.findings.entries()) {
    for (const [locationIndex, location] of finding.locations.entries()) {
      const file = fileById.get(location.fileId);
      if (!file) {
        throw new Error(`AI analysis JSON references unknown findings[${findingIndex}].locations[${locationIndex}].fileId.`);
      }
      if (location.path !== file.path) {
        throw new Error(`AI analysis JSON has mismatched findings[${findingIndex}].locations[${locationIndex}].path.`);
      }
    }
  }

  for (const [chapterIdIndex, chapterId] of analysis.approvalPacket.reviewedChapters.entries()) {
    if (!chapterIds.has(chapterId)) {
      throw new Error(`AI analysis JSON references unknown approvalPacket.reviewedChapters[${chapterIdIndex}].`);
    }
  }

  for (const [findingIdIndex, findingId] of analysis.approvalPacket.unresolvedFindings.entries()) {
    if (!findingIds.has(findingId)) {
      throw new Error(`AI analysis JSON references unknown approvalPacket.unresolvedFindings[${findingIdIndex}].`);
    }
  }
}

export function parseReviewAnalysisJson(text: string, dataset?: ReviewDataset): ReviewAnalysis {
  const parsed = requireRecord(JSON.parse(text) as unknown, "analysis");
  if (!Array.isArray(parsed.chapters)) {
    throw new Error("AI analysis JSON has invalid chapters.");
  }
  if (!Array.isArray(parsed.findings)) {
    throw new Error("AI analysis JSON has invalid findings.");
  }

  const analysis: ReviewAnalysis = {
    status: "ready",
    message: "AI analysis ready.",
    chapters: parsed.chapters.map(normalizeChapter),
    findings: parsed.findings.map(normalizeFinding),
    approvalPacket: normalizeApprovalPacket(parsed.approvalPacket),
  };

  if (dataset) {
    validateAnalysisRelationships(analysis, dataset);
  }

  return analysis;
}

export async function analyzeReviewDataset(ctx: ExtensionCommandContext, dataset: ReviewDataset): Promise<ReviewAnalysis> {
  if (!ctx.model) {
    return createFallbackAnalysis(dataset, "No Pi model is selected, so deterministic fallback analysis was used.");
  }

  const model = ctx.model;

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      return createFallbackAnalysis(dataset, auth.ok ? `No API key for ${model.provider}.` : auth.error);
    }

    const userMessage: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: buildAnalysisInput(dataset) }],
    };

    const response = await complete(
      model,
      { systemPrompt: ANALYSIS_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers },
    );

    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (response.stopReason !== "stop" || text.length === 0) {
      return createFallbackAnalysis(dataset, "AI analysis did not complete cleanly, so deterministic fallback analysis was used.");
    }

    return parseReviewAnalysisJson(text, dataset);
  } catch (error) {
    return createFallbackAnalysis(dataset, "AI analysis could not produce a complete review map, so deterministic fallback analysis was used.");
  }
}
