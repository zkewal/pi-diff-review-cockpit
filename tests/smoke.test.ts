import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
};

test("package metadata is wired for local development", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageJson;

  assert.equal(packageJson.name, "pi-diff-review-cockpit");
  assert.equal(typeof packageJson.scripts?.check, "string");
  assert.equal(typeof packageJson.scripts?.test, "string");
});

test("right-panel UI avoids duplicated review text and dead progress affordances", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

  assert.equal(appJs.includes("Drafted on diff"), false);
  assert.equal(appJs.includes("Suggested comment</div>"), false);
  assert.equal(appJs.includes("Autosaves locally. Submit review includes non-empty drafts."), false);
  assert.equal(appJs.includes("Draft comments autosave locally"), false);
  assert.equal(appJs.includes("Rerun AI review"), false);
  assert.equal(appJs.includes("h-1.5 overflow-hidden rounded-full"), false);
  assert.equal(appJs.includes("No suggested comment."), false);
  assert.equal(appJs.includes("AI Suggested Draft"), true);
});

test("finding cards focus and pulse the selected inline finding", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

  assert.equal(appJs.includes("pendingFindingFocus"), true);
  assert.equal(appJs.includes("openFirstFindingLocation(finding"), true);
  assert.equal(appJs.includes("pulseInlineFinding"), true);
  assert.equal(appJs.includes("data-ai-finding-id"), true);
  assert.equal(html.includes("ai-finding-pulse"), true);
});
