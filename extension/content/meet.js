(() => {
  if (window.__NDI_MEET_CONTENT_LOADED__) return;
  window.__NDI_MEET_CONTENT_LOADED__ = true;

  let mainStreamActive = false;
  let lastGetDisplayMediaError = null;
  let lastReportedJson = "";
  let pendingSwapResolver = null;

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findButtonByMatchers(matchers) {
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], [role="menuitem"]')
    ).filter(isVisible);

    for (const matcher of matchers) {
      for (const el of candidates) {
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const tip = (el.getAttribute("data-tooltip") || "").toLowerCase();
        const jsname = (el.getAttribute("jsname") || "").toLowerCase();
        const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (matcher({ el, aria, tip, jsname, txt })) {
          return el;
        }
      }
    }
    return null;
  }

  function findPresentButton() {
    return findButtonByMatchers([
      ({ aria, tip }) =>
        aria.includes("present now") ||
        tip.includes("present now") ||
        aria.includes("share screen") ||
        tip.includes("share screen"),
      ({ aria }) =>
        aria.includes("present") &&
        !aria.includes("stop") &&
        !aria.includes("options"),
      ({ jsname }) => jsname === "hnggjb",
    ]);
  }

  function findStopPresentingButton() {
    return findButtonByMatchers([
      ({ aria, tip }) =>
        aria.includes("stop presenting") ||
        aria.includes("stop sharing") ||
        tip.includes("stop presenting") ||
        tip.includes("stop sharing"),
      ({ txt }) =>
        txt === "stop presenting" ||
        txt === "stop sharing" ||
        txt.includes("stop presenting"),
    ]);
  }

  function findMicButton() {
    return findButtonByMatchers([
      ({ aria, tip }) =>
        aria.includes("microphone") || tip.includes("microphone"),
      ({ jsname }) => jsname === "bohaee",
    ]);
  }

  function findCamButton() {
    return findButtonByMatchers([
      ({ aria, tip }) => aria.includes("camera") || tip.includes("camera"),
      ({ jsname }) => jsname === "r3gxpe",
    ]);
  }

  function findLeaveButton() {
    return findButtonByMatchers([
      ({ aria, tip }) =>
        aria.includes("leave call") || tip.includes("leave call"),
      ({ jsname }) => jsname === "cqylad",
    ]);
  }

  function findTabShareMenuItem() {
    const items = Array.from(
      document.querySelectorAll('[role="menuitem"], [role="option"], li, button')
    ).filter(isVisible);

    for (const item of items) {
      const text = (item.innerText || item.textContent || "")
        .trim()
        .toLowerCase();
      const aria = (item.getAttribute("aria-label") || "").toLowerCase();
      if (
        text === "a tab" ||
        text.startsWith("a tab") ||
        text.includes("chrome tab") ||
        aria.includes("a tab") ||
        aria.includes("chrome tab") ||
        text.includes("best for video and animation")
      ) {
        return item;
      }
    }
    return null;
  }

  function getRectCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  function clickElement(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (_) {}
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function readBoolMuted(el) {
    if (!el) return null;
    const attr = el.getAttribute("data-is-muted");
    if (attr === "true") return true;
    if (attr === "false") return false;
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("turn on")) return true;
    if (aria.includes("turn off")) return false;
    return null;
  }

  function readMeetState() {
    const leaveBtn = findLeaveButton();
    const presentBtn = findPresentButton();
    const stopBtn = findStopPresentingButton();
    const micBtn = findMicButton();
    const camBtn = findCamButton();

    const codeMatch = location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    const isPresenting = mainStreamActive || Boolean(stopBtn);

    return {
      url: location.href,
      meetingCode: codeMatch ? codeMatch[1] : location.pathname.replace(/^\//, ""),
      inMeeting: Boolean(leaveBtn || presentBtn || stopBtn),
      isPresenting,
      micMuted: readBoolMuted(micBtn),
      camOff: readBoolMuted(camBtn),
      canPresent: Boolean(presentBtn),
      canStopPresent: Boolean(stopBtn || mainStreamActive),
    };
  }

  function reportState(force = false) {
    const state = readMeetState();
    const raw = JSON.stringify(state);
    if (!force && raw === lastReportedJson) return;
    lastReportedJson = raw;
    try {
      chrome.runtime.sendMessage({ type: "MEET_STATE_UPDATE", state });
    } catch (_) {}
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== "NDI_MEET_MAIN") return;

    if (event.data.type === "DISPLAY_STREAM_STATUS") {
      mainStreamActive = Boolean(event.data.active);
      reportState(true);
    } else if (event.data.type === "GET_DISPLAY_MEDIA_ERROR") {
      lastGetDisplayMediaError = {
        name: event.data.name,
        error: event.data.error,
        ts: Date.now(),
      };
    } else if (event.data.type === "SWAP_RESULT" && pendingSwapResolver) {
      const resolve = pendingSwapResolver;
      pendingSwapResolver = null;
      resolve(event.data);
    }
  });

  async function triggerPresentFlow(streamId, keepLocalAudio) {
    lastGetDisplayMediaError = null;
    if (streamId) {
      window.postMessage(
        {
          source: "NDI_MEET_CONTENT",
          type: "SET_PENDING_CAPTURE",
          streamId,
          keepLocalAudio,
        },
        "*"
      );
    }

    const presentBtn = findPresentButton();
    if (!presentBtn) {
      return {
        ok: false,
        error: "Could not find Present/Share Screen button in Google Meet. Join the meeting first.",
      };
    }

    const coords = getRectCenter(presentBtn);
    clickElement(presentBtn);

    // Wait briefly to see if a menu ("A tab" / "A window" / "Your entire screen") opens
    await new Promise((r) => setTimeout(r, 320));
    const tabItem = findTabShareMenuItem();
    if (tabItem) {
      const itemCoords = getRectCenter(tabItem);
      clickElement(tabItem);
      await new Promise((r) => setTimeout(r, 350));
      const needsTrusted =
        lastGetDisplayMediaError &&
        Date.now() - lastGetDisplayMediaError.ts < 2000 &&
        /activation|gesture/i.test(lastGetDisplayMediaError.error || "");
      return {
        ok: true,
        needsTrustedClick: needsTrusted,
        clickCoords: itemCoords,
        usedMenu: true,
      };
    }

    // Check if getDisplayMedia failed due to transient user activation
    const needsTrusted =
      lastGetDisplayMediaError &&
      Date.now() - lastGetDisplayMediaError.ts < 2000 &&
      /activation|gesture/i.test(lastGetDisplayMediaError.error || "");

    return {
      ok: true,
      needsTrustedClick: needsTrusted,
      clickCoords: coords,
      usedMenu: false,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "meet") return;

    (async () => {
      if (msg.action === "getState") {
        sendResponse({ ok: true, state: readMeetState() });
        return;
      }

      if (msg.action === "getPresentCoords") {
        const presentBtn = findPresentButton();
        const tabItem = findTabShareMenuItem();
        sendResponse({
          ok: Boolean(tabItem || presentBtn),
          presentCoords: presentBtn ? getRectCenter(presentBtn) : null,
          tabItemCoords: tabItem ? getRectCenter(tabItem) : null,
        });
        return;
      }

      if (msg.action === "preparePendingCapture") {
        window.postMessage(
          {
            source: "NDI_MEET_CONTENT",
            type: "SET_PENDING_CAPTURE",
            streamId: msg.streamId,
            keepLocalAudio: msg.keepLocalAudio !== false,
          },
          "*"
        );
        sendResponse({ ok: true });
        return;
      }

      if (msg.action === "startPresent") {
        const res = await triggerPresentFlow(msg.streamId || null, msg.keepLocalAudio !== false);
        setTimeout(() => reportState(true), 400);
        sendResponse(res);
        return;
      }

      if (msg.action === "swapStream") {
        const swapRes = await new Promise((resolve) => {
          pendingSwapResolver = resolve;
          window.postMessage(
            {
              source: "NDI_MEET_CONTENT",
              type: "SWAP_LIVE_STREAM",
              streamId: msg.streamId,
              keepLocalAudio: msg.keepLocalAudio !== false,
            },
            "*"
          );
          setTimeout(() => {
            if (pendingSwapResolver === resolve) {
              pendingSwapResolver = null;
              resolve({ ok: false, error: "swap_timeout" });
            }
          }, 2500);
        });
        reportState(true);
        sendResponse(swapRes);
        return;
      }

      if (msg.action === "stopSharing") {
        const stopBtn = findStopPresentingButton();
        const clicked = clickElement(stopBtn);
        window.postMessage(
          { source: "NDI_MEET_CONTENT", type: "STOP_DISPLAY_STREAM" },
          "*"
        );
        setTimeout(() => reportState(true), 300);
        sendResponse({
          ok: clicked || mainStreamActive,
          message: clicked || mainStreamActive ? "Stopped presenting" : "Not currently presenting",
        });
        return;
      }

      if (msg.action === "toggleMic") {
        const btn = findMicButton();
        if (!btn) {
          sendResponse({ ok: false, error: "Mic button not found" });
          return;
        }
        clickElement(btn);
        setTimeout(() => reportState(true), 200);
        sendResponse({ ok: true });
        return;
      }

      if (msg.action === "toggleCam") {
        const btn = findCamButton();
        if (!btn) {
          sendResponse({ ok: false, error: "Camera button not found" });
          return;
        }
        clickElement(btn);
        setTimeout(() => reportState(true), 200);
        sendResponse({ ok: true });
        return;
      }

      if (msg.action === "leaveCall") {
        const btn = findLeaveButton();
        if (!btn) {
          sendResponse({ ok: false, error: "Leave call button not found" });
          return;
        }
        clickElement(btn);
        setTimeout(() => reportState(true), 300);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: `Unknown Meet action: ${msg.action}` });
    })();

    return true;
  });

  const observer = new MutationObserver(() => reportState(false));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label", "data-is-muted"],
  });
  setInterval(() => reportState(false), 1200);
  setTimeout(() => reportState(true), 500);
})();
