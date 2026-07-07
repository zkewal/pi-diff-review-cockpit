import assert from "node:assert/strict";
import test from "node:test";
import { buildPrPrivateRefs, parseGitHubPrUrl, buildPrWorktreePath } from "../src/sources/github-pr.js";

test("parses github pull request url", () => {
  assert.deepEqual(parseGitHubPrUrl("https://github.com/headout/magellan/pull/646"), {
    owner: "headout",
    repo: "magellan",
    number: 646,
    url: "https://github.com/headout/magellan/pull/646",
  });
});

test("parses devinreview-style github path only when host is github", () => {
  assert.throws(() => parseGitHubPrUrl("https://devinreview.com/headout/magellan/pull/646"), /Expected a github.com PR URL/);
});

test("rejects malformed pull request url", () => {
  assert.throws(() => parseGitHubPrUrl("https://github.com/headout/magellan/issues/646"), /Expected URL path/);
});

test("builds safe cache worktree path", () => {
  const path = buildPrWorktreePath({ owner: "headout", repo: "magellan", number: 646, url: "https://github.com/headout/magellan/pull/646" });
  assert.match(path, /pi-diff-review-cockpit/);
  assert.match(path, /headout--magellan--pr-646$/);
  assert.equal(path.includes(".."), false);
});

test("builds safe cache worktree path for unsafe owner and repo values", () => {
  const path = buildPrWorktreePath({ owner: "../head/out", repo: "..\\magellan", number: 646, url: "https://github.com/headout/magellan/pull/646" });
  assert.match(path, /pi-diff-review-cockpit/);
  assert.equal(path.includes(".."), false);
  assert.match(path, /--head-out----magellan--pr-646$/);
});

test("builds private refs outside the origin remote tracking namespace", () => {
  const refs = buildPrPrivateRefs({ owner: "headout", repo: "magellan", number: 646, url: "https://github.com/headout/magellan/pull/646" });
  assert.match(refs.baseRef, /^refs\/pi-diff-review-cockpit/);
  assert.match(refs.headRef, /^refs\/pi-diff-review-cockpit/);
  assert.equal(refs.baseRef.includes("refs/remotes/origin"), false);
  assert.equal(refs.headRef.includes("refs/remotes/origin"), false);
});
