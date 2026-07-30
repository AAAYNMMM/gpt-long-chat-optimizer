"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  mode: "balanced"
});

const elements = {
  enabled: document.getElementById("enabled"),
  statusDot: document.getElementById("status-dot"),
  statusTitle: document.getElementById("status-title"),
  statusDetail: document.getElementById("status-detail"),
  turnCount: document.getElementById("turn-count"),
  frozenCount: document.getElementById("frozen-count"),
  revealAll: document.getElementById("reveal-all"),
  modes: Array.from(document.querySelectorAll('input[name="mode"]'))
};

let currentTabId = null;
let refreshTimer = 0;

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, resolve);
  });
}

function setSettings(patch) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(patch, resolve);
  });
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] ?? null);
    });
  });
}

function sendToTab(message) {
  return new Promise((resolve, reject) => {
    if (currentTabId === null) {
      reject(new Error("没有活动页面"));
      return;
    }
    chrome.tabs.sendMessage(currentTabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function renderSettings(settings) {
  elements.enabled.checked = settings.enabled !== false;
  const mode = ["safe", "balanced", "strong"].includes(settings.mode)
    ? settings.mode
    : DEFAULT_SETTINGS.mode;
  for (const input of elements.modes) {
    input.checked = input.value === mode;
  }
}

function renderUnavailable() {
  elements.statusDot.className = "status-dot error";
  elements.statusTitle.textContent = "当前页面不可用";
  elements.statusDetail.textContent = "请打开 chatgpt.com 的聊天页面";
  elements.turnCount.textContent = "—";
  elements.frozenCount.textContent = "—";
  elements.revealAll.disabled = true;
}

function renderStatus(status) {
  if (!status) {
    renderUnavailable();
    return;
  }

  elements.turnCount.textContent = String(status.turns ?? 0);
  elements.frozenCount.textContent = String(status.frozen ?? 0);
  elements.revealAll.disabled = !status.enabled || !status.active;

  if (!status.enabled) {
    elements.statusDot.className = "status-dot paused";
    elements.statusTitle.textContent = "优化已暂停";
    elements.statusDetail.textContent = "页面保持原始渲染方式";
    return;
  }

  if (status.paused) {
    elements.statusDot.className = "status-dot paused";
    elements.statusTitle.textContent = "暂时显示全部";
    elements.statusDetail.textContent = "30 秒后自动恢复优化";
    return;
  }

  if (status.active) {
    const recentByMode = { safe: 14, balanced: 10, strong: 6 };
    elements.statusDot.className = "status-dot active";
    elements.statusTitle.textContent = "正在优化";
    elements.statusDetail.textContent = `远处消息已轻量化，最近 ${recentByMode[status.mode] ?? 10} 条保持完整`;
    return;
  }

  elements.statusDot.className = "status-dot";
  elements.statusTitle.textContent = "等待长会话";
  elements.statusDetail.textContent = `达到 ${status.activationTurns ?? 30} 条消息后自动生效`;
}

async function refreshStatus() {
  try {
    const status = await sendToTab({ type: "GLCO_GET_STATUS" });
    renderStatus(status);
  } catch {
    renderUnavailable();
  }
}

elements.enabled.addEventListener("change", async () => {
  await setSettings({ enabled: elements.enabled.checked });
  setTimeout(refreshStatus, 80);
});

for (const input of elements.modes) {
  input.addEventListener("change", async () => {
    if (!input.checked) {
      return;
    }
    await setSettings({ mode: input.value });
    setTimeout(refreshStatus, 80);
  });
}

elements.revealAll.addEventListener("click", async () => {
  try {
    const status = await sendToTab({ type: "GLCO_REVEAL_ALL" });
    renderStatus(status);
  } catch {
    renderUnavailable();
  }
});

async function initialize() {
  renderSettings(await getSettings());
  const tab = await queryActiveTab();
  currentTabId = tab?.id ?? null;
  await refreshStatus();
  refreshTimer = setInterval(refreshStatus, 1_000);
}

addEventListener("unload", () => clearInterval(refreshTimer), { once: true });

if (globalThis.chrome?.storage?.sync && globalThis.chrome?.tabs) {
  initialize();
} else {
  renderSettings(DEFAULT_SETTINGS);
  renderUnavailable();
  elements.enabled.disabled = true;
  for (const input of elements.modes) {
    input.disabled = true;
  }
}
