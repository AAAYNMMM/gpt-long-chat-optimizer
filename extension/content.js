(() => {
  "use strict";

  const chromeApi = globalThis.chrome;
  if (!chromeApi?.storage?.sync || !chromeApi?.runtime) {
    return;
  }

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: "balanced"
  });

  const PRESETS = Object.freeze({
    safe: Object.freeze({
      activationTurns: 60,
      bufferScreens: 16,
      keepRecent: 14,
      freezeFarTurns: false
    }),
    balanced: Object.freeze({
      activationTurns: 30,
      bufferScreens: 10,
      keepRecent: 10,
      freezeFarTurns: true
    }),
    strong: Object.freeze({
      activationTurns: 16,
      bufferScreens: 6,
      keepRecent: 6,
      freezeFarTurns: true
    })
  });

  const TURN_PRIMARY_SELECTOR = [
    '[data-testid^="conversation-turn-"]',
    'article[data-testid*="conversation-turn"]'
  ].join(",");

  const TURN_HINT_SELECTOR = [
    TURN_PRIMARY_SELECTOR,
    "[data-message-author-role]"
  ].join(",");

  const STYLE_ID = "glco-runtime-style";
  const STYLE_TEXT = `
    html[data-glco-enabled="true"] [data-glco-turn="true"] {
      content-visibility: auto !important;
      contain-intrinsic-block-size: auto var(--glco-intrinsic-size, 320px) !important;
    }

    html[data-glco-enabled="true"] [data-glco-frozen="true"] {
      content-visibility: hidden !important;
    }

    @media print {
      html[data-glco-enabled="true"] [data-glco-turn="true"] {
        content-visibility: visible !important;
        contain-intrinsic-size: none !important;
      }
    }
  `;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    turns: [],
    turnSet: new Set(),
    heights: new WeakMap(),
    active: false,
    pausedUntil: 0,
    scrollRoot: null,
    intersectionObserver: null,
    resizeObserver: null,
    mutationObserver: null,
    scanTimer: 0,
    statusTimer: 0,
    resumeTimer: 0,
    resizeTimer: 0
  };

  function preset() {
    return PRESETS[state.settings.mode] ?? PRESETS.balanced;
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

  function normalizeSettings(raw) {
    return {
      enabled: raw?.enabled !== false,
      mode: Object.hasOwn(PRESETS, raw?.mode) ? raw.mode : DEFAULT_SETTINGS.mode
    };
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

  function findScrollRoot(element) {
    let current = element?.parentElement ?? null;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      if (
        /(auto|scroll|overlay)/.test(style.overflowY)
        && current.scrollHeight > current.clientHeight + 2
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function currentViewportHeight() {
    return Math.max(
      1,
      state.scrollRoot?.clientHeight || document.documentElement.clientHeight || innerHeight || 800
    );
  }

  function isPaused() {
    return Date.now() < state.pausedUntil;
  }

  function isProtectedTurn(turn) {
    if (!turn?.isConnected || isPaused()) {
      return true;
    }

    const keepRecent = preset().keepRecent;
    const index = state.turns.indexOf(turn);
    if (index >= Math.max(0, state.turns.length - keepRecent)) {
      return true;
    }

    if (
      turn.matches('[data-is-streaming="true"], .result-streaming')
      || turn.querySelector('[data-is-streaming="true"], .result-streaming')
    ) {
      return true;
    }

    const activeElement = document.activeElement;
    if (activeElement && turn.contains(activeElement)) {
      return true;
    }

    const selection = getSelection();
    return Boolean(
      selection
      && !selection.isCollapsed
      && (
        (selection.anchorNode && turn.contains(selection.anchorNode))
        || (selection.focusNode && turn.contains(selection.focusNode))
      )
    );
  }

  function measuredContentHeight(turn) {
    const rectHeight = turn.getBoundingClientRect().height;
    const style = getComputedStyle(turn);
    const boxExtras = (
      Number.parseFloat(style.paddingBlockStart || style.paddingTop) || 0
    ) + (
      Number.parseFloat(style.paddingBlockEnd || style.paddingBottom) || 0
    ) + (
      Number.parseFloat(style.borderBlockStartWidth || style.borderTopWidth) || 0
    ) + (
      Number.parseFloat(style.borderBlockEndWidth || style.borderBottomWidth) || 0
    );
    return Math.max(0, Math.round(rectHeight - boxExtras));
  }

  function rememberHeight(turn) {
    if (!turn?.isConnected || turn.dataset.glcoFrozen === "true") {
      return;
    }
    const height = measuredContentHeight(turn);
    if (height > 0) {
      state.heights.set(turn, height);
      turn.style.setProperty("--glco-intrinsic-size", `${height}px`);
    }
  }

  function thaw(turn) {
    if (!turn) {
      return;
    }
    delete turn.dataset.glcoFrozen;
  }

  function freeze(turn) {
    if (
      !state.active
      || !preset().freezeFarTurns
      || isProtectedTurn(turn)
    ) {
      thaw(turn);
      return;
    }

    rememberHeight(turn);
    const remembered = state.heights.get(turn);
    if (remembered > 0) {
      turn.style.setProperty("--glco-intrinsic-size", `${remembered}px`);
    }
    turn.dataset.glcoFrozen = "true";
  }

  function thawAll() {
    for (const turn of state.turns) {
      thaw(turn);
    }
  }

  function ensureResizeObserver() {
    if (state.resizeObserver || typeof ResizeObserver !== "function") {
      return;
    }
    state.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target.dataset.glcoFrozen !== "true") {
          const height = Math.round(
            entry.contentBoxSize?.[0]?.blockSize || entry.contentRect.height
          );
          if (height > 0) {
            state.heights.set(entry.target, height);
            entry.target.style.setProperty("--glco-intrinsic-size", `${height}px`);
          }
        }
      }
    });
  }

  function destroyIntersectionObserver() {
    state.intersectionObserver?.disconnect();
    state.intersectionObserver = null;
  }

  function createIntersectionObserver() {
    destroyIntersectionObserver();
    if (!state.active || typeof IntersectionObserver !== "function") {
      return;
    }

    const margin = Math.round(currentViewportHeight() * preset().bufferScreens);
    state.intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting || !preset().freezeFarTurns) {
          thaw(entry.target);
          rememberHeight(entry.target);
        } else {
          freeze(entry.target);
        }
      }
      scheduleStatus();
    }, {
      root: state.scrollRoot,
      rootMargin: `${margin}px 0px ${margin}px 0px`,
      threshold: 0
    });

    for (const turn of state.turns) {
      state.intersectionObserver.observe(turn);
    }
  }

  function cleanTurn(turn) {
    state.intersectionObserver?.unobserve(turn);
    state.resizeObserver?.unobserve(turn);
    delete turn.dataset.glcoTurn;
    delete turn.dataset.glcoFrozen;
    turn.style.removeProperty("--glco-intrinsic-size");
  }

  function deactivate() {
    state.active = false;
    destroyIntersectionObserver();
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
    for (const turn of state.turns) {
      cleanTurn(turn);
    }
    state.heights = new WeakMap();
    document.documentElement.dataset.glcoEnabled = String(state.settings.enabled);
    document.documentElement.dataset.glcoState = state.settings.enabled ? "waiting" : "disabled";
    delete document.documentElement.dataset.glcoMode;
  }

  function activate(turns) {
    state.active = true;
    document.documentElement.dataset.glcoEnabled = "true";
    document.documentElement.dataset.glcoState = isPaused() ? "paused" : "active";
    document.documentElement.dataset.glcoMode = state.settings.mode;

    ensureResizeObserver();

    // Batch every initial geometry read before applying content-visibility.
    // This prevents a generic fallback height from changing the scroll range.
    for (const turn of turns) {
      if (!state.heights.has(turn) && turn.dataset.glcoTurn !== "true") {
        const height = measuredContentHeight(turn);
        if (height > 0) {
          state.heights.set(turn, height);
        }
      }
    }

    for (const turn of turns) {
      const remembered = state.heights.get(turn);
      if (remembered > 0) {
        turn.style.setProperty("--glco-intrinsic-size", `${remembered}px`);
      }
      turn.dataset.glcoTurn = "true";
      if (!(remembered > 0)) {
        rememberHeight(turn);
      }
      state.resizeObserver?.observe(turn);
    }

    const nextRoot = findScrollRoot(turns[0]);
    const rootChanged = nextRoot !== state.scrollRoot;
    state.scrollRoot = nextRoot;
    if (rootChanged || !state.intersectionObserver) {
      createIntersectionObserver();
    } else {
      for (const turn of turns) {
        state.intersectionObserver.observe(turn);
      }
    }

    for (const turn of turns.slice(-preset().keepRecent)) {
      thaw(turn);
    }
  }

  function scan() {
    state.scanTimer = 0;
    const turns = collectTurns();
    const nextSet = new Set(turns);

    for (const previous of state.turns) {
      if (!nextSet.has(previous)) {
        cleanTurn(previous);
      }
    }

    state.turns = turns;
    state.turnSet = nextSet;

    if (!state.settings.enabled || turns.length < preset().activationTurns) {
      deactivate();
      scheduleStatus(true);
      return;
    }

    activate(turns);
    scheduleStatus(true);
  }

  function scheduleScan(delay = 180) {
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
    }
    state.scanTimer = setTimeout(scan, delay);
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
            state.turnSet.has(node)
            || node.querySelector('[data-glco-turn="true"]')
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function statusSnapshot() {
    let frozen = 0;
    for (const turn of state.turns) {
      if (turn.dataset.glcoFrozen === "true") {
        frozen += 1;
      }
    }

    return {
      enabled: state.settings.enabled,
      active: state.active,
      paused: isPaused(),
      mode: state.settings.mode,
      turns: state.turns.length,
      frozen,
      activationTurns: preset().activationTurns
    };
  }

  function publishStatus() {
    state.statusTimer = 0;
    const snapshot = statusSnapshot();
    const root = document.documentElement;
    root.dataset.glcoState = snapshot.enabled
      ? (snapshot.paused ? "paused" : (snapshot.active ? "active" : "waiting"))
      : "disabled";
    root.dataset.glcoTurns = String(snapshot.turns);
    root.dataset.glcoFrozen = String(snapshot.frozen);

    try {
      const result = chromeApi.runtime.sendMessage({
        type: "GLCO_STATUS_UPDATE",
        payload: snapshot
      });
      result?.catch?.(() => {});
    } catch {
      // The extension may have been reloaded while this page stayed open.
    }
  }

  function scheduleStatus(immediate = false) {
    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
    }
    state.statusTimer = setTimeout(publishStatus, immediate ? 0 : 120);
  }

  function pauseOptimization(durationMs = 30_000) {
    state.pausedUntil = Date.now() + durationMs;
    clearTimeout(state.resumeTimer);
    thawAll();
    destroyIntersectionObserver();
    scheduleStatus(true);
    state.resumeTimer = setTimeout(() => {
      state.pausedUntil = 0;
      if (state.active) {
        createIntersectionObserver();
      }
      scheduleStatus(true);
    }, durationMs);
  }

  function refreshAfterResize() {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      if (state.active) {
        createIntersectionObserver();
      }
    }, 180);
  }

  function installObservers() {
    state.mutationObserver = new MutationObserver((records) => {
      if (mutationCanChangeTurns(records)) {
        scheduleScan();
      }
    });
    state.mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    addEventListener("resize", refreshAfterResize, { passive: true });
    addEventListener("pageshow", () => scheduleScan(0), { passive: true });
    addEventListener("beforeprint", () => pauseOptimization(5_000), { passive: true });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        pauseOptimization(30_000);
      }
    }, true);

    chromeApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || (!changes.enabled && !changes.mode)) {
        return;
      }
      state.settings = normalizeSettings({
        enabled: changes.enabled?.newValue ?? state.settings.enabled,
        mode: changes.mode?.newValue ?? state.settings.mode
      });
      destroyIntersectionObserver();
      scheduleScan(0);
    });

    chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "GLCO_GET_STATUS") {
        sendResponse(statusSnapshot());
        return;
      }
      if (message?.type === "GLCO_REVEAL_ALL") {
        const requestedDuration = Number(message.durationMs);
        const duration = Number.isFinite(requestedDuration)
          ? Math.min(30_000, Math.max(1_000, requestedDuration))
          : 30_000;
        pauseOptimization(duration);
        sendResponse(statusSnapshot());
        return;
      }
      if (message?.type === "GLCO_RESCAN") {
        scan();
        sendResponse(statusSnapshot());
      }
    });
  }

  async function start() {
    injectStyles();
    state.settings = await loadSettings();
    installObservers();
    scan();
  }

  start();
})();
