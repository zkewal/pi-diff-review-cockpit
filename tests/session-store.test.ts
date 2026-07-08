import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFallbackAnalysis } from "../src/analysis.js";
import {
  buildReviewDiffFingerprint,
  buildReviewSessionRecord,
  resolveReviewSession,
  resetReviewSession,
} from "../src/session-store.js";
import type { ReviewDataset } from "../src/sources/types.js";

function mockPi() {
  return {
    exec: async (_command: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[2] === "HEAD") {
        return { code: 0, stdout: "base-sha\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  };
}

function dataset(paths: string[]): ReviewDataset {
  return {
    repoRoot: "/repo",
    workingRoot: "/repo",
    commits: [],
    analysisFileIds: paths,
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot: "/repo",
      workingRoot: "/repo",
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
    files: paths.map((path) => ({
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
        commentableModifiedLines: [{ start: 1, end: 2 }],
      },
      lastCommit: null,
      commitComparisons: {},
    })),
  };
}

test("diff fingerprint is stable for the same patches and changes when patches change", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const first = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:one`);
  const second = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:one`);
  const changed = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:two`);

  assert.equal(first.hash, second.hash);
  assert.notEqual(first.hash, changed.hash);
  assert.equal(first.fileCount, 1);
});

test("session resolution restores cached analysis when fingerprint matches", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const stored = buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
    snapshot: {
      analysis,
      overallComment: "remember this",
    },
  });

  const resolution = resolveReviewSession({
    stored,
    sourceKey: fingerprint.sourceKey,
    currentFingerprint: fingerprint,
    dataset: reviewDataset,
  });

  assert.equal(resolution.status, "restored");
  assert.equal(resolution.analysis?.message, "cached");
  assert.equal(resolution.snapshot?.overallComment, "remember this");
});

test("session resolution keeps saved state but invalidates analysis when fingerprint changes", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const oldFingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:old`);
  const newFingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}:new`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const stored = buildReviewSessionRecord({
    sourceKey: oldFingerprint.sourceKey,
    fingerprint: oldFingerprint,
    analysis,
    snapshot: {
      analysis,
      comments: [{
        id: "comment-1",
        fileId: "src/app/api/qa_api.py",
        scope: "git-diff",
        side: "modified",
        startLine: 1,
        endLine: 1,
        body: "keep this draft",
      }],
    },
  });

  const resolution = resolveReviewSession({
    stored,
    sourceKey: newFingerprint.sourceKey,
    currentFingerprint: newFingerprint,
    dataset: reviewDataset,
  });

  assert.equal(resolution.status, "stale");
  assert.equal(resolution.analysis, null);
  assert.equal(resolution.snapshot?.comments?.[0]?.body, "keep this draft");
});

test("session resolution refreshes a matching session with invalid cached analysis", async () => {
  const reviewDataset = dataset(["src/app/api/qa_api.py"]);
  const fingerprint = await buildReviewDiffFingerprint(mockPi() as never, reviewDataset, async (file) => `patch:${file.path}`);
  const analysis = createFallbackAnalysis(reviewDataset, "cached");
  const stored = buildReviewSessionRecord({
    sourceKey: fingerprint.sourceKey,
    fingerprint,
    analysis,
  });
  stored.snapshot.analysis = {
    ...analysis,
    chapters: [{
      ...analysis.chapters[0],
      fileIds: ["not-a-real-file"],
    }],
  };

  const resolution = resolveReviewSession({
    stored,
    sourceKey: fingerprint.sourceKey,
    currentFingerprint: fingerprint,
    dataset: reviewDataset,
  });

  assert.equal(resolution.status, "refreshed");
  assert.equal(resolution.analysis, null);
});

test("reset review session removes only the selected review metadata directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-session-"));
  const selectedPath = join(root, "reviews", "selected", "session.json");
  const siblingPath = join(root, "reviews", "sibling", "session.json");
  await mkdir(join(root, "reviews", "selected"), { recursive: true });
  await mkdir(join(root, "reviews", "sibling"), { recursive: true });
  await writeFile(selectedPath, "selected", "utf8");
  await writeFile(siblingPath, "sibling", "utf8");

  await resetReviewSession(selectedPath);

  assert.equal(existsSync(selectedPath), false);
  assert.equal(existsSync(join(root, "reviews", "selected")), false);
  assert.equal(existsSync(siblingPath), true);
});
