(() => {
  "use strict";

  const chromeApi = globalThis.chrome;
  const root = document.documentElement;
  if (!root || !chromeApi?.storage?.sync) {
    return;
  }

  // "pending" enables the safe CSS immediately. The synchronized setting is
  // resolved before ChatGPT normally receives and renders conversation data.
  root.dataset.glcoStartup = "pending";

  const applyEnabled = (enabled) => {
    root.dataset.glcoStartup = enabled === false ? "false" : "true";
  };

  const updateNetworkState = () => {
    root.dataset.glcoOnline = navigator.onLine ? "true" : "false";
  };

  try {
    chromeApi.storage.sync.get({ enabled: true }, (stored) => {
      applyEnabled(stored?.enabled);
    });
  } catch {
    applyEnabled(true);
  }

  chromeApi.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName === "sync" && changes.enabled) {
      applyEnabled(changes.enabled.newValue);
    }
  });

  updateNetworkState();
  addEventListener("online", updateNetworkState, { passive: true });
  addEventListener("offline", updateNetworkState, { passive: true });
  addEventListener("pageshow", updateNetworkState, { passive: true });
})();
