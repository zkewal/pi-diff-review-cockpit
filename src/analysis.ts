import type { ReviewDataset } from "./sources/types.js";
import type { ReviewAnalysis, ReviewChapter, ApprovalPacket } from "./types.js";

function chapterIdFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "changes";
}

function inferChapterTitle(path: string): string {
  if (path.includes("migration")) return "Schema and migrations";
  if (path.includes("/api/")) return "API surface";
  if (path.includes("/models/")) return "Data models";
  if (path.includes("/services/")) return "Service behavior";
  if (path.includes("/tests/") || path.startsWith("tests/")) return "Tests";
  return "Miscellaneous changes";
}

export function createFallbackAnalysis(dataset: ReviewDataset, message: string): ReviewAnalysis {
  const chaptersByTitle = new Map<string, ReviewChapter>();

  for (const file of dataset.files) {
    const title = inferChapterTitle(file.path);
    const existing = chaptersByTitle.get(title);
    if (existing) {
      existing.fileIds.push(file.id);
      continue;
    }

    chaptersByTitle.set(title, {
      id: chapterIdFromTitle(title),
      title,
      summary: `Review ${title.toLowerCase()} before marking this source complete.`,
      risk: title === "Schema and migrations" ? "high" : "medium",
      fileIds: [file.id],
      findingIds: [],
    });
  }

  const chapterTitles = [...chaptersByTitle.values()].map((chapter) => chapter.title);
  const approvalPacket: ApprovalPacket = {
    summary: `${dataset.source.label} contains ${dataset.files.length} reviewable file(s).`,
    reviewedChapters: [],
    acceptedRisks: [],
    unresolvedFindings: [],
    suggestedVerdict: "comment",
    body: [`Reviewed ${dataset.source.label}.`, "", "Chapters:", ...chapterTitles.map((title) => `- ${title}`)].join("\n"),
  };

  return {
    status: "fallback",
    message,
    chapters: [...chaptersByTitle.values()],
    findings: [],
    approvalPacket,
  };
}
