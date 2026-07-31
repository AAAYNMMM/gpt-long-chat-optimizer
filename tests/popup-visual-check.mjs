import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const artifactDir = join(root, "artifacts", "design-qa");
const referencePath = join(artifactDir, "popup-v0.3.1-reference.png");
const lightPath = join(artifactDir, "popup-v0.3.2-light.png");
const darkPath = join(artifactDir, "popup-v0.3.2-dark.png");
const comparisonPath = join(artifactDir, "popup-v0.3.2-comparison.png");
const previewUrl = process.env.GLCO_POPUP_PREVIEW_URL
  ?? "http://127.0.0.1:4173/extension/popup.html";

await mkdir(artifactDir, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
let metrics;

try {
  const context = await browser.newContext({
    colorScheme: "light",
    deviceScaleFactor: 1,
    viewport: { width: 340, height: 600 }
  });

  await context.addInitScript(() => {
    const preview = {
      rescueCalls: 0,
      settings: {
        enabled: true,
        mode: "balanced"
      }
    };

    const status = () => ({
      active: true,
      chunks: 56,
      enabled: preview.settings.enabled,
      frozen: 0,
      frozenChunks: 12,
      healthIssue: "none",
      mode: preview.settings.mode,
      paused: false,
      startupRescue: true,
      thinkingOptimized: true,
      turns: 6
    });

    globalThis.__GLCO_POPUP_PREVIEW__ = preview;
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage(_message, callback) {
          preview.rescueCalls += 1;
          callback({
            discardedOldTab: true,
            ok: true
          });
        }
      },
      storage: {
        sync: {
          get(defaults, callback) {
            callback({
              ...defaults,
              ...preview.settings
            });
          },
          set(patch, callback) {
            Object.assign(preview.settings, patch);
            callback();
          }
        }
      },
      tabs: {
        query(_query, callback) {
          callback([{
            id: 1,
            index: 0,
            url: "https://chatgpt.com/c/layout-preview"
          }]);
        },
        sendMessage(_tabId, _message, callback) {
          callback(status());
        }
      }
    };
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });

  await page.goto(previewUrl, { waitUntil: "load" });
  await page.waitForFunction(() => (
    document.getElementById("status-title")?.textContent === "正在优化长思考"
  ));

  metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const rows = Array.from(document.querySelectorAll(".mode-option"), (element) => {
      const rect = element.getBoundingClientRect();
      const title = element.querySelector("strong").getBoundingClientRect();
      const note = element.querySelector("small").getBoundingClientRect();
      return {
        height: rect.height,
        noteLeft: note.left,
        noteRight: note.right,
        rowRight: rect.right,
        titleLeft: title.left
      };
    });

    return {
      bodyScrollHeight: document.body.scrollHeight,
      clientHeight: root.clientHeight,
      clientWidth: root.clientWidth,
      rows,
      scrollHeight: root.scrollHeight,
      scrollWidth: root.scrollWidth
    };
  });

  assert.equal(metrics.clientWidth, 340);
  assert.equal(metrics.clientHeight, 600);
  assert.equal(metrics.scrollWidth, metrics.clientWidth, "弹窗不应横向滚动");
  assert.equal(metrics.scrollHeight, metrics.clientHeight, "弹窗不应纵向滚动");
  assert.ok(metrics.bodyScrollHeight <= metrics.clientHeight);
  assert.deepEqual(metrics.rows.map((row) => row.height), [38, 38, 38]);
  assert.ok(metrics.rows.every((row) => row.noteLeft > row.titleLeft));
  assert.ok(metrics.rows.every((row) => row.noteRight < row.rowRight));

  await page.screenshot({ path: lightPath });

  const strong = page.getByRole("radio", { name: /强力/ });
  await strong.check();
  await page.waitForFunction(() => (
    globalThis.__GLCO_POPUP_PREVIEW__.settings.mode === "strong"
  ));
  assert.equal(await strong.isChecked(), true);

  await strong.focus();
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => (
    globalThis.__GLCO_POPUP_PREVIEW__.settings.mode === "balanced"
  ));
  assert.equal(
    await page.getByRole("radio", { name: /均衡/ }).isChecked(),
    true
  );

  const enabled = page.getByRole("checkbox", { name: "启用优化" });
  const switchTrack = page.locator(".switch-track");
  await switchTrack.click();
  assert.equal(await enabled.isChecked(), false);
  await page.waitForFunction(() => (
    document.getElementById("status-title")?.textContent === "优化已暂停"
  ));
  await switchTrack.click();
  assert.equal(await enabled.isChecked(), true);
  await page.waitForFunction(() => (
    document.getElementById("status-title")?.textContent === "正在优化长思考"
  ));

  await page.getByRole("button", { name: "救援重开当前对话" }).click();
  await page.waitForFunction(() => (
    document.getElementById("recovery-result")?.textContent
      === "已在新标签页重开，并休眠旧页。"
  ));
  assert.equal(
    await page.evaluate(() => globalThis.__GLCO_POPUP_PREVIEW__.rescueCalls),
    1
  );

  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => (
    document.getElementById("status-title")?.textContent === "正在优化长思考"
  ));
  await page.emulateMedia({ colorScheme: "dark" });
  const darkMetrics = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    width: document.documentElement.scrollWidth
  }));
  assert.deepEqual(darkMetrics, { height: 600, width: 340 });
  await page.screenshot({ path: darkPath });

  assert.deepEqual(errors, [], "弹窗预览不应产生控制台错误");
  await context.close();
} finally {
  await browser.close();
}

const labelHeight = 36;
const padding = 12;
const gap = 20;
const comparisonWidth = (340 * 2) + (padding * 2) + gap;
const comparisonHeight = 600 + labelHeight + padding;
const labels = Buffer.from(`
  <svg width="${comparisonWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">
    <style>
      text {
        fill: #172033;
        font: 700 14px "Segoe UI", sans-serif;
      }
    </style>
    <text x="${padding}" y="24">原始弹窗</text>
    <text x="${padding + 340 + gap}" y="24">v0.3.2 紧凑布局</text>
  </svg>
`);

await sharp({
  create: {
    background: "#e7e9f0",
    channels: 4,
    height: comparisonHeight,
    width: comparisonWidth
  }
})
  .composite([
    { input: labels, left: 0, top: 0 },
    { input: referencePath, left: padding, top: labelHeight },
    { input: lightPath, left: padding + 340 + gap, top: labelHeight }
  ])
  .png()
  .toFile(comparisonPath);

console.log(JSON.stringify({
  comparisonPath,
  darkPath,
  errors,
  lightPath,
  metrics
}, null, 2));
