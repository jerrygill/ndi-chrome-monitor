const statusLed = document.getElementById("statusLed");
const statusText = document.getElementById("statusText");
const modeBadge = document.getElementById("modeBadge");
const tabsBadge = document.getElementById("tabsBadge");
const wsUrlInput = document.getElementById("wsUrl");
const trustedDebugger = document.getElementById("trustedDebugger");
const keepLocalAudio = document.getElementById("keepLocalAudio");
const saveBtn = document.getElementById("saveBtn");
const reconnectBtn = document.getElementById("reconnectBtn");
const openMonitorBtn = document.getElementById("openMonitorBtn");
const extIdText = document.getElementById("extIdText");
const copyIdBtn = document.getElementById("copyIdBtn");

let currentExtId = "";

function deriveHttpUrl(wsUrl) {
  try {
    const u = new URL(wsUrl);
    const proto = u.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${u.host}/`;
  } catch (_) {
    return "http://127.0.0.1:8765/";
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "POPUP_GET_STATUS" }, (res) => {
    if (!res) return;
    statusLed.className = `led ${res.status || "disconnected"}`;
    if (res.status === "connected") {
      statusText.textContent = "Connected to NDI Bridge";
    } else if (res.status === "connecting") {
      statusText.textContent = "Connecting to NDI Bridge...";
    } else {
      statusText.textContent = "Disconnected — start server";
    }

    if (res.studioMode) {
      modeBadge.textContent = "Studio Zero-Click Ready";
      modeBadge.classList.add("studio");
    } else {
      modeBadge.textContent = "Normal Chrome Mode";
      modeBadge.classList.remove("studio");
    }

    tabsBadge.textContent = `${res.tabCount || 0} Tabs`;
    currentExtId = res.extensionId || "";
    extIdText.textContent = `ID: ${currentExtId}`;

    if (res.settings) {
      if (document.activeElement !== wsUrlInput) {
        wsUrlInput.value = res.settings.serverWsUrl || "";
      }
      trustedDebugger.checked = res.settings.trustedDebugger !== false;
      keepLocalAudio.checked = res.settings.keepLocalAudio !== false;
    }
  });
}

saveBtn.addEventListener("click", () => {
  const val = wsUrlInput.value.trim() || "ws://127.0.0.1:8765/ws/extension";
  chrome.runtime.sendMessage(
    {
      type: "POPUP_SAVE_SETTINGS",
      settings: {
        serverWsUrl: val,
        trustedDebugger: trustedDebugger.checked,
        keepLocalAudio: keepLocalAudio.checked,
      },
    },
    () => {
      saveBtn.textContent = "Saved!";
      setTimeout(() => {
        saveBtn.textContent = "Save & Connect";
        refreshStatus();
      }, 800);
    }
  );
});

reconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "POPUP_RECONNECT" }, () => {
    setTimeout(refreshStatus, 400);
  });
});

openMonitorBtn.addEventListener("click", () => {
  const url = deriveHttpUrl(wsUrlInput.value.trim());
  chrome.tabs.create({ url });
});

copyIdBtn.addEventListener("click", async () => {
  if (!currentExtId) return;
  await navigator.clipboard.writeText(currentExtId);
  copyIdBtn.textContent = "Copied!";
  setTimeout(() => {
    copyIdBtn.textContent = "Copy ID";
  }, 1000);
});

refreshStatus();
setInterval(refreshStatus, 1500);
