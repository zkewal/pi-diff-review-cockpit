const reviewData = JSON.parse(document.getElementById("diff-review-data").textContent || "{}");
const restoredSession = reviewData.session?.snapshot || {};
const restoredFindingIds = new Set((reviewData.analysis?.findings || []).map((finding) => finding.id));

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function objectOrEmpty(value) {
  return isPlainObject(value) ? value : {};
}

function booleanMapOrEmpty(value) {
  return Object.fromEntries(Object.entries(objectOrEmpty(value)).filter((entry) => typeof entry[1] === "boolean"));
}

function commentsOrEmpty(value) {
  return Array.isArray(value) ? value.filter((comment) => isPlainObject(comment) && typeof comment.id === "string") : [];
}

function activeInsightOrDefault(value) {
  if (!isPlainObject(value)) return { type: "default", id: null };
  if (!["default", "chapter", "finding"].includes(value.type)) return { type: "default", id: null };
  return {
    type: value.type,
    id: typeof value.id === "string" ? value.id : null,
  };
}

function restoredFindingStatuses() {
  const savedStatuses = objectOrEmpty(restoredSession.findingStatuses);
  return Object.fromEntries((reviewData.analysis?.findings || []).map((finding) => [
    finding.id,
    typeof savedStatuses[finding.id] === "string" ? savedStatuses[finding.id] : finding.status || "new",
  ]));
}

function restoredAcceptedFindingComments() {
  return Object.fromEntries(
    Object.entries(objectOrEmpty(restoredSession.acceptedFindingComments))
      .filter(([findingId, body]) => restoredFindingIds.has(findingId) && typeof body === "string"),
  );
}

function defaultScope() {
  if (reviewData.files.some((file) => file.inGitDiff)) return "git-diff";
  if (reviewData.files.some((file) => file.inLastCommit)) return "last-commit";
  if (reviewData.commits?.length > 0) return "commit";
  return "all-files";
}

function hasFilesForScope(scope, commitSha) {
  switch (scope) {
    case "git-diff": return reviewData.files.some((file) => file.inGitDiff);
    case "last-commit": return reviewData.files.some((file) => file.inLastCommit);
    case "commit": return !!commitSha && reviewData.files.some((file) => file.commitComparisons?.[commitSha]);
    case "all-files": return reviewData.files.some((file) => file.hasWorkingTreeFile);
    default: return false;
  }
}

const restoredCommitSha = typeof restoredSession.selectedCommitSha === "string" && reviewData.commits?.some((commit) => commit.sha === restoredSession.selectedCommitSha)
  ? restoredSession.selectedCommitSha
  : reviewData.commits?.[0]?.sha || null;
const restoredScope = typeof restoredSession.currentScope === "string" && hasFilesForScope(restoredSession.currentScope, restoredCommitSha)
  ? restoredSession.currentScope
  : defaultScope();

const state = {
  activeFileId: typeof restoredSession.activeFileId === "string" ? restoredSession.activeFileId : null,
  activeSidebarTab: ["review-map", "files", "findings"].includes(restoredSession.activeSidebarTab) ? restoredSession.activeSidebarTab : "review-map",
  currentScope: restoredScope,
  comments: commentsOrEmpty(restoredSession.comments),
  overallComment: typeof restoredSession.overallComment === "string" ? restoredSession.overallComment : "",
  hideUnchanged: typeof restoredSession.hideUnchanged === "boolean" ? restoredSession.hideUnchanged : false,
  wrapLines: typeof restoredSession.wrapLines === "boolean" ? restoredSession.wrapLines : true,
  collapsedDirs: {},
  reviewedFiles: booleanMapOrEmpty(restoredSession.reviewedFiles),
  reviewedChapters: booleanMapOrEmpty(restoredSession.reviewedChapters),
  findingStatuses: restoredFindingStatuses(),
  acceptedFindingComments: restoredAcceptedFindingComments(),
  scrollPositions: {},
  sidebarCollapsed: typeof restoredSession.sidebarCollapsed === "boolean" ? restoredSession.sidebarCollapsed : false,
  fileFilter: "",
  activeInsight: activeInsightOrDefault(restoredSession.activeInsight),
  selectedCommitSha: restoredCommitSha,
  fileContents: {},
  fileErrors: {},
  pendingRequestIds: {},
  activeDiffSide: "modified",
  activeDiffLine: null,
  pendingHunkFocus: null,
  aiReview: {
    requestId: null,
    status: "idle",
    message: "AI review has not run.",
    progress: null,
    config: reviewData.aiReviewConfig || null,
  },
};

const sidebarEl = document.getElementById("sidebar");
const mainPaneEl = document.getElementById("main-pane");
const sidebarTitleEl = document.getElementById("sidebar-title");
const sidebarSearchInputEl = document.getElementById("sidebar-search-input");
const toggleSidebarButton = document.getElementById("toggle-sidebar-button");
const tabReviewMapButton = document.getElementById("tab-review-map-button");
const tabFilesButton = document.getElementById("tab-files-button");
const tabFindingsButton = document.getElementById("tab-findings-button");
const scopeDiffButton = document.getElementById("scope-diff-button");
const scopeLastCommitButton = document.getElementById("scope-last-commit-button");
const scopeCommitButton = document.getElementById("scope-commit-button");
const scopeAllButton = document.getElementById("scope-all-button");
const scopeControlsEl = document.getElementById("scope-controls");
const commitSelectEl = document.getElementById("commit-select");
const windowTitleEl = document.getElementById("window-title");
const repoRootEl = document.getElementById("repo-root");
const fileTreeEl = document.getElementById("file-tree");
const summaryEl = document.getElementById("summary");
const currentFileLabelEl = document.getElementById("current-file-label");
const modeHintEl = document.getElementById("mode-hint");
const fileCommentsContainer = document.getElementById("file-comments-container");
const editorContainerEl = document.getElementById("editor-container");
const insightPanelEl = document.getElementById("insight-panel");
const insightPanelTitleEl = document.getElementById("insight-panel-title");
const insightContentEl = document.getElementById("insight-content");
const sourceLabelEl = document.getElementById("source-label");
const analysisStatusEl = document.getElementById("analysis-status");
const submitButton = document.getElementById("submit-button");
const autosaveStatusButton = document.getElementById("autosave-status");
const fileCommentButton = document.getElementById("file-comment-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleUnchangedButton = document.getElementById("toggle-unchanged-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");

function shortPathName(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || "repository";
}

function workflowTitleParts() {
  const github = reviewData.source?.github;
  if (github) {
    return {
      title: `PR #${github.number} review`,
      subtitle: `${github.owner}/${github.repo} · ${github.title}`,
      documentTitle: `Review PR #${github.number} · ${github.owner}/${github.repo}`,
    };
  }
  const repoName = shortPathName(reviewData.repoRoot);
  return {
    title: `${scopeLabel(defaultScope())} review`,
    subtitle: `${repoName} · ${reviewData.repoRoot || ""}`,
    documentTitle: `Diff review · ${repoName}`,
  };
}

const workflowTitle = workflowTitleParts();
repoRootEl.textContent = workflowTitle.subtitle;
windowTitleEl.textContent = workflowTitle.title;
document.title = workflowTitle.documentTitle;

let monacoApi = null;
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let originalDecorations = [];
let modifiedDecorations = [];
let originalKeyboardDecorations = [];
let modifiedKeyboardDecorations = [];
let activeViewZones = [];
let editorResizeObserver = null;
let requestSequence = 0;
let sessionSaveTimer = null;
let saveRequestSequence = 0;
let latestSaveRequestId = null;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function buildSessionSnapshot() {
  return {
    analysis: reviewData.analysis,
    overallComment: state.overallComment,
    comments: state.comments,
    acceptedFindingComments: state.acceptedFindingComments,
    findingStatuses: state.findingStatuses,
    reviewedFiles: state.reviewedFiles,
    reviewedChapters: state.reviewedChapters,
    activeFileId: state.activeFileId,
    activeSidebarTab: state.activeSidebarTab,
    currentScope: state.currentScope,
    selectedCommitSha: state.selectedCommitSha,
    activeInsight: state.activeInsight,
    hideUnchanged: state.hideUnchanged,
    wrapLines: state.wrapLines,
    sidebarCollapsed: state.sidebarCollapsed,
    updatedAt: new Date().toISOString(),
  };
}

function setAutosaveStatus(status, message, detail = "") {
  if (!autosaveStatusButton) return;
  autosaveStatusButton.textContent = message;
  autosaveStatusButton.dataset.status = status;
  autosaveStatusButton.title = detail || message;
  autosaveStatusButton.disabled = status !== "failed";
  autosaveStatusButton.className = {
    saving: "cursor-default rounded-md px-2 py-1 text-[11px] font-medium text-review-muted",
    saved: "cursor-default rounded-md px-2 py-1 text-[11px] font-medium text-[#3fb950]",
    failed: "cursor-pointer rounded-md bg-[#f85149]/10 px-2 py-1 text-[11px] font-medium text-[#ff7b72] hover:bg-[#f85149]/15",
  }[status] || "cursor-default rounded-md px-2 py-1 text-[11px] font-medium text-review-muted";
}

function saveSessionNow(options = {}) {
  if (!window.glimpse?.send) return;
  syncCommentBodiesFromDOM();
  const requestId = `save:${Date.now()}:${++saveRequestSequence}`;
  latestSaveRequestId = requestId;
  if (options.showStatus !== false) setAutosaveStatus("saving", "Saving...");
  window.glimpse.send({
    type: "save-session",
    requestId,
    snapshot: buildSessionSnapshot(),
  });
}

function scheduleSessionSave() {
  if (!window.glimpse?.send) return;
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    saveSessionNow();
  }, 500);
}

function inferLanguage(path) {
  if (!path) return "plaintext";
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt")) return "kotlin";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  return "plaintext";
}

function scopeLabel(scope) {
  switch (scope) {
    case "git-diff": return "Git diff";
    case "last-commit": return "Last commit";
    case "commit": return "Commit history";
    default: return "All files";
  }
}

function scopeHint(scope) {
  switch (scope) {
    case "git-diff":
      return "Review changed hunks. Click line numbers to draft comments.";
    case "last-commit":
      return "Review the last commit against its parent.";
    case "commit":
      return "Review the selected commit against its parent.";
    default:
      return "Review the current working tree snapshot.";
  }
}

function statusLabel(status) {
  if (!status) return "";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusBadgeClass(status) {
  switch (status) {
    case "added": return "text-[#3fb950]";
    case "deleted": return "text-[#f85149]";
    case "renamed": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function countLineRanges(ranges) {
  return (ranges || []).reduce((total, range) => total + Math.max(0, range.end - range.start + 1), 0);
}

function diffstatCountsFromComparison(comparison) {
  if (!comparison) return null;
  return {
    added: countLineRanges(comparison.commentableModifiedLines),
    deleted: countLineRanges(comparison.commentableOriginalLines),
  };
}

function addDiffstatCounts(left, right) {
  return {
    added: (left?.added || 0) + (right?.added || 0),
    deleted: (left?.deleted || 0) + (right?.deleted || 0),
  };
}

function fileDiffstatCounts(file, scope = state.currentScope) {
  return diffstatCountsFromComparison(getScopeComparison(file, scope));
}

function scopedDiffstatCounts(files, scope = state.currentScope) {
  return files.reduce((total, file) => addDiffstatCounts(total, fileDiffstatCounts(file, scope)), { added: 0, deleted: 0 });
}

function chapterDiffstatCounts(chapter) {
  return {
    added: chapterRangeLineCount(chapter, "modified"),
    deleted: chapterRangeLineCount(chapter, "original"),
  };
}

function coverageDiffstatCounts(coverage) {
  if (!coverage) return null;
  return {
    added: coverage.modifiedLineCount || 0,
    deleted: coverage.originalLineCount || 0,
  };
}

function diffstatHtml(counts, options = {}) {
  if (!counts) return "";
  const added = Math.max(0, Number(counts.added || 0));
  const deleted = Math.max(0, Number(counts.deleted || 0));
  if (!options.showZero && added === 0 && deleted === 0) return "";

  const blockCount = options.blocks || 5;
  const total = added + deleted;
  let addBlocks = 0;
  let delBlocks = 0;

  if (total > 0) {
    addBlocks = added > 0 ? Math.max(1, Math.round((added / total) * blockCount)) : 0;
    delBlocks = deleted > 0 ? Math.max(1, Math.round((deleted / total) * blockCount)) : 0;

    while (addBlocks + delBlocks > blockCount) {
      if (addBlocks >= delBlocks && addBlocks > 1) {
        addBlocks -= 1;
      } else if (delBlocks > 1) {
        delBlocks -= 1;
      } else {
        break;
      }
    }
  }

  const neutralBlocks = Math.max(0, blockCount - addBlocks - delBlocks);
  const blocks = [
    ...Array.from({ length: addBlocks }, () => "diffstat-block diffstat-block-add"),
    ...Array.from({ length: delBlocks }, () => "diffstat-block diffstat-block-del"),
    ...Array.from({ length: neutralBlocks }, () => "diffstat-block"),
  ];
  const label = `${added} additions, ${deleted} deletions`;
  const compactClass = options.compact ? " diffstat-compact" : "";

  return `
    <span class="diffstat${compactClass}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
      <span class="diffstat-counts">
        <span class="diffstat-add">+${added}</span>
        <span class="diffstat-del">-${deleted}</span>
      </span>
      <span class="diffstat-bars" aria-hidden="true">
        ${blocks.map((className) => `<span class="${className}"></span>`).join("")}
      </span>
    </span>
  `;
}

function setSummary(summary, counts = null) {
  const stats = diffstatHtml(counts, { compact: true });
  summaryEl.innerHTML = `${stats ? `${stats}<span class="mx-1 text-review-muted">•</span>` : ""}<span>${escapeHtml(summary)}</span>`;
}

function chapterRangeLineCount(chapter, side) {
  return (chapter.ranges || [])
    .filter((range) => range.side === side)
    .reduce((total, range) => total + Math.max(0, range.endLine - range.startLine + 1), 0);
}

function coverageSummaryLabel(coverage) {
  if (!coverage) return "";
  const base = `${coverage.fileCount} changed file(s)`;
  if (coverage.unmappedFileCount === 0) return `${base} • 100% covered`;
  return `${base} • ${coverage.unmappedFileCount} file(s) in Unmapped diff`;
}

function humanizeToken(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function severityTextClass(severity) {
  switch (severity) {
    case "critical":
    case "high":
      return "text-[#f85149]";
    case "medium":
      return "text-[#d29922]";
    case "low":
      return "text-[#58a6ff]";
    default:
      return "text-review-muted";
  }
}

function severityBadgeClass(severity) {
  switch (severity) {
    case "critical":
    case "high":
      return "shrink-0 whitespace-nowrap rounded bg-[#f85149]/10 px-2 py-0.5 text-[11px] font-medium text-[#ff7b72]";
    case "medium":
      return "shrink-0 whitespace-nowrap rounded bg-[#d29922]/10 px-2 py-0.5 text-[11px] font-medium text-[#e3b341]";
    case "low":
      return "shrink-0 whitespace-nowrap rounded bg-[#58a6ff]/10 px-2 py-0.5 text-[11px] font-medium text-[#79c0ff]";
    default:
      return "shrink-0 whitespace-nowrap rounded bg-[#30363d]/50 px-2 py-0.5 text-[11px] font-medium text-review-muted";
  }
}

function chapterPriorityLabel(priority) {
  switch (priority) {
    case "review-first": return "Review first";
    case "high-attention": return "High attention";
    case "low-attention": return "Low attention";
    case "reference": return "Reference";
    default: return "Standard";
  }
}

function chapterPriorityBadgeClass(priority) {
  switch (priority) {
    case "review-first":
      return "shrink-0 whitespace-nowrap rounded bg-[#8957e5]/12 px-2 py-0.5 text-[11px] font-medium text-[#d2a8ff]";
    case "high-attention":
      return "shrink-0 whitespace-nowrap rounded bg-[#d29922]/10 px-2 py-0.5 text-[11px] font-medium text-[#e3b341]";
    case "low-attention":
      return "shrink-0 whitespace-nowrap rounded bg-[#58a6ff]/10 px-2 py-0.5 text-[11px] font-medium text-[#79c0ff]";
    case "reference":
      return "shrink-0 whitespace-nowrap rounded bg-[#30363d]/50 px-2 py-0.5 text-[11px] font-medium text-review-muted";
    default:
      return "shrink-0 whitespace-nowrap rounded bg-[#238636]/10 px-2 py-0.5 text-[11px] font-medium text-[#7ee787]";
  }
}

function attentionTagsHtml(chapter) {
  return (chapter.attentionTags || [])
    .slice(0, 3)
    .map((tag) => `<span class="rounded bg-[#30363d]/45 px-1.5 py-0.5 text-[11px] font-medium text-review-muted">${escapeHtml(tag)}</span>`)
    .join("");
}

function reviewStatusBadgeClass(done) {
  return done
    ? "shrink-0 whitespace-nowrap rounded bg-[#238636]/15 px-2 py-0.5 text-[11px] font-medium text-[#3fb950]"
    : "shrink-0 whitespace-nowrap rounded bg-[#30363d]/50 px-2 py-0.5 text-[11px] font-medium text-review-muted";
}

function findingStatusLabel(status) {
  switch (status) {
    case "accepted-comment": return "Drafted";
    case "dismissed": return "Dismissed";
    case "accepted-risk": return "Accepted risk";
    default: return "Needs review";
  }
}

function findingStatusClass(status) {
  switch (status) {
    case "accepted-comment": return "text-[#3fb950]";
    case "dismissed": return "text-review-muted";
    case "accepted-risk": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function aiReviewStepClass(status) {
  switch (status) {
    case "running": return "text-[#58a6ff]";
    case "done": return "text-[#3fb950]";
    case "failed": return "text-[#f85149]";
    default: return "text-review-muted";
  }
}

function getReviewChapters() {
  return reviewData.analysis?.chapters || [];
}

function getReviewFindings() {
  return reviewData.analysis?.findings || [];
}

function getReviewFinding(findingId) {
  return getReviewFindings().find((finding) => finding.id === findingId) || null;
}

function getReviewChapter(chapterId) {
  return getReviewChapters().find((chapter) => chapter.id === chapterId) || null;
}

function getFileById(fileId) {
  return reviewData.files.find((file) => file.id === fileId) || null;
}

function isFileReviewed(fileId) {
  return state.reviewedFiles[fileId] === true;
}

function isCommentInScope(comment, scope = state.currentScope) {
  return comment.scope === scope && (comment.scope !== "commit" || comment.commitSha === state.selectedCommitSha);
}

function getDraftComments(scope = state.currentScope) {
  return state.comments.filter((comment) => isCommentInScope(comment, scope));
}

function getDraftCommentsForFile(fileId, scope = state.currentScope) {
  return state.comments.filter((comment) => comment.fileId === fileId && isCommentInScope(comment, scope));
}

function getDraftCommentsForChapter(chapter, scope = state.currentScope) {
  const fileIds = new Set(chapter.fileIds || []);
  return state.comments.filter((comment) => fileIds.has(comment.fileId) && isCommentInScope(comment, scope));
}

function findingStatusCounts() {
  return getReviewFindings().reduce((counts, finding) => {
    const status = state.findingStatuses[finding.id] || "new";
    counts.total += 1;
    if (status === "accepted-comment") counts.drafted += 1;
    else if (status === "dismissed" || status === "accepted-risk") counts.dismissed += 1;
    else counts.open += 1;
    return counts;
  }, { total: 0, open: 0, drafted: 0, dismissed: 0 });
}

function commentLocationLabel(comment) {
  if (comment.side === "file" || comment.startLine == null) return "File comment";
  const side = comment.side === "original" ? "Original" : "Modified";
  const range = comment.endLine != null && comment.endLine !== comment.startLine
    ? `${comment.startLine}-${comment.endLine}`
    : `${comment.startLine}`;
  return `${side} line ${range}`;
}

function commentSummaryHtml(comments, emptyText) {
  const visibleComments = comments.slice(0, 6);
  const hiddenCount = Math.max(0, comments.length - visibleComments.length);
  if (visibleComments.length === 0) {
    return `<div class="text-sm text-review-muted">${escapeHtml(emptyText)}</div>`;
  }
  return `
    <div class="space-y-2">
      ${visibleComments.map((comment) => {
        const file = getFileById(comment.fileId);
        const body = String(comment.body || "").trim();
        return `
          <button data-comment-jump-id="${escapeHtml(comment.id)}" class="block w-full cursor-pointer rounded-md border border-review-border bg-[#010409] p-2 text-left hover:bg-[#161b22]">
            <div class="truncate text-[11px] font-medium text-review-muted">${escapeHtml(getScopeDisplayPath(file, comment.scope))} • ${escapeHtml(commentLocationLabel(comment))}</div>
            <div class="mt-1 line-clamp-2 text-xs leading-5 text-review-text">${escapeHtml(body || "Empty draft comment")}</div>
          </button>
        `;
      }).join("")}
      ${hiddenCount > 0 ? `<div class="px-2 text-xs text-review-muted">${hiddenCount} more draft comment(s).</div>` : ""}
    </div>
  `;
}

function openDraftCommentFromSummary(commentId) {
  const comment = state.comments.find((item) => item.id === commentId);
  const file = comment ? getFileById(comment.fileId) : null;
  if (!comment || !file) return;

  saveCurrentScrollPosition();
  state.currentScope = comment.scope;
  if (comment.scope === "commit" && comment.commitSha) {
    state.selectedCommitSha = comment.commitSha;
    commitSelectEl.value = comment.commitSha;
  }
  state.activeFileId = file.id;
  if (comment.side === "original" || comment.side === "modified") {
    state.activeDiffSide = comment.side;
    state.activeDiffLine = comment.startLine;
  }
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(file.id, comment.scope);

  if (comment.side !== "file" && comment.startLine != null) {
    setTimeout(() => focusDiffLine(comment.side, comment.startLine, comment.endLine ?? comment.startLine), 50);
  }
}

function bindCommentSummaryLinks() {
  insightContentEl.querySelectorAll("[data-comment-jump-id]").forEach((button) => {
    button.addEventListener("click", () => openDraftCommentFromSummary(button.getAttribute("data-comment-jump-id")));
  });
}

function getScopedFiles() {
  switch (state.currentScope) {
    case "git-diff":
      return reviewData.files.filter((file) => file.inGitDiff);
    case "last-commit":
      return reviewData.files.filter((file) => file.inLastCommit);
    case "commit":
      return reviewData.files.filter((file) => state.selectedCommitSha && file.commitComparisons?.[state.selectedCommitSha]);
    default:
      return reviewData.files.filter((file) => file.hasWorkingTreeFile);
  }
}

function ensureActiveFileForScope() {
  const scopedFiles = getScopedFiles();
  if (scopedFiles.length === 0) {
    state.activeFileId = null;
    return;
  }
  if (scopedFiles.some((file) => file.id === state.activeFileId)) {
    return;
  }
  state.activeFileId = scopedFiles[0].id;
}

function activeFile() {
  return reviewData.files.find((file) => file.id === state.activeFileId) ?? null;
}

function getScopeComparison(file, scope = state.currentScope) {
  if (!file) return null;
  if (scope === "git-diff") return file.gitDiff;
  if (scope === "last-commit") return file.lastCommit;
  if (scope === "commit") return state.selectedCommitSha ? file.commitComparisons?.[state.selectedCommitSha] ?? null : null;
  return null;
}

function activeComparison() {
  return getScopeComparison(activeFile(), state.currentScope);
}

function activeFileShowsDiff() {
  return activeComparison() != null;
}

function getEditorForSide(side) {
  if (!diffEditor) return null;
  return side === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
}

function getFocusedDiffSide() {
  if (!diffEditor) return state.activeDiffSide;
  if (diffEditor.getOriginalEditor().hasTextFocus()) return "original";
  if (diffEditor.getModifiedEditor().hasTextFocus()) return "modified";
  return state.activeDiffSide;
}

function rangesForSide(comparison, side) {
  if (!comparison) return [];
  return side === "original"
    ? comparison.commentableOriginalLines || []
    : comparison.commentableModifiedLines || [];
}

function clampRangeToCommentable(startLine, endLine, ranges) {
  const start = Math.min(startLine, endLine);
  const end = Math.max(startLine, endLine);
  const containingRange = (ranges || []).find((range) => start >= range.start && end <= range.end);
  if (!containingRange) return null;
  return { startLine: start, endLine: end };
}

function getReviewableRangesForFile(file = activeFile()) {
  const comparison = getScopeComparison(file, state.currentScope);
  if (!comparison) return [];

  const modified = rangesForSide(comparison, "modified").map((range) => ({ ...range, side: "modified" }));
  const original = rangesForSide(comparison, "original").map((range) => ({ ...range, side: "original" }));
  const primary = modified.length > 0 ? modified : original;
  return primary.sort((a, b) => a.start - b.start);
}

function updateKeyboardLineDecoration(side, startLine, endLine = startLine) {
  if (!diffEditor || !monacoApi || startLine == null) return;
  state.activeDiffSide = side;
  state.activeDiffLine = startLine;
  const decoration = {
    range: new monacoApi.Range(startLine, 1, endLine, 1),
    options: { isWholeLine: true, className: "review-keyboard-line" },
  };

  if (side === "original") {
    originalKeyboardDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalKeyboardDecorations, [decoration]);
    modifiedKeyboardDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedKeyboardDecorations, []);
  } else {
    modifiedKeyboardDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedKeyboardDecorations, [decoration]);
    originalKeyboardDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalKeyboardDecorations, []);
  }
}

function focusDiffLine(side, line, endLine = line) {
  const editor = getEditorForSide(side);
  if (!editor || line == null) return false;
  state.activeDiffSide = side;
  state.activeDiffLine = line;
  editor.focus();
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.revealLineInCenter(line);
  updateKeyboardLineDecoration(side, line, endLine);
  return true;
}

function getCurrentDiffPosition() {
  const side = getFocusedDiffSide();
  const editor = getEditorForSide(side);
  const position = editor?.getPosition();
  return {
    side,
    line: position?.lineNumber || state.activeDiffLine || null,
  };
}

function getScopeFilePath(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.newPath || comparison?.oldPath || file?.path || "";
}

function getScopeDisplayPath(file, scope = state.currentScope) {
  const comparison = getScopeComparison(file, scope);
  return comparison?.displayPath || file?.path || "";
}

function getFileSearchPath(file) {
  return file?.path || "";
}

function getBaseName(path) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function getActiveStatus(file) {
  const comparison = getScopeComparison(file, state.currentScope);
  return comparison?.status ?? file?.worktreeStatus ?? null;
}

function normalizeQuery(query) {
  return String(query || "").trim().toLowerCase().replace(/\s+/g, "");
}

function scoreSubsequence(query, candidate) {
  if (!query) return 0;
  let queryIndex = 0;
  let score = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -2;

  for (let i = 0; i < candidate.length && queryIndex < query.length; i += 1) {
    if (candidate[i] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = i;
    score += 10;

    if (i === previousMatchIndex + 1) {
      score += 8;
    }

    const previousChar = i > 0 ? candidate[i - 1] : "";
    if (i === 0 || previousChar === "/" || previousChar === "_" || previousChar === "-" || previousChar === ".") {
      score += 12;
    }

    previousMatchIndex = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return -1;
  if (firstMatchIndex >= 0) score += Math.max(0, 20 - firstMatchIndex);
  return score;
}

function getFileSearchScore(query, file) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return 0;

  const path = getFileSearchPath(file).toLowerCase();
  const baseName = getBaseName(path);
  const pathScore = scoreSubsequence(normalizedQuery, path);
  const baseScore = scoreSubsequence(normalizedQuery, baseName);
  let score = Math.max(pathScore, baseScore >= 0 ? baseScore + 40 : -1);

  if (score < 0) return -1;
  if (baseName === normalizedQuery) score += 200;
  else if (baseName.startsWith(normalizedQuery)) score += 120;
  else if (path.includes(normalizedQuery)) score += 35;

  return score;
}

function getFilteredFiles() {
  const scopedFiles = getScopedFiles();
  const query = state.fileFilter.trim();
  if (!query) return [...scopedFiles];

  return scopedFiles
    .map((file) => ({ file, score: getFileSearchScore(query, file) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return getFileSearchPath(a.file).localeCompare(getFileSearchPath(b.file));
    })
    .map((entry) => entry.file);
}

function buildTree(files) {
  const root = { name: "", path: "", kind: "dir", children: new Map(), file: null };
  for (const file of files) {
    const path = getFileSearchPath(file);
    const parts = path.split("/");
    let node = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: currentPath,
          kind: isLeaf ? "file" : "dir",
          children: new Map(),
          file: isLeaf ? file : null,
        });
      }
      node = node.children.get(part);
      if (isLeaf) node.file = file;
    }
  }
  return root;
}

function scopeInstanceKey(scope) {
  return scope === "commit" ? `${scope}:${state.selectedCommitSha || ""}` : scope;
}

function cacheKey(scope, fileId) {
  return `${scopeInstanceKey(scope)}:${fileId}`;
}

function scrollKey(scope, fileId) {
  return `${scopeInstanceKey(scope)}:${fileId}`;
}

function saveCurrentScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  state.scrollPositions[scrollKey(state.currentScope, state.activeFileId)] = {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreFileScrollPosition() {
  if (!diffEditor || !state.activeFileId) return;
  const scrollState = state.scrollPositions[scrollKey(state.currentScope, state.activeFileId)];
  if (!scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function captureScrollState() {
  if (!diffEditor) return null;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  return {
    originalTop: originalEditor.getScrollTop(),
    originalLeft: originalEditor.getScrollLeft(),
    modifiedTop: modifiedEditor.getScrollTop(),
    modifiedLeft: modifiedEditor.getScrollLeft(),
  };
}

function restoreScrollState(scrollState) {
  if (!diffEditor || !scrollState) return;
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  originalEditor.setScrollTop(scrollState.originalTop);
  originalEditor.setScrollLeft(scrollState.originalLeft);
  modifiedEditor.setScrollTop(scrollState.modifiedTop);
  modifiedEditor.setScrollLeft(scrollState.modifiedLeft);
}

function getRequestState(fileId, scope = state.currentScope) {
  const key = cacheKey(scope, fileId);
  return {
    contents: state.fileContents[key],
    error: state.fileErrors[key],
    requestId: state.pendingRequestIds[key],
  };
}

function ensureFileLoaded(fileId, scope = state.currentScope) {
  if (!fileId) return;
  const key = cacheKey(scope, fileId);
  if (state.fileContents[key] != null) return;
  if (state.fileErrors[key] != null) return;
  if (state.pendingRequestIds[key] != null) return;

  const requestId = `request:${Date.now()}:${++requestSequence}`;
  state.pendingRequestIds[key] = requestId;
  renderTree();
  if (window.glimpse?.send) {
    window.glimpse.send({ type: "request-file", requestId, fileId, scope, commitSha: scope === "commit" ? state.selectedCommitSha : undefined });
  }
}

function openFile(fileId) {
  if (state.activeFileId === fileId) {
    ensureFileLoaded(fileId, state.currentScope);
    requestAnimationFrame(applyPendingHunkFocus);
    return;
  }
  saveCurrentScrollPosition();
  state.activeFileId = fileId;
  state.activeDiffLine = null;
  state.activeDiffSide = "modified";
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(fileId, state.currentScope);
}

function openFileWithPendingHunk(fileId, direction = 1) {
  state.pendingHunkFocus = { fileId, direction };
  openFile(fileId);
}

function getCurrentChapterIndex() {
  const chapters = getReviewChapters();
  if (chapters.length === 0) return -1;
  if (state.activeInsight.type === "chapter") {
    const index = chapters.findIndex((chapter) => chapter.id === state.activeInsight.id);
    if (index >= 0) return index;
  }
  if (state.activeFileId) {
    const index = chapters.findIndex((chapter) => (chapter.fileIds || []).includes(state.activeFileId));
    if (index >= 0) return index;
  }
  return 0;
}

function openChapterByIndex(index) {
  const chapters = getReviewChapters();
  if (chapters.length === 0) return false;
  const boundedIndex = Math.max(0, Math.min(chapters.length - 1, index));
  const chapter = chapters[boundedIndex];
  if (!chapter) return false;
  state.activeSidebarTab = "review-map";
  state.activeInsight = { type: "chapter", id: chapter.id };
  const fileId = firstExistingChapterFileId(chapter);
  if (fileId) {
    openFileWithPendingHunk(fileId, 1);
  } else {
    renderAll({ restoreFileScroll: false });
  }
  return true;
}

function moveChapter(direction) {
  const index = getCurrentChapterIndex();
  if (index < 0) return false;
  return openChapterByIndex(index + direction);
}

function getKeyboardFileList() {
  if (state.activeInsight.type === "chapter") {
    const chapter = getReviewChapter(state.activeInsight.id);
    const files = chapter ? getChapterDisplayFiles(chapter) : [];
    if (files.length > 0) return files;
  }
  const filteredFiles = getFilteredFiles();
  return filteredFiles.length > 0 ? filteredFiles : getScopedFiles();
}

function moveFile(direction) {
  const files = getKeyboardFileList();
  if (files.length === 0) return false;
  const foundIndex = files.findIndex((file) => file.id === state.activeFileId);
  const currentIndex = foundIndex >= 0 ? foundIndex : direction > 0 ? -1 : files.length;
  const nextIndex = Math.max(0, Math.min(files.length - 1, currentIndex + direction));
  const nextFile = files[nextIndex];
  if (!nextFile) return false;
  openFileWithPendingHunk(nextFile.id, direction >= 0 ? 1 : -1);
  return true;
}

function moveToAdjacentReviewFile(direction) {
  const files = getKeyboardFileList().filter((file) => getReviewableRangesForFile(file).length > 0);
  if (files.length === 0) return false;
  const currentIndex = files.findIndex((file) => file.id === state.activeFileId);
  const fallbackIndex = direction > 0 ? -1 : files.length;
  const nextIndex = Math.max(0, Math.min(files.length - 1, (currentIndex >= 0 ? currentIndex : fallbackIndex) + direction));
  const nextFile = files[nextIndex];
  if (!nextFile || nextFile.id === state.activeFileId) return false;
  openFileWithPendingHunk(nextFile.id, direction);
  return true;
}

function focusHunk(direction) {
  const file = activeFile();
  const ranges = getReviewableRangesForFile(file);
  if (ranges.length === 0) return moveToAdjacentReviewFile(direction);

  const current = getCurrentDiffPosition();
  const sameSideRanges = ranges.filter((range) => range.side === current.side);
  const candidateRanges = sameSideRanges.length > 0 ? sameSideRanges : ranges;
  const currentLine = current.line ?? (direction > 0 ? 0 : Number.POSITIVE_INFINITY);
  const target = direction > 0
    ? candidateRanges.find((range) => range.start > currentLine) || null
    : [...candidateRanges].reverse().find((range) => range.start < currentLine) || null;

  if (target) {
    focusDiffLine(target.side, target.start, target.end);
    return true;
  }

  return moveToAdjacentReviewFile(direction);
}

function applyPendingHunkFocus() {
  const pending = state.pendingHunkFocus;
  if (!pending || pending.fileId !== state.activeFileId) return;
  const ranges = getReviewableRangesForFile(activeFile());
  if (ranges.length === 0) {
    state.pendingHunkFocus = null;
    return;
  }
  const target = pending.direction < 0 ? ranges[ranges.length - 1] : ranges[0];
  state.pendingHunkFocus = null;
  if (target) focusDiffLine(target.side, target.start, target.end);
}

function renderTreeNode(node, depth) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const indentPx = 12;

  for (const child of children) {
    if (child.kind === "dir") {
      const collapsed = state.collapsedDirs[child.path] === true;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "group flex w-full items-center gap-1.5 px-2 py-1 text-left text-[13px] text-[#c9d1d9] hover:bg-[#21262d]";
      row.style.paddingLeft = `${depth * indentPx + 8}px`;
      row.innerHTML = `
        <svg class="h-4 w-4 shrink-0 text-[#8b949e] transition-transform ${collapsed ? "-rotate-90" : ""}" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.78 6.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"></path>
        </svg>
        <span class="truncate">${escapeHtml(child.name)}</span>
      `;
      row.addEventListener("click", () => {
        state.collapsedDirs[child.path] = !collapsed;
        renderTree();
      });
      fileTreeEl.appendChild(row);
      if (!collapsed) renderTreeNode(child, depth + 1);
      continue;
    }

    const file = child.file;
    const count = getDraftCommentsForFile(file.id).length;
    const reviewed = isFileReviewed(file.id);
    const requestState = getRequestState(file.id, state.currentScope);
    const loading = requestState.requestId != null && requestState.contents == null;
    const errored = requestState.error != null;
    const status = getActiveStatus(file);
    const stats = diffstatHtml(fileDiffstatCounts(file), { compact: true });
    const button = document.createElement("button");
    button.type = "button";
    if (file.id === state.activeFileId) button.setAttribute("aria-current", "true");
    button.className = [
      "group flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[13px]",
      file.id === state.activeFileId ? "bg-[#373e47] text-white" : reviewed ? "text-[#c9d1d9] hover:bg-[#21262d]" : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]",
    ].join(" ");
    button.style.paddingLeft = `${(depth * indentPx) + 26}px`;
    button.innerHTML = `
      <span class="flex min-w-0 items-center gap-1.5 truncate ${file.id === state.activeFileId ? "font-medium" : ""}">
        <span class="shrink-0 text-[10px] ${reviewed ? "text-[#3fb950]" : errored ? "text-red-400" : loading ? "text-[#58a6ff]" : "text-transparent"}">${reviewed ? "●" : errored ? "!" : loading ? "…" : "●"}</span>
        <span class="truncate">${escapeHtml(child.name)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${stats}
        ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]">${count}</span>` : ""}
        ${status ? `<span class="font-medium ${statusBadgeClass(status)}">${escapeHtml(statusLabel(status).charAt(0))}</span>` : ""}
      </span>
    `;
    button.addEventListener("click", () => openFile(file.id));
    fileTreeEl.appendChild(button);
  }
}

function renderSearchResults(files) {
  files.forEach((file) => {
    const path = getFileSearchPath(file);
    const baseName = getBaseName(path);
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const count = getDraftCommentsForFile(file.id).length;
    const reviewed = isFileReviewed(file.id);
    const requestState = getRequestState(file.id, state.currentScope);
    const loading = requestState.requestId != null && requestState.contents == null;
    const errored = requestState.error != null;
    const status = getActiveStatus(file);
    const stats = diffstatHtml(fileDiffstatCounts(file), { compact: true });
    const button = document.createElement("button");
    button.type = "button";
    if (file.id === state.activeFileId) button.setAttribute("aria-current", "true");
    button.className = [
      "group flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left",
      file.id === state.activeFileId ? "bg-[#373e47] text-white" : "text-[#c9d1d9] hover:bg-[#21262d]",
    ].join(" ");
    button.innerHTML = `
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <span class="shrink-0 text-[10px] ${reviewed ? "text-[#3fb950]" : errored ? "text-red-400" : loading ? "text-[#58a6ff]" : "text-transparent"}">${reviewed ? "●" : errored ? "!" : loading ? "…" : "●"}</span>
          <span class="truncate text-[13px] ${file.id === state.activeFileId ? "font-medium" : ""}">${escapeHtml(baseName)}</span>
        </span>
        <span class="mt-0.5 block truncate pl-[14px] text-[11px] ${file.id === state.activeFileId ? "text-[#c9d1d9]" : "text-review-muted"}">${escapeHtml(parentPath || path)}</span>
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        ${stats}
        ${count > 0 ? `<span class="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]">${count}</span>` : ""}
        ${status ? `<span class="font-medium ${statusBadgeClass(status)}">${escapeHtml(statusLabel(status).charAt(0))}</span>` : ""}
      </span>
    `;
    button.addEventListener("click", () => openFile(file.id));
    fileTreeEl.appendChild(button);
  });
}

function updateSidebarLayout() {
  const collapsed = state.sidebarCollapsed;
  sidebarEl.style.width = collapsed ? "0px" : "280px";
  sidebarEl.style.minWidth = collapsed ? "0px" : "280px";
  sidebarEl.style.flexBasis = collapsed ? "0px" : "280px";
  sidebarEl.style.borderRightWidth = collapsed ? "0px" : "1px";
  sidebarEl.style.pointerEvents = collapsed ? "none" : "auto";
  toggleSidebarButton.textContent = collapsed ? "Show plan" : "Review plan";
}

function setSidebarTab(tab) {
  state.activeSidebarTab = tab;
  renderAll({ restoreFileScroll: false });
}

function updateSidebarTabs() {
  const activeClasses = "rounded bg-[#8957e5]/15 px-2 py-1 text-[11px] font-medium text-[#d2a8ff]";
  const inactiveClasses = "rounded px-2 py-1 text-[11px] font-medium text-review-muted hover:bg-[#21262d] hover:text-review-text";
  tabReviewMapButton.className = state.activeSidebarTab === "review-map" ? activeClasses : inactiveClasses;
  tabFilesButton.className = state.activeSidebarTab === "files" ? activeClasses : inactiveClasses;
  tabFindingsButton.className = state.activeSidebarTab === "findings" ? activeClasses : inactiveClasses;
}

function updateScopeButtons() {
  scopeControlsEl.className = state.activeSidebarTab === "files"
    ? "mb-3 flex flex-wrap items-center gap-2"
    : "mb-3 hidden flex-wrap items-center gap-2";

  const counts = {
    diff: reviewData.files.filter((file) => file.inGitDiff).length,
    lastCommit: reviewData.files.filter((file) => file.inLastCommit).length,
    commit: state.selectedCommitSha ? reviewData.files.filter((file) => file.commitComparisons?.[state.selectedCommitSha]).length : 0,
    all: reviewData.files.filter((file) => file.hasWorkingTreeFile).length,
  };

  const applyButtonClasses = (button, active, disabled) => {
    button.disabled = disabled;
    button.className = disabled
      ? "cursor-default rounded-md border border-review-border bg-[#11161d] px-2.5 py-1 text-[11px] font-medium text-review-muted opacity-60"
      : active
        ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-2.5 py-1 text-[11px] font-medium text-[#3fb950] hover:bg-[#238636]/25"
        : "cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-[11px] font-medium text-review-text hover:bg-[#21262d]";
  };

  scopeDiffButton.textContent = `Git diff${counts.diff > 0 ? ` (${counts.diff})` : ""}`;
  scopeLastCommitButton.textContent = `Last commit${counts.lastCommit > 0 ? ` (${counts.lastCommit})` : ""}`;
  scopeCommitButton.textContent = `Commits${counts.commit > 0 ? ` (${counts.commit})` : ""}`;
  scopeAllButton.textContent = `All files${counts.all > 0 ? ` (${counts.all})` : ""}`;

  applyButtonClasses(scopeDiffButton, state.currentScope === "git-diff", counts.diff === 0);
  applyButtonClasses(scopeLastCommitButton, state.currentScope === "last-commit", counts.lastCommit === 0);
  applyButtonClasses(scopeCommitButton, state.currentScope === "commit", !state.selectedCommitSha || counts.commit === 0);
  applyButtonClasses(scopeAllButton, state.currentScope === "all-files", counts.all === 0);

  commitSelectEl.className = state.currentScope === "commit"
    ? "mb-3 block w-full rounded-md border border-review-border bg-review-panel px-2 py-2 text-xs text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
    : "mb-3 hidden w-full rounded-md border border-review-border bg-review-panel px-2 py-2 text-xs text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500";
}

function updateAiReviewButton() {
  const running = state.aiReview.status === "running";
  document.querySelectorAll("[data-action='run-ai-review']").forEach((button) => {
    button.disabled = running;
    button.textContent = running ? "Reviewing..." : state.aiReview.status === "done" ? "Rerun AI review" : "Run AI review";
    button.className = running
      ? "cursor-default rounded-md border border-[#8957e5]/25 bg-[#8957e5]/10 px-3 py-1.5 text-xs font-medium text-[#d2a8ff] opacity-70"
      : "cursor-pointer rounded-md border border-[#8957e5]/40 bg-[#8957e5]/15 px-3 py-1.5 text-xs font-medium text-[#d2a8ff] hover:bg-[#8957e5]/20";
  });
}

function updateToggleButtons() {
  const file = activeFile();
  const reviewed = file ? isFileReviewed(file.id) : false;
  toggleReviewedButton.textContent = reviewed ? "Reviewed" : "Mark reviewed";
  toggleReviewedButton.className = reviewed
    ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-3 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25"
    : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text hover:bg-[#21262d]";
  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? "on" : "off"}`;
  toggleUnchangedButton.textContent = state.hideUnchanged ? "Show full file" : "Show changed areas only";
  toggleUnchangedButton.style.display = activeFileShowsDiff() ? "inline-flex" : "none";
  updateScopeButtons();
  updateAiReviewButton();
  modeHintEl.textContent = scopeHint(state.currentScope);
  submitButton.disabled = state.aiReview.status === "running";
}

function findPreferredScopeForFile(file) {
  if (getScopedFiles().some((scopedFile) => scopedFile.id === file.id)) {
    return { scope: state.currentScope, commitSha: state.selectedCommitSha };
  }
  if (file.inGitDiff) return { scope: "git-diff", commitSha: state.selectedCommitSha };
  if (file.inLastCommit) return { scope: "last-commit", commitSha: state.selectedCommitSha };
  if (file.hasWorkingTreeFile) return { scope: "all-files", commitSha: state.selectedCommitSha };

  const commitSha = Object.keys(file.commitComparisons || {})[0];
  if (commitSha) return { scope: "commit", commitSha };
  return { scope: state.currentScope, commitSha: state.selectedCommitSha };
}

function openFileFromAnalysis(fileId) {
  const file = getFileById(fileId);
  if (!file) return;

  saveCurrentScrollPosition();
  const preferred = findPreferredScopeForFile(file);
  state.currentScope = preferred.scope;
  if (preferred.scope === "commit" && preferred.commitSha) {
    state.selectedCommitSha = preferred.commitSha;
    commitSelectEl.value = preferred.commitSha;
  }
  state.activeFileId = file.id;
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(file.id, state.currentScope);
}

function firstExistingChapterFileId(chapter) {
  return getChapterDisplayFiles(chapter)[0]?.id ?? null;
}

function firstExistingFindingFileId(finding) {
  return (finding.locations || [])
    .map((location) => location.fileId)
    .find((fileId) => getFileById(fileId) != null) || null;
}

function firstDraftableFindingLocation(finding) {
  for (const location of finding.locations || []) {
    if (location.line == null || location.side === "file") continue;
    const file = getFileById(location.fileId);
    const comparison = file?.gitDiff;
    if (!comparison) continue;
    const range = clampRangeToCommentable(location.line, location.line, rangesForSide(comparison, location.side));
    if (range) return location;
  }
  return null;
}

function firstLocationLabel(finding) {
  const location = (finding.locations || [])[0];
  if (!location) return "No location";
  return `${location.path}${location.line != null ? `:${location.line}` : ""}`;
}

function insightActionButtonClass(active) {
  return active
    ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-3 py-1.5 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25"
    : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1.5 text-xs font-medium text-review-text hover:bg-[#21262d]";
}

function insightNavHtml(items) {
  return `
    <div class="flex flex-wrap items-center gap-1.5 text-xs text-review-muted">
      ${items.map((item, index) => `
        ${index > 0 ? `<span class="text-review-muted">/</span>` : ""}
        ${item.id ? `
          <button data-insight-nav="${escapeHtml(item.id)}" class="cursor-pointer rounded px-1.5 py-1 text-review-muted hover:bg-[#21262d] hover:text-review-text">${escapeHtml(item.label)}</button>
        ` : `<span class="px-1.5 py-1 text-review-text">${escapeHtml(item.label)}</span>`}
      `).join("")}
    </div>
  `;
}

function bindInsightNav(chapterId = null) {
  insightContentEl.querySelector("[data-insight-nav='overview']")?.addEventListener("click", () => {
    state.activeInsight = { type: "default", id: null };
    renderTree();
  });
  insightContentEl.querySelector("[data-insight-nav='chapter']")?.addEventListener("click", () => {
    if (!chapterId) return;
    state.activeInsight = { type: "chapter", id: chapterId };
    renderTree();
  });
}

function bindAiReviewControls() {
  insightContentEl.querySelectorAll("[data-action='run-ai-review']").forEach((button) => {
    button.addEventListener("click", runAiReviewFromUi);
  });
  updateAiReviewButton();
}

function aiReviewConfigHtml(config) {
  if (!config) return "";
  const warnings = Array.isArray(config.warnings) ? config.warnings : [];
  return warnings.length > 0
    ? `<div class="relative mt-2 rounded bg-[#d29922]/10 px-2 py-1.5 text-[11px] leading-4 text-[#e3b341]">${warnings.map(escapeHtml).join("<br>")}</div>`
    : "";
}

function aiReviewPanelHtml(chapterId = null) {
  const progress = state.aiReview.progress;
  const config = progress?.config || state.aiReview.config || reviewData.aiReviewConfig || null;
  const title = chapterId ? "AI review for this area" : "AI review";
  const running = progress?.status === "running";
  if (!progress) {
    return `
      <div class="ai-review-card rounded-md border border-[#8957e5]/20 p-3" data-running="false">
        <div class="relative flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-review-muted">
            <span class="rounded bg-[#8957e5]/15 px-1.5 py-0.5 text-[#d2a8ff]">AI</span>
            <span>${title}</span>
          </div>
          <span class="text-[11px] text-review-muted">Idle</span>
        </div>
        <div class="relative mt-2 text-sm text-review-text">Ready to review changed hunks and suggest findings.</div>
        ${aiReviewConfigHtml(config)}
        <button data-action="run-ai-review" class="mt-3 cursor-pointer rounded-md border border-[#8957e5]/40 bg-[#8957e5]/15 px-3 py-1.5 text-xs font-medium text-[#d2a8ff] hover:bg-[#8957e5]/20">Run AI review</button>
      </div>
    `;
  }

  const chapters = chapterId
    ? progress.chapters.filter((chapter) => chapter.chapterId === chapterId)
    : progress.chapters;
  const visibleChapters = chapters.slice(0, chapterId ? 1 : 4);
  const hiddenCount = Math.max(0, chapters.length - visibleChapters.length);
  const completedCount = progress.chapters.filter((chapter) => chapter.status === "done").length;
  const failedCount = progress.chapters.filter((chapter) => chapter.status === "failed").length;
  const totalFindings = progress.chapters.reduce((total, chapter) => total + chapter.findingCount, 0);
  const progressPercent = progress.chapters.length === 0 ? 0 : Math.round(((completedCount + failedCount) / progress.chapters.length) * 100);
  const showChapterRows = running || failedCount > 0 || chapterId != null;

  return `
    <div class="ai-review-card rounded-md border p-3" data-running="${running ? "true" : "false"}">
      <div class="relative flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-review-muted">
          <span class="rounded bg-[#8957e5]/15 px-1.5 py-0.5 text-[#d2a8ff]">AI</span>
          <span>${title}</span>
          ${running ? `<span class="flex items-center gap-1" aria-hidden="true"><span class="ai-pulse-dot"></span><span class="ai-pulse-dot"></span><span class="ai-pulse-dot"></span></span>` : ""}
        </div>
        <span class="text-[11px] ${aiReviewStepClass(progress.status)}">${escapeHtml(humanizeToken(progress.status))}</span>
      </div>
      <div class="relative mt-2 text-sm leading-5 text-review-text">${escapeHtml(progress.message || state.aiReview.message)}</div>
      <div class="relative mt-3 h-1.5 overflow-hidden rounded-full bg-[#161b22]">
        <div class="h-full rounded-full bg-[#58a6ff]" style="width: ${progressPercent}%"></div>
      </div>
      <div class="relative mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-review-muted">
        <span>${completedCount}/${progress.chapters.length} area(s)</span>
        ${failedCount > 0 ? `<span class="text-[#f85149]">${failedCount} failed</span>` : ""}
        <span>${totalFindings} finding(s)</span>
      </div>
      ${aiReviewConfigHtml(config)}
      ${running && progress.scoutSummary ? `<div class="relative mt-2 line-clamp-2 text-xs leading-5 text-review-muted">${escapeHtml(progress.scoutSummary)}</div>` : ""}
      ${showChapterRows ? `<div class="relative mt-3 space-y-1.5">
        ${visibleChapters.map((chapter) => `
          <div class="rounded border border-review-border bg-review-panel px-2 py-1.5">
            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 truncate text-xs font-medium text-review-text">${escapeHtml(chapter.title)}</span>
              <span class="shrink-0 text-[11px] ${aiReviewStepClass(chapter.status)}">${escapeHtml(humanizeToken(chapter.status))}</span>
            </div>
            <div class="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-review-muted">
              <span class="min-w-0 truncate">${escapeHtml(chapter.message)}</span>
              <span class="shrink-0">${chapter.findingCount} finding(s)</span>
            </div>
          </div>
        `).join("")}
        ${hiddenCount > 0 ? `<div class="px-2 text-xs text-review-muted">${hiddenCount} more review area(s).</div>` : ""}
      </div>` : ""}
      <button data-action="run-ai-review" class="relative mt-3 cursor-pointer rounded-md border border-[#8957e5]/40 bg-[#8957e5]/15 px-3 py-1.5 text-xs font-medium text-[#d2a8ff] hover:bg-[#8957e5]/20">${state.aiReview.status === "done" ? "Rerun AI review" : "Run AI review"}</button>
    </div>
  `;
}

function renderDefaultInsight() {
  insightPanelTitleEl.textContent = "Review summary";
  const packet = reviewData.analysis?.approvalPacket;
  const draftComments = getDraftComments();
  const findingCounts = findingStatusCounts();
  const coverage = reviewData.analysis?.coverage;
  const coverageText = coverage ? coverageSummaryLabel(coverage) : "";
  const summary = packet?.summary || "Select a review area or run AI review to build the summary.";
  const verdict = packet?.suggestedVerdict ? humanizeToken(packet.suggestedVerdict) : "Comment";

  insightContentEl.innerHTML = `
    <div class="space-y-3">
      <div class="rounded-md bg-[#010409] p-3">
        <div class="text-base font-semibold leading-6 text-white">${escapeHtml(workflowTitle.title)}</div>
        <div class="mt-1 text-sm leading-5 text-review-text">${escapeHtml(summary)}</div>
        <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-review-muted">
          ${coverage ? diffstatHtml(coverageDiffstatCounts(coverage), { showZero: true }) : ""}
          ${coverageText ? `<span>${escapeHtml(coverageText)}</span>` : ""}
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-review-muted">
          <span>${findingCounts.total} AI finding(s)</span>
          <span>${draftComments.length} draft(s)</span>
          <span>Suggested verdict: <span class="font-medium text-review-text">${escapeHtml(verdict)}</span></span>
        </div>
      </div>
      ${aiReviewPanelHtml()}
      ${draftComments.length > 0 ? `<div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Local draft comments</div>
        <div class="mt-2">${commentSummaryHtml(draftComments, "No draft comments yet.")}</div>
        <div class="mt-2 text-xs text-review-muted">Draft comments autosave locally and are included when you submit the review.</div>
      </div>` : ""}
    </div>
  `;
  bindCommentSummaryLinks();
  bindAiReviewControls();
}

function getChapterFiles(chapter) {
  return (chapter.fileIds || []).map(getFileById).filter(Boolean);
}

function getChapterDisplayFiles(chapter) {
  const files = getChapterFiles(chapter);
  const diffFiles = files.filter((file) => file.inGitDiff);
  return diffFiles.length > 0 ? diffFiles : files;
}

function renderInsightForChapter(chapter) {
  insightPanelTitleEl.textContent = "Review area";
  const reviewed = state.reviewedChapters[chapter.id] === true;
  const files = getChapterDisplayFiles(chapter);
  const visibleFiles = files.slice(0, 60);
  const hiddenFileCount = Math.max(0, files.length - visibleFiles.length);
  const findings = (chapter.findingIds || []).map(getReviewFinding).filter(Boolean);
  const draftComments = getDraftCommentsForChapter(chapter);
  const chapterFindingCounts = findings.reduce((counts, finding) => {
    const status = state.findingStatuses[finding.id] || "new";
    if (status === "accepted-comment") counts.drafted += 1;
    else if (status === "dismissed" || status === "accepted-risk") counts.dismissed += 1;
    else counts.open += 1;
    return counts;
  }, { open: 0, drafted: 0, dismissed: 0 });

  insightContentEl.innerHTML = `
    <div class="space-y-4">
      ${insightNavHtml([{ id: "overview", label: "Review summary" }, { label: chapter.title }])}
      ${aiReviewPanelHtml(chapter.id)}
      <div>
        <div class="mb-2 flex items-center gap-2">
          <span class="${chapterPriorityBadgeClass(chapter.priority)}">${escapeHtml(chapterPriorityLabel(chapter.priority))}</span>
          <span class="${reviewStatusBadgeClass(reviewed)}">${reviewed ? "Reviewed" : "Not reviewed"}</span>
          ${attentionTagsHtml(chapter)}
        </div>
        <div class="text-base font-semibold leading-6 text-white">${escapeHtml(chapter.title)}</div>
        <div class="mt-2 text-sm leading-5 text-review-text">${escapeHtml(chapter.summary)}</div>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-review-muted">
          ${diffstatHtml(chapterDiffstatCounts(chapter), { showZero: true })}
          <span>${(chapter.fileIds || []).length} file(s)</span>
          <span>${draftComments.length} draft comment(s)</span>
          <span>${chapterFindingCounts.open} finding(s) to review</span>
        </div>
      </div>
      <button id="chapter-reviewed-toggle" class="${insightActionButtonClass(reviewed)}">${reviewed ? "Mark not reviewed" : "Mark area reviewed"}</button>
      <div>
        <div class="flex items-center justify-between gap-3">
          <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Files</div>
          <div class="text-[11px] text-review-muted">${files.length} in area</div>
        </div>
        <div class="mt-2 space-y-1">
          ${visibleFiles.length === 0 ? `<div class="text-sm text-review-muted">No files linked.</div>` : visibleFiles.map((file) => {
            const status = file.gitDiff?.status ?? file.worktreeStatus;
            const stats = diffstatHtml(diffstatCountsFromComparison(file.gitDiff), { compact: true });
            const active = file.id === state.activeFileId;
            const commentCount = getDraftCommentsForFile(file.id).length;
            return `
              <button
                data-file-id="${escapeHtml(file.id)}"
                ${active ? `aria-current="true"` : ""}
                class="block w-full rounded-md border px-2 py-1.5 text-left text-xs ${active ? "border-[#2ea043]/40 bg-[#238636]/10 text-white" : "border-transparent text-review-text hover:bg-[#21262d]"}"
              >
                <span class="flex min-w-0 items-center gap-2">
                  ${status ? `<span class="shrink-0 font-medium ${statusBadgeClass(status)}">${escapeHtml(statusLabel(status).charAt(0))}</span>` : ""}
                  <span class="min-w-0 flex-1 truncate ${active ? "font-medium" : ""}">${escapeHtml(file.path)}</span>
                  ${commentCount > 0 ? `<span class="shrink-0 rounded-full bg-[#1f2937] px-1.5 py-0.5 text-[10px] font-medium text-[#c9d1d9]">${commentCount} comment(s)</span>` : ""}
                  ${stats}
                </span>
              </button>
            `;
          }).join("")}
          ${hiddenFileCount > 0 ? `<div class="px-2 py-1 text-xs text-review-muted">${hiddenFileCount} more file(s) hidden. Use the Files tab to browse all files.</div>` : ""}
        </div>
      </div>
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Local draft comments</div>
        <div class="mt-2">${commentSummaryHtml(draftComments, "No draft comments in this area.")}</div>
      </div>
      <div>
        <div class="flex items-center justify-between gap-3">
          <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Findings</div>
          <div class="text-[11px] text-review-muted">${chapterFindingCounts.open} open • ${chapterFindingCounts.drafted} drafted • ${chapterFindingCounts.dismissed} closed</div>
        </div>
        <div class="mt-2 space-y-2">
          ${findings.length === 0 ? `<div class="text-sm text-review-muted">No AI findings linked to this area.</div>` : findings.map((finding) => `
            <button data-finding-id="${escapeHtml(finding.id)}" class="block w-full rounded-md border border-review-border bg-[#010409] p-2 text-left hover:bg-[#161b22]">
              <div class="flex items-center justify-between gap-2 text-[11px]">
                <span class="${severityTextClass(finding.severity)}">${escapeHtml(humanizeToken(finding.severity))}</span>
                <span class="${findingStatusClass(state.findingStatuses[finding.id] || "new")}">${escapeHtml(findingStatusLabel(state.findingStatuses[finding.id] || "new"))}</span>
              </div>
              <div class="mt-1 text-xs font-medium text-review-text">${escapeHtml(finding.title)}</div>
            </button>
          `).join("")}
        </div>
      </div>
    </div>
  `;

  insightContentEl.querySelector("#chapter-reviewed-toggle")?.addEventListener("click", () => {
    state.reviewedChapters[chapter.id] = !reviewed;
    state.activeInsight = { type: "chapter", id: chapter.id };
    renderTree();
  });
  bindInsightNav(chapter.id);
  bindCommentSummaryLinks();
  bindAiReviewControls();
  insightContentEl.querySelectorAll("[data-file-id]").forEach((button) => {
    button.addEventListener("click", () => openFileFromAnalysis(button.getAttribute("data-file-id")));
  });
  insightContentEl.querySelectorAll("[data-finding-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const finding = getReviewFinding(button.getAttribute("data-finding-id"));
      if (!finding) return;
      state.activeInsight = { type: "finding", id: finding.id };
      const fileId = firstExistingFindingFileId(finding);
      if (fileId) openFileFromAnalysis(fileId);
      else renderTree();
    });
  });
}

function setFindingStatus(finding, status) {
  state.findingStatuses[finding.id] = status;
  delete state.acceptedFindingComments[finding.id];
  state.activeInsight = { type: "finding", id: finding.id };
  renderTree();
}

function chapterForFinding(finding) {
  return getReviewChapters().find((chapter) => (chapter.findingIds || []).includes(finding.id)) || null;
}

function openFindingLocation(location) {
  const file = getFileById(location.fileId);
  if (!file) return;
  saveCurrentScrollPosition();
  state.currentScope = "git-diff";
  state.activeFileId = file.id;
  if (location.side === "original" || location.side === "modified") {
    state.activeDiffSide = location.side;
    state.activeDiffLine = location.line ?? null;
  }
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(file.id, state.currentScope);
  if (location.side !== "file" && location.line != null) {
    setTimeout(() => focusDiffLine(location.side, location.line, location.line), 50);
  }
}

function openFirstFindingLocation(finding) {
  const location = (finding.locations || []).find((item) => getFileById(item.fileId));
  if (location) openFindingLocation(location);
}

function renderInsightForFinding(finding) {
  insightPanelTitleEl.textContent = "Finding detail";
  const status = state.findingStatuses[finding.id] || "new";
  const canCreateDraft = firstDraftableFindingLocation(finding) != null;
  const chapter = chapterForFinding(finding);
  const isDrafted = status === "accepted-comment";

  insightContentEl.innerHTML = `
    <div class="space-y-4">
      ${insightNavHtml([
        { id: "overview", label: "Review summary" },
        ...(chapter ? [{ id: "chapter", label: chapter.title }] : []),
        { label: "Finding" },
      ])}
      <div class="rounded-md bg-[#010409] p-3">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="rounded bg-[#30363d]/50 px-2 py-0.5 text-[11px] font-medium text-review-muted">${escapeHtml(humanizeToken(finding.kind))}</span>
          <span class="${severityBadgeClass(finding.severity)}">${escapeHtml(humanizeToken(finding.severity))}</span>
          <span class="rounded bg-[#30363d]/50 px-2 py-0.5 text-[11px] font-medium text-review-muted">${escapeHtml(humanizeToken(finding.confidence))} confidence</span>
        </div>
        <div class="text-base font-semibold leading-6 text-white">${escapeHtml(finding.title)}</div>
        <div class="mt-2 text-sm leading-5 text-review-text">${escapeHtml(finding.explanation)}</div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <span class="rounded bg-[#30363d]/50 px-2 py-1 text-xs ${findingStatusClass(status)}">${escapeHtml(findingStatusLabel(status))}</span>
          ${chapter ? `<span class="rounded bg-[#30363d]/50 px-2 py-1 text-xs text-review-muted">${escapeHtml(chapter.title)}</span>` : ""}
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between gap-3">
          <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Locations</div>
          ${(finding.locations || []).length > 0 ? `<button data-finding-action="open-location" class="cursor-pointer text-[11px] font-medium text-[#58a6ff] hover:text-[#79c0ff]">Open first</button>` : ""}
        </div>
        <div class="mt-2 space-y-1">
          ${(finding.locations || []).length === 0 ? `<div class="text-sm text-review-muted">No locations linked.</div>` : finding.locations.map((location, index) => `
            <button data-location-index="${index}" class="block w-full rounded-md px-2 py-1.5 text-left text-xs text-review-text hover:bg-[#21262d]">
              <span class="block truncate">${escapeHtml(location.path)}${location.line != null ? `:${escapeHtml(location.line)}` : ""}</span>
              <span class="text-review-muted">${escapeHtml(humanizeToken(location.side))}</span>
            </button>
          `).join("")}
        </div>
      </div>
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Suggested comment</div>
        <div class="mt-2 whitespace-pre-wrap rounded-md border border-review-border bg-[#010409] p-3 text-xs leading-5 text-review-text">${escapeHtml(finding.suggestedComment || "No suggested comment.")}</div>
        ${isDrafted ? `<div class="mt-2 text-xs text-[#3fb950]">A draft comment was created in the diff and will be included when you submit the review.</div>` : ""}
      </div>
      <div class="flex flex-wrap gap-2">
        ${isDrafted
          ? `<span class="rounded-md border border-[#2ea043]/40 bg-[#238636]/10 px-3 py-1.5 text-xs font-medium text-[#3fb950]">Drafted on diff</span>`
          : canCreateDraft
            ? `<button data-finding-action="create-draft" class="${insightActionButtonClass(false)}">Draft on diff</button>`
            : `<span class="rounded-md border border-review-border bg-[#010409] px-3 py-1.5 text-xs text-review-muted">No commentable diff line</span>`}
        <button data-finding-status="${status === "dismissed" ? "new" : "dismissed"}" class="${insightActionButtonClass(status === "dismissed")}">${status === "dismissed" ? "Reopen" : "Dismiss"}</button>
      </div>
    </div>
  `;

  bindInsightNav(chapter?.id || null);
  insightContentEl.querySelectorAll("[data-location-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.getAttribute("data-location-index"));
      const location = (finding.locations || [])[index];
      if (location) openFindingLocation(location);
    });
  });
  insightContentEl.querySelector("[data-finding-action='open-location']")?.addEventListener("click", () => openFirstFindingLocation(finding));
  insightContentEl.querySelectorAll("[data-finding-status]").forEach((button) => {
    button.addEventListener("click", () => setFindingStatus(finding, button.getAttribute("data-finding-status")));
  });
  insightContentEl.querySelector("[data-finding-action='create-draft']")?.addEventListener("click", () => createFirstDraftCommentFromFinding(finding));
}

function renderInsightPanel() {
  insightPanelEl.dataset.activeInsight = state.activeInsight.type;
  if (state.activeInsight.type === "chapter") {
    const chapter = getReviewChapter(state.activeInsight.id);
    if (chapter) {
      renderInsightForChapter(chapter);
      return;
    }
  }
  if (state.activeInsight.type === "finding") {
    const finding = getReviewFinding(state.activeInsight.id);
    if (finding) {
      renderInsightForFinding(finding);
      return;
    }
  }
  renderDefaultInsight();
}

function renderReviewMap() {
  const chapters = getReviewChapters();
  if (chapters.length === 0) {
    fileTreeEl.innerHTML = `
      <div class="px-3 py-4 text-sm text-review-muted">
        No review map available.
      </div>
    `;
    return;
  }

  chapters.forEach((chapter, index) => {
    const reviewed = state.reviewedChapters[chapter.id] === true;
    const active = state.activeInsight.type === "chapter" && state.activeInsight.id === chapter.id;
    const stats = diffstatHtml(chapterDiffstatCounts(chapter), { compact: true, showZero: true });
    const draftCommentCount = getDraftCommentsForChapter(chapter).length;
    const findingCount = (chapter.findingIds || []).length;
    const previewFiles = getChapterDisplayFiles(chapter).slice(0, 2);
    const metaItems = [
      `<span>${(chapter.fileIds || []).length} file(s)</span>`,
      stats,
      draftCommentCount > 0 ? `<span>${draftCommentCount} draft(s)</span>` : "",
      findingCount > 0 ? `<span>${findingCount} finding(s)</span>` : "",
    ].filter(Boolean).join("");
    const button = document.createElement("button");
    button.type = "button";
    if (active) button.setAttribute("aria-current", "true");
    button.className = [
      "mb-2 block w-full rounded-md border px-2.5 py-2.5 text-left",
      active ? "border-[#8957e5]/70 bg-[#8957e5]/10" : "border-[#27313c] bg-[#0b1118] hover:bg-[#111923]",
    ].join(" ");
    button.innerHTML = `
      <div class="mb-1.5 flex items-start justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[#30363d]/60 text-[10px] font-semibold text-review-muted">${index + 1}</span>
          <span class="min-w-0 truncate text-sm font-semibold leading-5 text-white">${escapeHtml(chapter.title)}</span>
        </div>
        <span class="${reviewed ? reviewStatusBadgeClass(true) : chapterPriorityBadgeClass(chapter.priority)}">${reviewed ? "Reviewed" : chapterPriorityLabel(chapter.priority)}</span>
      </div>
      <div class="line-clamp-2 text-xs leading-5 text-review-muted">${escapeHtml(chapter.summary)}</div>
      ${(chapter.attentionTags || []).length > 0 ? `<div class="mt-2 flex flex-wrap items-center gap-1">${attentionTagsHtml(chapter)}</div>` : ""}
      ${previewFiles.length > 0 ? `<div class="mt-2 space-y-1">
        ${previewFiles.map((file) => `<div class="truncate text-[11px] text-review-muted">${escapeHtml(file.path)}</div>`).join("")}
      </div>` : ""}
      <div class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-review-muted">
        ${metaItems}
      </div>
    `;
    button.addEventListener("click", () => {
      state.activeInsight = { type: "chapter", id: chapter.id };
      const fileId = firstExistingChapterFileId(chapter);
      if (fileId) openFileFromAnalysis(fileId);
      else renderTree();
    });
    fileTreeEl.appendChild(button);
  });
}

function renderFindings() {
  const findings = getReviewFindings();
  if (findings.length === 0) {
    fileTreeEl.innerHTML = `
      <div class="px-3 py-4 text-sm text-review-muted">
        No AI findings for this diff.
      </div>
    `;
    return;
  }

  findings.forEach((finding) => {
    const status = state.findingStatuses[finding.id] || "new";
    const active = state.activeInsight.type === "finding" && state.activeInsight.id === finding.id;
    const button = document.createElement("button");
    button.type = "button";
    if (active) button.setAttribute("aria-current", "true");
    button.className = [
      "mb-2 block w-full rounded-md border p-3 text-left",
      active ? "border-[#2ea043]/40 bg-[#238636]/10" : "border-review-border bg-[#010409] hover:bg-[#161b22]",
    ].join(" ");
    button.innerHTML = `
      <div class="mb-2 flex items-center justify-between gap-2 text-[11px] font-medium">
        <span class="${severityTextClass(finding.severity)}">${escapeHtml(humanizeToken(finding.kind))} • ${escapeHtml(humanizeToken(finding.severity))}</span>
        <span class="${findingStatusClass(status)}">${escapeHtml(findingStatusLabel(status))}</span>
      </div>
      <div class="text-sm font-semibold leading-5 text-white">${escapeHtml(finding.title)}</div>
      <div class="mt-1 line-clamp-3 text-xs leading-5 text-review-muted">${escapeHtml(finding.explanation)}</div>
      <div class="mt-2 truncate text-[11px] text-review-muted">${escapeHtml(firstLocationLabel(finding))}</div>
    `;
    button.addEventListener("click", () => {
      state.activeInsight = { type: "finding", id: finding.id };
      const fileId = firstExistingFindingFileId(finding);
      if (fileId) openFileFromAnalysis(fileId);
      else renderTree();
    });
    fileTreeEl.appendChild(button);
  });
}

function applyEditorOptions() {
  if (!diffEditor) return;
  diffEditor.updateOptions({
    renderSideBySide: activeFileShowsDiff(),
    diffWordWrap: state.wrapLines ? "on" : "off",
    hideUnchangedRegions: {
      enabled: activeFileShowsDiff() && state.hideUnchanged,
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
  });
  diffEditor.getOriginalEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
  diffEditor.getModifiedEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
}

function renderTree() {
  ensureActiveFileForScope();
  scheduleSessionSave();
  fileTreeEl.innerHTML = "";
  updateSidebarTabs();
  sourceLabelEl.textContent = workflowTitle.title;
  analysisStatusEl.textContent = state.aiReview.status === "running"
    ? state.aiReview.message
    : state.aiReview.status === "done" || state.aiReview.status === "failed"
      ? state.aiReview.message
      : reviewData.session?.message || reviewData.analysis?.message || "";

  const scopedFiles = getScopedFiles();
  const comments = getDraftComments().length;

  if (state.activeSidebarTab === "review-map") {
    const chapters = getReviewChapters();
    const findings = getReviewFindings();
    renderReviewMap();
    sidebarTitleEl.textContent = "Review plan";
    setSummary(
      `${chapters.length} review areas • ${findings.length} findings • ${comments} drafts`,
      coverageDiffstatCounts(reviewData.analysis?.coverage),
    );
    updateToggleButtons();
    updateSidebarLayout();
    renderInsightPanel();
    return;
  }

  if (state.activeSidebarTab === "findings") {
    const findings = getReviewFindings();
    const newFindings = findings.filter((finding) => (state.findingStatuses[finding.id] || "new") === "new").length;
    renderFindings();
    sidebarTitleEl.textContent = "Findings";
    setSummary(
      `${findings.length} findings • ${newFindings} to review • ${comments} drafts`,
      coverageDiffstatCounts(reviewData.analysis?.coverage),
    );
    updateToggleButtons();
    updateSidebarLayout();
    renderInsightPanel();
    return;
  }

  const visibleFiles = getFilteredFiles();
  if (visibleFiles.length === 0) {
    const message = state.fileFilter.trim()
      ? `No files match <span class="text-review-text">${escapeHtml(state.fileFilter.trim())}</span>.`
      : `No files in <span class="text-review-text">${escapeHtml(scopeLabel(state.currentScope).toLowerCase())}</span>.`;
    fileTreeEl.innerHTML = `
      <div class="px-3 py-4 text-sm text-review-muted">
        ${message}
      </div>
    `;
  } else if (state.fileFilter.trim()) {
    renderSearchResults(visibleFiles);
  } else {
    renderTreeNode(buildTree(visibleFiles), 0);
  }

  sidebarTitleEl.textContent = scopeLabel(state.currentScope);
  const filteredSuffix = state.fileFilter.trim() ? ` • ${visibleFiles.length} shown` : "";
  setSummary(
    `${scopedFiles.length} files • ${comments} drafts${filteredSuffix}`,
    state.currentScope === "all-files" ? null : scopedDiffstatCounts(scopedFiles, state.currentScope),
  );
  updateToggleButtons();
  updateSidebarLayout();
  renderInsightPanel();
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">${escapeHtml(options.title)}</div>
      <div class="mb-4 text-sm text-review-muted">${escapeHtml(options.description)}</div>
      <textarea id="review-modal-text" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(options.initialValue ?? "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="review-modal-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="review-modal-save" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#238636] px-4 py-2 text-sm font-medium text-white hover:bg-[#2ea043]">${escapeHtml(options.saveLabel ?? "Save")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const textarea = backdrop.querySelector("#review-modal-text");
  const close = () => backdrop.remove();
  const save = () => {
    options.onSave(textarea.value.trim());
    close();
  };
  backdrop.querySelector("#review-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#review-modal-save").addEventListener("click", save);
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function suggestedGitHubReviewEvent() {
  const verdict = reviewData.analysis?.approvalPacket?.suggestedVerdict;
  if (verdict === "request-changes") return "REQUEST_CHANGES";
  if (verdict === "approve") return "APPROVE";
  return "COMMENT";
}

function showPublishGitHubModal() {
  if (state.aiReview.status === "running") return;
  syncCommentBodiesFromDOM();
  const submitPayload = buildSubmitPayload();
  const draftCount = submitPayload.comments.length;
  const findingCounts = findingStatusCounts();
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-1 text-base font-semibold text-white">Submit review</div>
      <div class="mb-4 text-sm leading-5 text-review-muted">Submit the review body with ${draftCount} draft comment(s). Submitted comments are not synced back into this window yet.</div>
      <div class="mb-4 grid grid-cols-3 gap-2">
        <div class="rounded-md border border-review-border bg-[#010409] px-3 py-2">
          <div class="text-sm font-semibold text-white">${draftCount}</div>
          <div class="text-[10px] uppercase tracking-wider text-review-muted">Draft comments</div>
        </div>
        <div class="rounded-md border border-review-border bg-[#010409] px-3 py-2">
          <div class="text-sm font-semibold text-[#58a6ff]">${findingCounts.open}</div>
          <div class="text-[10px] uppercase tracking-wider text-review-muted">Findings open</div>
        </div>
        <div class="rounded-md border border-review-border bg-[#010409] px-3 py-2">
          <div class="text-sm font-semibold text-[#3fb950]">${findingCounts.drafted}</div>
          <div class="text-[10px] uppercase tracking-wider text-review-muted">Findings drafted</div>
        </div>
      </div>
      <label class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-review-muted" for="github-review-event">Verdict</label>
      <select id="github-review-event" class="mb-4 w-full rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
        <option value="COMMENT">Comment</option>
        <option value="REQUEST_CHANGES">Request changes</option>
        <option value="APPROVE">Approve</option>
      </select>
      <label class="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-review-muted" for="github-review-body">Review body</label>
      <textarea id="github-review-body" class="scrollbar-thin min-h-40 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm leading-6 text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(reviewData.analysis?.approvalPacket?.body || "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="github-publish-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1.5 text-sm font-medium text-review-text hover:bg-[#21262d]">Back</button>
        <button id="github-publish-submit" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#1f6feb] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#388bfd]">Submit review</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const eventSelect = backdrop.querySelector("#github-review-event");
  const textarea = backdrop.querySelector("#github-review-body");
  const close = () => backdrop.remove();
  const publish = () => {
    syncCommentBodiesFromDOM();
    window.glimpse.send({
      type: "publish-github-review",
      event: eventSelect.value,
      body: textarea.value.trim(),
      submit: buildSubmitPayload(),
    });
    close();
  };

  eventSelect.value = suggestedGitHubReviewEvent();
  backdrop.querySelector("#github-publish-cancel").addEventListener("click", close);
  backdrop.querySelector("#github-publish-submit").addEventListener("click", publish);
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      publish();
    }
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function showFileCommentModal() {
  const file = activeFile();
  if (!file) return;
  showTextModal({
    title: `File comment for ${getScopeDisplayPath(file, state.currentScope)}`,
    description: `This comment applies to the whole file in ${scopeLabel(state.currentScope).toLowerCase()}.`,
    initialValue: "",
    saveLabel: "Add comment",
    onSave: (value) => {
      if (!value) return;
      state.comments.push({
        id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
        fileId: file.id,
        scope: state.currentScope,
        commitSha: state.currentScope === "commit" ? state.selectedCommitSha : undefined,
        side: "file",
        startLine: null,
        endLine: null,
        body: value,
      });
      submitButton.disabled = state.aiReview.status === "running";
      updateCommentsUI();
    },
  });
}

function layoutEditor() {
  if (!diffEditor) return;
  const width = editorContainerEl.clientWidth;
  const height = editorContainerEl.clientHeight;
  if (width <= 0 || height <= 0) return;
  diffEditor.layout({ width, height });
}

function clearViewZones() {
  if (!diffEditor || activeViewZones.length === 0) return;
  const original = diffEditor.getOriginalEditor();
  const modified = diffEditor.getModifiedEditor();
  original.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === original) accessor.removeZone(zone.id);
  });
  modified.changeViewZones((accessor) => {
    for (const zone of activeViewZones) if (zone.editor === modified) accessor.removeZone(zone.id);
  });
  activeViewZones = [];
}

function renderCommentDOM(comment, onDelete) {
  const container = document.createElement("div");
  container.className = "view-zone-container";
  const title = comment.side === "file"
    ? `File comment • ${scopeLabel(comment.scope)}`
    : `${comment.side === "original" ? "Original" : "Modified"} line ${comment.startLine} • ${scopeLabel(comment.scope)}`;

  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="text-xs font-semibold text-review-text">${escapeHtml(title)}</div>
      <span class="text-[11px] font-medium text-[#3fb950]">Autosaved draft</span>
    </div>
    <textarea data-comment-id="${escapeHtml(comment.id)}" class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave a comment"></textarea>
    <div class="mt-2 flex items-center justify-between gap-3">
      <div class="text-xs text-review-muted">Autosaves locally. Submit review includes non-empty drafts.</div>
      <button data-action="delete" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-xs font-medium text-review-muted hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400">Delete</button>
    </div>
  `;
  const textarea = container.querySelector("textarea");
  const saveDraft = () => {
    comment.body = textarea.value.trim();
    if (!comment.body) {
      onDelete();
      return;
    }
    textarea.value = comment.body;
    textarea.blur();
    if (comment.side !== "file") {
      setTimeout(() => focusDiffLine(comment.side, comment.startLine, comment.endLine ?? comment.startLine), 0);
    }
    scheduleSessionSave();
  };
  textarea.value = comment.body || "";
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
    scheduleSessionSave();
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      saveDraft();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (!textarea.value.trim()) {
        onDelete();
        return;
      }
      textarea.blur();
      if (comment.side !== "file") {
        setTimeout(() => focusDiffLine(comment.side, comment.startLine, comment.endLine ?? comment.startLine), 0);
      }
    }
  });
  container.querySelector("[data-action='delete']").addEventListener("click", onDelete);
  if (!comment.body) setTimeout(() => textarea.focus(), 50);
  return container;
}

function getInlineAiFindingEntries(file) {
  if (!file || state.currentScope !== "git-diff" || !activeFileShowsDiff()) return [];
  const entries = [];
  for (const finding of getReviewFindings()) {
    const status = state.findingStatuses[finding.id] || "new";
    if (status !== "new") continue;
    for (const location of finding.locations || []) {
      if (location.fileId !== file.id || location.line == null || location.side === "file") continue;
      const ranges = rangesForSide(activeComparison(), location.side);
      if (!clampRangeToCommentable(location.line, location.line, ranges)) continue;
      entries.push({ finding, location });
    }
  }
  return entries;
}

function createDraftCommentFromFinding(finding, location) {
  const body = (finding.suggestedComment || "").trim();
  if (!body) return;
  const file = activeFile();
  const comparison = activeComparison();
  const commentRange = file && comparison && location.fileId === file.id && state.currentScope === "git-diff" && location.line != null
    ? clampRangeToCommentable(location.line, location.line, rangesForSide(comparison, location.side))
    : null;
  if (!commentRange || location.side === "file") {
    state.activeInsight = { type: "finding", id: finding.id };
    renderTree();
    return;
  }
  const duplicate = state.comments.some((comment) =>
    comment.fileId === location.fileId &&
    comment.scope === state.currentScope &&
    comment.side === location.side &&
    comment.startLine === commentRange.startLine &&
    comment.body.trim() === body
  );
  if (!duplicate) {
    state.comments.push({
      id: `ai:${finding.id}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: location.fileId,
      scope: state.currentScope,
      commitSha: state.currentScope === "commit" ? state.selectedCommitSha : undefined,
      side: location.side,
      startLine: commentRange.startLine,
      endLine: commentRange.endLine,
      body,
    });
  }
  state.findingStatuses[finding.id] = "accepted-comment";
  delete state.acceptedFindingComments[finding.id];
  state.activeInsight = { type: "finding", id: finding.id };
  updateCommentsUI();
}

function createFirstDraftCommentFromFinding(finding) {
  const location = firstDraftableFindingLocation(finding);
  if (!location) return;
  const file = getFileById(location.fileId);
  if (!file) return;
  saveCurrentScrollPosition();
  state.currentScope = "git-diff";
  state.activeFileId = file.id;
  state.activeDiffSide = location.side;
  state.activeDiffLine = location.line;
  createDraftCommentFromFinding(finding, location);
  ensureFileLoaded(file.id, state.currentScope);
  renderAll({ restoreFileScroll: true });
}

function renderAiFindingZoneDOM(finding, location) {
  const container = document.createElement("div");
  container.className = "view-zone-container ai-finding-zone";
  container.innerHTML = `
    <div class="mb-2 flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2 text-xs font-semibold text-review-text">
        <span class="rounded bg-[#8957e5]/15 px-1.5 py-0.5 text-[10px] text-[#d2a8ff]">AI</span>
        <span class="truncate">Review item • ${escapeHtml(humanizeToken(finding.kind))}</span>
      </div>
      <span class="shrink-0 text-[11px] ${severityTextClass(finding.severity)}">${escapeHtml(humanizeToken(finding.severity))}</span>
    </div>
    <div class="text-sm font-medium leading-5 text-white">${escapeHtml(finding.title)}</div>
    <div class="mt-1 line-clamp-2 text-xs leading-5 text-review-muted">${escapeHtml(finding.explanation)}</div>
    <div class="mt-2 flex items-center justify-between gap-3">
      <div class="min-w-0 truncate text-xs text-review-muted">${escapeHtml(finding.suggestedComment || "No suggested comment.")}</div>
      <div class="flex shrink-0 items-center gap-2">
        <button data-action="open" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-xs font-medium text-review-muted hover:bg-[#21262d]">Open</button>
        <button data-action="dismiss" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-2.5 py-1 text-xs font-medium text-review-muted hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400">Dismiss</button>
        <button data-action="accept" class="cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-2.5 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25">Draft on diff</button>
      </div>
    </div>
  `;
  container.querySelector("[data-action='open']").addEventListener("click", () => {
    state.activeInsight = { type: "finding", id: finding.id };
    renderTree();
  });
  container.querySelector("[data-action='dismiss']").addEventListener("click", () => setFindingStatus(finding, "dismissed"));
  container.querySelector("[data-action='accept']").addEventListener("click", () => createDraftCommentFromFinding(finding, location));
  return container;
}

function canCommentOnSide(file, side) {
  if (!file) return false;
  const comparison = activeComparison();
  if (side === "original") {
    return comparison != null && comparison.hasOriginal;
  }
  return comparison != null ? comparison.hasModified : file.hasWorkingTreeFile;
}

function isActiveFileReady() {
  const file = activeFile();
  if (!file) return false;
  const requestState = getRequestState(file.id, state.currentScope);
  return requestState.contents != null && requestState.error == null;
}

function syncViewZones() {
  clearViewZones();
  if (!diffEditor || !isActiveFileReady()) return;
  const file = activeFile();
  if (!file) return;

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const inlineComments = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && (comment.scope !== "commit" || comment.commitSha === state.selectedCommitSha) && comment.side !== "file");

  inlineComments.forEach((item) => {
    const editor = item.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderCommentDOM(item, () => {
      state.comments = state.comments.filter((comment) => comment.id !== item.id);
      updateCommentsUI();
    });

    editor.changeViewZones((accessor) => {
      const lineCount = typeof item.body === "string" && item.body.length > 0 ? item.body.split("\n").length : 1;
      const id = accessor.addZone({
        afterLineNumber: item.startLine,
        heightInPx: Math.max(150, lineCount * 22 + 86),
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });

  getInlineAiFindingEntries(file).forEach(({ finding, location }) => {
    const editor = location.side === "original" ? originalEditor : modifiedEditor;
    const domNode = renderAiFindingZoneDOM(finding, location);
    editor.changeViewZones((accessor) => {
      const id = accessor.addZone({
        afterLineNumber: location.line,
        heightInPx: 142,
        domNode,
      });
      activeViewZones.push({ id, editor });
    });
  });
}

function updateDecorations() {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  const comments = file ? state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && (comment.scope !== "commit" || comment.commitSha === state.selectedCommitSha) && comment.side !== "file") : [];
  const originalRanges = [];
  const modifiedRanges = [];

  for (const comment of comments) {
    const range = {
      range: new monacoApi.Range(comment.startLine, 1, comment.startLine, 1),
      options: {
        isWholeLine: true,
        className: comment.side === "original" ? "review-comment-line-original" : "review-comment-line-modified",
        glyphMarginClassName: comment.side === "original" ? "review-comment-glyph-original" : "review-comment-glyph-modified",
      },
    };
    if (comment.side === "original") originalRanges.push(range);
    else modifiedRanges.push(range);
  }

  originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, originalRanges);
  modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, modifiedRanges);
}

function renderFileComments() {
  fileCommentsContainer.innerHTML = "";
  const file = activeFile();
  if (!file) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  const fileComments = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && (comment.scope !== "commit" || comment.commitSha === state.selectedCommitSha) && comment.side === "file");

  if (fileComments.length === 0) {
    fileCommentsContainer.className = "hidden overflow-hidden px-0 py-0";
    return;
  }

  fileCommentsContainer.className = "border-b border-review-border bg-[#0d1117] px-4 py-4 space-y-4";
  fileComments.forEach((comment) => {
    const dom = renderCommentDOM(comment, () => {
      state.comments = state.comments.filter((item) => item.id !== comment.id);
      updateCommentsUI();
    });
    dom.className = "rounded-lg border border-review-border bg-review-panel p-4";
    fileCommentsContainer.appendChild(dom);
  });
}

function getPlaceholderContents(file, scope) {
  const path = getScopeDisplayPath(file, scope);
  const requestState = getRequestState(file.id, scope);
  if (requestState.error) {
    const body = `Failed to load ${path}\n\n${requestState.error}`;
    return { originalContent: body, modifiedContent: body };
  }
  const body = `Loading ${path}...`;
  return { originalContent: body, modifiedContent: body };
}

function getMountedContents(file, scope = state.currentScope) {
  return getRequestState(file.id, scope).contents || getPlaceholderContents(file, scope);
}

function mountFile(options = {}) {
  if (!diffEditor || !monacoApi) return;
  const file = activeFile();
  if (!file) {
    currentFileLabelEl.textContent = "No file selected";
    clearViewZones();
    if (originalModel) originalModel.dispose();
    if (modifiedModel) modifiedModel.dispose();
    originalModel = monacoApi.editor.createModel("", "plaintext");
    modifiedModel = monacoApi.editor.createModel("", "plaintext");
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    applyEditorOptions();
    updateDecorations();
    renderFileComments();
    requestAnimationFrame(layoutEditor);
    return;
  }

  ensureFileLoaded(file.id, state.currentScope);

  const preserveScroll = options.preserveScroll === true;
  const scrollState = preserveScroll ? captureScrollState() : null;
  const language = inferLanguage(getScopeFilePath(file) || file.path);
  const contents = getMountedContents(file, state.currentScope);

  clearViewZones();
  currentFileLabelEl.innerHTML = `
    <span class="flex min-w-0 items-center gap-2">
      <span class="min-w-0 truncate">${escapeHtml(getScopeDisplayPath(file, state.currentScope))}</span>
      ${diffstatHtml(fileDiffstatCounts(file), { compact: true })}
    </span>
  `;

  if (originalModel) originalModel.dispose();
  if (modifiedModel) modifiedModel.dispose();

  originalModel = monacoApi.editor.createModel(contents.originalContent, language);
  modifiedModel = monacoApi.editor.createModel(contents.modifiedContent, language);

  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  applyEditorOptions();
  syncViewZones();
  updateDecorations();
  renderFileComments();
  requestAnimationFrame(() => {
    layoutEditor();
    if (options.restoreFileScroll) restoreFileScrollPosition();
    if (options.preserveScroll) restoreScrollState(scrollState);
    applyPendingHunkFocus();
    setTimeout(() => {
      layoutEditor();
      if (options.restoreFileScroll) restoreFileScrollPosition();
      if (options.preserveScroll) restoreScrollState(scrollState);
      applyPendingHunkFocus();
    }, 50);
  });
}

function syncCommentBodiesFromDOM() {
  const textareas = document.querySelectorAll("textarea[data-comment-id]");
  textareas.forEach((textarea) => {
    const commentId = textarea.getAttribute("data-comment-id");
    const comment = state.comments.find((item) => item.id === commentId);
    if (comment) comment.body = textarea.value;
  });
}

function updateCommentsUI() {
  renderTree();
  syncViewZones();
  updateDecorations();
  renderFileComments();
}

function renderAll(options = {}) {
  renderTree();
  submitButton.disabled = state.aiReview.status === "running";
  if (diffEditor && monacoApi) {
    mountFile(options);
    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
    });
  } else {
    renderFileComments();
  }
}

function addInlineComment(side, startLine, endLine = startLine) {
  const file = activeFile();
  if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return false;
  const ranges = rangesForSide(activeComparison(), side);
  const commentRange = clampRangeToCommentable(startLine, endLine, ranges);
  if (!commentRange) return false;

  state.comments.push({
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    fileId: file.id,
    scope: state.currentScope,
    commitSha: state.currentScope === "commit" ? state.selectedCommitSha : undefined,
    side,
    startLine: commentRange.startLine,
    endLine: commentRange.endLine,
    body: "",
  });
  updateCommentsUI();
  focusDiffLine(side, commentRange.startLine, commentRange.endLine);
  return true;
}

function addInlineCommentAtCursor() {
  const side = getFocusedDiffSide();
  const editor = getEditorForSide(side);
  if (!editor) return false;
  const selection = editor.getSelection();
  const position = editor.getPosition();
  const startLine = selection ? selection.startLineNumber : position?.lineNumber;
  const endLine = selection ? selection.endLineNumber : position?.lineNumber;
  if (!startLine || !endLine) return false;
  return addInlineComment(side, startLine, endLine);
}

function createGlyphHoverActions(editor, side) {
  let hoverDecoration = [];

  function openDraftAtLine(line) {
    addInlineComment(side, line, line);
  }

  editor.onMouseMove((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
      return;
    }

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      hoverDecoration = editor.deltaDecorations(hoverDecoration, [{
        range: new monacoApi.Range(line, 1, line, 1),
        options: { glyphMarginClassName: "review-glyph-plus" },
      }]);
    } else {
      hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
    }
  });

  editor.onMouseLeave(() => {
    hoverDecoration = editor.deltaDecorations(hoverDecoration, []);
  });

  editor.onMouseDown((event) => {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return;

    const target = event.target;
    if (target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      const line = target.position?.lineNumber;
      if (!line) return;
      openDraftAtLine(line);
    }
  });
}

window.__reviewReceive = function (message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "save-session-result") {
    if (message.requestId !== latestSaveRequestId) return;
    if (message.ok) {
      const savedAt = message.savedAt ? new Date(message.savedAt) : null;
      const detail = savedAt && !Number.isNaN(savedAt.getTime()) ? `Saved at ${savedAt.toLocaleTimeString()}` : "Saved";
      setAutosaveStatus("saved", "Saved", detail);
    } else {
      setAutosaveStatus("failed", "Save failed", message.message || "Click to retry autosave.");
    }
    return;
  }

  if (message.type === "ai-review-progress") {
    if (message.requestId !== state.aiReview.requestId) return;
    state.aiReview = {
      requestId: message.requestId,
      status: message.progress?.status || "running",
      message: message.progress?.message || "AI review is running.",
      progress: message.progress,
      config: message.progress?.config || state.aiReview.config,
    };
    renderTree();
    return;
  }

  if (message.type === "ai-review-partial-result") {
    if (message.requestId !== state.aiReview.requestId) return;
    applyAiReviewAnalysis(message.analysis);
    state.aiReview = {
      requestId: message.requestId,
      status: message.progress?.status || "running",
      message: message.progress?.message || "AI review results are streaming.",
      progress: message.progress,
      config: message.progress?.config || state.aiReview.config,
    };
    renderTree();
    syncViewZones();
    updateDecorations();
    renderFileComments();
    return;
  }

  if (message.type === "ai-review-result") {
    if (message.requestId !== state.aiReview.requestId) return;
    applyAiReviewAnalysis(message.analysis);
    state.aiReview = {
      requestId: message.requestId,
      status: message.progress?.status || "done",
      message: message.progress?.message || "AI review complete.",
      progress: message.progress,
      config: message.progress?.config || state.aiReview.config,
    };
    renderAll({ preserveScroll: true });
    return;
  }

  if (message.type === "ai-review-error") {
    if (message.requestId !== state.aiReview.requestId) return;
    state.aiReview = {
      requestId: message.requestId,
      status: "failed",
      message: message.message || "AI review failed.",
      progress: message.progress || state.aiReview.progress,
      config: message.progress?.config || state.aiReview.config,
    };
    renderTree();
    return;
  }

  const previousSelectedCommitSha = state.selectedCommitSha;
  if (message.scope === "commit" && message.commitSha) state.selectedCommitSha = message.commitSha;
  const key = cacheKey(message.scope, message.fileId);
  state.selectedCommitSha = previousSelectedCommitSha;

  if (message.type === "file-data") {
    state.fileContents[key] = {
      originalContent: message.originalContent,
      modifiedContent: message.modifiedContent,
    };
    delete state.fileErrors[key];
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope && (message.scope !== "commit" || message.commitSha === state.selectedCommitSha)) {
      mountFile({ restoreFileScroll: true });
    }
    return;
  }

  if (message.type === "file-error") {
    state.fileErrors[key] = message.message || "Unknown error";
    delete state.pendingRequestIds[key];
    renderTree();
    if (state.activeFileId === message.fileId && state.currentScope === message.scope && (message.scope !== "commit" || message.commitSha === state.selectedCommitSha)) {
      mountFile({ preserveScroll: false });
    }
  }
};

function setupMonaco() {
  window.require.config({
    paths: {
      vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs",
    },
  });

  window.require(["vs/editor/editor.main"], function () {
    monacoApi = window.monaco;

    monacoApi.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "diffEditor.insertedLineBackground": "#2ea04314",
        "diffEditor.removedLineBackground": "#f8514914",
        "diffEditor.insertedTextBackground": "#2ea04320",
        "diffEditor.removedTextBackground": "#f8514920",
      },
    });
    monacoApi.editor.setTheme("review-dark");

    diffEditor = monacoApi.editor.createDiffEditor(editorContainerEl, {
      automaticLayout: true,
      renderSideBySide: activeFileShowsDiff(),
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
      renderOverviewRuler: true,
      diffWordWrap: "on",
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 10,
      overviewRulerBorder: false,
      wordWrap: "on",
    });

    createGlyphHoverActions(diffEditor.getOriginalEditor(), "original");
    createGlyphHoverActions(diffEditor.getModifiedEditor(), "modified");
    trackEditorCursor(diffEditor.getOriginalEditor(), "original");
    trackEditorCursor(diffEditor.getModifiedEditor(), "modified");

    if (typeof ResizeObserver !== "undefined") {
      editorResizeObserver = new ResizeObserver(() => {
        layoutEditor();
      });
      editorResizeObserver.observe(editorContainerEl);
    }

    requestAnimationFrame(() => {
      layoutEditor();
      setTimeout(layoutEditor, 50);
      setTimeout(layoutEditor, 150);
    });

    mountFile();
  });
}

function populateCommitSelect() {
  commitSelectEl.innerHTML = "";
  (reviewData.commits || []).forEach((commit) => {
    const option = document.createElement("option");
    option.value = commit.sha;
    option.textContent = `${commit.shortSha} ${commit.subject}`;
    commitSelectEl.appendChild(option);
  });
  if (state.selectedCommitSha) commitSelectEl.value = state.selectedCommitSha;
}

function switchScope(scope) {
  const hasScopeFiles = {
    "git-diff": reviewData.files.some((file) => file.inGitDiff),
    "last-commit": reviewData.files.some((file) => file.inLastCommit),
    "commit": !!state.selectedCommitSha && reviewData.files.some((file) => file.commitComparisons?.[state.selectedCommitSha]),
    "all-files": reviewData.files.some((file) => file.hasWorkingTreeFile),
  };
  if (!hasScopeFiles[scope] || state.currentScope === scope) return;
  saveCurrentScrollPosition();
  state.currentScope = scope;
  renderAll({ restoreFileScroll: true });
  const file = activeFile();
  if (file) ensureFileLoaded(file.id, state.currentScope);
}

function applyAiReviewAnalysis(analysis) {
  const previousStatuses = state.findingStatuses;
  const previousAcceptedComments = state.acceptedFindingComments;
  reviewData.analysis = analysis;

  const findingIds = new Set((analysis.findings || []).map((finding) => finding.id));
  state.findingStatuses = Object.fromEntries((analysis.findings || []).map((finding) => [
    finding.id,
    previousStatuses[finding.id] || finding.status || "new",
  ]));
  state.acceptedFindingComments = Object.fromEntries(
    Object.entries(previousAcceptedComments).filter(([findingId]) => findingIds.has(findingId)),
  );

  if (state.activeInsight.type === "finding" && !findingIds.has(state.activeInsight.id)) {
    state.activeInsight = { type: "default", id: null };
  }
}

function runAiReviewFromUi() {
  if (state.aiReview.status === "running") return;
  const requestId = `ai-review:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  state.aiReview = {
    requestId,
    status: "running",
    message: "Starting AI review.",
    progress: {
      status: "running",
      phase: "scout",
      message: "Starting AI review.",
      scoutSummary: "",
      config: state.aiReview.config,
      chapters: getReviewChapters().map((chapter) => ({
        chapterId: chapter.id,
        title: chapter.title,
        status: "queued",
        message: "Queued.",
        findingCount: 0,
      })),
    },
  };
  renderTree();
  window.glimpse.send({ type: "run-ai-review", requestId });
}

function buildSubmitPayload() {
  return {
    type: "submit",
    overallComment: state.overallComment.trim(),
    comments: state.comments
      .map((comment) => ({ ...comment, body: comment.body.trim() }))
      .filter((comment) => comment.body.length > 0),
    acceptedFindings: Object.entries(state.acceptedFindingComments).map(([findingId, body]) => ({ findingId, body })),
    findingStatuses: Object.entries(state.findingStatuses).map(([findingId, status]) => ({ findingId, status })),
    approvalPacket: reviewData.analysis?.approvalPacket || {
      summary: "",
      reviewedChapters: [],
      acceptedRisks: [],
      unresolvedFindings: [],
      suggestedVerdict: "comment",
      body: "",
    },
  };
}

function finishReview() {
  if (state.aiReview.status === "running") return;
  syncCommentBodiesFromDOM();
  saveSessionNow();
  window.glimpse.send(buildSubmitPayload());
  window.glimpse.close();
}

function submitReview() {
  if (state.aiReview.status === "running") return;
  if (reviewData.source?.canPublishGitHubReview) {
    showPublishGitHubModal();
    return;
  }
  finishReview();
}

function toggleChangedAreasOnly() {
  if (!activeFileShowsDiff()) return;
  state.hideUnchanged = !state.hideUnchanged;
  applyEditorOptions();
  updateToggleButtons();
  scheduleSessionSave();
  requestAnimationFrame(layoutEditor);
}

function toggleWrapLines() {
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateToggleButtons();
  scheduleSessionSave();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
}

function toggleCurrentFileReviewed() {
  const file = activeFile();
  if (!file) return;
  state.reviewedFiles[file.id] = !isFileReviewed(file.id);
  renderTree();
}

function toggleCurrentChapterReviewed() {
  const chapters = getReviewChapters();
  const chapter = chapters[getCurrentChapterIndex()];
  if (!chapter) return;
  state.reviewedChapters[chapter.id] = !state.reviewedChapters[chapter.id];
  state.activeInsight = { type: "chapter", id: chapter.id };
  renderTree();
}

function focusSidebarPane() {
  if (state.sidebarCollapsed) {
    state.sidebarCollapsed = false;
    updateSidebarLayout();
  }
  sidebarEl.focus();
  setTimeout(() => {
    const target = fileTreeEl.querySelector("[aria-current='true'], button") || sidebarSearchInputEl;
    target?.focus();
  }, 0);
}

function focusDiffPane() {
  mainPaneEl.focus();
  const ranges = getReviewableRangesForFile(activeFile());
  if (state.activeDiffLine != null) {
    focusDiffLine(state.activeDiffSide, state.activeDiffLine);
    return;
  }
  if (ranges[0]) {
    focusDiffLine(ranges[0].side, ranges[0].start, ranges[0].end);
    return;
  }
  diffEditor?.getModifiedEditor().focus();
}

function focusInsightPane() {
  insightPanelEl.focus();
  setTimeout(() => {
    const target = insightContentEl.querySelector("[aria-current='true'], button, textarea");
    target?.focus();
  }, 0);
}

function focusFileSearch() {
  if (state.sidebarCollapsed) {
    state.sidebarCollapsed = false;
    updateSidebarLayout();
  }
  sidebarSearchInputEl.focus();
  sidebarSearchInputEl.select();
}

function trackEditorCursor(editor, side) {
  editor.onDidChangeCursorPosition((event) => {
    if (!editor.hasTextFocus()) return;
    state.activeDiffSide = side;
    state.activeDiffLine = event.position?.lineNumber ?? null;
    if (state.activeDiffLine != null) updateKeyboardLineDecoration(side, state.activeDiffLine);
  });
}

function isTextEntryTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".review-modal-card")) return true;
  if (target.matches("textarea[data-comment-id], #sidebar-search-input, input, select, [contenteditable='true']")) return true;
  return target.tagName === "TEXTAREA" && target.hasAttribute("data-comment-id");
}

function shortcutAction(id, label, shortcut, run, options = {}) {
  return {
    id,
    label,
    shortcut,
    keywords: options.keywords || "",
    enabled: options.enabled || (() => true),
    match: options.match || (() => false),
    run,
  };
}

function getKeyboardActions() {
  const key = (expected, options = {}) => (event) => {
    if (options.metaOrCtrl && !(event.metaKey || event.ctrlKey)) return false;
    if (!options.metaOrCtrl && (event.metaKey || event.ctrlKey || event.altKey)) return false;
    if (!!options.shift !== event.shiftKey) return false;
    return event.key.toLowerCase() === expected.toLowerCase();
  };

  return [
    shortcutAction("help", "Show keyboard shortcuts", "?", showKeyboardShortcutsModal, {
      keywords: "help shortcuts",
      match: (event) => !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "?",
    }),
    shortcutAction("palette", "Open command palette", "Cmd/Ctrl+K", showCommandPalette, {
      keywords: "command palette",
      match: key("k", { metaOrCtrl: true }),
    }),
    shortcutAction("run-ai-review", state.aiReview.status === "done" ? "Rerun AI review" : "Run AI review", "", runAiReviewFromUi, {
      keywords: "ai review findings",
      enabled: () => state.aiReview.status !== "running",
    }),
    shortcutAction("focus-sidebar", "Focus review map or files", "1", focusSidebarPane, { match: key("1") }),
    shortcutAction("focus-diff", "Focus diff", "2", focusDiffPane, { match: key("2") }),
    shortcutAction("focus-context", "Focus review summary", "3", focusInsightPane, { match: key("3") }),
    shortcutAction("search-files", "Search files", "/", focusFileSearch, { match: key("/") }),
    shortcutAction("next-chapter", "Next review area", "]", () => moveChapter(1), { match: key("]") }),
    shortcutAction("previous-chapter", "Previous review area", "[", () => moveChapter(-1), { match: key("[") }),
    shortcutAction("next-file", "Next file", "Shift+J", () => moveFile(1), { match: key("j", { shift: true }) }),
    shortcutAction("previous-file", "Previous file", "Shift+K", () => moveFile(-1), { match: key("k", { shift: true }) }),
    shortcutAction("next-hunk", "Next changed hunk", "J", () => focusHunk(1), { match: key("j") }),
    shortcutAction("previous-hunk", "Previous changed hunk", "K", () => focusHunk(-1), { match: key("k") }),
    shortcutAction("comment-line", "Add line comment", "C", addInlineCommentAtCursor, {
      enabled: () => activeFileShowsDiff(),
      match: key("c"),
    }),
    shortcutAction("comment-file", "Add file comment", "Shift+C", showFileCommentModal, { match: key("c", { shift: true }) }),
    shortcutAction("mark-file-reviewed", "Mark file reviewed", "R", toggleCurrentFileReviewed, { match: key("r") }),
    shortcutAction("mark-chapter-reviewed", "Mark review area reviewed", "Shift+R", toggleCurrentChapterReviewed, { match: key("r", { shift: true }) }),
    shortcutAction("toggle-changed-only", "Toggle changed areas only", "U", toggleChangedAreasOnly, {
      enabled: () => activeFileShowsDiff(),
      match: key("u"),
    }),
    shortcutAction("toggle-wrap", "Toggle line wrap", "W", toggleWrapLines, { match: key("w") }),
    shortcutAction("submit-review", "Submit review", "P", submitReview, {
      enabled: () => state.aiReview.status !== "running",
      match: key("p"),
    }),
  ];
}

function showKeyboardShortcutsModal() {
  const actions = getKeyboardActions().filter((action) => action.shortcut);
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-1 text-base font-semibold text-white">Keyboard shortcuts</div>
      <div class="mb-4 text-sm text-review-muted">Navigate the review, add comments, and mark progress without leaving the keyboard.</div>
      <div class="grid gap-2 sm:grid-cols-2">
        ${actions.map((action) => `
          <div class="flex items-center justify-between gap-4 rounded-md border border-review-border bg-[#010409] px-3 py-2">
            <span class="text-sm text-review-text">${escapeHtml(action.label)}</span>
            <kbd class="shrink-0 rounded border border-review-border bg-review-panel px-2 py-1 text-[11px] font-semibold text-review-muted">${escapeHtml(action.shortcut)}</kbd>
          </div>
        `).join("")}
      </div>
      <div class="mt-4 flex justify-end">
        <button data-action="close" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector("[data-action='close']").addEventListener("click", close);
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector("[data-action='close']").focus();
}

function showCommandPalette() {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card p-0">
      <div class="border-b border-review-border p-3">
        <input id="command-palette-input" type="text" spellcheck="false" autocomplete="off" placeholder="Run a review command" class="w-full rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none placeholder:text-review-muted focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
      </div>
      <div id="command-palette-list" class="scrollbar-thin max-h-[360px] overflow-auto p-2"></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const input = backdrop.querySelector("#command-palette-input");
  const list = backdrop.querySelector("#command-palette-list");
  let selectedIndex = 0;

  const getVisibleActions = () => {
    const query = input.value.trim().toLowerCase();
    return getKeyboardActions()
      .filter((action) => action.enabled())
      .filter((action) => {
        if (!query) return true;
        return `${action.label} ${action.shortcut} ${action.keywords}`.toLowerCase().includes(query);
      });
  };

  const runAction = (action) => {
    if (!action || !action.enabled()) return;
    backdrop.remove();
    action.run();
  };

  const render = () => {
    const actions = getVisibleActions();
    selectedIndex = Math.max(0, Math.min(selectedIndex, actions.length - 1));
    list.innerHTML = actions.length === 0
      ? `<div class="px-3 py-6 text-center text-sm text-review-muted">No matching commands.</div>`
      : actions.map((action, index) => `
        <button data-action-id="${escapeHtml(action.id)}" class="flex w-full items-center justify-between gap-4 rounded-md px-3 py-2 text-left ${index === selectedIndex ? "bg-[#238636]/15 text-white" : "text-review-text hover:bg-[#21262d]"}">
          <span class="text-sm">${escapeHtml(action.label)}</span>
          ${action.shortcut ? `<kbd class="shrink-0 rounded border border-review-border bg-review-panel px-2 py-1 text-[11px] font-semibold text-review-muted">${escapeHtml(action.shortcut)}</kbd>` : `<span class="text-[11px] text-review-muted">Palette</span>`}
        </button>
      `).join("");
    list.querySelectorAll("[data-action-id]").forEach((button) => {
      button.addEventListener("click", () => runAction(actions.find((action) => action.id === button.getAttribute("data-action-id"))));
    });
  };

  input.addEventListener("input", () => {
    selectedIndex = 0;
    render();
  });
  backdrop.addEventListener("keydown", (event) => {
    const actions = getVisibleActions();
    if (event.key === "Escape") {
      event.preventDefault();
      backdrop.remove();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = Math.min(actions.length - 1, selectedIndex + 1);
      render();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex = Math.max(0, selectedIndex - 1);
      render();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runAction(actions[selectedIndex]);
    }
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) backdrop.remove();
  });
  render();
  input.focus();
}

function handleGlobalShortcut(event) {
  if (isTextEntryTarget(event.target)) return;
  if (document.querySelector(".review-modal-backdrop")) return;
  const action = getKeyboardActions().find((candidate) => candidate.enabled() && candidate.match(event));
  if (!action) return;
  event.preventDefault();
  action.run();
}

submitButton.addEventListener("click", submitReview);

autosaveStatusButton?.addEventListener("click", () => {
  if (autosaveStatusButton.dataset.status === "failed") saveSessionNow();
});

window.addEventListener("beforeunload", () => {
  saveSessionNow({ showStatus: false });
});

fileCommentButton.addEventListener("click", () => {
  showFileCommentModal();
});

toggleUnchangedButton.addEventListener("click", toggleChangedAreasOnly);

toggleWrapButton.addEventListener("click", toggleWrapLines);

toggleReviewedButton.addEventListener("click", toggleCurrentFileReviewed);

tabReviewMapButton.addEventListener("click", () => setSidebarTab("review-map"));

tabFilesButton.addEventListener("click", () => setSidebarTab("files"));

tabFindingsButton.addEventListener("click", () => setSidebarTab("findings"));

scopeDiffButton.addEventListener("click", () => {
  switchScope("git-diff");
});

scopeLastCommitButton.addEventListener("click", () => {
  switchScope("last-commit");
});

scopeCommitButton.addEventListener("click", () => {
  switchScope("commit");
});

scopeAllButton.addEventListener("click", () => {
  switchScope("all-files");
});

toggleSidebarButton.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  updateSidebarLayout();
  scheduleSessionSave();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

sidebarSearchInputEl.addEventListener("input", () => {
  state.fileFilter = sidebarSearchInputEl.value;
  renderTree();
});

sidebarSearchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    sidebarSearchInputEl.value = "";
    state.fileFilter = "";
    renderTree();
  }
});

commitSelectEl.addEventListener("change", () => {
  saveCurrentScrollPosition();
  state.selectedCommitSha = commitSelectEl.value || null;
  if (state.currentScope !== "commit") state.currentScope = "commit";
  state.activeFileId = null;
  renderAll({ restoreFileScroll: true });
  const file = activeFile();
  if (file) ensureFileLoaded(file.id, state.currentScope);
});

document.addEventListener("keydown", handleGlobalShortcut);

populateCommitSelect();
ensureActiveFileForScope();
renderTree();
renderFileComments();
updateSidebarLayout();
setupMonaco();
