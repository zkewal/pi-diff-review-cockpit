import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getReviewWindowData } from "../src/git.js";

interface FakeExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function fakePi(outputs: Map<string, Partial<FakeExecResult>>): ExtensionAPI {
  return {
    exec: async (command: string, args: string[]) => {
      assert.equal(command, "git");
      const result = outputs.get(args.join("\0"));
      assert.ok(result, `unexpected git args: ${args.join(" ")}`);
      return {
        code: 0,
        stdout: "",
        stderr: "",
        ...result,
      };
    },
  } as unknown as ExtensionAPI;
}

test("attaches commentable git-diff hunk ranges to worktree comparisons", async () => {
  const outputs = new Map<string, Partial<FakeExecResult>>([
    [["rev-parse", "--show-toplevel"].join("\0"), { stdout: "/repo\n" }],
    [["rev-parse", "--verify", "HEAD"].join("\0"), { stdout: "HEAD\n" }],
    [["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"].join("\0"), {
      stdout: [
        "M\tmodified.ts",
        "A\tadded.ts",
        "D\tdeleted.ts",
        "R100\told-name.ts\trenamed.ts",
      ].join("\n"),
    }],
    [["diff", "--find-renames", "-M", "--unified=0", "--no-color", "HEAD", "--"].join("\0"), {
      stdout: [
        "diff --git a/modified.ts b/modified.ts",
        "--- a/modified.ts",
        "+++ b/modified.ts",
        "@@ -5 +5,2 @@",
        "-old",
        "+new",
        "+newer",
        "diff --git a/added.ts b/added.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/added.ts",
        "@@ -0,0 +1,3 @@",
        "+one",
        "+two",
        "+three",
        "diff --git a/deleted.ts b/deleted.ts",
        "deleted file mode 100644",
        "--- a/deleted.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
        "diff --git a/old-name.ts b/renamed.ts",
        "similarity index 80%",
        "rename from old-name.ts",
        "rename to renamed.ts",
        "--- a/old-name.ts",
        "+++ b/renamed.ts",
        "@@ -20 +21 @@",
        "-old",
        "+new",
      ].join("\n"),
    }],
    [["ls-files", "--others", "--exclude-standard"].join("\0"), { stdout: "" }],
    [["ls-files", "--cached"].join("\0"), { stdout: "modified.ts\nadded.ts\nrenamed.ts\n" }],
    [["ls-files", "--deleted"].join("\0"), { stdout: "deleted.ts\n" }],
    [["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"].join("\0"), { stdout: "" }],
    [["log", "--max-count=50", "--format=%H%x09%h%x09%s"].join("\0"), { stdout: "" }],
  ]);

  const { files } = await getReviewWindowData(fakePi(outputs), "/repo");
  const byPath = new Map(files.map((file) => [file.path, file]));

  assert.deepEqual(byPath.get("modified.ts")?.gitDiff?.commentableOriginalLines, [{ start: 5, end: 5 }]);
  assert.deepEqual(byPath.get("modified.ts")?.gitDiff?.commentableModifiedLines, [{ start: 5, end: 6 }]);
  assert.deepEqual(byPath.get("added.ts")?.gitDiff?.commentableOriginalLines, []);
  assert.deepEqual(byPath.get("added.ts")?.gitDiff?.commentableModifiedLines, [{ start: 1, end: 3 }]);
  assert.deepEqual(byPath.get("deleted.ts")?.gitDiff?.commentableOriginalLines, [{ start: 1, end: 2 }]);
  assert.deepEqual(byPath.get("deleted.ts")?.gitDiff?.commentableModifiedLines, []);
  assert.deepEqual(byPath.get("renamed.ts")?.gitDiff?.commentableOriginalLines, [{ start: 20, end: 20 }]);
  assert.deepEqual(byPath.get("renamed.ts")?.gitDiff?.commentableModifiedLines, [{ start: 21, end: 21 }]);
});

test("index git-diff mode ignores unrelated unstaged worktree changes", async () => {
  const outputs = new Map<string, Partial<FakeExecResult>>([
    [["rev-parse", "--show-toplevel"].join("\0"), { stdout: "/repo\n" }],
    [["rev-parse", "--verify", "HEAD"].join("\0"), { stdout: "HEAD\n" }],
    [["diff", "--cached", "--find-renames", "-M", "--name-status", "HEAD", "--"].join("\0"), {
      stdout: "M\tpr-file.ts\n",
    }],
    [["diff", "--cached", "--find-renames", "-M", "--unified=0", "--no-color", "HEAD", "--"].join("\0"), {
      stdout: [
        "diff --git a/pr-file.ts b/pr-file.ts",
        "--- a/pr-file.ts",
        "+++ b/pr-file.ts",
        "@@ -10 +10,2 @@",
        "-old",
        "+new",
        "+newer",
      ].join("\n"),
    }],
    [["ls-files", "--cached"].join("\0"), { stdout: "pr-file.ts\nlarge-dirty.csv\n" }],
    [["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"].join("\0"), { stdout: "" }],
    [["log", "--max-count=50", "--format=%H%x09%h%x09%s"].join("\0"), { stdout: "" }],
  ]);

  const { files } = await getReviewWindowData(fakePi(outputs), "/repo", { gitDiffMode: "index" });
  const diffFiles = files.filter((file) => file.inGitDiff);

  assert.deepEqual(diffFiles.map((file) => file.path), ["pr-file.ts"]);
  assert.deepEqual(diffFiles[0]?.gitDiff?.commentableModifiedLines, [{ start: 10, end: 11 }]);
  assert.deepEqual(diffFiles[0]?.gitDiff?.commentableOriginalLines, [{ start: 10, end: 10 }]);
});
