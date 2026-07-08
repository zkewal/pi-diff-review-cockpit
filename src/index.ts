import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { createAiReviewFailedProgress, runAiReview } from "./ai-review.js";
import { loadAiReviewRuntimeConfig } from "./ai-review-config.js";
import { analyzeReviewDataset } from "./analysis.js";
import { parseDiffReviewArgs } from "./command.js";
import { loadReviewFileContents } from "./git.js";
import { buildGitHubReviewPayload, countSkippedGitHubReviewComments, publishGitHubReview } from "./github-publish.js";
import { composeReviewPrompt } from "./prompt.js";
import { buildGitHubPrReviewDataset } from "./sources/github-pr.js";
import { buildLocalReviewDataset } from "./sources/local.js";
import {
  buildReviewDiffFingerprint,
  buildReviewSessionRecord,
  getReviewSessionDescriptor,
  loadReviewSession,
  resolveReviewSession,
  saveReviewSession,
} from "./session-store.js";
import type {
  ReviewCancelPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewAnalysis,
  ReviewPublishPayload,
  ReviewRunAiReviewPayload,
  ReviewRequestFilePayload,
  ReviewSaveSessionPayload,
  ReviewSessionSnapshot,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";
import { buildReviewHtml } from "./ui.js";

const PATCH_COMMAND_TIMEOUT_MS = 120_000;

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

function isPublishPayload(value: ReviewWindowMessage): value is ReviewPublishPayload {
  return value.type === "publish-github-review";
}

function isRunAiReviewPayload(value: ReviewWindowMessage): value is ReviewRunAiReviewPayload {
  return value.type === "run-ai-review";
}

function isSaveSessionPayload(value: ReviewWindowMessage): value is ReviewSaveSessionPayload {
  return value.type === "save-session";
}

type WaitingEditorResult = "escape" | "window-settled";

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function reviewWindowTitle(dataset: { repoRoot: string; source: { github?: { owner: string; repo: string; number: number } } }): string {
  const github = dataset.source.github;
  if (github != null) {
    return `Review PR #${github.number} · ${github.owner}/${github.repo}`;
  }
  return `Diff review · ${basename(dataset.repoRoot) || "repository"}`;
}

export default function (pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            "The native review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  async function reviewRepository(args: string[], ctx: ExtensionCommandContext): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    const command = parseDiffReviewArgs(args);
    const dataset = command.mode === "github-pr"
      ? await buildGitHubPrReviewDataset(pi, ctx, command.url)
      : await buildLocalReviewDataset(pi, ctx);
    const { workingRoot, files } = dataset;
    if (files.length === 0) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const loadFilePatch = async (file: ReviewFile): Promise<string> => {
      const comparison = file.gitDiff ?? file.lastCommit ?? Object.values(file.commitComparisons)[0] ?? null;
      if (comparison == null) return "";
      const paths = [...new Set([
        comparison.oldPath,
        comparison.newPath,
        file.path,
      ].filter((path): path is string => path != null && path.length > 0))];
      if (paths.length === 0) return "";

      const args = file.gitDiff != null
        ? ["diff", "--no-color", "--unified=80", "HEAD", "--", ...paths]
        : file.lastCommit != null
          ? ["diff", "--no-color", "--unified=80", "HEAD^", "HEAD", "--", ...paths]
          : ["diff", "--no-color", "--unified=80", "HEAD", "--", ...paths];
      const result = await pi.exec("git", args, {
        cwd: workingRoot,
        timeout: PATCH_COMMAND_TIMEOUT_MS,
      });
      if (result.code === 0 && result.stdout.length > 0) {
        return result.stdout;
      }

      if (comparison.status === "added" && comparison.oldPath == null && comparison.newPath != null) {
        try {
          return await readFile(join(workingRoot, comparison.newPath), "utf8");
        } catch {
          return "";
        }
      }

      return "";
    };

    ctx.ui.notify("Preparing review session.", "info");
    const sessionDescriptor = await getReviewSessionDescriptor(pi, dataset);
    const fingerprint = await buildReviewDiffFingerprint(pi, dataset, loadFilePatch);
    const storedSession = await loadReviewSession(sessionDescriptor.storagePath);
    const sessionResolution = resolveReviewSession({
      stored: storedSession,
      sourceKey: sessionDescriptor.sourceKey,
      currentFingerprint: fingerprint,
      dataset,
    });

    let analysis: ReviewAnalysis;
    if (sessionResolution.analysis == null) {
      ctx.ui.notify("Analyzing diff for review map and findings.", "info");
      analysis = await analyzeReviewDataset(ctx, dataset);
    } else {
      ctx.ui.notify("Restored cached review map.", "info");
      analysis = sessionResolution.analysis;
    }
    const aiReviewConfig = await loadAiReviewRuntimeConfig(ctx, dataset);

    let sessionSnapshot: ReviewSessionSnapshot | null = sessionResolution.snapshot;
    let saveChain: Promise<void> = Promise.resolve();
    const queueSessionSave = (snapshot: ReviewSessionSnapshot): void => {
      sessionSnapshot = snapshot;
      const analysisToSave = snapshot.analysis?.approvalPacket
        ? {
            ...analysis,
            approvalPacket: snapshot.analysis.approvalPacket,
          }
        : analysis;
      saveChain = saveChain
        .catch(() => undefined)
        .then(() => saveReviewSession(sessionDescriptor.storagePath, buildReviewSessionRecord({
          sourceKey: sessionDescriptor.sourceKey,
          fingerprint,
          analysis: analysisToSave,
          snapshot,
        })));
    };
    const flushSessionSave = async (): Promise<void> => {
      try {
        await saveChain;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save review session: ${message}`, "warning");
      }
    };
    const snapshotFromSubmit = (message: ReviewSubmitPayload): ReviewSessionSnapshot => ({
      ...(sessionSnapshot ?? {}),
      analysis,
      overallComment: message.overallComment,
      comments: message.comments,
      acceptedFindingComments: Object.fromEntries(message.acceptedFindings.map((finding) => [finding.findingId, finding.body])),
      findingStatuses: Object.fromEntries(message.findingStatuses.map((finding) => [finding.findingId, finding.status])),
    });

    queueSessionSave({
      ...(sessionSnapshot ?? {}),
      analysis,
    });
    await flushSessionSave();

    const html = buildReviewHtml({
      ...dataset,
      analysis,
      aiReviewConfig: aiReviewConfig.public,
      session: {
        status: sessionResolution.status,
        message: sessionResolution.message,
        storagePath: sessionDescriptor.storagePath,
        updatedAt: sessionResolution.updatedAt,
        snapshot: sessionSnapshot,
      },
    });
    const title = reviewWindowTitle(dataset);
    const window = open(html, {
      width: 1680,
      height: 1020,
      title,
    });
    activeWindow = window;
    window.show({ title });

    const waitingUI = showWaitingUI(ctx);
    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
    };

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"], commitSha?: string): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${commitSha ?? ""}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;

      const pending = loadReviewFileContents(pi, workingRoot, file, scope, commitSha);
      contentCache.set(cacheKey, pending);
      return pending;
    };

    ctx.ui.notify("Opened native review window.", "info");

    try {
      const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve, reject) => {
        let settled = false;
        let publishInFlight = false;
        let aiReviewInFlight = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const canUpdateAiReview = (): boolean => !settled && activeWindow === window;

        const handlePublishGitHubReview = async (message: ReviewPublishPayload): Promise<void> => {
          if (publishInFlight) {
            ctx.ui.notify("A GitHub review publish is already in progress.", "warning");
            return;
          }
          if (!dataset.source.github) {
            ctx.ui.notify("This review source cannot publish GitHub reviews.", "error");
            return;
          }

          publishInFlight = true;
          try {
            const filePathById = new Map(files.map((file) => [file.id, file.gitDiff?.newPath ?? file.gitDiff?.oldPath ?? file.path]));
            const commentableLinesByFileId = new Map(files.map((file) => [
              file.id,
              {
                original: file.gitDiff?.commentableOriginalLines ?? [],
                modified: file.gitDiff?.commentableModifiedLines ?? [],
              },
            ]));
            const buildOptions = {
              event: message.event,
              body: message.body,
              submit: message.submit,
              filePathById,
              commentableLinesByFileId,
            };
            const skippedCount = countSkippedGitHubReviewComments(buildOptions);
            const payload = buildGitHubReviewPayload(buildOptions);

            await publishGitHubReview(pi, dataset.workingRoot, dataset.source.github, payload);
            ctx.ui.notify("Published GitHub review.", "info");
            if (skippedCount > 0) {
              ctx.ui.notify(`Skipped ${skippedCount} unsupported manual comment(s) that are not GitHub PR diff coordinates.`, "warning");
            }
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`GitHub publish failed: ${messageText}`, "error");
          } finally {
            publishInFlight = false;
          }
        };

        const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
          const file = fileMap.get(message.fileId);
          if (file == null) {
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              commitSha: message.commitSha,
              message: "Unknown file requested.",
            });
            return;
          }

          try {
            const contents = await loadContents(file, message.scope, message.commitSha);
            sendWindowMessage({
              type: "file-data",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              commitSha: message.commitSha,
              originalContent: contents.originalContent,
              modifiedContent: contents.modifiedContent,
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              commitSha: message.commitSha,
              message: messageText,
            });
          }
        };

        const handleRunAiReview = async (message: ReviewRunAiReviewPayload): Promise<void> => {
          if (aiReviewInFlight) {
            sendWindowMessage({
              type: "ai-review-error",
              requestId: message.requestId,
              message: "An AI review is already running.",
              progress: createAiReviewFailedProgress(analysis, "An AI review is already running.", aiReviewConfig),
            });
            return;
          }

          aiReviewInFlight = true;
          try {
            const result = await runAiReview(ctx, dataset, analysis, {
              getFilePatch: loadFilePatch,
              config: aiReviewConfig,
              onProgress: (progress) => {
                if (!canUpdateAiReview()) return;
                sendWindowMessage({
                  type: "ai-review-progress",
                  requestId: message.requestId,
                  progress,
                });
              },
              onPartialResult: (partial) => {
                if (!canUpdateAiReview()) return;
                analysis = partial.analysis;
                queueSessionSave({
                  ...(sessionSnapshot ?? {}),
                  analysis,
                });
                sendWindowMessage({
                  type: "ai-review-partial-result",
                  requestId: message.requestId,
                  chapterId: partial.chapterId,
                  analysis: partial.analysis,
                  progress: partial.progress,
                });
              },
            });
            if (!canUpdateAiReview()) return;
            analysis = result.analysis;
            queueSessionSave({
              ...(sessionSnapshot ?? {}),
              analysis,
            });
            sendWindowMessage({
              type: "ai-review-result",
              requestId: message.requestId,
              analysis: result.analysis,
              progress: result.progress,
            });
          } catch (error) {
            if (!canUpdateAiReview()) return;
            const messageText = error instanceof Error ? error.message : String(error);
            sendWindowMessage({
              type: "ai-review-error",
              requestId: message.requestId,
              message: messageText,
              progress: createAiReviewFailedProgress(analysis, messageText, aiReviewConfig),
            });
          } finally {
            aiReviewInFlight = false;
          }
        };

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;
          if (isSaveSessionPayload(message)) {
            queueSessionSave(message.snapshot);
            return;
          }
          if (isRunAiReviewPayload(message)) {
            void handleRunAiReview(message);
            return;
          }
          if (isPublishPayload(message)) {
            queueSessionSave(snapshotFromSubmit(message.submit));
            void handlePublishGitHubReview(message);
            return;
          }
          if (isRequestFilePayload(message)) {
            void handleRequestFile(message);
            return;
          }
          if (isSubmitPayload(message) || isCancelPayload(message)) {
            settle(message);
          }
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      if (message?.type === "submit") {
        queueSessionSave(snapshotFromSubmit(message));
      }
      await flushSessionSave();
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a native review window with git diff, last commit, and all files scopes",
    handler: async (args, ctx) => {
      await reviewRepository(args.trim() === "" ? [] : args.trim().split(/\s+/), ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
