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
