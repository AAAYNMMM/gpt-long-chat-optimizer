(() => {
  "use strict";

  const LIVE_TURN_COUNT = 4;
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
  const STYLE_ID = "glco-live-turn-style";
  const STYLE_TEXT = `
    html[data-glco-enabled="true"]
    [data-glco-turn="true"][data-glco-live="true"] {
      content-visibility: visible !important;
      contain-intrinsic-block-size: none !important;
      contain-intrinsic-size: none !important;
    }
  `;

  const state = {
    liveTurns: new Set(),
    observer: null,
    scanTimer: 0
  };

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

  function isStreamingTurn(turn) {
    return Boolean(
      turn.matches(STREAMING_SELECTOR)
      || turn.querySelector(STREAMING_SELECTOR)
    );
  }

  function syncLiveTurns() {
    state.scanTimer = 0;
    const turns = collectTurns();
    const liveStart = Math.max(0, turns.length - LIVE_TURN_COUNT);
    const nextLiveTurns = new Set();

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (index >= liveStart || isStreamingTurn(turn)) {
        nextLiveTurns.add(turn);
      }
    }

    for (const turn of state.liveTurns) {
      if (!nextLiveTurns.has(turn) && turn.isConnected) {
        delete turn.dataset.glcoLive;
      }
    }

    for (const turn of nextLiveTurns) {
      turn.dataset.glcoLive = "true";
      delete turn.dataset.glcoFrozen;
    }

    state.liveTurns = nextLiveTurns;
    document.documentElement.dataset.glcoLiveTurns = String(nextLiveTurns.size);
  }

  function scheduleScan(delay = 80) {
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
    }
    state.scanTimer = setTimeout(syncLiveTurns, delay);
  }

  function mutationCanChangeTurns(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof Element
          && (
            node.matches(TURN_HINT_SELECTOR)
            || node.querySelector(TURN_HINT_SELECTOR)
            || node.tagName === "MAIN"
          )
        ) {
          return true;
        }
      }

      for (const node of record.removedNodes) {
        if (
          node instanceof Element
          && (
            state.liveTurns.has(node)
            || node.querySelector('[data-glco-live="true"]')
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function start() {
    injectStyles();
    syncLiveTurns();

    state.observer = new MutationObserver((records) => {
      if (mutationCanChangeTurns(records)) {
        scheduleScan();
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    addEventListener("pageshow", () => scheduleScan(0), { passive: true });
  }

  start();
})();
