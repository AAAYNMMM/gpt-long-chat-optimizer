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
      freezeFarTurns: false,
      chunkActivationScreens: 7,
      chunkActivationBlocks: 24,
      chunkBufferScreens: 10,
      keepRecentChunks: 12,
      freezeFarChunks: false
    }),
    balanced: Object.freeze({
      activationTurns: 30,
      bufferScreens: 10,
      keepRecent: 10,
      freezeFarTurns: true,
      chunkActivationScreens: 3.5,
      chunkActivationBlocks: 12,
      chunkBufferScreens: 4,
      keepRecentChunks: 8,
      freezeFarChunks: true
    }),
    strong: Object.freeze({
      activationTurns: 16,
      bufferScreens: 6,
      keepRecent: 6,
      freezeFarTurns: true,
      chunkActivationScreens: 2,
      chunkActivationBlocks: 8,
      chunkBufferScreens: 2.5,
      keepRecentChunks: 5,
      freezeFarChunks: true
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

  const CHUNK_SELECTOR = [
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

  const DENSE_CONTENT_SELECTOR = [
    '[data-testid*="reasoning"]',
    '[data-testid*="thought"]',
    '[data-testid*="thinking"]',
    ".markdown",
    ".prose"
  ].join(",");

  const CHUNK_MIN_COUNT = 8;
  const CHUNK_MAX_COUNT = 1_200;
  const PAGE_ERROR_SELECTOR = [
    '[role="alert"]',
    '[data-testid*="error"]',
    '[data-state="error"]'
  ].join(",");

  const STYLE_ID = "glco-runtime-style";
  const STYLE_TEXT = `
    html[data-glco-enabled="true"] [data-glco-turn="true"] {
      content-visibility: auto !important;
      contain-intrinsic-block-size: auto var(--glco-intrinsic-size, 360px) !important;
    }

    html[data-glco-enabled="true"] [data-glco-frozen="true"] {
      content-visibility: hidden !important;
    }

    html[data-glco-enabled="true"] [data-glco-chunk="true"] {
      content-visibility: auto !important;
      contain-intrinsic-block-size: auto var(--glco-chunk-size, var(--glco-startup-size, 64px)) !important;
    }

    html[data-glco-enabled="true"] [data-glco-chunk-frozen="true"] {
      content-visibility: hidden !important;
    }

    html[data-glco-state="paused"] [data-glco-turn="true"],
    html[data-glco-state="paused"] [data-glco-chunk="true"] {
      content-visibility: visible !important;
      contain-intrinsic-size: none !important;
    }

    @media print {
      html[data-glco-enabled="true"] [data-glco-turn="true"],
      html[data-glco-enabled="true"] [data-glco-chunk="true"] {
        content-visibility: visible !important;
        contain-intrinsic-size: none !important;
      }
    }
  `;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    turns: [],
    turnSet: new Set(),
    turnIndexes: new WeakMap(),
    heights: new WeakMap(),
    active: false,
    chunks: new Set(),
    chunksByTurn: new Map(),
    chunkOwners: new WeakMap(),
    chunkIndexes: new WeakMap(),
    chunkHeights: new WeakMap(),
    chunkActive: false,
    pausedUntil: 0,
    scrollRoot: null,
    chunkScrollRoot: null,
    intersectionObserver: null,
    chunkIntersectionObserver: null,
    resizeObserver: null,
    chunkResizeObserver: null,
    mutationObserver: null,
    scanTimer: 0,
    chunkScanTimer: 0,
    chunkBatchTimer: 0,
    chunkScanGeneration: 0,
    statusTimer: 0,
    healthTimer: 0,
    resumeTimer: 0,
    resizeTimer: 0,
    pageAlert: false
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

  function assistantContentRoot(turn) {
    const roleElement = turn.matches('[data-message-author-role="assistant"]')
      ? turn
      : turn.querySelector('[data-message-author-role="assistant"]');
    return roleElement instanceof HTMLElement ? roleElement : null;
  }

  function collectChunks(turn) {
    const contentRoot = assistantContentRoot(turn);
    if (!contentRoot) {
      return [];
    }

    const raw = new Set(contentRoot.querySelectorAll(CHUNK_SELECTOR));
    const denseContainers = Array.from(new Set([
      contentRoot,
      ...contentRoot.querySelectorAll(DENSE_CONTENT_SELECTOR)
    ])).slice(0, 120);

    for (const container of denseContainers) {
      if (container.children.length < CHUNK_MIN_COUNT) {
        continue;
      }
      for (const child of container.children) {
        if (
          child instanceof HTMLElement
          && (
            child.matches(CHUNK_SELECTOR)
            || child.matches("div, section, article")
          )
        ) {
          raw.add(child);
        }
      }
    }

    const candidates = Array.from(raw).filter((element) => {
      if (
        !(element instanceof HTMLElement)
        || !element.isConnected
        || element === contentRoot
        || element.closest('[data-glco-ignore="true"]')
        || element.matches("script, style, template, button, input, textarea, select")
      ) {
        return false;
      }

      let ancestor = element.parentElement;
      while (ancestor && ancestor !== contentRoot) {
        if (raw.has(ancestor)) {
          return false;
        }
        ancestor = ancestor.parentElement;
      }
      return true;
    });

    candidates.sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left.compareDocumentPosition(right) & 4 ? -1 : 1;
    });

    if (candidates.length <= CHUNK_MAX_COUNT) {
      return candidates;
    }

    const tailSize = Math.max(100, preset().keepRecentChunks * 4);
    return [
      ...candidates.slice(0, CHUNK_MAX_COUNT - tailSize),
      ...candidates.slice(-tailSize)
    ];
  }

  function viewportHeightFor(root = state.scrollRoot) {
    return Math.max(
      1,
      root?.clientHeight || document.documentElement.clientHeight || innerHeight || 800
    );
  }

  function currentViewportHeight() {
    return viewportHeightFor(state.scrollRoot);
  }

  function isPaused() {
    return Date.now() < state.pausedUntil;
  }

  function hasProtectedInteraction(element) {
    const activeElement = document.activeElement;
    if (activeElement && element.contains(activeElement)) {
      return true;
    }

    const selection = getSelection();
    return Boolean(
      selection
      && !selection.isCollapsed
      && (
        (selection.anchorNode && element.contains(selection.anchorNode))
        || (selection.focusNode && element.contains(selection.focusNode))
      )
    );
  }

  function isProtectedTurn(turn) {
    if (!turn?.isConnected || isPaused()) {
      return true;
    }

    const keepRecent = preset().keepRecent;
    const index = state.turnIndexes.get(turn) ?? -1;
    if (index >= Math.max(0, state.turns.length - keepRecent)) {
      return true;
    }

    if (
      turn.matches('[data-is-streaming="true"], .result-streaming')
      || turn.querySelector('[data-is-streaming="true"], .result-streaming')
    ) {
      return true;
    }

    return hasProtectedInteraction(turn);
  }

  function isProtectedChunk(chunk) {
    if (!chunk?.isConnected || isPaused()) {
      return true;
    }

    const owner = state.chunkOwners.get(chunk);
    const index = state.chunkIndexes.get(chunk) ?? -1;
    const siblingCount = state.chunksByTurn.get(owner)?.length ?? 0;
    if (index >= Math.max(0, siblingCount - preset().keepRecentChunks)) {
      return true;
    }

    return hasProtectedInteraction(chunk);
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

    const remembered = state.heights.get(turn);
    if (!(remembered > 0)) {
      thaw(turn);
      return;
    }
    turn.style.setProperty("--glco-intrinsic-size", `${remembered}px`);
    turn.dataset.glcoFrozen = "true";
  }

  function thawChunk(chunk) {
    if (chunk) {
      delete chunk.dataset.glcoChunkFrozen;
    }
  }

  function freezeChunk(chunk) {
    if (
      !state.chunkActive
      || !preset().freezeFarChunks
      || isProtectedChunk(chunk)
    ) {
      thawChunk(chunk);
      return;
    }

    const remembered = state.chunkHeights.get(chunk);
    if (!(remembered > 0)) {
      thawChunk(chunk);
      return;
    }
    chunk.style.setProperty("--glco-chunk-size", `${remembered}px`);
    chunk.dataset.glcoChunkFrozen = "true";
  }

  function thawAll() {
    for (const turn of state.turns) {
      thaw(turn);
    }
  }

  function thawAllChunks() {
    for (const chunk of state.chunks) {
      thawChunk(chunk);
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
            if (
              assistantContentRoot(entry.target)
              && height >= viewportHeightFor() * 1.5
            ) {
              scheduleChunkScan();
            }
          }
        }
      }
    });
  }

  function ensureChunkResizeObserver() {
    if (state.chunkResizeObserver || typeof ResizeObserver !== "function") {
      return;
    }
    state.chunkResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target.dataset.glcoChunkFrozen !== "true") {
          const height = Math.round(
            entry.contentBoxSize?.[0]?.blockSize || entry.contentRect.height
          );
          if (height > 0) {
            state.chunkHeights.set(entry.target, height);
            entry.target.style.setProperty("--glco-chunk-size", `${height}px`);
          }
        }
      }
    });
  }

  function destroyIntersectionObserver() {
    state.intersectionObserver?.disconnect();
    state.intersectionObserver = null;
  }

  function destroyChunkIntersectionObserver() {
    state.chunkIntersectionObserver?.disconnect();
    state.chunkIntersectionObserver = null;
  }

  function createIntersectionObserver() {
    destroyIntersectionObserver();
    if (!state.active || typeof IntersectionObserver !== "function") {
      return;
    }

    state.resizeObserver?.disconnect();
    const margin = Math.round(currentViewportHeight() * preset().bufferScreens);
    state.intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          thaw(entry.target);
          state.resizeObserver?.observe(entry.target);
          scheduleChunkScan(0);
        } else {
          state.resizeObserver?.unobserve(entry.target);
          if (preset().freezeFarTurns) {
            freeze(entry.target);
          } else {
            thaw(entry.target);
          }
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

  function createChunkIntersectionObserver() {
    destroyChunkIntersectionObserver();
    if (
      !state.chunkActive
      || isPaused()
      || typeof IntersectionObserver !== "function"
    ) {
      return;
    }

    state.chunkResizeObserver?.disconnect();
    const margin = Math.round(
      viewportHeightFor(state.chunkScrollRoot) * preset().chunkBufferScreens
    );
    state.chunkIntersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          thawChunk(entry.target);
          state.chunkResizeObserver?.observe(entry.target);
        } else {
          state.chunkResizeObserver?.unobserve(entry.target);
          if (preset().freezeFarChunks) {
            freezeChunk(entry.target);
          } else {
            thawChunk(entry.target);
          }
        }
      }
      scheduleStatus();
    }, {
      root: state.chunkScrollRoot,
      rootMargin: `${margin}px 0px ${margin}px 0px`,
      threshold: 0
    });

    for (const chunk of state.chunks) {
      state.chunkIntersectionObserver.observe(chunk);
    }
  }

  function cleanTurn(turn) {
    state.intersectionObserver?.unobserve(turn);
    state.resizeObserver?.unobserve(turn);
    delete turn.dataset.glcoTurn;
    delete turn.dataset.glcoFrozen;
    turn.style.removeProperty("--glco-intrinsic-size");
  }

  function cleanChunk(chunk) {
    state.chunkIntersectionObserver?.unobserve(chunk);
    state.chunkResizeObserver?.unobserve(chunk);
    delete chunk.dataset.glcoChunk;
    delete chunk.dataset.glcoChunkFrozen;
    chunk.style.removeProperty("--glco-chunk-size");
  }

  function deactivateChunks() {
    destroyChunkIntersectionObserver();
    state.chunkResizeObserver?.disconnect();
    state.chunkResizeObserver = null;
    for (const chunk of state.chunks) {
      cleanChunk(chunk);
    }
    state.chunks = new Set();
    state.chunksByTurn = new Map();
    state.chunkOwners = new WeakMap();
    state.chunkIndexes = new WeakMap();
    state.chunkHeights = new WeakMap();
    state.chunkActive = false;
    state.chunkScrollRoot = null;
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
    state.turnIndexes = new WeakMap();
    document.documentElement.dataset.glcoEnabled = String(state.settings.enabled);
    document.documentElement.dataset.glcoState = state.settings.enabled ? "waiting" : "disabled";
    delete document.documentElement.dataset.glcoMode;
  }

  function finishChunkScan(generation, nextByTurn, nextChunks) {
    if (generation !== state.chunkScanGeneration) {
      return;
    }
    for (const chunk of state.chunks) {
      if (!nextChunks.has(chunk)) {
        cleanChunk(chunk);
      }
    }

    if (nextChunks.size === 0) {
      state.chunks = nextChunks;
      state.chunksByTurn = nextByTurn;
      state.chunkOwners = new WeakMap();
      state.chunkIndexes = new WeakMap();
      state.chunkHeights = new WeakMap();
      state.chunkActive = false;
      destroyChunkIntersectionObserver();
      state.chunkResizeObserver?.disconnect();
      state.chunkResizeObserver = null;
      state.chunkScrollRoot = null;
      scheduleStatus(true);
      return;
    }

    const nextOwners = new WeakMap();
    const nextIndexes = new WeakMap();
    for (const [turn, chunks] of nextByTurn) {
      chunks.forEach((chunk, index) => {
        nextOwners.set(chunk, turn);
        nextIndexes.set(chunk, index);
      });
    }

    state.chunks = nextChunks;
    state.chunksByTurn = nextByTurn;
    state.chunkOwners = nextOwners;
    state.chunkIndexes = nextIndexes;
    state.chunkActive = true;
    ensureChunkResizeObserver();

    for (const chunk of nextChunks) {
      const remembered = state.chunkHeights.get(chunk);
      if (remembered > 0) {
        chunk.style.setProperty("--glco-chunk-size", `${remembered}px`);
      }
      chunk.dataset.glcoChunk = "true";
    }

    state.chunkScrollRoot = null;
    if (isPaused()) {
      thawAllChunks();
      destroyChunkIntersectionObserver();
    } else if (!state.chunkIntersectionObserver) {
      createChunkIntersectionObserver();
    } else {
      for (const chunk of nextChunks) {
        state.chunkIntersectionObserver.observe(chunk);
      }
    }

    for (const chunks of nextByTurn.values()) {
      for (const chunk of chunks.slice(-preset().keepRecentChunks)) {
        thawChunk(chunk);
      }
    }
    scheduleStatus(true);
  }

  function scanChunks() {
    state.chunkScanTimer = 0;
    clearTimeout(state.chunkBatchTimer);
    state.chunkBatchTimer = 0;
    const generation = ++state.chunkScanGeneration;

    if (!state.settings.enabled || state.turns.length === 0) {
      deactivateChunks();
      scheduleStatus(true);
      return;
    }

    const turns = [...state.turns];
    const nextByTurn = new Map();
    const nextChunks = new Set();
    const minimumHeight = viewportHeightFor() * preset().chunkActivationScreens;
    let turnIndex = 0;

    const processBatch = () => {
      state.chunkBatchTimer = 0;
      if (generation !== state.chunkScanGeneration) {
        return;
      }

      const started = performance.now();
      let processed = 0;
      while (
        turnIndex < turns.length
        && (processed === 0 || (processed < 6 && performance.now() - started < 8))
      ) {
        const turn = turns[turnIndex++];
        processed += 1;
        if (turn.dataset.glcoFrozen === "true" || !assistantContentRoot(turn)) {
          continue;
        }

        const chunks = collectChunks(turn);
        const knownHeight = state.heights.get(turn) ?? 0;
        const largeEnough = chunks.length >= preset().chunkActivationBlocks
          || knownHeight >= minimumHeight;
        if (chunks.length < CHUNK_MIN_COUNT || !largeEnough) {
          continue;
        }

        nextByTurn.set(turn, chunks);
        for (const chunk of chunks) {
          nextChunks.add(chunk);
        }
      }

      if (turnIndex < turns.length) {
        state.chunkBatchTimer = setTimeout(processBatch, 0);
        return;
      }

      finishChunkScan(generation, nextByTurn, nextChunks);
    };

    state.chunkBatchTimer = setTimeout(processBatch, 0);
  }

  function activate(turns) {
    state.active = true;
    document.documentElement.dataset.glcoEnabled = "true";
    document.documentElement.dataset.glcoState = isPaused() ? "paused" : "active";
    document.documentElement.dataset.glcoMode = state.settings.mode;

    ensureResizeObserver();

    for (const turn of turns) {
      const remembered = state.heights.get(turn);
      if (remembered > 0) {
        turn.style.setProperty("--glco-intrinsic-size", `${remembered}px`);
      }
      turn.dataset.glcoTurn = "true";
    }

    state.scrollRoot = null;
    if (!state.intersectionObserver) {
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
    const nextIndexes = new WeakMap();
    turns.forEach((turn, index) => nextIndexes.set(turn, index));
    state.turnIndexes = nextIndexes;

    if (!state.settings.enabled || turns.length < preset().activationTurns) {
      deactivate();
      scanChunks();
      scheduleStatus(true);
      return;
    }

    activate(turns);
    scanChunks();
    scheduleStatus(true);
  }

  function scheduleScan(delay = 180) {
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
    }
    state.scanTimer = setTimeout(scan, delay);
  }

  function scheduleChunkScan(delay = 320) {
    if (state.chunkScanTimer) {
      return;
    }
    state.chunkScanTimer = setTimeout(scanChunks, delay);
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

  function mutationCanChangeChunks(records) {
    for (const record of records) {
      if (record.type !== "childList") {
        continue;
      }
      const changedElements = [...record.addedNodes, ...record.removedNodes]
        .some((node) => node instanceof Element);
      if (!changedElements) {
        continue;
      }

      const target = record.target instanceof Element
        ? record.target
        : record.target.parentElement;
      if (target?.closest('[data-message-author-role="assistant"]')) {
        return true;
      }

      for (const node of record.addedNodes) {
        if (
          node instanceof Element
          && (
            node.matches('[data-message-author-role="assistant"]')
            || node.querySelector('[data-message-author-role="assistant"]')
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function mutationCanChangeHealth(records) {
    for (const record of records) {
      const target = record.target instanceof Element
        ? record.target
        : record.target.parentElement;
      if (target?.matches(PAGE_ERROR_SELECTOR) && target.childNodes.length > 0) {
        return true;
      }

      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (
          node instanceof Element
          && (
            node.matches(PAGE_ERROR_SELECTOR)
            || node.querySelector(PAGE_ERROR_SELECTOR)
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function scanHealth() {
    state.healthTimer = 0;
    const alerts = Array.from(document.querySelectorAll(PAGE_ERROR_SELECTOR)).slice(0, 30);
    state.pageAlert = alerts.some((element) => {
      return !element.hidden
        && element.getAttribute("aria-hidden") !== "true"
        && !element.closest('[hidden], [aria-hidden="true"]')
        && element.childNodes.length > 0;
    });
    document.documentElement.dataset.glcoOnline = navigator.onLine ? "true" : "false";
    scheduleStatus();
  }

  function scheduleHealthScan(delay = 180) {
    if (state.healthTimer) {
      return;
    }
    state.healthTimer = setTimeout(scanHealth, delay);
  }

  function statusSnapshot() {
    let frozen = 0;
    for (const turn of state.turns) {
      if (turn.dataset.glcoFrozen === "true") {
        frozen += 1;
      }
    }

    let frozenChunks = 0;
    for (const chunk of state.chunks) {
      if (chunk.dataset.glcoChunkFrozen === "true") {
        frozenChunks += 1;
      }
    }

    return {
      enabled: state.settings.enabled,
      active: state.active || state.chunkActive,
      paused: isPaused(),
      mode: state.settings.mode,
      turns: state.turns.length,
      frozen,
      chunks: state.chunks.size,
      frozenChunks,
      thinkingOptimized: state.chunkActive,
      activationTurns: preset().activationTurns,
      chunkActivationBlocks: preset().chunkActivationBlocks,
      startupRescue: document.documentElement.dataset.glcoStartup !== "false",
      online: navigator.onLine,
      pageAlert: state.pageAlert
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
    root.dataset.glcoChunks = String(snapshot.chunks);
    root.dataset.glcoFrozenChunks = String(snapshot.frozenChunks);
    root.dataset.glcoPageAlert = String(snapshot.pageAlert);

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
    thawAllChunks();
    destroyIntersectionObserver();
    destroyChunkIntersectionObserver();
    scheduleStatus(true);
    state.resumeTimer = setTimeout(() => {
      state.pausedUntil = 0;
      if (state.active) {
        createIntersectionObserver();
      }
      if (state.chunkActive) {
        createChunkIntersectionObserver();
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
      thawAllChunks();
      destroyChunkIntersectionObserver();
      scheduleChunkScan(0);
    }, 180);
  }

  function installObservers() {
    state.mutationObserver = new MutationObserver((records) => {
      if (mutationCanChangeTurns(records)) {
        scheduleScan();
      }
      if (state.settings.enabled && mutationCanChangeChunks(records)) {
        scheduleChunkScan();
      }
      if (mutationCanChangeHealth(records)) {
        scheduleHealthScan();
      }
    });
    state.mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    addEventListener("resize", refreshAfterResize, { passive: true });
    addEventListener("pageshow", () => {
      scheduleScan(0);
      scheduleHealthScan(0);
    }, { passive: true });
    addEventListener("online", () => scheduleHealthScan(0), { passive: true });
    addEventListener("offline", () => scheduleHealthScan(0), { passive: true });
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
      destroyChunkIntersectionObserver();
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
    scanHealth();
    scheduleScan(40);
  }

  start();
})();
