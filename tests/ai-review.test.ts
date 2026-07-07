import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewAnalysisJson } from "../src/analysis.js";
import { normalizeChapterReviewJson } from "../src/ai-review.js";
import type { ReviewDataset } from "../src/sources/types.js";
import type { ReviewChapter } from "../src/types.js";

function dataset(): ReviewDataset {
  const path = "src/app/api/qa_api.py";
  return {
    repoRoot: "/repo",
    workingRoot: "/repo",
    commits: [],
    analysisFileIds: [path],
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot: "/repo",
      workingRoot: "/repo",
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
    files: [{
      id: path,
      path,
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      gitDiff: {
        status: "modified",
        oldPath: path,
        newPath: path,
        displayPath: path,
        hasOriginal: true,
        hasModified: true,
        commentableOriginalLines: [{ start: 1, end: 1 }],
        commentableModifiedLines: [{ start: 1, end: 4 }],
      },
      lastCommit: null,
      commitComparisons: {},
    }],
  };
}

function chapter(): ReviewChapter {
  return {
    id: "qa-api",
    title: "QA labeling API",
    summary: "Review API changes.",
    risk: "high",
    fileIds: ["src/app/api/qa_api.py"],
    ranges: [],
    findingIds: [],
  };
}

test("chapter review normalization ignores invalid model approval packet", () => {
  const modelOutput = {
    chapters: [{
      id: "different-id",
      title: "Different",
      summary: "Wrong shape.",
      risk: "low",
      fileIds: ["not-real.py"],
      findingIds: ["missing-check"],
    }],
    findings: [{
      id: "missing-check",
      kind: "bug",
      severity: "medium",
      confidence: "high",
      title: "Validate request",
      explanation: "The diff calls the service without checking required input.",
      suggestedComment: "Should this validate the request before calling the service?",
      locations: [{
        fileId: "src/app/api/qa_api.py",
        path: "src/app/api/qa_api.py",
        side: "modified",
        line: 2,
      }],
      status: "new",
    }],
    approvalPacket: {
      summary: 123,
      reviewedChapters: ["not-real"],
      acceptedRisks: "invalid",
      unresolvedFindings: ["not-real-finding"],
      suggestedVerdict: "merge",
      body: null,
    },
  };

  const normalized = normalizeChapterReviewJson(JSON.stringify(modelOutput), chapter());
  const analysis = parseReviewAnalysisJson(normalized, dataset());

  assert.equal(analysis.chapters[0]?.id, "qa-api");
  assert.deepEqual(analysis.chapters[0]?.fileIds, ["src/app/api/qa_api.py"]);
  assert.deepEqual(analysis.approvalPacket.reviewedChapters, ["qa-api"]);
  assert.deepEqual(analysis.approvalPacket.unresolvedFindings, ["missing-check"]);
  assert.equal(analysis.findings[0]?.title, "Validate request");
});
