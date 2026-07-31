(() => {
  "use strict";

  const chromeApi = globalThis.chrome;
  if (!chromeApi?.storage?.sync) {
    return;
  }

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: "balanced"
  });
  const LIVE_TURN_COUNT = 4;
  const LIVE_BLOCK_COUNTS = Object.freeze({
    safe: 12,
    balanced: 8,
    strong: 5
  });
  const TURN_PRIMARY_SELECTOR = [
    '[data-testid^="conversation-turn-"]',
    'article[data-testid*="conversation-turn"]'
  ].join(",");
  const TURN_HINT_SELECTOR = [
    TURN_PRIMARY_SELECTOR,
    "[data-message-author-role]"
  ].join(",");
  const STREAMING_SELECTOR = [
    '[data-is-streaming="true"]',
    ".result-streaming"
  ].join(",");
  const BLOCK_SELECTOR = [
    '[data-glco-chunk="true"]',
    "p",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "table",
    "figure",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6"
  ].join(",");
  const STYLE_ID = "glco-final-transition-style";
  const STYLE_TEXT = `
    html[data-glco-startup]:not([data-glco-startup="false"])
      [data-glco-transition-live="true"],
    html[data-glco-enabled="true"]
      [data-glco-transition-live="true"],
    html[data-glco-startup]:not([data-glco-startup="false"])
      [data-glco-transition-block="true"],
    html[data-glco-enabled="true"]
      [data-glco-transition-block="true"] {
      content-visibility: visible !important;
      contain-intrinsic-size: none !important;
      contain-intrinsic-block-size: none !important;
    }
  `;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    liveTurns: new Set(),
    liveBlocks: new Set(),
    observer: null,
    scanTimer: 0
  };

  function normalizeSettings(raw) {
    return {
      enabled: raw?.enabled !== false,
      mode: Object.hasOwn(LIVE_BLOCK_COUNTS, raw?.mode)
        ? raw.mode
        : DEFAULT_SETTINGS.mode
    };
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    (document.head || document.documentElement).append(style);
  }

  function closestTurn(roleElement) {
    return roleElement.closest(TURN_PRIMARY_SELECTOR)
      || roleElement.closest("article")
      || roleElement;
  }

  function collectTurns() {
    const scope = document.querySelector("main") || document.body;
    if (!scope) {
      return [];
    }

    let candidates = Array.from(scope.querySelectorAll(TURN_PRIMARY_SELECTOR));
    if (candidates.length === 0) {
      candidates = Array.from(scope.querySelectorAll("[data-message-author-role]"), closestTurn);
    }

    const unique = Array.from(new Set(candidates)).filter((element) => {
      return element instanceof HTMLElement
        && element.isConnected
        && !element.closest('[data-glco-ignore="true"]');
    });

    unique.sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left.compareDocumentPosition(right) & 4 ? -1 : 1;
    });
    return unique;
  }

  function assistantContentRoot(turn) {
    const roleElement = turn.matches('[data-message-author-role="assistant"]')
      ? turn
      : turn.querySelector('[data-message-author-role="assistant"]');
    return roleElement instanceof HTMLElement ? roleElement : null;
  }

  function isStreamingTurn(turn) {
    return Boolean(
      turn.matches(STREAMING_SELECTOR)
      || turn.querySelector(STREAMING_SELECTOR)
    );
  }

  function collectLiveBlocks(turn) {
    const contentRoot = assistantContentRoot(turn);
    if (!contentRoot) {
      return [];
    }

    const candidates = Array.from(new Set(contentRoot.querySelectorAll(BLOCK_SELECTOR)))
      .filter((element) => {
        return element instanceof HTMLElement
          && element.isConnected
          && !element.closest('[data-glco-ignore="true"]')
          && !element.matches("script, style, template, button, input, textarea, select");
      });
    const keepCount = LIVE_BLOCK_COUNTS[state.settings.mode]
      ?? LIVE_BLOCK_COUNTS.balanced;
    return candidates.slice(-keepCount);
  }

  function clearLiveSurface() {
    for (const turn of state.liveTurns) {
      if (turn.isConnected) {
        delete turn.dataset.glcoTransitionLive;
      }
    }
    for (const block of state.liveBlocks) {
      if (block.isConnected) {
        delete block.dataset.glcoTransitionBlock;
      }
    }
    state.liveTurns = new Set();
    state.liveBlocks = new Set();
    delete document.documentElement.dataset.glcoTransitionTurns;
    delete document.documentElement.dataset.glcoTransitionBlocks;
  }

  function syncLiveSurface() {
    state.scanTimer = 0;
    if (!state.settings.enabled) {
      clearLiveSurface();
      return;
    }

    const turns = collectTurns();
    const liveStart = Math.max(0, turns.length - LIVE_TURN_COUNT);
    const nextTurns = new Set();
    const nextBlocks = new Set();

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (index < liveStart && !isStreamingTurn(turn)) {
        continue;
      }
      nextTurns.add(turn);
      for (const block of collectLiveBlocks(turn)) {
        nextBlocks.add(block);
      }
    }

    for (const turn of state.liveTurns) {
      if (!nextTurns.has(turn) && turn.isConnected) {
        delete turn.dataset.glcoTransitionLive;
      }
    }
    for (const block of state.liveBlocks) {
      if (!nextBlocks.has(block) && block.isConnected) {
        delete block.dataset.glcoTransitionBlock;
      }
    }

    for (const turn of nextTurns) {
      turn.dataset.glcoTransitionLive = "true";
      delete turn.dataset.glcoFrozen;
    }
    for (const block of nextBlocks) {
      block.dataset.glcoTransitionBlock = "true";
      delete block.dataset.glcoChunkFrozen;
    }

    state.liveTurns = nextTurns;
    state.liveBlocks = nextBlocks;
    document.documentElement.dataset.glcoTransitionTurns = String(nextTurns.size);
    document.documentElement.dataset.glcoTransitionBlocks = String(nextBlocks.size);
  }

  function scheduleScan(delay = 60) {
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
    }
    state.scanTimer = setTimeout(syncLiveSurface, delay);
  }

  function mutationCanChangeLiveSurface(records) {
    for (const record of records) {
      const target = record.target instanceof Element
        ? record.target
        : record.target.parentElement;
      if (
        target?.closest(TURN_HINT_SELECTOR)
        && [...record.addedNodes, ...record.removedNodes]
          .some((node) => node instanceof Element)
      ) {
        return true;
      }

      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (
          node instanceof Element
          && (
            node.matches(TURN_HINT_SELECTOR)
            || node.querySelector(TURN_HINT_SELECTOR)
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chromeApi.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
          resolve(normalizeSettings(stored));
        });
      } catch {
        resolve({ ...DEFAULT_SETTINGS });
      }
    });
  }

  async function start() {
    injectStyles();
    state.settings = await loadSettings();
    syncLiveSurface();

    state.observer = new MutationObserver((records) => {
      if (mutationCanChangeLiveSurface(records)) {
        scheduleScan();
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    chromeApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || (!changes.enabled && !changes.mode)) {
        return;
      }
      state.settings = normalizeSettings({
        enabled: changes.enabled?.newValue ?? state.settings.enabled,
        mode: changes.mode?.newValue ?? state.settings.mode
      });
      scheduleScan(0);
    });

    addEventListener("pageshow", () => scheduleScan(0), { passive: true });
  }

  start();
})();
