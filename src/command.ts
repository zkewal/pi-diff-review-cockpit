export type DiffReviewCommand =
  | { mode: "local" }
  | { mode: "github-pr"; url: string };

export function parseDiffReviewArgs(args: string[]): DiffReviewCommand {
  if (args.length === 0) {
    return { mode: "local" };
  }

  const [source, value] = args;
  if (source === "pr") {
    if (!value) {
      throw new Error("Usage: /diff-review pr <github-pr-url>");
    }
    return { mode: "github-pr", url: value };
  }

  throw new Error(`Unsupported diff-review source "${source}". Use /diff-review or /diff-review pr <github-pr-url>.`);
}
