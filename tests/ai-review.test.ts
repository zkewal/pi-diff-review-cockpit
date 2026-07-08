import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewAnalysisJson } from "../src/analysis.js";
import {
  applyValidationDecisions,
  normalizeChapterReviewJson,
  normalizeSynthesisJson,
  normalizeValidationDecisionsJson,
  refreshProgressFindingCounts,
} from "../src/ai-review.js";
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
    priority: "review-first",
    attentionTags: ["API"],
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
      priority: "low-attention",
      attentionTags: ["Wrong"],
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

test("chapter review normalization caps candidate findings", () => {
  const output = {
    findings: [
      {
        id: "first",
        kind: "bug",
        severity: "medium",
        confidence: "high",
        title: "First",
        explanation: "First issue.",
        suggestedComment: "First comment.",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 }],
        status: "new",
      },
      {
        id: "second",
        kind: "bug",
        severity: "medium",
        confidence: "high",
        title: "Second",
        explanation: "Second issue.",
        suggestedComment: "Second comment.",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 3 }],
        status: "new",
      },
    ],
  };

  const normalized = normalizeChapterReviewJson(JSON.stringify(output), chapter(), 1);
  const analysis = parseReviewAnalysisJson(normalized, dataset());

  assert.deepEqual(analysis.findings.map((finding) => finding.id), ["first"]);
  assert.deepEqual(analysis.chapters[0]?.findingIds, ["first"]);
});

test("validation decisions drop and adjust candidate findings", () => {
  const analysis = parseReviewAnalysisJson(normalizeChapterReviewJson(JSON.stringify({
    findings: [
      {
        id: "drop-me",
        kind: "question",
        severity: "medium",
        confidence: "low",
        title: "Speculative",
        explanation: "Maybe bad.",
        suggestedComment: "Maybe bad?",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 }],
        status: "new",
      },
      {
        id: "adjust-me",
        kind: "bug",
        severity: "high",
        confidence: "medium",
        title: "Old title",
        explanation: "Old explanation.",
        suggestedComment: "Old comment.",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 3 }],
        status: "new",
      },
    ],
  }), chapter()), dataset());
  const decisions = normalizeValidationDecisionsJson(JSON.stringify({
    decisions: [
      { id: "drop-me", action: "drop", reason: "Speculative." },
      { id: "adjust-me", action: "adjust", reason: "Too severe.", severity: "medium", confidence: "high", title: "New title" },
      { id: "invented", action: "keep", reason: "Ignore." },
    ],
  }), new Set(analysis.findings.map((finding) => finding.id)));

  const validated = applyValidationDecisions(analysis, decisions);

  assert.deepEqual(validated.findings.map((finding) => finding.id), ["adjust-me"]);
  assert.equal(validated.findings[0]?.severity, "medium");
  assert.equal(validated.findings[0]?.confidence, "high");
  assert.equal(validated.findings[0]?.title, "New title");
  assert.deepEqual(validated.chapters[0]?.findingIds, ["adjust-me"]);
  assert.deepEqual(validated.approvalPacket.unresolvedFindings, ["adjust-me"]);
  assert.equal(validated.approvalPacket.suggestedVerdict, "comment");
});

test("validation decisions reset request-changes verdict when all findings are dropped", () => {
  const analysis = parseReviewAnalysisJson(normalizeChapterReviewJson(JSON.stringify({
    findings: [{
      id: "drop-high",
      kind: "bug",
      severity: "high",
      confidence: "high",
      title: "High candidate",
      explanation: "High issue.",
      suggestedComment: "High comment.",
      locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 }],
      status: "new",
    }],
  }), chapter()), dataset());
  const withRequestChanges = {
    ...analysis,
    approvalPacket: {
      ...analysis.approvalPacket,
      suggestedVerdict: "request-changes" as const,
    },
  };

  const validated = applyValidationDecisions(withRequestChanges, [{ id: "drop-high", action: "drop", reason: "Unverifiable." }]);

  assert.equal(validated.findings.length, 0);
  assert.deepEqual(validated.approvalPacket.unresolvedFindings, []);
  assert.equal(validated.approvalPacket.suggestedVerdict, "comment");
});

test("progress finding counts can be refreshed from validated chapters", () => {
  const analysis = parseReviewAnalysisJson(normalizeChapterReviewJson(JSON.stringify({
    findings: [{
      id: "kept",
      kind: "bug",
      severity: "medium",
      confidence: "high",
      title: "Kept",
      explanation: "Kept issue.",
      suggestedComment: "Kept comment.",
      locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 }],
      status: "new",
    }],
  }), chapter()), dataset());
  const progress = {
    status: "running" as const,
    phase: "validation" as const,
    message: "Validating.",
    scoutSummary: "",
    chapters: [{
      chapterId: "qa-api",
      title: "QA labeling API",
      status: "done" as const,
      message: "Done. 3 finding(s).",
      findingCount: 3,
    }],
  };

  const refreshed = refreshProgressFindingCounts(progress, analysis);

  assert.equal(refreshed.chapters[0]?.findingCount, 1);
});

test("synthesis normalization falls back for invalid packet fields", () => {
  const fallback = {
    summary: "Fallback summary.",
    reviewedChapters: ["qa-api"],
    acceptedRisks: ["Known risk."],
    unresolvedFindings: [],
    suggestedVerdict: "comment" as const,
    body: "Fallback body.",
  };

  const synthesis = normalizeSynthesisJson(JSON.stringify({
    summary: "Synthesized summary.",
    suggestedVerdict: "merge",
    acceptedRisks: [123, "Risk accepted."],
    body: "",
  }), fallback);

  assert.equal(synthesis.summary, "Synthesized summary.");
  assert.equal(synthesis.suggestedVerdict, "comment");
  assert.deepEqual(synthesis.acceptedRisks, ["Risk accepted."]);
  assert.equal(synthesis.body, "Fallback body.");
});
