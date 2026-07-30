"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  mode: "balanced"
});

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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "GLCO_STATUS_UPDATE" || sender.tab?.id === undefined) {
    return;
  }

  const tabId = sender.tab.id;
  const status = message.payload ?? {};
  const frozen = Number.isFinite(status.frozen) ? status.frozen : 0;
  const badgeText = status.enabled && status.active && frozen > 0
    ? (frozen > 999 ? "999+" : String(frozen))
    : "";

  chrome.action.setBadgeBackgroundColor({ tabId, color: "#635BFF" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: badgeText }).catch(() => {});

  const title = status.enabled
    ? `GPT 长聊加速器：${status.active ? `已冻结 ${frozen} 条离屏消息` : "等待长会话"}`
    : "GPT 长聊加速器：已暂停";
  chrome.action.setTitle({ tabId, title }).catch(() => {});
});
