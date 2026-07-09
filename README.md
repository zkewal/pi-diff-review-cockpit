# pi-diff-review-cockpit

`pi-diff-review-cockpit` is a review cockpit for Pi. It supports local working tree review and GitHub PR review with AI-generated review maps, findings triage, staged comments, and explicit GitHub review submission.

## Install

```bash
pi install git:https://github.com/zkewal/pi-diff-review-cockpit
```

For local development:

```bash
pi install /Users/kewalzanzmeria/Desktop/ho-repos/pi-diff-review-cockpit
```

To put the direct CLI on your shell `PATH` during local development:

```bash
npm install
npm link
```

Without linking, run the CLI through npm:

```bash
npm run cli -- pr https://github.com/owner/repo/pull/123
```

## Commands

From a terminal:

```bash
pi-diff-review
pi-diff-review pr https://github.com/owner/repo/pull/123
pi-diff-review --reset-review pr https://github.com/owner/repo/pull/123
pi-diff-review --repo /path/to/repo pr https://github.com/owner/repo/pull/123
```

Inside Pi:

```text
/diff-review
```

`/diff-review` preserves local review behavior for working tree diffs, last commit, commit history, and all-files snapshots.

## GitHub PR Review

```text
/diff-review pr https://github.com/owner/repo/pull/123
```

`/diff-review pr <url>` loads GitHub PR metadata, fetches private base/head review refs, and opens the cockpit review window for the PR diff without creating a detached cache worktree.

Use `--reset-review` to clear saved cockpit metadata for the selected local diff or PR before opening the review again:

```bash
pi-diff-review --reset-review pr https://github.com/owner/repo/pull/123
pi-diff-review pr https://github.com/owner/repo/pull/123 --reset-review
```

This removes the saved review map, AI findings, staged local comments, and review progress for that one review source. It does not reset Git files, branches, refs, or worktrees. `--fresh` is accepted as a short alias, but `--reset-review` is the preferred spelling.

## PI Review Configuration

AI review defaults to the active PI model, `standard` depth, three parallel chapter agents, and per-phase reasoning of scout `low`, chapter agents `medium`, validation `high`, and synthesis `high`.

Configuration is dependency-free JSON for now. The cockpit reads, in order:

- `~/.config/pi-diff-review-cockpit/config.json`
- `<repo>/.pi-diff-review-cockpit/config.json`
- `<repo>/pi-diff-review-cockpit.config.json`
- `PI_DIFF_REVIEW_COCKPIT_CONFIG=/path/to/config.json`

Later files override earlier files. Example:

```json
{
  "aiReview": {
    "depth": "deep",
    "parallelChapterReviews": 2,
    "maxFindingsPerChapter": 12,
    "skills": {
      "preset": "balanced",
      "enabled": ["correctness", "contracts", "tests", "silent-failures", "security", "comments"],
      "custom": [
        {
          "id": "team-qa",
          "title": "Team QA contracts",
          "focus": "Headout QA workflow assumptions.",
          "instructions": "Check QA label lifecycle and benchmark data compatibility before suggesting approval."
        }
      ],
      "additionalInstructions": "Prefer fewer, higher-confidence comments."
    },
    "phases": {
      "scout": { "reasoning": "medium" },
      "chapter": { "provider": "openai-codex", "model": "your-model-id", "reasoning": "high" },
      "validation": { "reasoning": "high" },
      "synthesis": { "reasoning": "high" }
    }
  }
}
```

Skill presets are `minimal`, `balanced`, `security`, and `exhaustive`. If `skills` is omitted, `balanced` is used. Unknown skills are ignored with a warning; if a config accidentally disables every skill, review falls back to `correctness`.

For a short explicit skill list, this is also accepted:

```json
{
  "aiReview": {
    "skills": ["correctness", "security", "tests"]
  }
}
```

## GitHub Publish Policy

The cockpit workflow reads PR metadata when GitHub access is available. It will not post comments, approvals, or change requests automatically. Publishing selected comments as a GitHub review requires a human click in the review window.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- `gh` authenticated for private GitHub PRs in the cockpit workflow
- internet access for the Tailwind and Monaco CDNs used by the review window
