import assert from "node:assert/strict";
import test from "node:test";
import { buildGitHubReviewPayload, countSkippedGitHubReviewComments } from "../src/github-publish.js";
import type { ReviewSubmitPayload } from "../src/types.js";

const filePathById = new Map([["file-1", "src/app/api/qa_api.py"]]);
const commentableLinesByFileId = new Map([[
  "file-1",
  {
    original: [{ start: 10, end: 12 }],
    modified: [{ start: 40, end: 45 }],
  },
]]);

function payload(): ReviewSubmitPayload {
  return {
    type: "submit",
    overallComment: "Looks good with one note.",
    comments: [{
      id: "c1",
      fileId: "file-1",
      scope: "git-diff",
      side: "modified",
      startLine: 42,
      endLine: null,
      body: "Please add a regression test here.",
    }],
    acceptedFindings: [{ findingId: "f1", body: "This migration needs a rollback note." }],
    findingStatuses: [{ findingId: "f1", status: "accepted-comment" }],
    approvalPacket: {
      summary: "Summary",
      reviewedChapters: [],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "Approval packet body",
    },
  };
}

function buildOptions(submit: ReviewSubmitPayload, event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE" = "COMMENT") {
  return {
    event,
    body: "Review body",
    submit,
    filePathById,
    commentableLinesByFileId,
  };
}

test("builds github review payload with explicit event", () => {
  const result = buildGitHubReviewPayload({
    ...buildOptions(payload()),
    event: "COMMENT",
  });

  assert.equal(result.event, "COMMENT");
  assert.deepEqual(Object.keys(result).sort(), ["body", "comments", "event"]);
  assert.equal(result.body, "Review body\n\n## Accepted AI findings\n\n1. This migration needs a rollback note.");
  assert.deepEqual(result.comments, [{
    path: "src/app/api/qa_api.py",
    body: "Please add a regression test here.",
    side: "RIGHT",
    line: 42,
  }]);
});

test("publishes valid modified git-diff line inside commentable range", () => {
  const submit = payload();
  submit.comments = [{
    id: "modified",
    fileId: "file-1",
    scope: "git-diff",
    side: "modified",
    startLine: 44,
    endLine: null,
    body: "Modified line note.",
  }];

  const options = buildOptions(submit);
  const result = buildGitHubReviewPayload(options);

  assert.equal(countSkippedGitHubReviewComments(options), 0);
  assert.deepEqual(result.comments, [{
    path: "src/app/api/qa_api.py",
    body: "Modified line note.",
    side: "RIGHT",
    line: 44,
  }]);
});

test("skips and counts modified git-diff line outside commentable range", () => {
  const submit = payload();
  submit.comments = [{
    id: "outside-range",
    fileId: "file-1",
    scope: "git-diff",
    side: "modified",
    startLine: 46,
    endLine: null,
    body: "Outside range note.",
  }];
  const options = buildOptions(submit);

  const result = buildGitHubReviewPayload(options);

  assert.equal(countSkippedGitHubReviewComments(options), 1);
  assert.deepEqual(result.comments, []);
});

test("skips unresolved, file-level, and no-line comments", () => {
  const submit = payload();
  submit.comments = [
    {
      id: "file-level",
      fileId: "file-1",
      scope: "git-diff",
      side: "file",
      startLine: null,
      endLine: null,
      body: "Whole-file note.",
    },
    {
      id: "no-line",
      fileId: "file-1",
      scope: "git-diff",
      side: "modified",
      startLine: null,
      endLine: null,
      body: "No line note.",
    },
    {
      id: "missing-path",
      fileId: "missing",
      scope: "git-diff",
      side: "modified",
      startLine: 12,
      endLine: null,
      body: "Missing path note.",
    },
  ];

  const options = buildOptions(submit, "REQUEST_CHANGES");
  const result = buildGitHubReviewPayload(options);

  assert.equal(countSkippedGitHubReviewComments(options), 3);
  assert.deepEqual(result.comments, []);
});

test("skips comments outside git diff scope", () => {
  const submit = payload();
  submit.comments = [
    {
      id: "last-commit",
      fileId: "file-1",
      scope: "last-commit",
      side: "modified",
      startLine: 42,
      endLine: null,
      body: "Last commit note.",
    },
    {
      id: "commit",
      fileId: "file-1",
      scope: "commit",
      side: "modified",
      startLine: 42,
      endLine: null,
      body: "Commit note.",
    },
    {
      id: "all-files",
      fileId: "file-1",
      scope: "all-files",
      side: "modified",
      startLine: 42,
      endLine: null,
      body: "All files note.",
    },
  ];
  const options = {
    ...buildOptions(submit),
    event: "COMMENT" as const,
  };

  const result = buildGitHubReviewPayload(options);

  assert.equal(countSkippedGitHubReviewComments(options), 3);
  assert.deepEqual(result.comments, []);
});

test("maps original range comments to left side when endpoints are commentable", () => {
  const submit = payload();
  submit.comments = [
    {
      id: "range",
      fileId: "file-1",
      scope: "git-diff",
      side: "original",
      startLine: 10,
      endLine: 12,
      body: "Original range note.",
    },
    {
      id: "outside-original-range",
      fileId: "file-1",
      scope: "git-diff",
      side: "original",
      startLine: 10,
      endLine: 13,
      body: "Outside original range note.",
    },
  ];

  const options = buildOptions(submit, "APPROVE");
  const result = buildGitHubReviewPayload(options);

  assert.equal(countSkippedGitHubReviewComments(options), 1);
  assert.deepEqual(result.comments, [{
    path: "src/app/api/qa_api.py",
    body: "Original range note.",
    side: "LEFT",
    line: 12,
    start_line: 10,
    start_side: "LEFT",
  }]);
});

test("skips git-diff comments when no commentable ranges are known for the file", () => {
  const submit = payload();
  const options = {
    ...buildOptions(submit),
    commentableLinesByFileId: new Map([["file-1", { original: [], modified: [] }]]),
  };

  const result = buildGitHubReviewPayload(options);

  assert.equal(countSkippedGitHubReviewComments(options), 1);
  assert.deepEqual(result.comments, []);
});

test("appends non-empty accepted finding bodies to review body", () => {
  const submit = payload();
  submit.acceptedFindings = [
    { findingId: "empty", body: "   " },
    { findingId: "f1", body: "This migration needs a rollback note." },
    { findingId: "f2", body: "Please document the API fallback." },
  ];

  const result = buildGitHubReviewPayload(buildOptions(submit));

  assert.equal(result.body, [
    "Review body",
    "## Accepted AI findings",
    "1. This migration needs a rollback note.",
    "2. Please document the API fallback.",
  ].join("\n\n"));
});
