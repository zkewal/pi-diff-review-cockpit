import type { ReviewSourceMetadata } from "./sources/types.js";

export type ReviewScope = "git-diff" | "last-commit" | "commit" | "all-files";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  hasOriginal: boolean;
  hasModified: boolean;
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

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: DiffReviewComment[];
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

export type ReviewWindowMessage = ReviewSubmitPayload | ReviewCancelPayload | ReviewRequestFilePayload;

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

export type ReviewHostMessage = ReviewFileDataMessage | ReviewFileErrorMessage;

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewFindingKind = "bug" | "security" | "migration-risk" | "api-contract" | "test-gap" | "performance" | "question" | "informational";
export type ReviewFindingStatus = "new" | "accepted-comment" | "dismissed" | "accepted-risk";

export interface ReviewLocation {
  fileId: string;
  path: string;
  side: CommentSide;
  line: number | null;
}

export interface ReviewChapter {
  id: string;
  title: string;
  summary: string;
  risk: ReviewFindingSeverity;
  fileIds: string[];
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
  approvalPacket: ApprovalPacket;
}

export interface ReviewWindowData {
  repoRoot: string;
  workingRoot: string;
  files: ReviewFile[];
  commits: ReviewCommit[];
  source: ReviewSourceMetadata;
  analysis: ReviewAnalysis;
}
