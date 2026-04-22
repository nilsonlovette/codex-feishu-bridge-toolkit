"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

let puppeteer = null;
try {
  puppeteer = require("puppeteer-core");
} catch {
  puppeteer = null;
}

const SUPPORTED_MERMAID_TYPES = Object.freeze(
  new Set(["graph", "flowchart", "sequenceDiagram", "classDiagram"]),
);
const MERMAID_TALL_LAYOUT_MIN_HEIGHT = 520;
const MERMAID_TALL_LAYOUT_MIN_HEIGHT_RATIO = 1.6;
const MERMAID_WIDE_LAYOUT_MAX_WIDTH_RATIO = 5.5;
const MERMAID_WIDE_LAYOUT_MIN_HEIGHT_GAIN = 0.72;
const MERMAID_WIDE_LAYOUT_MIN_WIDTH_GAIN = 1.1;
const MERMAID_WIDE_LAYOUT_MIN_IMBALANCE_GAIN = 0.88;
const MERMAID_SCREENSHOT_MIN_PIXEL_WIDTH = 1600;
const MERMAID_SCREENSHOT_MIN_PIXEL_HEIGHT = 640;
const MERMAID_SCREENSHOT_MAX_SCALE_FACTOR = 5;

function buildMermaidSourceExcerpt(source, maxChars = 240) {
  const normalized = String(source ?? "").replace(/\s+/g, " ").trim();
  const limit = Math.max(48, Number(maxChars) || 240);
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1).trimEnd()}...`;
}

function normalizeMermaidTimeoutMs(timeoutMs, fallback = 12000) {
  return Math.max(1000, Number(timeoutMs) || fallback);
}

function detectMermaidDiagramType(source) {
  const lines = String(source ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  let inDirective = false;
  for (const rawLine of lines) {
    const line = String(rawLine ?? "").trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("%%{")) {
      inDirective = !line.endsWith("}%%");
      continue;
    }
    if (inDirective) {
      if (line.endsWith("}%%")) {
        inDirective = false;
      }
      continue;
    }
    if (line.startsWith("%%")) {
      continue;
    }
    const token = line.split(/\s+/)[0] ?? "";
    return token.trim();
  }
  return "";
}

function isSupportedMermaidDiagramType(diagramType) {
  return SUPPORTED_MERMAID_TYPES.has(String(diagramType ?? "").trim());
}

function normalizeMermaidLineBreaks(source) {
  return String(source ?? "").replace(/\r\n/g, "\n");
}

function rewriteMermaidFlowchartDirection(source, nextDirection = "LR") {
  const targetDirection = String(nextDirection ?? "").trim().toUpperCase() || "LR";
  const lines = normalizeMermaidLineBreaks(source).split("\n");
  let inDirective = false;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = String(lines[index] ?? "");
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("%%{")) {
      inDirective = !trimmed.endsWith("}%%");
      continue;
    }
    if (inDirective) {
      if (trimmed.endsWith("}%%")) {
        inDirective = false;
      }
      continue;
    }
    if (trimmed.startsWith("%%")) {
      continue;
    }
    const match = rawLine.match(/^(\s*(?:flowchart|graph)\s+)(TB|TD|BT|RL|LR)\b(.*)$/i);
    if (!match) {
      return null;
    }
    const previousDirection = String(match[2] ?? "").trim().toUpperCase();
    if (previousDirection === targetDirection) {
      return {
        changed: false,
        source: normalizeMermaidLineBreaks(source),
        previousDirection,
        nextDirection: targetDirection,
      };
    }
    lines[index] = `${match[1]}${targetDirection}${match[3] ?? ""}`;
    return {
      changed: true,
      source: lines.join("\n"),
      previousDirection,
      nextDirection: targetDirection,
    };
  }
  return null;
}

function extractSimpleMermaidNodeId(spec) {
  const match = String(spec ?? "")
    .trim()
    .match(/^([A-Za-z][A-Za-z0-9_]*)\b/);
  return match ? match[1] : null;
}

function parseSimpleLinearFlowchart(source) {
  const lines = normalizeMermaidLineBreaks(source).split("\n");
  let inDirective = false;
  const bodyLines = [];
  let headerSeen = false;
  for (const rawLine of lines) {
    const trimmed = String(rawLine ?? "").trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("%%{")) {
      inDirective = !trimmed.endsWith("}%%");
      return null;
    }
    if (inDirective) {
      if (trimmed.endsWith("}%%")) {
        inDirective = false;
      }
      return null;
    }
    if (trimmed.startsWith("%%")) {
      return null;
    }
    if (!headerSeen) {
      if (/^(?:flowchart|graph)\b/i.test(trimmed)) {
        headerSeen = true;
        continue;
      }
      return null;
    }
    bodyLines.push(trimmed);
  }
  if (!headerSeen || bodyLines.length < 4) {
    return null;
  }

  const edges = [];
  const nodeSpecs = new Map();
  const incoming = new Map();
  const outgoing = new Map();
  for (const line of bodyLines) {
    if (
      /^(?:style|classDef|class|click|linkStyle|subgraph|end)\b/i.test(line) ||
      line.includes("&") ||
      line.includes("---") ||
      line.includes("-.") ||
      line.includes("==")
    ) {
      return null;
    }
    const parts = line.split(/\s+-->\s+/);
    if (parts.length !== 2) {
      return null;
    }
    const leftSpec = parts[0].trim();
    const rightSpec = parts[1].trim();
    const leftId = extractSimpleMermaidNodeId(leftSpec);
    const rightId = extractSimpleMermaidNodeId(rightSpec);
    if (!leftId || !rightId) {
      return null;
    }
    if (leftSpec !== leftId || !nodeSpecs.has(leftId)) {
      nodeSpecs.set(leftId, leftSpec);
    }
    if (rightSpec !== rightId || !nodeSpecs.has(rightId)) {
      nodeSpecs.set(rightId, rightSpec);
    }
    edges.push({ fromId: leftId, toId: rightId });
    outgoing.set(leftId, (outgoing.get(leftId) ?? 0) + 1);
    incoming.set(rightId, (incoming.get(rightId) ?? 0) + 1);
    incoming.set(leftId, incoming.get(leftId) ?? 0);
    outgoing.set(rightId, outgoing.get(rightId) ?? 0);
  }

  const nodeIds = [...nodeSpecs.keys()];
  if (nodeIds.length !== edges.length + 1) {
    return null;
  }
  const starts = nodeIds.filter((nodeId) => (incoming.get(nodeId) ?? 0) === 0);
  const ends = nodeIds.filter((nodeId) => (outgoing.get(nodeId) ?? 0) === 0);
  if (starts.length !== 1 || ends.length !== 1) {
    return null;
  }
  for (const nodeId of nodeIds) {
    const inDegree = incoming.get(nodeId) ?? 0;
    const outDegree = outgoing.get(nodeId) ?? 0;
    if (nodeId === starts[0]) {
      if (inDegree !== 0 || outDegree !== 1) {
        return null;
      }
      continue;
    }
    if (nodeId === ends[0]) {
      if (inDegree !== 1 || outDegree !== 0) {
        return null;
      }
      continue;
    }
    if (inDegree !== 1 || outDegree !== 1) {
      return null;
    }
  }

  const nextByNode = new Map(edges.map((edge) => [edge.fromId, edge.toId]));
  const orderedNodeIds = [];
  let cursor = starts[0];
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    orderedNodeIds.push(cursor);
    seen.add(cursor);
    cursor = nextByNode.get(cursor) ?? null;
  }
  if (orderedNodeIds.length !== nodeIds.length) {
    return null;
  }
  return {
    orderedNodes: orderedNodeIds.map((nodeId) => ({
      id: nodeId,
      spec: nodeSpecs.get(nodeId) ?? nodeId,
    })),
  };
}

function buildSnakeMermaidFlowchartSource(source) {
  const parsed = parseSimpleLinearFlowchart(source);
  if (!parsed || parsed.orderedNodes.length < 5) {
    return null;
  }
  const orderedNodes = parsed.orderedNodes;
  const firstRowCount = Math.ceil(orderedNodes.length / 2);
  const firstRow = orderedNodes.slice(0, firstRowCount);
  const secondRow = orderedNodes.slice(firstRowCount);
  if (secondRow.length < 2) {
    return null;
  }
  const reversedSecondRow = [...secondRow].reverse();
  const connectorTarget = secondRow[0];
  return {
    changed: true,
    source: [
      "flowchart LR",
      `  ${firstRow.map((node) => node.spec).join(" --> ")}`,
      `  ${reversedSecondRow.map((node) => node.spec).join(" --> ")}`,
      `  ${firstRow[firstRow.length - 1].id} --> ${connectorTarget.id}`,
    ].join("\n"),
    strategy: "snake_two_row",
    nodeCount: orderedNodes.length,
  };
}

function measureMermaidLayoutImbalance(width, height) {
  const safeWidth = Math.max(1, Number(width) || 0);
  const safeHeight = Math.max(1, Number(height) || 0);
  return Math.max(safeWidth, safeHeight) / Math.max(1, Math.min(safeWidth, safeHeight));
}

function shouldAttemptWideMermaidLayout({ diagramType, source, width, height } = {}) {
  const normalizedType = String(diagramType ?? "").trim();
  if (normalizedType !== "flowchart" && normalizedType !== "graph") {
    return {
      attempt: false,
      reason: "diagram_type_not_supported",
    };
  }
  const rewrite = rewriteMermaidFlowchartDirection(source, "LR");
  if (!rewrite || !rewrite.changed) {
    return {
      attempt: false,
      reason: rewrite ? "direction_already_horizontal" : "direction_not_rewritable",
    };
  }
  if (!["TD", "TB"].includes(rewrite.previousDirection)) {
    return {
      attempt: false,
      reason: "direction_not_vertical",
    };
  }
  const safeWidth = Math.max(1, Number(width) || 0);
  const safeHeight = Math.max(1, Number(height) || 0);
  if (
    safeHeight < MERMAID_TALL_LAYOUT_MIN_HEIGHT ||
    safeHeight / safeWidth < MERMAID_TALL_LAYOUT_MIN_HEIGHT_RATIO
  ) {
    return {
      attempt: false,
      reason: "layout_not_tall_enough",
      rewrite,
    };
  }
  return {
    attempt: true,
    reason: "vertical_flowchart_tall_layout",
    rewrite,
  };
}

function shouldPreferWideMermaidLayout(primary, candidate) {
  if (!primary || !candidate) {
    return false;
  }
  const primaryWidth = Math.max(1, Number(primary.width) || 0);
  const primaryHeight = Math.max(1, Number(primary.height) || 0);
  const candidateWidth = Math.max(1, Number(candidate.width) || 0);
  const candidateHeight = Math.max(1, Number(candidate.height) || 0);
  const candidateLandscapeRatio = candidateWidth / candidateHeight;
  if (candidateLandscapeRatio > MERMAID_WIDE_LAYOUT_MAX_WIDTH_RATIO) {
    return false;
  }
  const primaryImbalance = measureMermaidLayoutImbalance(primaryWidth, primaryHeight);
  const candidateImbalance = measureMermaidLayoutImbalance(candidateWidth, candidateHeight);
  if (candidateImbalance <= primaryImbalance * MERMAID_WIDE_LAYOUT_MIN_IMBALANCE_GAIN) {
    return true;
  }
  return (
    candidateHeight <= primaryHeight * MERMAID_WIDE_LAYOUT_MIN_HEIGHT_GAIN &&
    candidateWidth >= primaryWidth * MERMAID_WIDE_LAYOUT_MIN_WIDTH_GAIN
  );
}

function computeMermaidScreenshotScaleFactor(width, height) {
  const safeWidth = Math.max(1, Number(width) || 0);
  const safeHeight = Math.max(1, Number(height) || 0);
  const widthScale = Math.ceil(MERMAID_SCREENSHOT_MIN_PIXEL_WIDTH / safeWidth);
  const heightScale = Math.ceil(MERMAID_SCREENSHOT_MIN_PIXEL_HEIGHT / safeHeight);
  return Math.max(
    1,
    Math.min(
      MERMAID_SCREENSHOT_MAX_SCALE_FACTOR,
      Math.max(widthScale, heightScale),
    ),
  );
}

function detectMermaidBrowserExecutable() {
  const candidates = [
    process.env.CODEX_FEISHU_MERMAID_BROWSER,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ]
    .map((candidate) => String(candidate ?? "").trim())
    .filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function buildMermaidBundlePath() {
  return path.join(__dirname, "node_modules", "mermaid", "dist", "mermaid.min.js");
}

function getMermaidBundlePath() {
  const bundlePath = buildMermaidBundlePath();
  return fs.existsSync(bundlePath) ? bundlePath : null;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildMermaidRenderHtml({ mermaidBundlePath, source }) {
  const bundleUrl = pathToFileURL(mermaidBundlePath).href;
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #ffffff;
      }
      body {
        display: inline-block;
      }
      #diagram {
        display: inline-block;
        padding: 16px;
        background: #ffffff;
      }
      #render-error {
        color: #a61b1b;
        white-space: pre-wrap;
        font: 12px/1.5 Consolas, monospace;
        padding: 16px;
      }
    </style>
    <script src="${bundleUrl}"></script>
  </head>
  <body>
    <div id="diagram" class="mermaid">${escapeHtml(source)}</div>
    <script>
      const SOURCE = ${JSON.stringify(String(source ?? ""))};
      const host = document.getElementById("diagram");
      host.textContent = SOURCE;
      (async () => {
        try {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "loose",
            theme: "default",
            flowchart: {
              htmlLabels: false,
            },
            themeVariables: {
              fontSize: "18px",
              fontFamily:
                "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif",
            },
          });
          await mermaid.run({ nodes: [host] });
          document.body.setAttribute("data-render-status", "done");
        } catch (error) {
          document.body.setAttribute("data-render-status", "error");
          const block = document.createElement("pre");
          block.id = "render-error";
          block.textContent = String(error && (error.stack || error.message) || error);
          document.body.appendChild(block);
        }
      })();
    </script>
  </body>
</html>`;
}

async function renderMermaidSourceVariant({
  browser,
  source,
  mermaidBundlePath,
  renderDir,
  fileStem = "diagram",
  timeoutMs,
} = {}) {
  const renderHtmlPath = path.join(renderDir, `${fileStem}.html`);
  await fs.promises.writeFile(
    renderHtmlPath,
    buildMermaidRenderHtml({
      mermaidBundlePath,
      source,
    }),
    "utf8",
  );

  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    await page.setViewport({
      width: 2400,
      height: 2400,
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(renderHtmlPath).href, {
      waitUntil: "load",
      timeout: timeoutMs,
    });
    await page.waitForFunction(
      () =>
        document.body.getAttribute("data-render-status") === "done" ||
        document.body.getAttribute("data-render-status") === "error",
      {
        timeout: timeoutMs,
      },
    );
    const renderStatus = await page.evaluate(() =>
      document.body.getAttribute("data-render-status"),
    );
    if (renderStatus !== "done") {
      const renderError =
        (await page.$eval("#render-error", (node) => node.textContent).catch(() => null)) ??
        "unknown";
      throw new Error(`mermaid_render_failed:${String(renderError ?? "").trim() || "svg_missing"}`);
    }
    const svgMarkup = await page.$eval("#diagram svg", (node) => node.outerHTML);
    if (!svgMarkup) {
      throw new Error("mermaid_render_failed:svg_missing");
    }
    const svgPath = path.join(renderDir, `${fileStem}.svg`);
    await fs.promises.writeFile(svgPath, svgMarkup, "utf8");

    const diagramHandle = await page.$("#diagram svg");
    if (!diagramHandle) {
      throw new Error("mermaid_render_failed:svg_missing");
    }
    const bounds = await diagramHandle.boundingBox();
    const screenshotScaleFactor = computeMermaidScreenshotScaleFactor(
      bounds?.width,
      bounds?.height,
    );
    if (screenshotScaleFactor > 1) {
      await page.setViewport({
        width: 2400,
        height: 2400,
        deviceScaleFactor: screenshotScaleFactor,
      });
    }
    const pngPath = path.join(renderDir, `${fileStem}.png`);
    const screenshotHandle =
      screenshotScaleFactor > 1 ? await page.$("#diagram svg") : diagramHandle;
    if (!screenshotHandle) {
      throw new Error("mermaid_render_failed:svg_missing");
    }
    await screenshotHandle.screenshot({
      path: pngPath,
      omitBackground: false,
    });
    if (!fs.existsSync(pngPath)) {
      throw new Error("mermaid_screenshot_missing");
    }

    return {
      pngPath,
      svgPath,
      width: Math.ceil(bounds?.width ?? 0),
      height: Math.ceil(bounds?.height ?? 0),
      pixelWidth: Math.ceil((bounds?.width ?? 0) * screenshotScaleFactor),
      pixelHeight: Math.ceil((bounds?.height ?? 0) * screenshotScaleFactor),
      screenshotScaleFactor,
    };
  } finally {
    await page.close().catch(() => void 0);
  }
}

async function renderMermaidDiagramToPng({
  source,
  outputDir,
  browserPath = detectMermaidBrowserExecutable(),
  mermaidBundlePath = getMermaidBundlePath(),
  timeoutMs = 12000,
} = {}) {
  const normalizedTimeoutMs = normalizeMermaidTimeoutMs(timeoutMs);
  const startedAt = Date.now();
  const sourceExcerpt = buildMermaidSourceExcerpt(source);
  if (!puppeteer) {
    throw new Error("mermaid_puppeteer_unavailable");
  }
  if (!browserPath) {
    throw new Error("mermaid_browser_unavailable");
  }
  if (!mermaidBundlePath) {
    throw new Error("mermaid_bundle_unavailable");
  }
  const diagramType = detectMermaidDiagramType(source);
  if (!isSupportedMermaidDiagramType(diagramType)) {
    throw new Error(`mermaid_diagram_type_unsupported:${diagramType || "unknown"}`);
  }

  const safeOutputDir =
    String(outputDir ?? "").trim() || path.join(os.tmpdir(), "codex-feishu-mermaid");
  await fs.promises.mkdir(safeOutputDir, { recursive: true });
  const hash = crypto.createHash("sha1").update(String(source ?? ""), "utf8").digest("hex");
  const renderDir = path.join(safeOutputDir, hash);
  await fs.promises.mkdir(renderDir, { recursive: true });

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: "new",
      args: [
        "--allow-file-access-from-files",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
      ],
    });
    const primaryRender = await renderMermaidSourceVariant({
      browser,
      source,
      mermaidBundlePath,
      renderDir,
      fileStem: "diagram",
      timeoutMs: normalizedTimeoutMs,
    });
    let selectedRender = primaryRender;
    let layoutStrategy = "original";
    const wideAttempt = shouldAttemptWideMermaidLayout({
      diagramType,
      source,
      width: primaryRender.width,
      height: primaryRender.height,
    });
    if (wideAttempt.attempt) {
      const candidateVariants = [];
      const snakeRewrite = buildSnakeMermaidFlowchartSource(source);
      if (snakeRewrite?.changed) {
        candidateVariants.push({
          source: snakeRewrite.source,
          strategy: snakeRewrite.strategy,
          fileStem: "diagram-snake",
        });
      }
      candidateVariants.push({
        source: wideAttempt.rewrite.source,
        strategy: `rewritten_${wideAttempt.rewrite.previousDirection.toLowerCase()}_to_lr`,
        fileStem: "diagram-wide",
      });
      for (const candidate of candidateVariants) {
        try {
          const candidateRender = await renderMermaidSourceVariant({
            browser,
            source: candidate.source,
            mermaidBundlePath,
            renderDir,
            fileStem: candidate.fileStem,
            timeoutMs: normalizedTimeoutMs,
          });
          if (shouldPreferWideMermaidLayout(primaryRender, candidateRender)) {
            selectedRender = candidateRender;
            layoutStrategy = candidate.strategy;
            break;
          }
        } catch {
          // Keep the original render when an optional layout rewrite fails.
        }
      }
    }

    return {
      diagramType,
      hash,
      pngPath: selectedRender.pngPath,
      svgPath: selectedRender.svgPath,
      width: selectedRender.width,
      height: selectedRender.height,
      pixelWidth: selectedRender.pixelWidth,
      pixelHeight: selectedRender.pixelHeight,
      screenshotScaleFactor: selectedRender.screenshotScaleFactor,
      elapsedMs: Date.now() - startedAt,
      browserPath,
      layoutStrategy,
    };
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error ?? "unknown"));
    normalizedError.mermaidMeta = {
      diagramType,
      browserPath,
      elapsedMs: Date.now() - startedAt,
      sourceExcerpt,
      timeoutMs: normalizedTimeoutMs,
    };
    throw normalizedError;
  } finally {
    await browser?.close().catch(() => void 0);
  }
}

module.exports = {
  detectMermaidBrowserExecutable,
  detectMermaidDiagramType,
  getMermaidBundlePath,
  isSupportedMermaidDiagramType,
  rewriteMermaidFlowchartDirection,
  buildSnakeMermaidFlowchartSource,
  computeMermaidScreenshotScaleFactor,
  parseSimpleLinearFlowchart,
  shouldAttemptWideMermaidLayout,
  shouldPreferWideMermaidLayout,
  renderMermaidDiagramToPng,
};
