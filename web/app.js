const reviewData = JSON.parse(document.getElementById("diff-review-data").textContent || "{}");

const state = {
  activeFileId: null,
  activeSidebarTab: "review-map",
  currentScope: reviewData.files.some((file) => file.inGitDiff)
    ? "git-diff"
    : reviewData.files.some((file) => file.inLastCommit)
      ? "last-commit"
      : reviewData.commits?.length > 0
        ? "commit"
        : "all-files",
  comments: [],
  overallComment: "",
  hideUnchanged: false,
  wrapLines: true,
  collapsedDirs: {},
  reviewedFiles: {},
  reviewedChapters: {},
  findingStatuses: Object.fromEntries((reviewData.analysis?.findings || []).map((finding) => [finding.id, finding.status || "new"])),
  acceptedFindingComments: {},
  scrollPositions: {},
  sidebarCollapsed: false,
  fileFilter: "",
  activeInsight: { type: "default", id: null },
  selectedCommitSha: reviewData.commits?.[0]?.sha || null,
  fileContents: {},
  fileErrors: {},
  pendingRequestIds: {},
};

const sidebarEl = document.getElementById("sidebar");
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
const insightContentEl = document.getElementById("insight-content");
const sourceLabelEl = document.getElementById("source-label");
const analysisStatusEl = document.getElementById("analysis-status");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const publishGitHubButton = document.getElementById("publish-github-button");
const overallCommentButton = document.getElementById("overall-comment-button");
const approvalPacketButton = document.getElementById("approval-packet-button");
const fileCommentButton = document.getElementById("file-comment-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleUnchangedButton = document.getElementById("toggle-unchanged-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");

repoRootEl.textContent = reviewData.repoRoot || "";
windowTitleEl.textContent = "Review";
if (reviewData.source?.canPublishGitHubReview) {
  publishGitHubButton.classList.remove("hidden");
}

let monacoApi = null;
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let originalDecorations = [];
let modifiedDecorations = [];
let activeViewZones = [];
let editorResizeObserver = null;
let requestSequence = 0;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
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
      return "Review working tree changes against HEAD. Hover or click line numbers in the gutter to add an inline comment.";
    case "last-commit":
      return "Review the last commit against its parent. Hover or click line numbers in the gutter to add an inline comment.";
    case "commit":
      return "Review the selected past commit against its parent. Use the commit dropdown in the sidebar to move through history.";
    default:
      return "Review the current working tree snapshot. Hover or click line numbers in the gutter to add a code review comment.";
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

function findingStatusLabel(status) {
  switch (status) {
    case "accepted-comment": return "Comment accepted";
    case "dismissed": return "Dismissed";
    case "accepted-risk": return "Risk accepted";
    default: return "New";
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
    return;
  }
  saveCurrentScrollPosition();
  state.activeFileId = fileId;
  renderAll({ restoreFileScroll: true });
  ensureFileLoaded(fileId, state.currentScope);
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
    const count = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && (comment.scope !== "commit" || comment.commitSha === state.selectedCommitSha)).length;
    const reviewed = isFileReviewed(file.id);
    const requestState = getRequestState(file.id, state.currentScope);
    const loading = requestState.requestId != null && requestState.contents == null;
    const errored = requestState.error != null;
    const status = getActiveStatus(file);
    const button = document.createElement("button");
    button.type = "button";
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
    const count = state.comments.filter((comment) => comment.fileId === file.id && comment.scope === state.currentScope && (comment.scope !== "commit" || comment.commitSha === state.selectedCommitSha)).length;
    const reviewed = isFileReviewed(file.id);
    const requestState = getRequestState(file.id, state.currentScope);
    const loading = requestState.requestId != null && requestState.contents == null;
    const errored = requestState.error != null;
    const status = getActiveStatus(file);
    const button = document.createElement("button");
    button.type = "button";
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
  toggleSidebarButton.textContent = collapsed ? "Show sidebar" : "Hide sidebar";
}

function setSidebarTab(tab) {
  state.activeSidebarTab = tab;
  renderAll({ restoreFileScroll: false });
}

function updateSidebarTabs() {
  const activeClasses = "rounded bg-[#238636]/15 px-2 py-1 text-[11px] font-medium text-[#3fb950]";
  const inactiveClasses = "rounded px-2 py-1 text-[11px] font-medium text-review-muted hover:bg-[#21262d] hover:text-review-text";
  tabReviewMapButton.className = state.activeSidebarTab === "review-map" ? activeClasses : inactiveClasses;
  tabFilesButton.className = state.activeSidebarTab === "files" ? activeClasses : inactiveClasses;
  tabFindingsButton.className = state.activeSidebarTab === "findings" ? activeClasses : inactiveClasses;
}

function updateScopeButtons() {
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
  modeHintEl.textContent = scopeHint(state.currentScope);
  submitButton.disabled = false;
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
  return (chapter.fileIds || []).find((fileId) => getFileById(fileId) != null) || null;
}

function firstExistingFindingFileId(finding) {
  return (finding.locations || [])
    .map((location) => location.fileId)
    .find((fileId) => getFileById(fileId) != null) || null;
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

function renderDefaultInsight() {
  const packet = reviewData.analysis?.approvalPacket;
  if (!packet) {
    insightContentEl.innerHTML = `
      <div class="space-y-3 text-sm text-review-muted">
        <div>No analysis context available.</div>
        <div>Select a chapter or finding to inspect details.</div>
      </div>
    `;
    return;
  }

  insightContentEl.innerHTML = `
    <div class="space-y-4">
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Approval packet</div>
        <div class="mt-2 text-sm font-medium text-white">${escapeHtml(packet.summary)}</div>
        <div class="mt-2 text-[11px] text-review-muted">Suggested verdict: <span class="font-medium text-review-text">${escapeHtml(humanizeToken(packet.suggestedVerdict))}</span></div>
      </div>
      ${packet.body ? `
        <pre class="scrollbar-thin max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md border border-review-border bg-[#010409] p-3 text-xs leading-5 text-review-text">${escapeHtml(packet.body)}</pre>
      ` : ""}
      <div class="text-xs text-review-muted">Select a chapter or finding to inspect details.</div>
    </div>
  `;
}

function renderInsightForChapter(chapter) {
  const reviewed = state.reviewedChapters[chapter.id] === true;
  const files = (chapter.fileIds || []).map(getFileById).filter(Boolean);
  const findings = (chapter.findingIds || []).map(getReviewFinding).filter(Boolean);

  insightContentEl.innerHTML = `
    <div class="space-y-4">
      <div>
        <div class="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider">
          <span class="${severityTextClass(chapter.risk)}">${escapeHtml(humanizeToken(chapter.risk))} risk</span>
          <span class="text-review-muted">•</span>
          <span class="${reviewed ? "text-[#3fb950]" : "text-review-muted"}">${reviewed ? "Reviewed" : "Not reviewed"}</span>
        </div>
        <div class="text-base font-semibold leading-6 text-white">${escapeHtml(chapter.title)}</div>
        <div class="mt-2 text-sm leading-5 text-review-text">${escapeHtml(chapter.summary)}</div>
      </div>
      <button id="chapter-reviewed-toggle" class="${insightActionButtonClass(reviewed)}">${reviewed ? "Mark not reviewed" : "Mark chapter reviewed"}</button>
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Files</div>
        <div class="mt-2 space-y-1">
          ${files.length === 0 ? `<div class="text-sm text-review-muted">No files linked.</div>` : files.map((file) => `
            <button data-file-id="${escapeHtml(file.id)}" class="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-review-text hover:bg-[#21262d]">${escapeHtml(file.path)}</button>
          `).join("")}
        </div>
      </div>
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Findings</div>
        <div class="mt-2 space-y-2">
          ${findings.length === 0 ? `<div class="text-sm text-review-muted">No findings linked.</div>` : findings.map((finding) => `
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
  if (status === "accepted-comment") {
    state.acceptedFindingComments[finding.id] = finding.suggestedComment;
  } else {
    delete state.acceptedFindingComments[finding.id];
  }
  state.activeInsight = { type: "finding", id: finding.id };
  renderTree();
}

function renderInsightForFinding(finding) {
  const status = state.findingStatuses[finding.id] || "new";
  const acceptedComment = state.acceptedFindingComments[finding.id] || "";

  insightContentEl.innerHTML = `
    <div class="space-y-4">
      <div>
        <div class="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider">
          <span class="text-review-muted">${escapeHtml(humanizeToken(finding.kind))}</span>
          <span class="${severityTextClass(finding.severity)}">${escapeHtml(humanizeToken(finding.severity))}</span>
          <span class="text-review-muted">Confidence ${escapeHtml(humanizeToken(finding.confidence))}</span>
        </div>
        <div class="text-base font-semibold leading-6 text-white">${escapeHtml(finding.title)}</div>
        <div class="mt-2 text-sm leading-5 text-review-text">${escapeHtml(finding.explanation)}</div>
        <div class="mt-2 text-xs ${findingStatusClass(status)}">${escapeHtml(findingStatusLabel(status))}</div>
      </div>
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Locations</div>
        <div class="mt-2 space-y-1">
          ${(finding.locations || []).length === 0 ? `<div class="text-sm text-review-muted">No locations linked.</div>` : finding.locations.map((location) => `
            <button data-file-id="${escapeHtml(location.fileId)}" class="block w-full rounded-md px-2 py-1.5 text-left text-xs text-review-text hover:bg-[#21262d]">
              <span class="block truncate">${escapeHtml(location.path)}${location.line != null ? `:${escapeHtml(location.line)}` : ""}</span>
              <span class="text-review-muted">${escapeHtml(humanizeToken(location.side))}</span>
            </button>
          `).join("")}
        </div>
      </div>
      <div>
        <div class="text-[11px] font-semibold uppercase tracking-wider text-review-muted">Suggested comment</div>
        <div class="mt-2 whitespace-pre-wrap rounded-md border border-review-border bg-[#010409] p-3 text-xs leading-5 text-review-text">${escapeHtml(finding.suggestedComment || "No suggested comment.")}</div>
        ${acceptedComment ? `<div class="mt-2 text-xs text-[#3fb950]">Accepted comment saved in this review session.</div>` : ""}
      </div>
      <div class="flex flex-wrap gap-2">
        <button data-finding-status="accepted-comment" class="${insightActionButtonClass(status === "accepted-comment")}">Accept comment</button>
        <button data-finding-status="dismissed" class="${insightActionButtonClass(status === "dismissed")}">Dismiss</button>
        <button data-finding-status="accepted-risk" class="${insightActionButtonClass(status === "accepted-risk")}">Accept risk</button>
        <button data-finding-status="new" class="${insightActionButtonClass(status === "new")}">Reset</button>
      </div>
    </div>
  `;

  insightContentEl.querySelectorAll("[data-file-id]").forEach((button) => {
    button.addEventListener("click", () => openFileFromAnalysis(button.getAttribute("data-file-id")));
  });
  insightContentEl.querySelectorAll("[data-finding-status]").forEach((button) => {
    button.addEventListener("click", () => setFindingStatus(finding, button.getAttribute("data-finding-status")));
  });
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
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "mb-2 block w-full rounded-md border p-3 text-left",
      active ? "border-[#2ea043]/40 bg-[#238636]/10" : "border-review-border bg-[#010409] hover:bg-[#161b22]",
    ].join(" ");
    button.innerHTML = `
      <div class="mb-2 flex items-center justify-between gap-2 text-[11px] font-medium">
        <span class="text-review-muted">Chapter ${index + 1}</span>
        <span class="${reviewed ? "text-[#3fb950]" : severityTextClass(chapter.risk)}">${reviewed ? "Reviewed" : `${escapeHtml(humanizeToken(chapter.risk))} risk`}</span>
      </div>
      <div class="text-sm font-semibold leading-5 text-white">${escapeHtml(chapter.title)}</div>
      <div class="mt-1 line-clamp-3 text-xs leading-5 text-review-muted">${escapeHtml(chapter.summary)}</div>
      <div class="mt-2 flex items-center gap-3 text-[11px] text-review-muted">
        <span>${(chapter.fileIds || []).length} file(s)</span>
        <span>${(chapter.findingIds || []).length} finding(s)</span>
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
  fileTreeEl.innerHTML = "";
  updateSidebarTabs();
  sourceLabelEl.textContent = reviewData.source?.label || "Review source";
  analysisStatusEl.textContent = reviewData.analysis?.message || "";

  const scopedFiles = getScopedFiles();
  const comments = state.comments.length;

  if (state.activeSidebarTab === "review-map") {
    const chapters = getReviewChapters();
    const findings = getReviewFindings();
    renderReviewMap();
    sidebarTitleEl.textContent = "Review map";
    summaryEl.textContent = `${chapters.length} chapter(s) • ${findings.length} finding(s) • ${comments} comment(s)${state.overallComment ? " • overall note" : ""}`;
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
    summaryEl.textContent = `${findings.length} finding(s) • ${newFindings} new • ${comments} comment(s)${state.overallComment ? " • overall note" : ""}`;
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
  summaryEl.textContent = `${scopedFiles.length} file(s) • ${comments} comment(s)${state.overallComment ? " • overall note" : ""}${filteredSuffix}`;
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
  backdrop.querySelector("#review-modal-cancel").addEventListener("click", close);
  backdrop.querySelector("#review-modal-save").addEventListener("click", () => {
    options.onSave(textarea.value.trim());
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  textarea.focus();
}

function showOverallCommentModal() {
  showTextModal({
    title: "Overall review note",
    description: "This note is prepended to the generated prompt above the inline comments.",
    initialValue: state.overallComment,
    saveLabel: "Save note",
    onSave: (value) => {
      state.overallComment = value;
      renderTree();
    },
  });
}

function showApprovalPacketModal() {
  const packet = reviewData.analysis?.approvalPacket;
  showTextModal({
    title: "Approval packet",
    description: "Edit the review summary before finishing or publishing.",
    initialValue: packet?.body || "",
    saveLabel: "Save packet",
    onSave: (value) => {
      if (reviewData.analysis?.approvalPacket) {
        reviewData.analysis.approvalPacket.body = value;
      }
      renderTree();
    },
  });
}

function suggestedGitHubReviewEvent() {
  const verdict = reviewData.analysis?.approvalPacket?.suggestedVerdict;
  if (verdict === "request-changes") return "REQUEST_CHANGES";
  if (verdict === "approve") return "APPROVE";
  return "COMMENT";
}

function showPublishGitHubModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "review-modal-backdrop";
  backdrop.innerHTML = `
    <div class="review-modal-card">
      <div class="mb-2 text-base font-semibold text-white">Publish to GitHub</div>
      <div class="mb-4 text-sm text-review-muted">Choose the review verdict and body to post.</div>
      <label class="mb-2 block text-xs font-medium uppercase tracking-wider text-review-muted" for="github-review-event">Verdict</label>
      <select id="github-review-event" class="mb-4 w-full rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
        <option value="COMMENT">Comment</option>
        <option value="REQUEST_CHANGES">Request changes</option>
        <option value="APPROVE">Approve</option>
      </select>
      <label class="mb-2 block text-xs font-medium uppercase tracking-wider text-review-muted" for="github-review-body">Review body</label>
      <textarea id="github-review-body" class="scrollbar-thin min-h-48 w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">${escapeHtml(reviewData.analysis?.approvalPacket?.body || "")}</textarea>
      <div class="mt-4 flex justify-end gap-2">
        <button id="github-publish-cancel" class="cursor-pointer rounded-md border border-review-border bg-review-panel px-4 py-2 text-sm font-medium text-review-text hover:bg-[#21262d]">Cancel</button>
        <button id="github-publish-submit" class="cursor-pointer rounded-md border border-[rgba(240,246,252,0.1)] bg-[#1f6feb] px-4 py-2 text-sm font-medium text-white hover:bg-[#388bfd]">Publish</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const eventSelect = backdrop.querySelector("#github-review-event");
  const textarea = backdrop.querySelector("#github-review-body");
  const close = () => backdrop.remove();

  eventSelect.value = suggestedGitHubReviewEvent();
  backdrop.querySelector("#github-publish-cancel").addEventListener("click", close);
  backdrop.querySelector("#github-publish-submit").addEventListener("click", () => {
    syncCommentBodiesFromDOM();
    window.glimpse.send({
      type: "publish-github-review",
      event: eventSelect.value,
      body: textarea.value.trim(),
      submit: buildSubmitPayload(),
    });
    close();
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
      submitButton.disabled = false;
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
      <button data-action="delete" class="cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400">Delete</button>
    </div>
    <textarea data-comment-id="${escapeHtml(comment.id)}" class="scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" placeholder="Leave a comment"></textarea>
  `;
  const textarea = container.querySelector("textarea");
  textarea.value = comment.body || "";
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
  });
  container.querySelector("[data-action='delete']").addEventListener("click", onDelete);
  if (!comment.body) setTimeout(() => textarea.focus(), 50);
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
  currentFileLabelEl.textContent = getScopeDisplayPath(file, state.currentScope);

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
    setTimeout(() => {
      layoutEditor();
      if (options.restoreFileScroll) restoreFileScrollPosition();
      if (options.preserveScroll) restoreScrollState(scrollState);
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
  submitButton.disabled = false;
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

function createGlyphHoverActions(editor, side) {
  let hoverDecoration = [];

  function openDraftAtLine(line) {
    const file = activeFile();
    if (!file || !canCommentOnSide(file, side) || !isActiveFileReady()) return;
    state.comments.push({
      id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
      fileId: file.id,
      scope: state.currentScope,
      commitSha: state.currentScope === "commit" ? state.selectedCommitSha : undefined,
      side,
      startLine: line,
      endLine: line,
      body: "",
    });
    updateCommentsUI();
    editor.revealLineInCenter(line);
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
        "diffEditor.insertedTextBackground": "#2ea04326",
        "diffEditor.removedTextBackground": "#f8514926",
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

submitButton.addEventListener("click", () => {
  syncCommentBodiesFromDOM();
  window.glimpse.send(buildSubmitPayload());
  window.glimpse.close();
});

cancelButton.addEventListener("click", () => {
  window.glimpse.send({ type: "cancel" });
  window.glimpse.close();
});

publishGitHubButton.addEventListener("click", () => {
  showPublishGitHubModal();
});

overallCommentButton.addEventListener("click", () => {
  showOverallCommentModal();
});

approvalPacketButton.addEventListener("click", () => {
  showApprovalPacketModal();
});

fileCommentButton.addEventListener("click", () => {
  showFileCommentModal();
});

toggleUnchangedButton.addEventListener("click", () => {
  state.hideUnchanged = !state.hideUnchanged;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(layoutEditor);
});

toggleWrapButton.addEventListener("click", () => {
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateToggleButtons();
  requestAnimationFrame(() => {
    layoutEditor();
    setTimeout(layoutEditor, 50);
  });
});

toggleReviewedButton.addEventListener("click", () => {
  const file = activeFile();
  if (!file) return;
  state.reviewedFiles[file.id] = !isFileReviewed(file.id);
  renderTree();
});

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

populateCommitSelect();
ensureActiveFileForScope();
renderTree();
renderFileComments();
updateSidebarLayout();
setupMonaco();
