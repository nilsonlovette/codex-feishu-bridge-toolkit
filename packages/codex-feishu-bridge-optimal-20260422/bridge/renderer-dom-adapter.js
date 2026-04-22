"use strict";

function createComposerStateRunner() {
  return `
    (() => {
      const installProbe = () => {
        if (typeof window.__codexFeishuBridgeGetComposerState === "function") {
          return window.__codexFeishuBridgeGetComposerState;
        }
        const normalizeText = (value) =>
          String(value ?? "")
            .replace(/\\u00a0/g, " ")
            .replace(/\\s+/g, " ")
            .trim();
        const extractConversationId = (value) => {
          const raw = String(value ?? "").trim();
          if (!raw || /\\s/.test(raw)) {
            return null;
          }
          const directMatch =
            raw.match(/\\bcodex:\\/\\/threads\\/([^/?#\\s]+)/i) ??
            raw.match(/\\/local\\/([^/?#\\s]+)/i) ??
            raw.match(/\\/thread\\/([^/?#\\s]+)/i) ??
            raw.match(/[?&](?:chat|conversationId|threadId|sessionId)=([^&#\\s]+)/i);
          const candidate = directMatch?.[1]
            ? decodeURIComponent(directMatch[1]).trim()
            : raw;
          if (!candidate || /\\s/.test(candidate)) {
            return null;
          }
          if (
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              candidate,
            ) ||
            /^[0-9a-f]{24,}$/i.test(candidate) ||
            /^(?:thread|conversation|chat|conv|local)[:_-][A-Za-z0-9._:-]{8,}$/i.test(
              candidate,
            ) ||
            (/^[A-Za-z0-9][A-Za-z0-9._:-]{15,}$/.test(candidate) &&
              /\\d/.test(candidate))
          ) {
            return candidate;
          }
          return null;
        };
        const isControlVisible = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            rect.width > 14 &&
            rect.height > 14
          );
        };
        const inferConversationId = () => {
          const search = new URLSearchParams(window.location.search);
          const pathname = window.location.pathname || "";
          const pathMatch = pathname.match(/\\/(?:local|thread|hotkey-window\\/thread)\\/([^/?#]+)/i);
          const routeCandidate =
            search.get("chat") ||
            search.get("conversationId") ||
            search.get("threadId") ||
            search.get("sessionId") ||
            (pathMatch ? decodeURIComponent(pathMatch[1]) : null);
          const routeConversationId = extractConversationId(routeCandidate);
          if (routeConversationId) {
            return routeConversationId;
          }
          const activeSelectors = [
            "[data-thread-id]",
            "[data-conversation-id]",
            "[data-chat-id]",
            "[data-session-id]",
            'a[aria-current="page"]',
            '[aria-current="page"]',
            '[data-state="active"]',
            '[data-active="true"]',
            '[data-selected="true"]',
            '[data-current="true"]',
          ];
          const attributeNames = [
            "href",
            "data-href",
            "data-url",
            "data-route",
            "data-thread-id",
            "data-conversation-id",
            "data-chat-id",
            "data-session-id",
          ];
          for (const selector of activeSelectors) {
            const candidates = Array.from(document.querySelectorAll(selector))
              .filter(isControlVisible)
              .slice(0, 12);
            for (const element of candidates) {
              for (const attributeName of attributeNames) {
                const candidate = extractConversationId(
                  element.getAttribute(attributeName),
                );
                if (candidate) {
                  return candidate;
                }
              }
              for (const value of Object.values(element.dataset ?? {})) {
                const candidate = extractConversationId(value);
                if (candidate) {
                  return candidate;
                }
              }
            }
          }
          return null;
        };
        const findComposer = () => {
          const candidates = Array.from(
            document.querySelectorAll(
              'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]',
            ),
          )
            .filter(isControlVisible)
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .sort((left, right) => right.rect.bottom - left.rect.bottom);
          return candidates[0]?.element ?? null;
        };
        const readComposerValue = (element) => {
          if (!element) return "";
          if (
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLInputElement
          ) {
            return normalizeText(element.value);
          }
          return normalizeText(element.innerText || element.textContent);
        };
        const isComposerFocused = (element) => {
          const active = document.activeElement;
          return Boolean(
            element &&
              active &&
              (active === element ||
                (typeof element.contains === "function" && element.contains(active))),
          );
        };
        const buildComposerValueFingerprint = (value) => {
          const normalized = normalizeText(value);
          if (!normalized) {
            return "empty";
          }
          return normalized.length + ":" + normalized.slice(-64);
        };
        const describeComposer = (element) => {
          if (!element) return null;
          return {
            tagName: element.tagName,
            role: element.getAttribute("role"),
            ariaLabel: element.getAttribute("aria-label"),
            placeholder: element.getAttribute("placeholder"),
            inputMode: element.getAttribute("inputmode"),
            isContentEditable: Boolean(element.isContentEditable),
            hasFormAncestor: Boolean(element.closest("form")),
            className: normalizeText(element.className),
            valueLength: readComposerValue(element).length,
          };
        };
        window.__codexFeishuBridgeGetComposerState = () => {
          const composer = findComposer();
          const composerValue = readComposerValue(composer);
          const focused = isComposerFocused(composer);
          const localThreadId = inferConversationId();
          return {
            url: window.location.href,
            pathname: window.location.pathname,
            title: normalizeText(document.title),
            localThreadId,
            localConversationId: localThreadId,
            bodyTextPreview: normalizeText(
              (document.querySelector("main") || document.body)?.textContent || "",
            ).slice(0, 320),
            hasComposer: Boolean(composer),
            composer: composer
              ? {
                  ...describeComposer(composer),
                  isFocused: focused,
                  valueLength: composerValue.length,
                  valueFingerprint: buildComposerValueFingerprint(composerValue),
                }
              : null,
          };
        };
        return window.__codexFeishuBridgeGetComposerState;
      };
      return installProbe()();
    })();
  `;
}

function createInjectedRunner(mode, payload = {}) {
  return `
    (async () => {
      const mode = ${JSON.stringify(mode)};
      const payload = ${JSON.stringify(payload)};
      const buildTopLevelRendererError = (error) => ({
        name: String(error?.name ?? "Error"),
        message: String(error?.message ?? error ?? "unknown_renderer_error"),
        stack: String(error?.stack ?? "").slice(0, 4000),
      });
      const buildTopLevelRendererFailure = (error) => {
        const rendererError = buildTopLevelRendererError(error);
        if (mode === "getActiveThread") {
          return {
            url: null,
            pathname: null,
            title: null,
            localThreadId: null,
            localConversationId: null,
            visibleMessageCount: 0,
            lastVisibleMessage: null,
            hasComposer: false,
            composer: null,
            nearbyButtons: [],
            visibleButtons: [],
            bodyTextPreview: "",
            conversationDiagnostics: null,
            rendererError,
          };
        }
        if (mode === "exportContextBundle") {
          return {
            bindingId: payload.bindingId ?? null,
            localThreadId: null,
            contextVersion: payload.contextVersion ?? 1,
            systemPrompt: "needs_desktop_refresh",
            visibleMessages: [],
            toolStateSummary: {
              locationHref: null,
              documentTitle: null,
              visibleToolSummaryLabels: [],
              rendererDiagnostics: null,
              rendererError,
            },
            attachmentSummary: [],
            memorySummary: {
              note: "Renderer-visible memory only. Durable bridge state lives in the bridge store.",
            },
            reasoningSummary: {
              type: "summary_only",
              text: "Raw hidden reasoning is not exported by this bridge. Use visible conversation state plus explicit summaries only.",
            },
            generatedAt: new Date().toISOString(),
            rendererError,
          };
        }
        return {
          ok: false,
          error: "renderer_exception",
          mode,
          rendererError,
        };
      };
      try {
      const normalizeText = (value) =>
        String(value ?? "")
          .replace(/\\u00a0/g, " ")
          .replace(/\\s+/g, " ")
          .trim();
      const buildRendererError = (error) => ({
        name: String(error?.name ?? "Error"),
        message: String(error?.message ?? error ?? "unknown_renderer_error"),
        stack: String(error?.stack ?? "").slice(0, 4000),
      });
      const buildActiveThreadErrorResult = (error) => {
        let localThreadId = null;
        try {
          localThreadId = inferConversationId();
        } catch {}
        return {
          url: window.location.href,
          pathname: window.location.pathname,
          title: normalizeText(document.title),
          localThreadId,
          localConversationId: localThreadId,
          visibleMessageCount: 0,
          lastVisibleMessage: null,
          hasComposer: false,
          composer: null,
          nearbyButtons: [],
          visibleButtons: [],
          bodyTextPreview: normalizeText(
            (document.querySelector("main") || document.body)?.innerText || "",
          ).slice(0, 500),
          conversationDiagnostics: null,
          rendererError: buildRendererError(error),
        };
      };
      const buildExportContextErrorResult = (error) => {
        let localThreadId = null;
        try {
          localThreadId = inferConversationId();
        } catch {}
        return {
          bindingId: payload.bindingId ?? null,
          localThreadId,
          contextVersion: payload.contextVersion ?? 1,
          systemPrompt: "needs_desktop_refresh",
          visibleMessages: [],
          toolStateSummary: {
            locationHref: window.location.href,
            documentTitle: normalizeText(document.title),
            visibleToolSummaryLabels: [],
            rendererDiagnostics: null,
            rendererError: buildRendererError(error),
          },
          attachmentSummary: [],
          memorySummary: {
            note: "Renderer-visible memory only. Durable bridge state lives in the bridge store.",
          },
          reasoningSummary: {
            type: "summary_only",
            text: "Raw hidden reasoning is not exported by this bridge. Use visible conversation state plus explicit summaries only.",
          },
          generatedAt: new Date().toISOString(),
          rendererError: buildRendererError(error),
        };
      };
      const extractConversationId = (value) => {
        const raw = String(value ?? "").trim();
        if (!raw || /\\s/.test(raw)) {
          return null;
        }
        const directMatch =
          raw.match(/\\bcodex:\\/\\/threads\\/([^/?#\\s]+)/i) ??
          raw.match(/\\/local\\/([^/?#\\s]+)/i) ??
          raw.match(/\\/thread\\/([^/?#\\s]+)/i) ??
          raw.match(/[?&](?:chat|conversationId|threadId|sessionId)=([^&#\\s]+)/i);
        const candidate = directMatch?.[1]
          ? decodeURIComponent(directMatch[1]).trim()
          : raw;
        if (!candidate || /\\s/.test(candidate)) {
          return null;
        }
        if (
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            candidate,
          ) ||
          /^[0-9a-f]{24,}$/i.test(candidate) ||
          /^(?:thread|conversation|chat|conv|local)[:_-][A-Za-z0-9._:-]{8,}$/i.test(
            candidate,
          ) ||
          (/^[A-Za-z0-9][A-Za-z0-9._:-]{15,}$/.test(candidate) &&
            /\\d/.test(candidate))
        ) {
          return candidate;
        }
        return null;
      };
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth &&
          rect.width > 32 &&
          rect.height > 20
        );
      };
      const isControlVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth &&
          rect.width > 14 &&
          rect.height > 14
        );
      };
      const inferConversationId = () => {
        const search = new URLSearchParams(window.location.search);
        const pathname = window.location.pathname || "";
        const pathMatch = pathname.match(/\\/(?:local|thread|hotkey-window\\/thread)\\/([^/?#]+)/i);
        const routeCandidate =
          search.get("chat") ||
          search.get("conversationId") ||
          search.get("threadId") ||
          search.get("sessionId") ||
          (pathMatch ? decodeURIComponent(pathMatch[1]) : null);
        const routeConversationId = extractConversationId(routeCandidate);
        if (routeConversationId) {
          return routeConversationId;
        }
        const activeSelectors = [
          "[data-thread-id]",
          "[data-conversation-id]",
          "[data-chat-id]",
          "[data-session-id]",
          'a[aria-current="page"]',
          '[aria-current="page"]',
          '[data-state="active"]',
          '[data-active="true"]',
          '[data-selected="true"]',
          '[data-current="true"]',
        ];
        const attributeNames = [
          "href",
          "data-href",
          "data-url",
          "data-route",
          "data-thread-id",
          "data-conversation-id",
          "data-chat-id",
          "data-session-id",
        ];
        for (const selector of activeSelectors) {
          const candidates = Array.from(document.querySelectorAll(selector))
            .filter(isControlVisible)
            .slice(0, 12);
          for (const element of candidates) {
            for (const attributeName of attributeNames) {
              const candidate = extractConversationId(
                element.getAttribute(attributeName),
              );
              if (candidate) {
                return candidate;
              }
            }
            for (const value of Object.values(element.dataset ?? {})) {
              const candidate = extractConversationId(value);
              if (candidate) {
                return candidate;
              }
            }
          }
        }
        return null;
      };
      const inferRole = (element) => {
        const annotated = element.closest("[data-message-author-role]");
        if (annotated) {
          return normalizeText(
            annotated.getAttribute("data-message-author-role"),
          ).toLowerCase();
        }
        const raw = [
          element.getAttribute("data-author-role"),
          element.getAttribute("aria-label"),
          element.className,
          element.closest("[class]")?.className,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (raw.includes("assistant") || raw.includes("codex") || raw.includes("agent")) {
          return "assistant";
        }
        if (raw.includes("user") || raw.includes("human") || raw.includes("me")) {
          return "user";
        }
        const rect = element.getBoundingClientRect();
        return rect.left > window.innerWidth * 0.45 ? "user" : "assistant";
      };
      const isIgnoredMessageActionLabel = (label) => {
        const normalized = normalizeText(label).toLowerCase();
        if (!normalized) {
          return true;
        }
        return [
          "copy message",
          "copy",
          "fork from this message",
          "复制",
          "复制消息",
          "复制此消息",
          "show more",
          "toggle side panel",
          "复制消息",
          "从此消息分叉",
          "显示更多",
          "展开",
          "收起",
        ].includes(normalized);
      };
      const sanitizeToolSummaryLabels = (labels) => {
        if (!Array.isArray(labels)) {
          return [];
        }
        return labels
          .map((label) => normalizeText(label))
          .filter((label, index, list) => Boolean(label) && list.indexOf(label) === index)
          .slice(0, 8);
      };
      const isMessageActionButtonLabel = (label) => {
        const normalized = normalizeText(label).toLowerCase();
        if (!normalized) {
          return false;
        }
        return [
          "copy message",
          "copy",
          "fork from this message",
          "复制",
          "复制消息",
          "复制此消息",
          "澶嶅埗娑堟伅",
        ].includes(normalized);
      };
      const isSupportedAssistantAnchorButtonLabel = (label) => {
        const normalized = normalizeText(label).toLowerCase();
        if (!normalized) {
          return false;
        }
        return [
          "copy message",
          "copy",
          "fork from this message",
          "\u590d\u5236",
          "\u590d\u5236\u6d88\u606f",
          "\u590d\u5236\u6b64\u6d88\u606f",
          "open file",
          "\u5207\u6362\u6587\u4ef6\u5dee\u5f02\u5bf9\u6bd4",
        ].includes(normalized);
      };
      const looksLikeToolSummaryLabel = (label) => {
        const normalized = normalizeText(label);
        if (!normalized) {
          return false;
        }
        if (isIgnoredMessageActionLabel(normalized)) {
          return false;
        }
        if (normalized.length > 96) {
          return false;
        }
        return [
          /^(?:ran|run)\s+\d+\s+commands?$/i,
          /^edited\s+\d+\s+files?$/i,
          /^(?:read|viewed|opened)\s+\d+\s+files?$/i,
          /^searched(?:\s+the)?\s+web(?:\s+\d+\s+times?)?$/i,
          /^used\s+.+?\s+skills?$/i,
          /^called\s+.+?\s+tools?$/i,
          /^applied\s+\d+\s+patch(?:es)?$/i,
          /^查看了.+文件$/u,
          /^编辑了.+文件$/u,
          /^打开了.+文件$/u,
          /^运行了.+命令$/u,
          /^搜索了网页(?:.+次)?$/u,
          /^使用了.+技能$/u,
          /^调用了.+工具$/u,
          /^应用了.+补丁$/u,
        ].some((pattern) => pattern.test(normalized));
      };
      const extractToolSummaryLabelsFromText = (
        value,
        { tailOnly = false, tailLineCount = 160 } = {},
      ) => {
        const normalizedText = String(value ?? "").replace(/\u00a0/g, " ");
        const rawLines = normalizedText
          .split(/\\r?\\n+/)
          .map((line) => normalizeText(line))
          .filter(Boolean);
        const candidateLines = tailOnly ? rawLines.slice(-Math.max(24, tailLineCount)) : rawLines;
        const labels = [];
        for (const line of candidateLines) {
          const parts = line
            .split(/\\s*[|•·]\\s*/u)
            .map((part) => normalizeText(part))
            .filter(Boolean);
          for (const part of parts) {
            if (!looksLikeToolSummaryLabel(part) || labels.includes(part)) {
              continue;
            }
            labels.push(part);
          }
        }
        return labels.slice(0, 8);
      };
      const MESSAGE_CANDIDATE_SELECTOR =
        'article, [role="listitem"], [data-testid*="message"], [class*="message"], [class*="turn"]';
      const describeElementForDebug = (element) => {
        if (!element) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          tagName: element.tagName,
          role: element.getAttribute("role"),
          id: element.id || null,
          className: normalizeText(element.className).slice(0, 240) || null,
          testId: element.getAttribute("data-testid"),
          bounds: {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      };
      const isScrollableContainer = (element) => {
        if (!element) {
          return false;
        }
        const style = window.getComputedStyle(element);
        const overflowY = String(style.overflowY || "").toLowerCase();
        return (
          ["auto", "scroll", "overlay"].includes(overflowY) ||
          element.scrollHeight > element.clientHeight + 48
        );
      };
      const countVisibleMessageCandidates = (root) => {
        if (!root) {
          return 0;
        }
        return Array.from(root.querySelectorAll(MESSAGE_CANDIDATE_SELECTOR)).filter(isVisible)
          .length;
      };
      const collectConversationSurfaceCandidates = (composer) => {
        const candidates = [];
        const seen = new Set();
        const pushCandidate = (element, reason) => {
          if (
            !element ||
            element === document.body ||
            element === document.documentElement ||
            seen.has(element)
          ) {
            return;
          }
          if (!isVisible(element)) {
            return;
          }
          const rect = element.getBoundingClientRect();
          if (
            rect.width < Math.min(window.innerWidth * 0.45, 320) ||
            rect.height < 120
          ) {
            return;
          }
          seen.add(element);
          candidates.push({ element, reason });
        };
        pushCandidate(document.querySelector("main"), "main");
        if (!composer) {
          return candidates;
        }
        let node = composer;
        for (let depth = 0; node?.parentElement && depth < 8; depth += 1) {
          const parent = node.parentElement;
          pushCandidate(parent, "ancestor:" + depth);
          let sibling = node.previousElementSibling;
          let siblingCount = 0;
          while (sibling && siblingCount < 4) {
            pushCandidate(
              sibling,
              "sibling:" + depth + ":" + siblingCount,
            );
            sibling = sibling.previousElementSibling;
            siblingCount += 1;
          }
          let parentSibling = parent.previousElementSibling;
          let parentSiblingCount = 0;
          while (parentSibling && parentSiblingCount < 3) {
            pushCandidate(
              parentSibling,
              "ancestorSibling:" + depth + ":" + parentSiblingCount,
            );
            parentSibling = parentSibling.previousElementSibling;
            parentSiblingCount += 1;
          }
          node = parent;
        }
        return candidates;
      };
      const scoreConversationSurfaceCandidate = (candidate, composer) => {
        if (!candidate?.element) {
          return Number.NEGATIVE_INFINITY;
        }
        const composerRect = composer?.getBoundingClientRect?.() ?? null;
        const rect = candidate.element.getBoundingClientRect();
        const messageCount = countVisibleMessageCandidates(candidate.element);
        if (messageCount === 0) {
          return Number.NEGATIVE_INFINITY;
        }
        const overlapWidth = composerRect
          ? Math.max(
              0,
              Math.min(rect.right, composerRect.right) -
                Math.max(rect.left, composerRect.left),
            )
          : 0;
        const overlapRatio = composerRect
          ? overlapWidth / Math.max(1, composerRect.width)
          : 0;
        const bottomGap = composerRect
          ? Math.abs(rect.bottom - composerRect.top)
          : 240;
        const containsComposer = Boolean(
          composer && candidate.element.contains(composer),
        );
        const scrollableBonus = isScrollableContainer(candidate.element) ? 6 : 0;
        const areaBonus = Math.min(12, rect.height / 160);
        return (
          messageCount * 20 +
          scrollableBonus +
          areaBonus +
          overlapRatio * 8 -
          bottomGap / 48 -
          (containsComposer ? 3 : 0)
        );
      };
      const findConversationSurfaceRoot = (composer = findComposer()) => {
        const candidates = collectConversationSurfaceCandidates(composer);
        let best = null;
        for (const candidate of candidates) {
          const score = scoreConversationSurfaceCandidate(candidate, composer);
          if (!Number.isFinite(score)) {
            continue;
          }
          if (best == null || score > best.score) {
            best = {
              ...candidate,
              score,
              messageCount: countVisibleMessageCandidates(candidate.element),
            };
          }
        }
        return best;
      };
      const collectMessageToolSummaryLabels = (candidate) => {
        if (!candidate) {
          return [];
        }
        const inlineLabels = extractToolSummaryLabelsFromText(
          candidate.innerText || candidate.textContent || "",
          { tailOnly: true },
        );
        if (inlineLabels.length > 0) {
          return inlineLabels.slice(0, 4);
        }
        const labels = [];
        const pushLabel = (value) => {
          const normalized = normalizeText(value);
          if (!looksLikeToolSummaryLabel(normalized)) {
            return;
          }
          if (labels.includes(normalized)) {
            return;
          }
          labels.push(normalized);
        };
        for (const element of Array.from(
          candidate.querySelectorAll("button, [role=\\"button\\"]"),
        ).filter(isControlVisible)) {
          pushLabel(
            element.innerText ||
              element.textContent ||
              element.getAttribute("aria-label") ||
              element.getAttribute("title"),
          );
        }
        if (labels.length > 0) {
          return labels.slice(0, 4);
        }
        const rect = candidate.getBoundingClientRect();
        for (const element of Array.from(
          document.querySelectorAll("button, [role=\\"button\\"]"),
        ).filter(isControlVisible)) {
          if (candidate.contains(element)) {
            continue;
          }
          const buttonRect = element.getBoundingClientRect();
          const verticallyNear =
            buttonRect.top >= rect.top - 24 && buttonRect.bottom <= rect.bottom + 24;
          const horizontallyAligned =
            buttonRect.left >= rect.left - 12 && buttonRect.right <= rect.right + 12;
          if (!verticallyNear || !horizontallyAligned) {
            continue;
          }
          pushLabel(
            element.innerText ||
              element.textContent ||
              element.getAttribute("aria-label") ||
              element.getAttribute("title"),
          );
        }
        return labels.slice(0, 4);
      };
      const collectVisibleMessagesFromRoot = (root) => {
        if (!root) {
          return [];
        }
        const candidates = Array.from(
          root.querySelectorAll(MESSAGE_CANDIDATE_SELECTOR),
        ).filter(isVisible);
        const seen = new Set();
        const messages = [];
        for (const candidate of candidates) {
          const text = normalizeText(candidate.innerText || candidate.textContent);
          if (!text || text.length < 2) continue;
          const role = inferRole(candidate);
          const key = role + "::" + text;
          if (seen.has(key)) continue;
          seen.add(key);
          messages.push({
            role,
            text,
            toolSummaryLabels:
              role === "assistant" ? collectMessageToolSummaryLabels(candidate) : [],
            bounds: candidate.getBoundingClientRect().top,
          });
        }
        return messages
          .sort((left, right) => left.bounds - right.bounds)
          .map(({ bounds, ...rest }) => rest);
      };
      const findPreferredTextBlockWithin = (root, composer = findComposer()) => {
        if (!root || !isVisible(root)) {
          return null;
        }
        const selectors = "article, section, div, p, pre, li, blockquote";
        const elements = [root].concat(
          Array.from(root.querySelectorAll(selectors)).slice(0, 80),
        );
        const seen = new Set();
        const candidates = [];
        for (const element of elements) {
          if (!element || seen.has(element) || !isVisible(element)) {
            continue;
          }
          seen.add(element);
          if (composer && element.contains(composer)) {
            continue;
          }
          const text = normalizeText(element.innerText || element.textContent);
          if (!text || text.length < 6 || text.length > 2400) {
            continue;
          }
          if (isIgnoredMessageActionLabel(text)) {
            continue;
          }
          const rect = element.getBoundingClientRect();
          candidates.push({
            element,
            text,
            role: inferRole(element),
            top: rect.top,
            height: rect.height,
          });
        }
        if (candidates.length === 0) {
          return null;
        }
        const assistantCandidates = candidates.filter(
          (candidate) => candidate.role === "assistant",
        );
        const pool = assistantCandidates.length > 0 ? assistantCandidates : candidates;
        pool.sort((left, right) => {
          if (right.top !== left.top) {
            return right.top - left.top;
          }
          if (left.height !== right.height) {
            return left.height - right.height;
          }
          return left.text.length - right.text.length;
        });
        const best = pool[0];
        return best
          ? {
              element: best.element,
              text: best.text,
            }
          : null;
      };
      const findMessageElementFromActionButton = (button, composer = findComposer()) => {
        const toCandidate = (element) => {
          if (!element || !isVisible(element)) {
            return null;
          }
          if (composer && element.contains(composer)) {
            return null;
          }
          const text = normalizeText(element.innerText || element.textContent);
          if (!text || text.length < 2) {
            return null;
          }
          if (isIgnoredMessageActionLabel(text)) {
            return null;
          }
          return { element, text };
        };
        let fallbackCandidate = null;
        let node = button?.parentElement ?? null;
        for (let depth = 0; node && depth < 8; depth += 1) {
          let sibling = node.previousElementSibling;
          let siblingCount = 0;
          while (sibling && siblingCount < 4) {
            const candidate =
              findPreferredTextBlockWithin(sibling, composer) ?? toCandidate(sibling);
            if (candidate) {
              return candidate;
            }
            sibling = sibling.previousElementSibling;
            siblingCount += 1;
          }
          const nodeCandidate = toCandidate(node);
          if (
            !fallbackCandidate &&
            nodeCandidate &&
            nodeCandidate.text.length <= 1600
          ) {
            fallbackCandidate = nodeCandidate;
          }
          node = node.parentElement;
        }
        return fallbackCandidate;
      };
      const collectVisibleMessagesFromActionAnchors = (composer = findComposer()) => {
        const actionButtons = Array.from(
          document.querySelectorAll("button, [role=\\"button\\"]"),
        )
          .filter(isControlVisible)
          .filter((element) =>
            isSupportedAssistantAnchorButtonLabel(
              element.innerText ||
                element.textContent ||
                element.getAttribute("aria-label") ||
                element.getAttribute("title"),
            ),
          );
        const seen = new Set();
        const messages = [];
        for (const button of actionButtons) {
          const candidate = findMessageElementFromActionButton(button, composer);
          if (!candidate) {
            continue;
          }
          const role = inferRole(candidate.element);
          const key = role + "::" + candidate.text;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          messages.push({
            role,
            text: candidate.text,
            toolSummaryLabels:
              role === "assistant" ? collectMessageToolSummaryLabels(candidate.element) : [],
            bounds: candidate.element.getBoundingClientRect().top,
          });
        }
        return messages
          .sort((left, right) => left.bounds - right.bounds)
          .map(({ bounds, ...rest }) => rest);
      };
      const collectVisibleMessagesFromComposerAnchors = (composer = findComposer()) => {
        if (!composer) {
          return [];
        }
        const composerRect = composer.getBoundingClientRect();
        const anchorButtons = Array.from(
          document.querySelectorAll("button, [role=\\"button\\"]"),
        )
          .filter(isControlVisible)
          .filter((element) => {
            const label = normalizeText(
              element.innerText ||
                element.textContent ||
                element.getAttribute("aria-label") ||
                element.getAttribute("title"),
            );
            if (!isSupportedAssistantAnchorButtonLabel(label)) {
              return false;
            }
            const rect = element.getBoundingClientRect();
            return (
              rect.bottom <= composerRect.top + 24 &&
              rect.top >= composerRect.top - 260 &&
              rect.left >= composerRect.left - 32 &&
              rect.right <= composerRect.right + 32
            );
          });
        const seen = new Set();
        const messages = [];
        for (const button of anchorButtons) {
          const candidate = findMessageElementFromActionButton(button, composer);
          if (!candidate) {
            continue;
          }
          const role = inferRole(candidate.element);
          if (role !== "assistant") {
            continue;
          }
          const key = role + "::" + candidate.text;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          messages.push({
            role,
            text: candidate.text,
            toolSummaryLabels: collectMessageToolSummaryLabels(candidate.element),
            bounds: candidate.element.getBoundingClientRect().top,
          });
        }
        return messages
          .sort((left, right) => left.bounds - right.bounds)
          .map(({ bounds, ...rest }) => rest);
      };
      const collectVisibleMessages = () => {
        const composer = findComposer();
        const surface = findConversationSurfaceRoot(composer);
        if (surface?.element) {
          const surfaceMessages = collectVisibleMessagesFromRoot(surface.element);
          if (surfaceMessages.length > 0) {
            return surfaceMessages;
          }
        }
        const mainMessages = collectVisibleMessagesFromRoot(document.querySelector("main"));
        if (mainMessages.length > 0) {
          return mainMessages;
        }
        const composerAnchorMessages = collectVisibleMessagesFromComposerAnchors(composer);
        if (composerAnchorMessages.length > 0) {
          return composerAnchorMessages;
        }
        return collectVisibleMessagesFromActionAnchors(composer);
      };
      const collectVisibleToolSummaryLabels = (messages = []) => {
        const labels = [];
        const assistantMessages = messages.filter((message) => message?.role === "assistant");
        for (const message of assistantMessages.slice(-3)) {
          for (const label of sanitizeToolSummaryLabels(message?.toolSummaryLabels)) {
            if (!labels.includes(label)) {
              labels.push(label);
            }
          }
        }
        return labels.slice(0, 8);
      };
      const collectMessageActionDiagnostics = () => {
        const composer = findComposer();
        const actionButtons = Array.from(
          document.querySelectorAll("button, [role=\\"button\\"]"),
        )
          .filter(isControlVisible)
          .filter((element) =>
            isSupportedAssistantAnchorButtonLabel(
              element.innerText ||
                element.textContent ||
                element.getAttribute("aria-label") ||
                element.getAttribute("title"),
            ),
          )
          .slice(0, 6);
        return actionButtons.map((button) => {
          const ancestors = [];
          let node = button.parentElement;
          let nearestTextAncestor = null;
          for (let depth = 0; node && depth < 8; depth += 1) {
            const text = normalizeText(node.innerText || node.textContent || "");
            ancestors.push({
              depth,
              tagName: node.tagName,
              role: node.getAttribute("role"),
              id: node.id || null,
              className: normalizeText(node.className).slice(0, 200) || null,
              textLength: text.length,
            });
            if (
              !nearestTextAncestor &&
              text.length >= 20 &&
              (!composer || !node.contains(composer))
            ) {
              nearestTextAncestor = {
                element: describeElementForDebug(node),
                textPreview: text.slice(0, 220),
              };
            }
            node = node.parentElement;
          }
          return {
            buttonLabel: normalizeText(
              button.innerText ||
                button.textContent ||
                button.getAttribute("aria-label") ||
                button.getAttribute("title"),
            ),
            button: describeElementForDebug(button),
            nearestTextAncestor,
            ancestors,
          };
        });
      };
      const buildConversationDiagnostics = ({ composer, surface, messages }) => {
        const composerAnchorMessages = collectVisibleMessagesFromComposerAnchors(composer);
        const actionAnchorMessages = collectVisibleMessagesFromActionAnchors(composer);
        const assistantTail = messages
          .filter((message) => message?.role === "assistant")
          .slice(-3)
          .map((message) => ({
            textPreview: normalizeText(message?.text || "").slice(0, 180),
            toolSummaryLabels: sanitizeToolSummaryLabels(message?.toolSummaryLabels),
          }));
        return {
          composer: describeElementForDebug(composer),
          mainCandidateCount: countVisibleMessageCandidates(document.querySelector("main")),
          composerAnchorMessageCount: composerAnchorMessages.length,
          actionAnchorMessageCount: actionAnchorMessages.length,
          conversationSurface: surface
            ? {
                reason: surface.reason,
                score: Math.round(Number(surface.score ?? 0) * 100) / 100,
                messageCount: Number(surface.messageCount ?? 0),
                element: describeElementForDebug(surface.element),
              }
            : null,
          assistantTail,
          bodyToolSummaryLabelsDiagnostic: extractToolSummaryLabelsFromText(
            document.body?.innerText || document.body?.textContent || "",
            { tailOnly: true },
          ),
          messageActionDiagnostics: collectMessageActionDiagnostics(),
        };
      };
      const findComposer = () => {
        const candidates = Array.from(
          document.querySelectorAll(
            'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]',
          ),
        )
          .filter(isControlVisible)
          .map((element) => ({ element, rect: element.getBoundingClientRect() }))
          .sort((left, right) => right.rect.bottom - left.rect.bottom);
        return candidates[0]?.element ?? null;
      };
      const collectVisibleButtons = () =>
        Array.from(document.querySelectorAll("button, [role=\\"button\\"]"))
          .filter(isControlVisible)
          .map((element) => ({
            label: normalizeText(
              element.innerText ||
                element.textContent ||
                element.getAttribute("aria-label"),
            ),
            disabled: Boolean(element.disabled),
            ariaDisabled: element.getAttribute("aria-disabled"),
            type: element.type || null,
          }))
          .filter((entry) => Boolean(entry.label))
          .slice(0, 16);
      const findButtonLike = (predicate) =>
        Array.from(document.querySelectorAll("button, [role=\\"button\\"], a"))
          .filter(isControlVisible)
          .map((element) => ({
            element,
            label: normalizeText(
              element.innerText ||
                element.textContent ||
                element.getAttribute("aria-label") ||
                element.getAttribute("title"),
            ).toLowerCase(),
          }))
          .find(({ label }) => predicate(label))?.element ?? null;
      const captureBridgeTraffic = async (action) => {
        const capturedBridgeMessages = [];
        const originalBridgeSend =
          window.electronBridge?.sendMessageFromView?.bind(window.electronBridge) ??
          null;
        const originalWorkerSend =
          window.electronBridge?.sendWorkerMessageFromView?.bind(
            window.electronBridge,
          ) ?? null;
        if (window.electronBridge && originalBridgeSend) {
          window.electronBridge.sendMessageFromView = async (message) => {
            capturedBridgeMessages.push({
              lane: "desktop",
              at: new Date().toISOString(),
              type: message?.type ?? null,
              keys: Object.keys(message ?? {}),
              message,
            });
            return originalBridgeSend(message);
          };
        }
        if (window.electronBridge && originalWorkerSend) {
          window.electronBridge.sendWorkerMessageFromView = async (
            worker,
            message,
          ) => {
            capturedBridgeMessages.push({
              lane: "worker",
              worker,
              at: new Date().toISOString(),
              type: message?.type ?? null,
              keys: Object.keys(message ?? {}),
              message,
            });
            return originalWorkerSend(worker, message);
          };
        }
        try {
          return {
            capturedBridgeMessages,
            result: await action(),
          };
        } finally {
          if (window.electronBridge && originalBridgeSend) {
            window.electronBridge.sendMessageFromView = originalBridgeSend;
          }
          if (window.electronBridge && originalWorkerSend) {
            window.electronBridge.sendWorkerMessageFromView = originalWorkerSend;
          }
        }
      };
      const readComposerValue = (element) => {
        if (!element) return "";
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          return normalizeText(element.value);
        }
        return normalizeText(element.innerText || element.textContent);
      };
      const isComposerFocused = (element) => {
        const active = document.activeElement;
        return Boolean(
          element &&
            active &&
            (active === element ||
              (typeof element.contains === "function" && element.contains(active))),
        );
      };
      const buildComposerValueFingerprint = (value) => {
        const normalized = normalizeText(value);
        if (!normalized) {
          return "empty";
        }
        return normalized.length + ":" + normalized.slice(-64);
      };
      const describeComposer = (element) => {
        if (!element) return null;
        return {
          tagName: element.tagName,
          role: element.getAttribute("role"),
          ariaLabel: element.getAttribute("aria-label"),
          placeholder: element.getAttribute("placeholder"),
          inputMode: element.getAttribute("inputmode"),
          isContentEditable: Boolean(element.isContentEditable),
          hasFormAncestor: Boolean(element.closest("form")),
          className: normalizeText(element.className),
          valueLength: readComposerValue(element).length,
        };
      };
      const snapshotComposerState = () => {
        const composer = findComposer();
        const composerValue = readComposerValue(composer);
        const focused = isComposerFocused(composer);
        const localThreadId = inferConversationId();
        const surface = findConversationSurfaceRoot(composer);
        return {
          url: window.location.href,
          pathname: window.location.pathname,
          title: normalizeText(document.title),
          localThreadId,
          localConversationId: localThreadId,
          bodyTextPreview: normalizeText(
            (surface?.element || document.querySelector("main") || document.body)?.innerText ||
              "",
          ).slice(0, 320),
          hasComposer: Boolean(composer),
          composer: composer
            ? {
                ...describeComposer(composer),
                isFocused: focused,
                valueLength: composerValue.length,
                valueFingerprint: buildComposerValueFingerprint(composerValue),
              }
            : null,
        };
      };
      const inspectComposerInternals = (element) => {
        if (!element) return null;
        const pmViewDesc = element.pmViewDesc ?? null;
        const ownKeys = Object.getOwnPropertyNames(element).filter((key) =>
          /pm|view|editor|mirror/i.test(key),
        );
        const rootKeys = Object.getOwnPropertyNames(
          Object.getPrototypeOf(element) || {},
        ).filter((key) => /pm|view|editor|mirror/i.test(key));
        const pmChain = [];
        let pointer = pmViewDesc;
        let depth = 0;
        while (pointer && depth < 8) {
          pmChain.push({
            depth,
            keys: Object.keys(pointer).slice(0, 24),
            hasView: Boolean(pointer.view),
            hasParent: Boolean(pointer.parent),
            domNodeName: pointer.dom?.nodeName ?? null,
          });
          pointer = pointer.parent ?? null;
          depth += 1;
        }
        const candidateView =
          element.ProseMirrorView ??
          element.editorView ??
          pmViewDesc?.view ??
          pmViewDesc?.parent?.view ??
          pmViewDesc?.parent?.parent?.view ??
          null;
        return {
          ownKeys,
          rootKeys,
          hasPmViewDesc: Boolean(pmViewDesc),
          pmViewDescKeys: pmViewDesc ? Object.keys(pmViewDesc).slice(0, 24) : [],
          pmChain,
          hasCandidateView: Boolean(candidateView),
          candidateViewKeys: candidateView ? Object.keys(candidateView).slice(0, 24) : [],
          stateKeys: candidateView?.state ? Object.keys(candidateView.state).slice(0, 24) : [],
        };
      };
      const collectNearbyButtons = (element) => {
        if (!element) return [];
        const composerRect = element.getBoundingClientRect();
        return Array.from(document.querySelectorAll("button, [role=\\"button\\"]"))
          .filter(isControlVisible)
          .map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              label: normalizeText(
                button.innerText ||
                  button.textContent ||
                  button.getAttribute("aria-label") ||
                  button.getAttribute("title"),
              ),
              type: button.type || null,
              disabled: Boolean(button.disabled),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              distance:
                Math.abs(rect.right - composerRect.right) +
                Math.abs(rect.bottom - composerRect.bottom),
            };
          })
          .filter(
            (button) =>
              button.distance < 500 &&
              button.y >= Math.round(composerRect.top) - 120 &&
              button.y <= Math.round(composerRect.bottom) + 120,
          )
          .sort((left, right) => left.distance - right.distance)
          .slice(0, 8);
      };
      const snapshotSubmitState = () => {
        const composer = findComposer();
        const messages = collectVisibleMessages();
        return {
          url: window.location.href,
          localThreadId: inferConversationId(),
          localConversationId: inferConversationId(),
          visibleMessageCount: messages.length,
          lastVisibleMessage: messages.at(-1) ?? null,
          hasComposer: Boolean(composer),
          composer: describeComposer(composer),
          nearbyButtons: collectNearbyButtons(composer),
          visibleButtons: collectVisibleButtons(),
        };
      };
      const activateInput = (element, text) => {
        element.focus();
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          const setter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(element),
            "value",
          )?.set;
          setter ? setter.call(element, text) : (element.value = text);
          element.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              data: text,
              inputType: "insertText",
            }),
          );
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        const selection = window.getSelection?.();
        if (selection) {
          selection.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          selection.addRange(range);
        }
        element.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            data: text,
            inputType: "insertText",
          }),
        );
        if (document.execCommand) {
          document.execCommand("selectAll", false);
          document.execCommand("delete", false);
          document.execCommand("insertText", false, text);
        } else {
          element.textContent = text;
        }
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: text,
            inputType: "insertText",
          }),
        );
      };
      const submitComposer = async (element) => {
        const form = element.closest("form");
        if (form) {
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
            await sleep(300);
            return { mode: "form-request-submit" };
          }
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          await sleep(300);
          return { mode: "form-submit-event" };
        }
        const composerRect = element.getBoundingClientRect();
        const buttons = Array.from(document.querySelectorAll("button, [role=\\"button\\"]"))
          .filter(isControlVisible)
          .map((button) => ({
            button,
            rect: button.getBoundingClientRect(),
            label: normalizeText(
              button.innerText ||
                button.textContent ||
                button.getAttribute("aria-label") ||
                button.getAttribute("title"),
            ).toLowerCase(),
          }))
          .filter(({ button }) => !button.disabled)
          .sort((left, right) => {
            const leftDistance =
              Math.abs(left.rect.right - composerRect.right) +
              Math.abs(left.rect.bottom - composerRect.bottom);
            const rightDistance =
              Math.abs(right.rect.right - composerRect.right) +
              Math.abs(right.rect.bottom - composerRect.bottom);
            return leftDistance - rightDistance;
          });
        const sendButton =
          buttons.find(
            (entry) =>
              entry.label.includes("send") ||
              entry.label.includes("\\u53d1\\u9001") ||
              entry.label.includes("submit") ||
              entry.label.includes("\\u63d0\\u4ea4"),
          )?.button ??
          buttons.find(({ button }) => button.type === "submit")?.button ??
          buttons.find(
            ({ rect }) =>
              rect.left >= composerRect.right - 48 &&
              Math.abs(rect.bottom - composerRect.bottom) <= 64,
          )?.button;
        if (sendButton) {
          sendButton.click();
          await sleep(350);
          return { mode: "button" };
        }
        for (const eventType of ["keydown", "keypress", "keyup"]) {
          element.dispatchEvent(
            new KeyboardEvent(eventType, {
              key: "Enter",
              code: "Enter",
              which: 13,
              keyCode: 13,
              bubbles: true,
            }),
          );
        }
        await sleep(350);
        return { mode: "keyboard" };
      };
      const waitForSubmitSettle = async (baseline) => {
        const timeoutMs = Math.max(1000, Number(payload.waitForThreadTimeoutMs || 5000));
        const deadline = Date.now() + timeoutMs;
        let lastState = snapshotSubmitState();
        while (Date.now() < deadline) {
          await sleep(100);
          lastState = snapshotSubmitState();
          const createdThread = !baseline.beforeThreadId && Boolean(lastState.localThreadId);
          const switchedThread =
            Boolean(
              baseline.beforeThreadId &&
                lastState.localThreadId &&
                lastState.localThreadId !== baseline.beforeThreadId,
            );
          const expectedThreadVisible =
            Boolean(
              payload.expectedThreadId &&
                lastState.localThreadId &&
                lastState.localThreadId === payload.expectedThreadId,
            );
          const messageCountGrew =
            Number(lastState.visibleMessageCount || 0) >
            Number(baseline.beforeVisibleMessageCount || 0);
          const lastMessageChanged =
            normalizeText(lastState.lastVisibleMessage?.text) !==
            normalizeText(baseline.beforeLastVisibleMessage?.text);
          const urlChanged = lastState.url !== baseline.beforeUrl;
          if (createdThread) {
            return { settled: true, settleReason: "created_thread", ...lastState };
          }
          if (switchedThread) {
            return { settled: true, settleReason: "switched_thread", ...lastState };
          }
          if (expectedThreadVisible && (messageCountGrew || lastMessageChanged || urlChanged)) {
            return {
              settled: true,
              settleReason: "message_appended_to_expected_thread",
              ...lastState,
            };
          }
          if (
            !payload.expectedThreadId &&
            lastState.localThreadId &&
            (messageCountGrew || lastMessageChanged || urlChanged)
          ) {
            return {
              settled: true,
              settleReason: "message_appended_after_submit",
              ...lastState,
            };
          }
        }
        return {
          settled: Boolean(lastState.localThreadId),
          settleReason: lastState.localThreadId
            ? "thread_visible_after_timeout"
            : "timeout_waiting_for_thread",
          ...lastState,
        };
      };
      const waitForNewThreadSurface = async (baselineUrl) => {
        const timeoutMs = Math.max(1000, Number(payload.waitForThreadTimeoutMs || 5000));
        const deadline = Date.now() + timeoutMs;
        let lastState = snapshotSubmitState();
        while (Date.now() < deadline) {
          await sleep(100);
          lastState = snapshotSubmitState();
          if (lastState.localThreadId) {
            return { ok: true, settleReason: "conversation_id_visible", ...lastState };
          }
          if (lastState.url !== baselineUrl && /\\/local\\//i.test(lastState.url)) {
            return { ok: true, settleReason: "local_thread_url", ...lastState };
          }
        }
        return { ok: false, error: "thread_surface_not_opened", ...lastState };
      };

      if (mode === "getActiveThread") {
        try {
          const composerState = snapshotComposerState();
          const composer = findComposer();
          const surface = findConversationSurfaceRoot(composer);
          const messages = surface?.element
            ? collectVisibleMessagesFromRoot(surface.element)
            : collectVisibleMessages();
          return {
            url: composerState.url,
            pathname: composerState.pathname,
            title: composerState.title,
            localThreadId: composerState.localThreadId,
            localConversationId: composerState.localConversationId,
            visibleMessageCount: messages.length,
            lastVisibleMessage: messages.at(-1) ?? null,
            hasComposer: composerState.hasComposer,
            composer: composerState.composer,
            nearbyButtons: collectNearbyButtons(composer),
            visibleButtons: collectVisibleButtons(),
            bodyTextPreview: normalizeText(
              (surface?.element || document.querySelector("main") || document.body)?.innerText ||
                "",
            ).slice(0, 500),
            conversationDiagnostics: buildConversationDiagnostics({
              composer,
              surface,
              messages,
            }),
          };
        } catch (error) {
          return buildActiveThreadErrorResult(error);
        }
      }

      if (mode === "getComposerState") {
        return snapshotComposerState();
      }

      if (mode === "submitUserMessage") {
        const composer = findComposer();
        if (!composer) {
          return { ok: false, error: "composer_not_found" };
        }
        const messagesBefore = collectVisibleMessages();
        const baseline = {
          beforeThreadId: inferConversationId(),
          beforeUrl: window.location.href,
          beforeVisibleMessageCount: messagesBefore.length,
          beforeLastVisibleMessage: messagesBefore.at(-1) ?? null,
          composerValueBeforeSubmit: readComposerValue(composer),
          composerDebugBeforeSubmit: describeComposer(composer),
        };
        activateInput(composer, payload.text || "");
        const submitResult = await submitComposer(composer);
        const settle = await waitForSubmitSettle(baseline);
        return {
          ok: true,
          submitResult,
          composerValueAfterSubmit: readComposerValue(composer),
          composerDebugAfterSubmit: describeComposer(composer),
          ...settle,
        };
      }

      if (mode === "probeSubmitPath") {
        const composer = findComposer();
        if (!composer) {
          return { ok: false, error: "composer_not_found" };
        }
        const messagesBefore = collectVisibleMessages();
        const baseline = {
          beforeThreadId: inferConversationId(),
          beforeUrl: window.location.href,
          beforeVisibleMessageCount: messagesBefore.length,
          beforeLastVisibleMessage: messagesBefore.at(-1) ?? null,
          composerValueBeforeSubmit: readComposerValue(composer),
          composerDebugBeforeSubmit: describeComposer(composer),
          composerInternalsBeforeSubmit: inspectComposerInternals(composer),
          visibleButtonsBeforeSubmit: collectVisibleButtons(),
          nearbyButtonsBeforeSubmit: collectNearbyButtons(composer),
        };
        const { capturedBridgeMessages, result } = await captureBridgeTraffic(
          async () => {
            activateInput(composer, payload.text || "");
            const submitResult = await submitComposer(composer);
            const settle = await waitForSubmitSettle(baseline);
            return {
              ok: true,
              submitResult,
              composerValueAfterSubmit: readComposerValue(composer),
              composerDebugAfterSubmit: describeComposer(composer),
              composerInternalsAfterSubmit: inspectComposerInternals(composer),
              visibleButtonsAfterSubmit: collectVisibleButtons(),
              nearbyButtonsAfterSubmit: collectNearbyButtons(composer),
              ...settle,
            };
          },
        );
        return {
          ...result,
          capturedBridgeMessages,
        };
      }

      if (mode === "probeUiAction") {
        const beforeState = snapshotSubmitState();
        const action = normalizeText(payload.action).toLowerCase();
        const { capturedBridgeMessages, result } = await captureBridgeTraffic(
          async () => {
            if (action === "click-new-thread-button") {
              const button =
                findButtonLike((label) => label.includes("\\u65b0\\u7ebf\\u7a0b")) ??
                findButtonLike((label) => label.includes("new thread")) ??
                findButtonLike((label) => label.includes("new chat"));
              if (!button) {
                return { ok: false, error: "new_thread_button_not_found" };
              }
              button.click();
              await sleep(payload.settleMs ?? 1500);
              return { ok: true, action };
            }
            if (action === "click-button-by-label") {
              const expected = normalizeText(payload.label).toLowerCase();
              const button = findButtonLike((label) => label.includes(expected));
              if (!button) {
                return { ok: false, error: "button_not_found", label: payload.label };
              }
              button.click();
              await sleep(payload.settleMs ?? 1500);
              return { ok: true, action, label: payload.label };
            }
            return { ok: false, error: "unsupported_action", action };
          },
        );
        return {
          ...result,
          capturedBridgeMessages,
          beforeState,
          afterState: snapshotSubmitState(),
        };
      }

      if (mode === "invokeElectronBridgeMessage") {
        if (!window.electronBridge?.sendMessageFromView) {
          return { ok: false, error: "electron_bridge_unavailable" };
        }
        const beforeState = snapshotSubmitState();
        const { capturedBridgeMessages, result } = await captureBridgeTraffic(
          async () => {
            try {
              const value = await window.electronBridge.sendMessageFromView(
                payload.message,
              );
              await sleep(payload.settleMs ?? 1500);
              return { ok: true, returnValue: value ?? null };
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        );
        return {
          ...result,
          capturedBridgeMessages,
          beforeState,
          afterState: snapshotSubmitState(),
        };
      }

      if (mode === "openNewThreadSurface") {
        const beforeUrl = window.location.href;
        const button =
          findButtonLike((label) => label.includes("\\u65b0\\u7ebf\\u7a0b")) ??
          findButtonLike((label) => label.includes("new thread")) ??
          findButtonLike((label) => label.includes("new chat"));
        if (!button) {
          return { ok: false, error: "new_thread_button_not_found" };
        }
        button.click();
        return await waitForNewThreadSurface(beforeUrl);
      }

      if (mode === "exportContextBundle") {
        try {
          const localThreadId = inferConversationId();
          const composer = findComposer();
          const surface = findConversationSurfaceRoot(composer);
          const visibleMessages = surface?.element
            ? collectVisibleMessagesFromRoot(surface.element)
            : collectVisibleMessages();
          return {
            bindingId: payload.bindingId ?? null,
            localThreadId,
            contextVersion: payload.contextVersion ?? 1,
            systemPrompt: "needs_desktop_refresh",
            visibleMessages,
            toolStateSummary: {
              locationHref: window.location.href,
              documentTitle: normalizeText(document.title),
              visibleToolSummaryLabels: collectVisibleToolSummaryLabels(visibleMessages),
              rendererDiagnostics: buildConversationDiagnostics({
                composer,
                surface,
                messages: visibleMessages,
              }),
            },
            attachmentSummary: [],
            memorySummary: {
              note: "Renderer-visible memory only. Durable bridge state lives in the bridge store.",
            },
            reasoningSummary: {
              type: "summary_only",
              text: "Raw hidden reasoning is not exported by this bridge. Use visible conversation state plus explicit summaries only.",
            },
            generatedAt: new Date().toISOString(),
          };
        } catch (error) {
          return buildExportContextErrorResult(error);
        }
      }

      return { ok: false, error: "unsupported_mode", mode };
      } catch (error) {
        return buildTopLevelRendererFailure(error);
      }
    })();
  `;
}

class RendererDomAdapter {
  constructor({ windowTracker }) {
    this.windowTracker = windowTracker;
    this.composerProbeReadyWebContentsIds = new Set();
    this.observedWebContentsIds = new Set();
  }

  _serializeExecuteJavaScriptError(error) {
    return {
      name: String(error?.name ?? "Error"),
      message: String(error?.message ?? error ?? "execute_javascript_failed"),
      stack: String(error?.stack ?? "").slice(0, 4000),
    };
  }

  _buildGetActiveThreadExecutionError(error) {
    return {
      url: null,
      pathname: null,
      title: null,
      localThreadId: null,
      localConversationId: null,
      visibleMessageCount: 0,
      lastVisibleMessage: null,
      hasComposer: false,
      composer: null,
      nearbyButtons: [],
      visibleButtons: [],
      bodyTextPreview: "",
      conversationDiagnostics: null,
      rendererError: this._serializeExecuteJavaScriptError(error),
    };
  }

  _buildExportContextExecutionError({ bindingId, contextVersion }, error) {
    return {
      bindingId: bindingId ?? null,
      localThreadId: null,
      contextVersion: contextVersion ?? 1,
      systemPrompt: "needs_desktop_refresh",
      visibleMessages: [],
      toolStateSummary: {
        locationHref: null,
        documentTitle: null,
        visibleToolSummaryLabels: [],
        rendererDiagnostics: null,
        rendererError: this._serializeExecuteJavaScriptError(error),
      },
      attachmentSummary: [],
      memorySummary: {
        note: "Renderer-visible memory only. Durable bridge state lives in the bridge store.",
      },
      reasoningSummary: {
        type: "summary_only",
        text: "Raw hidden reasoning is not exported by this bridge. Use visible conversation state plus explicit summaries only.",
      },
      generatedAt: new Date().toISOString(),
      rendererError: this._serializeExecuteJavaScriptError(error),
    };
  }

  async getActiveThread() {
    const webContents = this.windowTracker.getPreferredWebContents();
    if (webContents == null) {
      return null;
    }
    try {
      return await webContents.executeJavaScript(createInjectedRunner("getActiveThread"), true);
    } catch (error) {
      return this._buildGetActiveThreadExecutionError(error);
    }
  }

  async getComposerState() {
    const webContents = this.windowTracker.getPreferredWebContents();
    if (webContents == null) {
      return null;
    }
    return this._getComposerStateWithInstalledProbe(webContents);
  }

  async exportContextBundle({ bindingId, contextVersion }) {
    const webContents = this.windowTracker.getPreferredWebContents();
    if (webContents == null) {
      throw new Error("no_window_available");
    }
    try {
      return await webContents.executeJavaScript(
        createInjectedRunner("exportContextBundle", { bindingId, contextVersion }),
        true,
      );
    } catch (error) {
      return this._buildExportContextExecutionError(
        { bindingId, contextVersion },
        error,
      );
    }
  }

  async submitInboundFeishuMessage({
    text,
    expectedThreadId = null,
    waitForThreadTimeoutMs = 5000,
  }) {
    const webContents = this.windowTracker.getPreferredWebContents();
    if (webContents == null) {
      throw new Error("no_window_available");
    }
    return webContents.executeJavaScript(
      createInjectedRunner("submitUserMessage", {
        text,
        expectedThreadId,
        waitForThreadTimeoutMs,
      }),
      true,
    );
  }

  async probeSubmitPath({
    text,
    expectedThreadId = null,
    waitForThreadTimeoutMs = 5000,
  }) {
    const webContents = this.windowTracker.getPreferredWebContents();
    if (webContents == null) {
      throw new Error("no_window_available");
    }
    return webContents.executeJavaScript(
      createInjectedRunner("probeSubmitPath", {
        text,
        expectedThreadId,
        waitForThreadTimeoutMs,
      }),
      true,
    );
  }

  async openNewThreadSurface({ waitForThreadTimeoutMs = 5000 } = {}) {
    const webContents = this.windowTracker.getPreferredWebContents();
    if (webContents == null) {
      throw new Error("no_window_available");
    }
    return webContents.executeJavaScript(
      createInjectedRunner("openNewThreadSurface", {
        waitForThreadTimeoutMs,
      }),
      true,
    );
  }

  async probeUiAction({ action, label = null, settleMs = 1500 } = {}) {
    const webContents = this.windowTracker.getPreferredWebContents();
    if (webContents == null) {
      throw new Error("no_window_available");
    }
    return webContents.executeJavaScript(
      createInjectedRunner("probeUiAction", {
        action,
        label,
        settleMs,
      }),
      true,
    );
  }

  async invokeElectronBridgeMessage({ message, settleMs = 1500 }) {
    const webContents = this.windowTracker.getPreferredWebContents();
    if (webContents == null) {
      throw new Error("no_window_available");
    }
    return webContents.executeJavaScript(
      createInjectedRunner("invokeElectronBridgeMessage", {
        message,
        settleMs,
      }),
      true,
    );
  }

  async _getComposerStateWithInstalledProbe(webContents) {
    this._observeWebContentsLifecycle(webContents);
    if (this.composerProbeReadyWebContentsIds.has(webContents.id)) {
      const cachedState = await webContents
        .executeJavaScript(
          "window.__codexFeishuBridgeGetComposerState?.() ?? null",
          true,
        )
        .catch(() => null);
      if (cachedState != null) {
        return cachedState;
      }
      this.composerProbeReadyWebContentsIds.delete(webContents.id);
    }
    const installedState = await webContents.executeJavaScript(
      createComposerStateRunner(),
      true,
    );
    if (installedState != null) {
      this.composerProbeReadyWebContentsIds.add(webContents.id);
    }
    return installedState;
  }

  _observeWebContentsLifecycle(webContents) {
    if (webContents == null || this.observedWebContentsIds.has(webContents.id)) {
      return;
    }
    this.observedWebContentsIds.add(webContents.id);
    const clearComposerProbe = () => {
      this.composerProbeReadyWebContentsIds.delete(webContents.id);
    };
    webContents.on("did-start-loading", clearComposerProbe);
    webContents.once("destroyed", () => {
      clearComposerProbe();
      this.observedWebContentsIds.delete(webContents.id);
    });
  }
}

module.exports = {
  RendererDomAdapter,
};
