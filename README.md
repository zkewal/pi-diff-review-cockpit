# pi-diff-review-cockpit

`pi-diff-review-cockpit` is a review cockpit for Pi. It supports local working tree review and GitHub PR review with isolated PR worktrees, AI-generated review maps, findings triage, approval packets, and explicit GitHub review publishing.

## Install

```bash
pi install git:https://github.com/zkewal/pi-diff-review-cockpit
```

For local development:

```bash
pi install /Users/kewalzanzmeria/Desktop/ho-repos/pi-diff-review-cockpit
```

## Commands

```text
/diff-review
```

`/diff-review` preserves local review behavior for working tree diffs, last commit, commit history, and all-files snapshots.

## GitHub PR Review

```text
/diff-review pr https://github.com/owner/repo/pull/123
```

`/diff-review pr <url>` loads GitHub PR metadata, prepares an isolated review worktree under `~/.cache/pi-diff-review-cockpit/github/`, and opens the cockpit review window for the PR diff.

## GitHub Publish Policy

The cockpit workflow reads PR metadata when GitHub access is available. It will not post comments, approvals, or change requests automatically. Publishing selected comments as a GitHub review requires a human click in the review window.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- `gh` authenticated for private GitHub PRs in the cockpit workflow
- internet access for the Tailwind and Monaco CDNs used by the review window
