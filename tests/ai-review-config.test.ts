import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadAiReviewRuntimeConfig } from "../src/ai-review-config.js";
import type { ReviewDataset } from "../src/sources/types.js";

function model(provider: string, id: string, reasoning = true): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "openai-responses",
    baseUrl: "https://example.test",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

function context(activeModel: Model<Api>, models: Model<Api>[]): ExtensionCommandContext {
  return {
    model: activeModel,
    modelRegistry: {
      getAll: () => models,
      find: (provider: string, modelId: string) => models.find((item) => item.provider === provider && item.id === modelId),
    },
  } as unknown as ExtensionCommandContext;
}

function dataset(repoRoot: string): ReviewDataset {
  return {
    repoRoot,
    workingRoot: repoRoot,
    files: [],
    analysisFileIds: [],
    commits: [],
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot,
      workingRoot: repoRoot,
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
  };
}

test("AI review config merges later partial phase config without resetting earlier defaults", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-config-"));
  const envPath = join(repoRoot, "override.json");
  const repoConfigDir = join(repoRoot, ".pi-diff-review-cockpit");
  await mkdir(repoConfigDir, { recursive: true });
  await writeFile(join(repoConfigDir, "config.json"), JSON.stringify({
    aiReview: {
      depth: "deep",
      parallelChapterReviews: 6,
      phases: {
        chapter: {
          provider: "anthropic",
          model: "reviewer",
          reasoning: "high",
        },
      },
    },
  }));
  await writeFile(envPath, JSON.stringify({
    aiReview: {
      phases: {
        chapter: {
          reasoning: "low",
        },
      },
    },
  }));

  const previousEnv = process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG;
  process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG = envPath;
  try {
    const active = model("openai", "active");
    const reviewer = model("anthropic", "reviewer");
    const config = await loadAiReviewRuntimeConfig(context(active, [active, reviewer]), dataset(repoRoot));

    assert.equal(config.public.depth, "deep");
    assert.equal(config.public.parallelChapterReviews, 6);
    assert.equal(config.public.phases.chapter.model, "anthropic/reviewer");
    assert.equal(config.public.phases.chapter.reasoning, "low");
    assert.equal(config.public.phases.validation.reasoning, "high");
  } finally {
    if (previousEnv == null) {
      delete process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG;
    } else {
      process.env.PI_DIFF_REVIEW_COCKPIT_CONFIG = previousEnv;
    }
  }
});

test("AI review config disables missing xhigh reasoning support with a warning", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-config-"));
  await writeFile(join(repoRoot, "pi-diff-review-cockpit.config.json"), JSON.stringify({
    aiReview: {
      phases: {
        validation: { reasoning: "xhigh" },
      },
    },
  }));

  const active = model("openai", "active");
  const config = await loadAiReviewRuntimeConfig(context(active, [active]), dataset(repoRoot));

  assert.equal(config.public.phases.validation.reasoning, "off");
  assert.match(config.public.warnings.join("\n"), /does not support that level/);
});
