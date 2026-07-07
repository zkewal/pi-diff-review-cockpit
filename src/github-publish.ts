import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitHubPullRequestMetadata } from "./sources/types.js";
import type { DiffReviewComment, GitHubReviewEvent, ReviewLineRange, ReviewSubmitPayload } from "./types.js";

const PUBLISH_TIMEOUT_MS = 120_000;

type GitHubCommentSide = "LEFT" | "RIGHT";

export interface BuildPayloadOptions {
  event: GitHubReviewEvent;
  body: string;
  submit: ReviewSubmitPayload;
  filePathById: Map<string, string>;
  commentableLinesByFileId: Map<string, { original: ReviewLineRange[]; modified: ReviewLineRange[] }>;
}

export interface GitHubReviewComment {
  path: string;
  body: string;
  side: GitHubCommentSide;
  line: number;
  start_line?: number;
  start_side?: GitHubCommentSide;
}

export interface GitHubReviewPayload {
  event: GitHubReviewEvent;
  body: string;
  comments: GitHubReviewComment[];
}

function githubSide(side: "original" | "modified"): GitHubCommentSide {
  return side === "original" ? "LEFT" : "RIGHT";
}

function isLineInRanges(line: number, ranges: ReviewLineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function areRangeEndpointsCommentable(startLine: number, endLine: number, ranges: ReviewLineRange[]): boolean {
  return isLineInRanges(startLine, ranges) && isLineInRanges(endLine, ranges);
}

function toGitHubReviewComment(options: BuildPayloadOptions, comment: DiffReviewComment): GitHubReviewComment | null {
  const { filePathById, commentableLinesByFileId } = options;
  const path = filePathById.get(comment.fileId);
  if (!path || comment.scope !== "git-diff" || comment.startLine == null || comment.side === "file") {
    return null;
  }

  const commentableLines = commentableLinesByFileId.get(comment.fileId);
  if (commentableLines == null) {
    return null;
  }

  const endLine = comment.endLine ?? comment.startLine;
  const ranges = comment.side === "original" ? commentableLines.original : commentableLines.modified;
  if (!areRangeEndpointsCommentable(comment.startLine, endLine, ranges)) {
    return null;
  }

  const side = githubSide(comment.side);
  const reviewComment: GitHubReviewComment = {
    path,
    body: comment.body,
    side,
    line: endLine,
  };

  if (endLine !== comment.startLine) {
    reviewComment.start_line = comment.startLine;
    reviewComment.start_side = side;
  }

  return reviewComment;
}

export function countSkippedGitHubReviewComments(options: BuildPayloadOptions): number {
  return options.submit.comments.filter((comment) => toGitHubReviewComment(options, comment) == null).length;
}

function acceptedFindingsSection(submit: ReviewSubmitPayload): string | null {
  const bodies = submit.acceptedFindings
    .map((finding) => finding.body.trim())
    .filter((body) => body.length > 0);

  if (bodies.length === 0) {
    return null;
  }

  return [
    "## Accepted AI findings",
    ...bodies.map((body, index) => `${index + 1}. ${body.replace(/\n/g, "\n   ")}`),
  ].join("\n\n");
}

function appendAcceptedFindings(body: string, submit: ReviewSubmitPayload): string {
  const section = acceptedFindingsSection(submit);
  if (section == null) {
    return body.trim();
  }

  return [body.trim(), section].filter((part) => part.length > 0).join("\n\n");
}

export function buildGitHubReviewPayload(options: BuildPayloadOptions): GitHubReviewPayload {
  const comments = options.submit.comments
    .map((comment) => toGitHubReviewComment(options, comment))
    .filter((comment): comment is GitHubReviewComment => comment != null);

  return {
    event: options.event,
    body: appendAcceptedFindings(options.body, options.submit),
    comments,
  };
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export async function publishGitHubReview(
  pi: ExtensionAPI,
  cwd: string,
  metadata: GitHubPullRequestMetadata,
  payload: GitHubReviewPayload,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-review-publish-"));
  try {
    const jsonPath = join(tempDir, "review.json");
    await writeFile(jsonPath, JSON.stringify(payload), "utf8");

    const endpoint = `repos/${metadata.owner}/${metadata.repo}/pulls/${metadata.number}/reviews`;
    const args = ["api", endpoint, "--method", "POST", "--input", jsonPath];
    const result = await pi.exec("gh", args, { cwd, timeout: PUBLISH_TIMEOUT_MS });
    if (result.code !== 0) {
      const output = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
      throw new Error(`Failed to run ${formatCommand("gh", args)} in ${cwd}: ${output}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
