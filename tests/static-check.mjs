import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "extension");
const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
const content = await readFile(join(extensionDir, "content.js"), "utf8");
const liveProtection = await readFile(
  join(extensionDir, "live-turn-protection.js"),
  "utf8"
);
const background = await readFile(join(extensionDir, "background.js"), "utf8");
const popup = await readFile(join(extensionDir, "popup.js"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.2.0");
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
assert.deepEqual(
  manifest.content_scripts[0].js,
  ["content.js", "live-turn-protection.js"],
  "实时消息保护脚本应在核心优化脚本后加载"
);

for (const file of [content, liveProtection, background, popup]) {
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
assert.match(content, /data-testid\^="conversation-turn-"/);
assert.match(content, /data-message-author-role/);
assert.match(liveProtection, /LIVE_TURN_COUNT\s*=\s*4/);
assert.match(liveProtection, /data-glco-live="true"/);
assert.match(liveProtection, /content-visibility:\s*visible\s*!important/);
assert.match(liveProtection, /contain-intrinsic-(?:block-)?size:\s*none\s*!important/);
assert.match(liveProtection, /delete turn\.dataset\.glcoFrozen/);

for (const file of [content, liveProtection]) {
  assert.doesNotMatch(file, /\.innerText\b/, "内容脚本不应读取会话文字");
  assert.doesNotMatch(
    file,
    /\.textContent\b(?!\s*=)/,
    "内容脚本不应读取会话文字"
  );
}

console.log("✓ Manifest、权限、语法、隐私边界、离屏优化与实时消息保护检查通过");
