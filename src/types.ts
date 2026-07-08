import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ReviewSourceMetadata } from "./sources/types.js";

export type ReviewScope = "git-diff" | "last-commit" | "commit" | "all-files";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewLineRange {
  start: number;
  end: number;
}

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
  commentableOriginalLines?: ReviewLineRange[];
  commentableModifiedLines?: ReviewLineRange[];
}

export interface ReviewCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

export interface ReviewFile {
  id: string;
  path: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
  commitComparisons: Record<string, ReviewFileComparison>;
}

export interface ReviewFileContents {
  originalContent: string;
  modifiedContent: string;
}

export type CommentSide = "original" | "modified" | "file";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  scope: ReviewScope;
  commitSha?: string;
  side: CommentSide;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface AcceptedFindingComment {
  findingId: string;
  body: string;
}

export interface FindingStatusUpdate {
  findingId: string;
  status: ReviewFindingStatus;
}

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
  acceptedFindings: AcceptedFindingComment[];
  findingStatuses: FindingStatusUpdate[];
  approvalPacket: ApprovalPacket;
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export interface ReviewRequestFilePayload {
  type: "request-file";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  commitSha?: string;
}

export type GitHubReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

export interface ReviewPublishPayload {
  type: "publish-github-review";
  event: GitHubReviewEvent;
  body: string;
  submit: ReviewSubmitPayload;
}

export interface ReviewRunAiReviewPayload {
  type: "run-ai-review";
  requestId: string;
}

export type ReviewSessionRestoreStatus = "new" | "restored" | "stale" | "refreshed";

export interface ReviewActiveInsightState {
  type: "default" | "chapter" | "finding" | "comment";
  id: string | null;
}

export interface ReviewSessionSnapshot {
  analysis?: ReviewAnalysis;
  overallComment?: string;
  comments?: DiffReviewComment[];
  acceptedFindingComments?: Record<string, string>;
  findingStatuses?: Record<string, ReviewFindingStatus>;
  reviewedFiles?: Record<string, boolean>;
  reviewedChapters?: Record<string, boolean>;
  activeFileId?: string | null;
  activeSidebarTab?: "review-map" | "files" | "findings";
  currentScope?: ReviewScope;
  selectedCommitSha?: string | null;
  activeInsight?: ReviewActiveInsightState;
  hideUnchanged?: boolean;
  wrapLines?: boolean;
  sidebarCollapsed?: boolean;
  aiReviewCompleted?: boolean;
  aiReviewStatus?: AiReviewRunStatus;
  updatedAt?: string;
}

export interface ReviewSaveSessionPayload {
  type: "save-session";
  requestId?: string;
  snapshot: ReviewSessionSnapshot;
}

export type ReviewWindowMessage = ReviewSubmitPayload | ReviewCancelPayload | ReviewRequestFilePayload | ReviewPublishPayload | ReviewRunAiReviewPayload | ReviewSaveSessionPayload;

export interface ReviewFileDataMessage {
  type: "file-data";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  commitSha?: string;
  originalContent: string;
  modifiedContent: string;
}

export interface ReviewFileErrorMessage {
  type: "file-error";
  requestId: string;
  fileId: string;
  scope: ReviewScope;
  commitSha?: string;
  message: string;
}

export interface ReviewSaveSessionResultMessage {
  type: "save-session-result";
  requestId: string;
  ok: boolean;
  message?: string;
  savedAt?: string;
}

export type AiReviewRunStatus = "idle" | "running" | "done" | "failed";
export type AiReviewStepStatus = "queued" | "running" | "done" | "failed";
export type AiReviewDepth = "fast" | "standard" | "deep";
export type AiReviewPhase = "scout" | "chapter" | "validation" | "synthesis";

export interface AiReviewResolvedPhaseConfig {
  model: string | null;
  reasoning: "off" | ThinkingLevel;
}

export interface AiReviewResolvedConfig {
  depth: AiReviewDepth;
  parallelChapterReviews: number;
  maxPatchCharsPerFile: number;
  maxChapterPatchChars: number;
  maxFindingsPerChapter: number;
  configPaths: string[];
  warnings: string[];
  phases: Record<AiReviewPhase, AiReviewResolvedPhaseConfig>;
}

export interface AiReviewRuntimePhaseConfig {
  model: Model<Api> | null;
  reasoning?: ThinkingLevel;
  modelLabel: string;
}

export interface AiReviewRuntimeConfig {
  depth: AiReviewDepth;
  parallelChapterReviews: number;
  maxPatchCharsPerFile: number;
  maxChapterPatchChars: number;
  maxFindingsPerChapter: number;
  phases: Record<AiReviewPhase, AiReviewRuntimePhaseConfig>;
  public: AiReviewResolvedConfig;
}

export interface AiReviewChapterProgress {
  chapterId: string;
  title: string;
  status: AiReviewStepStatus;
  message: string;
  findingCount: number;
}

export interface AiReviewProgress {
  status: AiReviewRunStatus;
  phase: "idle" | AiReviewPhase | "chapter-review" | "done";
  message: string;
  scoutSummary: string;
  chapters: AiReviewChapterProgress[];
  config?: AiReviewResolvedConfig;
}

export interface ReviewAiReviewProgressMessage {
  type: "ai-review-progress";
  requestId: string;
  progress: AiReviewProgress;
}

export interface ReviewAiReviewResultMessage {
  type: "ai-review-result";
  requestId: string;
  analysis: ReviewAnalysis;
  progress: AiReviewProgress;
}

export interface ReviewAiReviewPartialResultMessage {
  type: "ai-review-partial-result";
  requestId: string;
  chapterId: string;
  analysis: ReviewAnalysis;
  progress: AiReviewProgress;
}

export interface ReviewAiReviewErrorMessage {
  type: "ai-review-error";
  requestId: string;
  message: string;
  progress: AiReviewProgress;
}

export type ReviewHostMessage = ReviewFileDataMessage | ReviewFileErrorMessage | ReviewSaveSessionResultMessage | ReviewAiReviewProgressMessage | ReviewAiReviewPartialResultMessage | ReviewAiReviewResultMessage | ReviewAiReviewErrorMessage;

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewFindingKind = "bug" | "security" | "migration-risk" | "api-contract" | "test-gap" | "performance" | "question" | "informational";
export type ReviewFindingStatus = "new" | "accepted-comment" | "dismissed" | "accepted-risk";
export type ReviewChapterPriority = "review-first" | "high-attention" | "standard" | "low-attention" | "reference";

export interface ReviewLocation {
  fileId: string;
  path: string;
  side: CommentSide;
  line: number | null;
}

export interface ReviewChapterRange {
  fileId: string;
  path: string;
  side: Exclude<CommentSide, "file">;
  startLine: number;
  endLine: number;
}

export interface ReviewChapter {
  id: string;
  title: string;
  summary: string;
  reviewOrder: number;
  reviewWeight: number;
  priority: ReviewChapterPriority;
  attentionTags: string[];
  fileIds: string[];
  ranges: ReviewChapterRange[];
  findingIds: string[];
}

export interface ReviewFinding {
  id: string;
  kind: ReviewFindingKind;
  severity: ReviewFindingSeverity;
  confidence: ReviewFindingSeverity;
  title: string;
  explanation: string;
  suggestedComment: string;
  locations: ReviewLocation[];
  status: ReviewFindingStatus;
}

export interface ApprovalPacket {
  summary: string;
  reviewedChapters: string[];
  acceptedRisks: string[];
  unresolvedFindings: string[];
  suggestedVerdict: "comment" | "request-changes" | "approve";
  body: string;
}

export interface ReviewAnalysis {
  status: "ready" | "fallback" | "failed";
  message: string;
  chapters: ReviewChapter[];
  findings: ReviewFinding[];
  coverage: ReviewCoverageSummary;
  approvalPacket: ApprovalPacket;
}

export interface ReviewCoverageSummary {
  fileCount: number;
  originalLineCount: number;
  modifiedLineCount: number;
  unmappedFileCount: number;
  unmappedOriginalLineCount: number;
  unmappedModifiedLineCount: number;
}

export interface ReviewWindowData {
  repoRoot: string;
  workingRoot: string;
  files: ReviewFile[];
  analysisFileIds: string[];
  commits: ReviewCommit[];
  source: ReviewSourceMetadata;
  analysis: ReviewAnalysis;
  aiReviewConfig?: AiReviewResolvedConfig;
  session?: {
    status: ReviewSessionRestoreStatus;
    message: string;
    storagePath: string;
    updatedAt: string | null;
    snapshot: ReviewSessionSnapshot | null;
  };
}
