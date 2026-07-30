import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "extension");
const packageJson = JSON.parse(
  await readFile(join(here, "..", "package.json"), "utf8")
);
const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
const content = await readFile(join(extensionDir, "content.js"), "utf8");
const early = await readFile(join(extensionDir, "early.js"), "utf8");
const earlyCss = await readFile(join(extensionDir, "early.css"), "utf8");
const background = await readFile(join(extensionDir, "background.js"), "utf8");
const popup = await readFile(join(extensionDir, "popup.js"), "utf8");
const popupHtml = await readFile(join(extensionDir, "popup.html"), "utf8");
const popupCss = await readFile(join(extensionDir, "popup.css"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.3.2");
assert.equal(packageJson.version, manifest.version);
assert.deepEqual(
  new Set(manifest.permissions),
  new Set(["storage", "activeTab"]),
  "扩展应只申请必要权限"
);
assert.equal(manifest.host_permissions, undefined, "不应申请额外主机权限");
assert.deepEqual(
  manifest.content_scripts[0].matches,
  ["https://chatgpt.com/*", "https://chat.openai.com/*"]
);
assert.equal(manifest.content_scripts[0].run_at, "document_start");
assert.deepEqual(manifest.content_scripts[0].css, ["early.css"]);
assert.deepEqual(manifest.content_scripts[0].js, ["early.js"]);
assert.equal(manifest.content_scripts[1].run_at, "document_idle");
assert.deepEqual(manifest.content_scripts[1].js, ["content.js"]);

for (const file of [content, early, background, popup]) {
  assert.doesNotMatch(
    file,
    /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/,
    "扩展运行代码不应发起网络请求"
  );
  // Parse each script without executing browser-specific globals.
  Function(file);
}

assert.match(content, /content-visibility:\s*auto/);
assert.match(content, /content-visibility:\s*hidden/);
assert.match(content, /data-glco-chunk="true"/);
assert.match(content, /data-glco-chunk-frozen="true"/);
assert.match(content, /chunkActivationScreens/);
assert.match(content, /chunkActivationBlocks/);
assert.doesNotMatch(
  content,
  /characterData:\s*true/,
  "内容观察器不应在流式生成的每个文字变化上触发"
);
assert.match(content, /childList:\s*true/);
assert.match(content, /data-testid\^="conversation-turn-"/);
assert.match(content, /data-message-author-role/);
assert.doesNotMatch(content, /\.innerText\b/, "内容脚本不应读取会话文字");
assert.equal(
  (content.match(/\.textContent\b(?!\s*=)/g) ?? []).length,
  1,
  "内容脚本只能读取一个候选错误提示的文字，不得读取聊天内容"
);
assert.match(content, /function classifyPageAlert\(element\)/);
assert.match(content, /ERROR_TEXT_PATTERNS/);
assert.match(content, /checkVisibility/);
assert.match(content, /getClientRects/);
assert.match(content, /healthIssue/);
assert.match(content, /slice\(0,\s*1_000\)/);
assert.doesNotMatch(
  content,
  /\b(getBoundingClientRect|getComputedStyle)\b/,
  "内容脚本不应在初始扫描中强制同步布局"
);
assert.match(earlyCss, /content-visibility:\s*auto/);
assert.match(early, /glcoStartup/);
assert.match(background, /GLCO_RESCUE_REOPEN/);
assert.match(background, /chrome\.tabs\.discard/);
assert.match(popup, /GLCO_RESCUE_REOPEN/);
assert.doesNotMatch(popupHtml, /class="mode-option"[\s\S]*?<span>/);
assert.match(popupCss, /grid-template-columns:\s*15px auto minmax\(0,\s*1fr\)/);
assert.match(popupCss, /\.mode-option small\s*\{[\s\S]*?text-align:\s*right/);

console.log("✓ Manifest、首屏注入、权限、语法、隐私边界与救援流程检查通过");
