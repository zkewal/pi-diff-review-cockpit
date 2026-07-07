import assert from "node:assert/strict";
import test from "node:test";
import { parseDiffReviewArgs } from "../src/command.js";

test("parses empty args as local review", () => {
  assert.deepEqual(parseDiffReviewArgs([]), { mode: "local" });
});

test("parses pr url", () => {
  assert.deepEqual(parseDiffReviewArgs(["pr", "https://github.com/headout/magellan/pull/646"]), {
    mode: "github-pr",
    url: "https://github.com/headout/magellan/pull/646",
  });
});

test("rejects pr without url", () => {
  assert.throws(() => parseDiffReviewArgs(["pr"]), /Usage: \/diff-review pr <github-pr-url>/);
});

test("rejects unknown source", () => {
  assert.throws(() => parseDiffReviewArgs(["branch", "main"]), /Unsupported diff-review source/);
});
