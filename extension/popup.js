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
  chunkCount: document.getElementById("chunk-count"),
  recoveryState: document.getElementById("recovery-state"),
  recoveryResult: document.getElementById("recovery-result"),
  rescueReopen: document.getElementById("rescue-reopen"),
  revealAll: document.getElementById("reveal-all"),
  modes: Array.from(document.querySelectorAll('input[name="mode"]'))
};

let currentTabId = null;
let currentTab = null;
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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function isSupportedChatUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["chatgpt.com", "chat.openai.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

function currentChatUrl() {
  const candidates = [currentTab?.url, currentTab?.pendingUrl];
  return candidates.find(isSupportedChatUrl) ?? null;
}

function updateRescueAvailability() {
  elements.rescueReopen.disabled = currentChatUrl() === null;
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
  const canRescue = currentChatUrl() !== null;
  elements.statusTitle.textContent = canRescue ? "页面脚本无响应" : "当前页面不可用";
  elements.statusDetail.textContent = canRescue
    ? "仍可使用下方按钮救援重开"
    : "请打开 chatgpt.com 的聊天页面";
  elements.turnCount.textContent = "—";
  elements.frozenCount.textContent = "—";
  elements.chunkCount.textContent = "—";
  elements.revealAll.disabled = true;
  elements.recoveryState.textContent = canRescue ? "建议救援重开" : "仅支持 ChatGPT";
  updateRescueAvailability();
}

function renderStatus(status) {
  if (!status) {
    renderUnavailable();
    return;
  }

  elements.turnCount.textContent = String(status.turns ?? 0);
  elements.frozenCount.textContent = String(status.frozen ?? 0);
  elements.chunkCount.textContent = String(status.frozenChunks ?? 0);
  elements.revealAll.disabled = !status.enabled || !status.active;
  updateRescueAvailability();

  if (status.online === false) {
    elements.statusDot.className = "status-dot error";
    elements.statusTitle.textContent = "浏览器当前离线";
    elements.statusDetail.textContent = "恢复网络后可救援重开当前对话";
    elements.recoveryState.textContent = "等待网络恢复";
    return;
  }

  if (status.pageAlert) {
    elements.statusDot.className = "status-dot error";
    elements.statusTitle.textContent = "页面出现异常提示";
    elements.statusDetail.textContent = "如生成未恢复，可在新标签页重开";
    elements.recoveryState.textContent = "可执行救援";
    return;
  }

  elements.recoveryState.textContent = status.startupRescue
    ? "首屏保护运行中"
    : "首屏保护已暂停";

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
    if (status.thinkingOptimized) {
      elements.statusTitle.textContent = status.frozen > 0
        ? "正在双重优化"
        : "正在优化长思考";
      elements.statusDetail.textContent = `长回复分为 ${status.chunks ?? 0} 段，已冻结 ${status.frozenChunks ?? 0} 个旧段`;
    } else {
      elements.statusTitle.textContent = "正在优化长会话";
      elements.statusDetail.textContent = `远处消息已轻量化，最近 ${recentByMode[status.mode] ?? 10} 条保持完整`;
    }
    return;
  }

  elements.statusDot.className = "status-dot";
  elements.statusTitle.textContent = "首屏救援已启用";
  elements.statusDetail.textContent = `加载阶段已保护；${status.activationTurns ?? 30} 条消息后增强`;
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

elements.rescueReopen.addEventListener("click", async () => {
  const chatUrl = currentChatUrl();
  if (!chatUrl || currentTabId === null) {
    elements.recoveryResult.textContent = "当前标签页不是受支持的 ChatGPT 页面。";
    updateRescueAvailability();
    return;
  }

  elements.rescueReopen.disabled = true;
  elements.rescueReopen.textContent = "正在建立新页面…";
  elements.recoveryResult.textContent = "新标签页建立后会休眠旧页，以释放页面内存。";

  try {
    const result = await sendRuntimeMessage({
      type: "GLCO_RESCUE_REOPEN",
      tabId: currentTabId,
      url: chatUrl,
      index: currentTab.index
    });
    if (!result?.ok) {
      throw new Error(result?.error || "救援重开失败");
    }
    elements.recoveryResult.textContent = result.discardedOldTab
      ? "已在新标签页重开，并休眠旧页。"
      : "已在新标签页重开；旧页由浏览器保留。";
  } catch (error) {
    elements.recoveryResult.textContent = error instanceof Error
      ? error.message
      : "救援重开失败";
    elements.rescueReopen.textContent = "救援重开当前对话";
    updateRescueAvailability();
  }
});

async function initialize() {
  renderSettings(await getSettings());
  const tab = await queryActiveTab();
  currentTab = tab;
  currentTabId = tab?.id ?? null;
  updateRescueAvailability();
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
  elements.rescueReopen.disabled = true;
  for (const input of elements.modes) {
    input.disabled = true;
  }
}
