# pi-diff-review-cockpit

`pi-diff-review-cockpit` is a review cockpit for Pi. Today it keeps the fast native diff window from `pi-diff-review` for local review. The MLP is adding source adapters, AI-generated review maps, findings triage, approval packets, and explicit GitHub PR review publishing in later tasks.

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

## Planned MLP Workflow

```text
/diff-review pr https://github.com/owner/repo/pull/123
```

`/diff-review pr <url>` is planned for the cockpit MLP. Later tasks will add the isolated review worktree, GitHub PR metadata loading, Review Map, Findings Inbox, and explicit GitHub review publishing flow.

## Planned GitHub Publish Policy

The planned cockpit workflow reads PR metadata and existing comments when GitHub access is available. It will not post comments, approvals, or change requests automatically. Publishing selected comments as a GitHub review will require a human click in the review window.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- `gh` authenticated for private GitHub PRs in the planned cockpit workflow
- internet access for the Tailwind and Monaco CDNs used by the review window
