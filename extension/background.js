const DEFAULT_WS_URL = "ws://127.0.0.1:8765/ws/extension";
const SHARE_TAG = "__NDI_SHARE__";

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let settings = {
  serverWsUrl: DEFAULT_WS_URL,
  trustedDebugger: true,
  keepLocalAudio: true,
};

let studioMode = false;
let sharedTabId = null;
let activeMeetTabId = null;
let meetStates = {}; // tabId -> state
let slidesStates = {}; // tabId -> state
let youtubeStates = {}; // tabId -> state
let statePushDebounce = null;
let lastConnectionStatus = "disconnected";

// --- Settings & Storage ---

async function loadSettings() {
  const res = await chrome.storage.local.get([
    "serverWsUrl",
    "trustedDebugger",
    "keepLocalAudio",
  ]);
  settings = {
    serverWsUrl: res.serverWsUrl || DEFAULT_WS_URL,
    trustedDebugger: res.trustedDebugger !== false,
    keepLocalAudio: res.keepLocalAudio !== false,
  };
}

// --- Studio Mode Probe ---

async function probeStudioMode() {
  try {
    const tabs = await chrome.tabs.query({});
    const candidate = tabs.find(
      (t) =>
        t.id &&
        t.url &&
        (t.url.startsWith("https://") || t.url.startsWith("http://"))
    );
    if (!candidate) return studioMode;
    const streamId = await new Promise((resolve) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: candidate.id }, (id) => {
        if (chrome.runtime.lastError || !id) {
          resolve(null);
        } else {
          resolve(id);
        }
      });
    });
    studioMode = Boolean(streamId);
  } catch (_) {
    studioMode = false;
  }
  return studioMode;
}

// --- Content Script Injection on Already-Open Tabs ---

async function ensureInjectedForTab(tab) {
  if (!tab || !tab.id || !tab.url) return;
  try {
    if (tab.url.startsWith("https://meet.google.com/")) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/meet_main.js"],
        world: "MAIN",
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/meet.js"],
      });
    } else if (tab.url.startsWith("https://docs.google.com/presentation/")) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content/slides.js"],
      });
    } else if (
      tab.url.startsWith("https://www.youtube.com/") ||
      tab.url.startsWith("https://youtu.be/") ||
      tab.url.startsWith("https://www.youtube-nocookie.com/")
    ) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/youtube.js"],
      });
    }
  } catch (_) {
    // Ignore tabs where scripting isn't permitted
  }
}

async function ensureAllContentScripts() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => ensureInjectedForTab(t)));
  } catch (_) {}
}

// --- Tab Classification & State Snapshot ---

function classifyTab(url = "") {
  if (url.startsWith("https://meet.google.com/")) return "meet";
  if (url.startsWith("https://docs.google.com/presentation/")) return "slides";
  if (
    url.startsWith("https://www.youtube.com/") ||
    url.startsWith("https://youtu.be/") ||
    url.startsWith("https://www.youtube-nocookie.com/")
  ) {
    return "youtube";
  }
  return "web";
}

async function buildChromeState() {
  const tabs = await chrome.tabs.query({});
  const win = await chrome.windows.getLastFocused().catch(() => null);

  const openIds = new Set(tabs.map((t) => t.id));
  for (const idStr of Object.keys(meetStates)) {
    if (!openIds.has(Number(idStr))) delete meetStates[idStr];
  }
  for (const idStr of Object.keys(slidesStates)) {
    if (!openIds.has(Number(idStr))) delete slidesStates[idStr];
  }
  for (const idStr of Object.keys(youtubeStates)) {
    if (!openIds.has(Number(idStr))) delete youtubeStates[idStr];
  }
  if (sharedTabId && !openIds.has(sharedTabId)) {
    sharedTabId = null;
  }

  let activeTabId = null;
  const serializedTabs = tabs.map((t) => {
    const kind = classifyTab(t.url || "");
    if (t.active && (!win || t.windowId === win.id)) {
      activeTabId = t.id;
    }
    return {
      id: t.id,
      windowId: t.windowId,
      index: t.index,
      title: t.title || t.url || "Tab",
      url: t.url || "",
      active: Boolean(t.active),
      audible: Boolean(t.audible),
      muted: Boolean(t.mutedInfo && t.mutedInfo.muted),
      pinned: Boolean(t.pinned),
      kind,
      isShared: sharedTabId === t.id,
      favIconUrl: t.favIconUrl || "",
    };
  });

  // Clear sharedTabId if Meet stopped presenting
  const anyPresenting = Object.values(meetStates).some((s) => s && s.isPresenting);
  if (!anyPresenting) {
    sharedTabId = null;
  }

  return {
    extension_id: chrome.runtime.id,
    studio_mode: studioMode,
    debugger_enabled: settings.trustedDebugger,
    tabs: serializedTabs,
    active_tab_id: activeTabId,
    shared_tab_id: sharedTabId,
    meet: meetStates,
    slides: slidesStates,
    youtube: youtubeStates,
  };
}

function scheduleStatePush(delayMs = 80) {
  if (statePushDebounce) clearTimeout(statePushDebounce);
  statePushDebounce = setTimeout(() => {
    statePushDebounce = null;
    pushStateNow();
  }, delayMs);
}

async function pushStateNow() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const state = await buildChromeState();
    ws.send(JSON.stringify({ type: "chrome_state", state }));
  } catch (_) {}
}

// --- WebSocket Connection & MV3 Keepalive ---

function setConnStatus(status) {
  lastConnectionStatus = status;
  chrome.action.setBadgeText({
    text: status === "connected" ? "ON" : status === "connecting" ? "..." : "OFF",
  });
  chrome.action.setBadgeBackgroundColor({
    color:
      status === "connected"
        ? "#10b981"
        : status === "connecting"
        ? "#f59e0b"
        : "#ef4444",
  });
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch (_) {}
    }
  }, 20000);
}

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delayMs);
}

async function connectWebSocket() {
  await loadSettings();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnStatus("connecting");
  try {
    ws = new WebSocket(settings.serverWsUrl);
  } catch (_) {
    setConnStatus("disconnected");
    scheduleReconnect(3000);
    return;
  }

  ws.onopen = async () => {
    setConnStatus("connected");
    startHeartbeat();
    await ensureAllContentScripts();
    await probeStudioMode();
    try {
      ws.send(
        JSON.stringify({
          type: "hello",
          extension_id: chrome.runtime.id,
          studio_mode: studioMode,
          debugger_enabled: settings.trustedDebugger,
        })
      );
    } catch (_) {}
    await queryAllSpecializedTabs();
    await pushStateNow();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (msg.type === "pong" || msg.type === "welcome") return;
    if (msg.type === "command") {
      const res = await executeCommand(msg.action, msg.payload || {});
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "command_result",
            request_id: msg.request_id,
            ...res,
          })
        );
      }
      scheduleStatePush(120);
    }
  };

  ws.onclose = () => {
    stopHeartbeat();
    ws = null;
    setConnStatus("disconnected");
    scheduleReconnect(2500);
  };

  ws.onerror = () => {
    try {
      ws && ws.close();
    } catch (_) {}
  };
}

async function queryAllSpecializedTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (t) => {
      if (!t.id || !t.url) return;
      const kind = classifyTab(t.url);
      if (kind === "web") return;
      try {
        const res = await chrome.tabs.sendMessage(t.id, {
          target: kind,
          action: "getState",
        });
        if (res && res.ok && res.state) {
          if (kind === "meet") meetStates[t.id] = res.state;
          if (kind === "slides") slidesStates[t.id] = res.state;
          if (kind === "youtube") youtubeStates[t.id] = res.state;
        }
      } catch (_) {}
    })
  );
}

// --- Trusted CDP / Debugger Helpers (used only when needed + permitted) ---

async function withDebugger(tabId, fn) {
  if (!settings.trustedDebugger) {
    throw new Error("Trusted debugger mode is disabled in extension popup.");
  }
  const debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;
    return await fn(debuggee);
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch (_) {}
    }
  }
}

async function debuggerClickAt(tabId, x, y) {
  return withDebugger(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  });
}

async function debuggerSendKey(tabId, key, code, keyCode, modifiers = 0) {
  return withDebugger(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  });
}

async function debuggerEvalUserGesture(tabId, expression) {
  return withDebugger(tabId, async (debuggee) => {
    return await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      userGesture: true,
      awaitPromise: true,
    });
  });
}

// --- Helper Utilities ---

function normalizeUrl(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  if (trimmed.includes(".") && !trimmed.includes(" ")) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  return tab;
}

async function getTargetTab(kind, explicitTabId) {
  if (explicitTabId) {
    return await chrome.tabs.get(Number(explicitTabId));
  }
  const tabs = await chrome.tabs.query({});
  const activeMatch = tabs.find((t) => t.active && classifyTab(t.url || "") === kind);
  if (activeMatch) return activeMatch;
  const anyMatch = tabs.find((t) => classifyTab(t.url || "") === kind);
  if (anyMatch) return anyMatch;
  throw new Error(`No open ${kind} tab found in Chrome.`);
}

async function sendTabMessageSafe(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    const tab = await chrome.tabs.get(tabId);
    await ensureInjectedForTab(tab);
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function tagTabTitleForShare(tabId, tagPrefix) {
  try {
    const [{ result: origTitle }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (prefix) => {
        const current = document.title || "";
        if (!window.__NDI_ORIG_TITLE__) {
          window.__NDI_ORIG_TITLE__ = current;
        }
        if (!current.startsWith(prefix)) {
          document.title = `${prefix} ${window.__NDI_ORIG_TITLE__}`;
        }
        return window.__NDI_ORIG_TITLE__;
      },
      args: [tagPrefix],
    });
    setTimeout(() => restoreTabTitle(tabId), 10000);
    return origTitle;
  } catch (_) {
    return null;
  }
}

async function restoreTabTitle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__NDI_ORIG_TITLE__) {
          document.title = window.__NDI_ORIG_TITLE__;
          delete window.__NDI_ORIG_TITLE__;
        }
      },
    });
  } catch (_) {}
}

async function getTabCaptureStreamId(targetTabId, consumerTabId) {
  return await new Promise((resolve) => {
    chrome.tabCapture.getMediaStreamId(
      { targetTabId, consumerTabId },
      (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          resolve(null);
        } else {
          resolve(streamId);
        }
      }
    );
  });
}

// --- Command Execution ---

async function executeCommand(action, payload) {
  try {
    // ---- TAB & URL COMMANDS ----
    if (action === "tabs:list") {
      await queryAllSpecializedTabs();
      return { ok: true, data: await buildChromeState() };
    }

    if (action === "tabs:open_url") {
      const url = normalizeUrl(payload.url);
      if (!url) return { ok: false, error: "URL cannot be empty." };
      let tab;
      if (payload.inCurrent && payload.tabId) {
        tab = await chrome.tabs.update(Number(payload.tabId), { url, active: true });
      } else {
        tab = await chrome.tabs.create({ url, active: payload.active !== false });
      }
      if (tab && tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      return { ok: true, message: `Opened ${url}`, data: { tabId: tab.id } };
    }

    if (action === "tabs:activate") {
      const tab = await focusTab(Number(payload.tabId));
      return { ok: true, message: `Focused ${tab.title}` };
    }

    if (action === "tabs:close") {
      await chrome.tabs.remove(Number(payload.tabId));
      return { ok: true, message: "Tab closed" };
    }

    if (action === "tabs:reload") {
      await chrome.tabs.reload(Number(payload.tabId));
      return { ok: true, message: "Tab reloaded" };
    }

    if (action === "tabs:mute") {
      const tabId = Number(payload.tabId);
      const tab = await chrome.tabs.get(tabId);
      const nextMuted =
        typeof payload.muted === "boolean"
          ? payload.muted
          : !(tab.mutedInfo && tab.mutedInfo.muted);
      await chrome.tabs.update(tabId, { muted: nextMuted });
      return { ok: true, message: nextMuted ? "Tab muted" : "Tab unmuted" };
    }

    if (action === "tabs:window_fullscreen") {
      const tab = payload.tabId
        ? await chrome.tabs.get(Number(payload.tabId))
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab) return { ok: false, error: "No active window" };
      const win = await chrome.windows.get(tab.windowId);
      const nextState =
        typeof payload.fullscreen === "boolean"
          ? payload.fullscreen
            ? "fullscreen"
            : "normal"
          : win.state === "fullscreen"
          ? "normal"
          : "fullscreen";
      await chrome.windows.update(win.id, { state: nextState });
      return { ok: true, message: `Window ${nextState}` };
    }

    // ---- GOOGLE MEET COMMANDS ----
    if (action.startsWith("meet:")) {
      const meetTab = await getTargetTab("meet", payload.tabId || activeMeetTabId);
      activeMeetTabId = meetTab.id;
      await ensureInjectedForTab(meetTab);

      if (action === "meet:focus") {
        await focusTab(meetTab.id);
        return { ok: true, message: "Focused Google Meet" };
      }

      if (action === "meet:stop_share") {
        const res = await sendTabMessageSafe(meetTab.id, {
          target: "meet",
          action: "stopSharing",
        });
        sharedTabId = null;
        return res;
      }

      if (action === "meet:toggle_mic") {
        return await sendTabMessageSafe(meetTab.id, {
          target: "meet",
          action: "toggleMic",
        });
      }

      if (action === "meet:toggle_cam") {
        return await sendTabMessageSafe(meetTab.id, {
          target: "meet",
          action: "toggleCam",
        });
      }

      if (action === "meet:leave") {
        sharedTabId = null;
        return await sendTabMessageSafe(meetTab.id, {
          target: "meet",
          action: "leaveCall",
        });
      }

      if (action === "meet:share_tab") {
        const targetTabId = Number(payload.targetTabId);
        if (!targetTabId) {
          return { ok: false, error: "Select a Chrome tab to share first." };
        }
        if (targetTabId === meetTab.id) {
          return { ok: false, error: "Cannot share the Google Meet tab itself." };
        }

        const targetTab = await chrome.tabs.get(targetTabId);
        const currentMeetState = meetStates[meetTab.id] || {};

        // 1) Try Studio Zero-Click mode via chrome.tabCapture.getMediaStreamId
        const streamId = await getTabCaptureStreamId(targetTabId, meetTab.id);
        if (streamId) {
          studioMode = true;

          // If already presenting via our MAIN bridge, try zero-downtime live track swap
          if (currentMeetState.isPresenting) {
            const swapRes = await sendTabMessageSafe(meetTab.id, {
              target: "meet",
              action: "swapStream",
              streamId,
              keepLocalAudio: settings.keepLocalAudio,
            });
            if (swapRes && swapRes.ok) {
              sharedTabId = targetTabId;
              if (payload.focusTarget) await focusTab(targetTabId);
              return {
                ok: true,
                message: `Swapped Meet share to "${targetTab.title}"`,
              };
            }
            // Otherwise stop old presentation before starting fresh
            await sendTabMessageSafe(meetTab.id, {
              target: "meet",
              action: "stopSharing",
            });
            await new Promise((r) => setTimeout(r, 350));
          }

          await focusTab(meetTab.id);
          const startRes = await sendTabMessageSafe(meetTab.id, {
            target: "meet",
            action: "startPresent",
            streamId,
            keepLocalAudio: settings.keepLocalAudio,
          });

          if (startRes && startRes.needsTrustedClick && startRes.clickCoords && settings.trustedDebugger) {
            await sendTabMessageSafe(meetTab.id, {
              target: "meet",
              action: "preparePendingCapture",
              streamId,
              keepLocalAudio: settings.keepLocalAudio,
            });
            await debuggerClickAt(
              meetTab.id,
              startRes.clickCoords.x,
              startRes.clickCoords.y
            );
          }

          sharedTabId = targetTabId;
          if (payload.focusTarget) {
            setTimeout(() => focusTab(targetTabId).catch(() => {}), 600);
          }
          return {
            ok: true,
            message: `Sharing "${targetTab.title}" in Meet (Studio Mode)`,
          };
        }

        // 2) Normal Chrome / --auto-select-tab-capture-source-by-title mode
        if (currentMeetState.isPresenting && payload.restartIfPresenting !== false) {
          await sendTabMessageSafe(meetTab.id, {
            target: "meet",
            action: "stopSharing",
          });
          await new Promise((r) => setTimeout(r, 400));
        }

        await tagTabTitleForShare(targetTabId, `${SHARE_TAG} [SHARE THIS]`);
        await focusTab(meetTab.id);

        const startRes = await sendTabMessageSafe(meetTab.id, {
          target: "meet",
          action: "startPresent",
        });

        if (startRes && startRes.needsTrustedClick && startRes.clickCoords && settings.trustedDebugger) {
          await debuggerClickAt(
            meetTab.id,
            startRes.clickCoords.x,
            startRes.clickCoords.y
          );
          // If Present opened a menu, check if "A tab" menuitem appeared and click it via debugger
          await new Promise((r) => setTimeout(r, 300));
          const coordsRes = await sendTabMessageSafe(meetTab.id, {
            target: "meet",
            action: "getPresentCoords",
          });
          if (coordsRes && coordsRes.tabItemCoords) {
            await debuggerClickAt(
              meetTab.id,
              coordsRes.tabItemCoords.x,
              coordsRes.tabItemCoords.y
            );
          }
        }

        sharedTabId = targetTabId;
        return {
          ok: true,
          message: `Opened Meet picker for "${targetTab.title}" — confirm in Chrome if prompted`,
        };
      }
    }

    // ---- GOOGLE SLIDES COMMANDS ----
    if (action.startsWith("slides:")) {
      const slidesTab = await getTargetTab("slides", payload.tabId);
      await ensureInjectedForTab(slidesTab);
      const subAction = action.split(":")[1];

      if (subAction === "focus") {
        await focusTab(slidesTab.id);
        return { ok: true, message: "Focused Google Slides" };
      }

      const res = await sendTabMessageSafe(slidesTab.id, {
        target: "slides",
        action: subAction,
        slide: payload.slide,
        inTab: payload.inTab !== false,
      });

      if (res && res.needDebuggerFallback && settings.trustedDebugger) {
        const keyMap = {
          ArrowRight: ["ArrowRight", "ArrowRight", 39, 0],
          ArrowLeft: ["ArrowLeft", "ArrowLeft", 37, 0],
          Escape: ["Escape", "Escape", 27, 0],
          "Ctrl+F5": ["F5", "F5", 116, 2],
        };
        const spec = keyMap[res.needDebuggerFallback];
        if (spec) {
          await focusTab(slidesTab.id);
          await debuggerSendKey(slidesTab.id, spec[0], spec[1], spec[2], spec[3] || 0);
          return { ok: true, message: `Slides: ${subAction} (trusted key)` };
        }
      }

      if (res && res.needDebuggerGoto && settings.trustedDebugger) {
        await focusTab(slidesTab.id);
        const digits = String(res.needDebuggerGoto).split("");
        for (const d of digits) {
          const code = d.charCodeAt(0);
          await debuggerSendKey(slidesTab.id, d, `Digit${d}`, code);
        }
        await debuggerSendKey(slidesTab.id, "Enter", "Enter", 13);
        return { ok: true, message: `Jumped to slide ${res.needDebuggerGoto}` };
      }

      return res || { ok: true };
    }

    // ---- YOUTUBE COMMANDS ----
    if (action.startsWith("youtube:")) {
      const ytTab = await getTargetTab("youtube", payload.tabId);
      await ensureInjectedForTab(ytTab);
      const subAction = action.split(":")[1];

      if (subAction === "focus") {
        await focusTab(ytTab.id);
        return { ok: true, message: "Focused YouTube" };
      }

      const res = await sendTabMessageSafe(ytTab.id, {
        target: "youtube",
        action: subAction,
        delta: payload.delta,
        time: payload.time,
        muted: payload.muted,
        volume: payload.volume,
        enabled: payload.enabled,
      });

      // Handle fullscreen gesture fallback cleanly
      if (subAction === "fullscreen" && res && res.gestureBlocked) {
        if (settings.trustedDebugger) {
          try {
            await focusTab(ytTab.id);
            await debuggerEvalUserGesture(
              ytTab.id,
              `(() => {
                if (document.fullscreenElement) { return document.exitFullscreen(); }
                const el = document.querySelector('#movie_player') || document.querySelector('video');
                return el && el.requestFullscreen ? el.requestFullscreen() : null;
              })()`
            );
            return { ok: true, message: "Toggled YouTube fullscreen" };
          } catch (_) {}
        }
        // Fallback: Fill-Tab + Chrome window fullscreen
        const fillRes = await sendTabMessageSafe(ytTab.id, {
          target: "youtube",
          action: "fillTab",
          enabled: true,
        });
        await chrome.windows
          .update(ytTab.windowId, { state: "fullscreen" })
          .catch(() => {});
        return {
          ok: true,
          message: "Enabled Fill-Tab + Window Fullscreen",
          data: fillRes,
        };
      }

      return res || { ok: true };
    }

    return { ok: false, error: `Unknown command: ${action}` };
  } catch (err) {
    return {
      ok: false,
      error: String(err && err.message ? err.message : err),
    };
  }
}

// --- Extension Listeners ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "MEET_STATE_UPDATE" && sender.tab && sender.tab.id) {
    const prevPresenting =
      meetStates[sender.tab.id] && meetStates[sender.tab.id].isPresenting;
    meetStates[sender.tab.id] = msg.state;
    activeMeetTabId = sender.tab.id;
    if (!prevPresenting && msg.state && msg.state.isPresenting && sharedTabId) {
      restoreTabTitle(sharedTabId);
    }
    if (prevPresenting && msg.state && !msg.state.isPresenting) {
      sharedTabId = null;
    }
    scheduleStatePush(60);
    return;
  }

  if (msg.type === "SLIDES_STATE_UPDATE" && sender.tab && sender.tab.id) {
    slidesStates[sender.tab.id] = msg.state;
    scheduleStatePush(60);
    return;
  }

  if (msg.type === "YOUTUBE_STATE_UPDATE" && sender.tab && sender.tab.id) {
    youtubeStates[sender.tab.id] = msg.state;
    scheduleStatePush(60);
    return;
  }

  if (msg.type === "POPUP_GET_STATUS") {
    buildChromeState().then((state) => {
      sendResponse({
        status: lastConnectionStatus,
        settings,
        extensionId: chrome.runtime.id,
        studioMode,
        tabCount: state.tabs.length,
      });
    });
    return true;
  }

  if (msg.type === "POPUP_SAVE_SETTINGS") {
    chrome.storage.local.set(msg.settings || {}).then(async () => {
      await loadSettings();
      if (ws) {
        try {
          ws.close();
        } catch (_) {}
      }
      connectWebSocket();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "POPUP_RECONNECT") {
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
    }
    connectWebSocket();
    sendResponse({ ok: true });
    return;
  }
});

chrome.tabs.onCreated.addListener(() => scheduleStatePush(120));
chrome.tabs.onRemoved.addListener(() => scheduleStatePush(100));
chrome.tabs.onActivated.addListener(() => scheduleStatePush(60));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    ensureInjectedForTab(tab);
    probeStudioMode().then(() => scheduleStatePush(100));
  } else if (changeInfo.title || changeInfo.url || changeInfo.audible !== undefined || changeInfo.mutedInfo) {
    scheduleStatePush(120);
  }
});
chrome.windows.onFocusChanged.addListener(() => scheduleStatePush(80));

chrome.alarms.create("ndi-ws-watchdog", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ndi-ws-watchdog") {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  connectWebSocket();
});
chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
});

connectWebSocket();
