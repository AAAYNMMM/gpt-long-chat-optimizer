import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backgroundSource = await readFile(
  join(here, "..", "extension", "background.js"),
  "utf8"
);

const operations = [];
let messageListener = null;
let currentTab = {
  id: 17,
  index: 3,
  url: "https://chatgpt.com/c/example-conversation"
};

const resolved = () => Promise.resolve();
const chrome = {
  storage: {
    sync: {
      get(defaults, callback) {
        callback(defaults);
      },
      set() {}
    }
  },
  runtime: {
    onInstalled: {
      addListener() {}
    },
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      }
    }
  },
  action: {
    setBadgeBackgroundColor: resolved,
    setBadgeText: resolved,
    setTitle: resolved
  },
  tabs: {
    async get(tabId) {
      operations.push(["get", tabId]);
      if (tabId !== currentTab.id) {
        throw new Error("missing tab");
      }
      return currentTab;
    },
    async create(properties) {
      operations.push(["create", properties]);
      return {
        id: 29,
        ...properties
      };
    },
    async discard(tabId) {
      operations.push(["discard", tabId]);
      return { id: tabId, discarded: true };
    }
  }
};

vm.runInNewContext(backgroundSource, {
  chrome,
  URL,
  Set,
  Object,
  Number,
  Error,
  Promise,
  setTimeout(callback) {
    callback();
    return 1;
  }
});

assert.equal(typeof messageListener, "function", "后台消息监听器应完成注册");

function dispatch(message) {
  return new Promise((resolve) => {
    const keepChannelOpen = messageListener(message, {}, resolve);
    assert.equal(keepChannelOpen, true, "异步救援消息应保持响应通道开放");
  });
}

const success = await dispatch({
  type: "GLCO_RESCUE_REOPEN",
  tabId: currentTab.id,
  url: currentTab.url,
  index: currentTab.index
});

assert.deepEqual(
  JSON.parse(JSON.stringify(success)),
  {
    ok: true,
    newTabId: 29,
    discardedOldTab: true
  }
);
assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
  ["get", 17],
  ["create", {
    url: "https://chatgpt.com/c/example-conversation",
    active: true,
    index: 4
  }],
  ["discard", 17]
]);

operations.length = 0;
currentTab = {
  id: 17,
  index: 0,
  url: "https://example.com/not-chatgpt"
};

const rejected = await dispatch({
  type: "GLCO_RESCUE_REOPEN",
  tabId: currentTab.id,
  url: "https://example.com/not-chatgpt"
});

assert.equal(rejected.ok, false);
assert.match(rejected.error, /不是受支持的 ChatGPT/);
assert.deepEqual(
  JSON.parse(JSON.stringify(operations)),
  [["get", 17]],
  "不受支持的页面不得新建或休眠标签页"
);

console.log("✓ 救援重开会复制当前对话、休眠旧页，并拒绝非 ChatGPT 地址");
