"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  mode: "balanced"
});

const SUPPORTED_CHAT_HOSTS = new Set([
  "chatgpt.com",
  "chat.openai.com"
]);

function supportedChatUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SUPPORTED_CHAT_HOSTS.has(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    chrome.storage.sync.set({
      enabled: stored.enabled !== false,
      mode: ["safe", "balanced", "strong"].includes(stored.mode)
        ? stored.mode
        : DEFAULT_SETTINGS.mode
    });
  });
});

async function reopenForRescue(message) {
  const oldTabId = Number(message?.tabId);
  let oldTab = null;
  if (Number.isInteger(oldTabId)) {
    try {
      oldTab = await chrome.tabs.get(oldTabId);
    } catch {
      // A crashed renderer can disappear between opening the popup and clicking.
    }
  }

  const url = supportedChatUrl(oldTab?.url)
    || supportedChatUrl(oldTab?.pendingUrl)
    || supportedChatUrl(message?.url);
  if (!url) {
    throw new Error("当前页面不是受支持的 ChatGPT 对话");
  }

  const createProperties = {
    url,
    active: true
  };
  const oldIndex = Number(oldTab?.index ?? message?.index);
  if (Number.isInteger(oldIndex) && oldIndex >= 0) {
    createProperties.index = oldIndex + 1;
  }

  const freshTab = await chrome.tabs.create(createProperties);
  let discardedOldTab = false;

  if (Number.isInteger(oldTabId) && oldTabId !== freshTab.id) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      await chrome.tabs.discard(oldTabId);
      discardedOldTab = true;
    } catch {
      // The fresh tab is still useful even when Chrome refuses to discard one.
    }
  }

  return {
    ok: true,
    newTabId: freshTab.id,
    discardedOldTab
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GLCO_RESCUE_REOPEN") {
    reopenForRescue(message)
      .catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : "救援重开失败"
      }))
      .then(sendResponse);
    return true;
  }

  if (message?.type !== "GLCO_STATUS_UPDATE" || sender.tab?.id === undefined) {
    return;
  }

  const tabId = sender.tab.id;
  const status = message.payload ?? {};
  const frozen = Number.isFinite(status.frozen) ? status.frozen : 0;
  const frozenChunks = Number.isFinite(status.frozenChunks) ? status.frozenChunks : 0;
  const optimizedUnits = frozen + frozenChunks;
  const hasPageIssue = status.online === false || status.pageAlert === true;
  const badgeText = hasPageIssue
    ? "!"
    : (
      status.enabled && status.active && optimizedUnits > 0
        ? (optimizedUnits > 999 ? "999+" : String(optimizedUnits))
        : ""
    );

  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: hasPageIssue ? "#D97706" : "#635BFF"
  }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: badgeText }).catch(() => {});

  const title = hasPageIssue
    ? "GPT 长聊加速器：检测到页面或连接异常，可尝试救援重开"
    : (
      status.enabled
        ? `GPT 长聊加速器：${status.active ? `已优化 ${frozen} 条消息、${frozenChunks} 个长回复段落` : "首屏救援已启用"}`
        : "GPT 长聊加速器：已暂停"
    );
  chrome.action.setTitle({ tabId, title }).catch(() => {});
});
