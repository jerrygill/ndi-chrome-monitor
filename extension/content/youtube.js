(() => {
  if (window.__NDI_YOUTUBE_CONTENT_LOADED__) return;
  window.__NDI_YOUTUBE_CONTENT_LOADED__ = true;

  let fillTabActive = false;
  let hideHudActive = false;
  let lastReportedJson = "";

  const FILL_STYLE_ID = "ndi-yt-fill-style";

  function ensureStyles() {
    let styleEl = document.getElementById(FILL_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = FILL_STYLE_ID;
      document.head.appendChild(styleEl);
    }

    let css = "";
    if (fillTabActive) {
      css += `
        html.ndi-yt-fill, html.ndi-yt-fill body {
          overflow: hidden !important;
          background: #000 !important;
        }
        html.ndi-yt-fill #masthead-container,
        html.ndi-yt-fill ytd-masthead,
        html.ndi-yt-fill #secondary,
        html.ndi-yt-fill #below,
        html.ndi-yt-fill tp-yt-app-drawer {
          display: none !important;
        }
        html.ndi-yt-fill #movie_player {
          position: fixed !important;
          inset: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          max-width: none !important;
          max-height: none !important;
          z-index: 2147483647 !important;
          background: #000 !important;
        }
        html.ndi-yt-fill #movie_player video.html5-main-video {
          width: 100vw !important;
          height: 100vh !important;
          left: 0 !important;
          top: 0 !important;
          object-fit: contain !important;
        }
      `;
    }
    if (hideHudActive) {
      css += `
        html.ndi-yt-hide-hud .ytp-chrome-top,
        html.ndi-yt-hide-hud .ytp-chrome-bottom,
        html.ndi-yt-hide-hud .ytp-gradient-top,
        html.ndi-yt-hide-hud .ytp-gradient-bottom,
        html.ndi-yt-hide-hud .ytp-bezel,
        html.ndi-yt-hide-hud .ytp-pause-overlay,
        html.ndi-yt-hide-hud .iv-branding {
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `;
    }
    styleEl.textContent = css;
    document.documentElement.classList.toggle("ndi-yt-fill", fillTabActive);
    document.documentElement.classList.toggle("ndi-yt-hide-hud", hideHudActive);
    window.dispatchEvent(new Event("resize"));
  }

  function getVideo() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function getPlayer() {
    return document.getElementById("movie_player");
  }

  function readYoutubeState() {
    const v = getVideo();
    const titleEl =
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
      document.querySelector("h1.title");
    const rawTitle =
      (titleEl && titleEl.textContent ? titleEl.textContent.trim() : "") ||
      document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim();

    const flexy = document.querySelector("ytd-watch-flexy");
    const theater = Boolean(flexy && flexy.hasAttribute("theater"));

    return {
      url: location.href,
      title: rawTitle || "YouTube",
      hasVideo: Boolean(v),
      paused: v ? v.paused : true,
      currentTime: v && Number.isFinite(v.currentTime) ? v.currentTime : 0,
      duration: v && Number.isFinite(v.duration) ? v.duration : 0,
      muted: v ? v.muted : false,
      volume: v ? Math.round(v.volume * 100) : 100,
      playbackRate: v ? v.playbackRate : 1,
      fillTab: fillTabActive,
      hideHud: hideHudActive,
      theater,
      nativeFullscreen: Boolean(document.fullscreenElement),
    };
  }

  function reportState(force = false) {
    const state = readYoutubeState();
    // Bucket currentTime to integer seconds to avoid excessive WS churn while playing
    const sigState = { ...state, currentTime: Math.floor(state.currentTime) };
    const raw = JSON.stringify(sigState);
    if (!force && raw === lastReportedJson) return;
    lastReportedJson = raw;
    try {
      chrome.runtime.sendMessage({ type: "YOUTUBE_STATE_UPDATE", state });
    } catch (_) {}
  }

  function bindVideoEvents() {
    const v = getVideo();
    if (!v || v.__ndiEventsBound) return;
    v.__ndiEventsBound = true;
    for (const evt of ["play", "pause", "volumechange", "seeked", "loadedmetadata", "ended"]) {
      v.addEventListener(evt, () => reportState(true));
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "youtube") return;

    (async () => {
      const v = getVideo();
      const player = getPlayer();

      if (msg.action === "getState") {
        sendResponse({ ok: true, state: readYoutubeState() });
        return;
      }

      if (!v) {
        sendResponse({ ok: false, error: "No YouTube video player found on this tab yet." });
        return;
      }

      if (msg.action === "play") {
        try {
          await v.play();
          reportState(true);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({
            ok: false,
            error: `Play blocked by autoplay policy (${err.message}). Try muting or clicking once in Chrome.`,
          });
        }
        return;
      }

      if (msg.action === "pause") {
        v.pause();
        reportState(true);
        sendResponse({ ok: true });
        return;
      }

      if (msg.action === "togglePlay") {
        if (v.paused) {
          try {
            await v.play();
            reportState(true);
            sendResponse({ ok: true, paused: false });
          } catch (err) {
            sendResponse({ ok: false, error: `Play blocked: ${err.message}` });
          }
        } else {
          v.pause();
          reportState(true);
          sendResponse({ ok: true, paused: true });
        }
        return;
      }

      if (msg.action === "seek") {
        if (typeof msg.time === "number") {
          v.currentTime = Math.max(0, Math.min(v.duration || 1e9, msg.time));
        } else if (typeof msg.delta === "number") {
          v.currentTime = Math.max(0, Math.min(v.duration || 1e9, v.currentTime + msg.delta));
        }
        reportState(true);
        sendResponse({ ok: true, currentTime: v.currentTime });
        return;
      }

      if (msg.action === "mute") {
        v.muted = typeof msg.muted === "boolean" ? msg.muted : !v.muted;
        reportState(true);
        sendResponse({ ok: true, muted: v.muted });
        return;
      }

      if (msg.action === "setVolume") {
        const vol = Math.max(0, Math.min(100, Number(msg.volume)));
        v.volume = vol / 100;
        if (vol > 0 && v.muted) v.muted = false;
        reportState(true);
        sendResponse({ ok: true, volume: vol });
        return;
      }

      if (msg.action === "fillTab") {
        fillTabActive = typeof msg.enabled === "boolean" ? msg.enabled : !fillTabActive;
        ensureStyles();
        reportState(true);
        sendResponse({ ok: true, fillTab: fillTabActive });
        return;
      }

      if (msg.action === "hideHud") {
        hideHudActive = typeof msg.enabled === "boolean" ? msg.enabled : !hideHudActive;
        ensureStyles();
        reportState(true);
        sendResponse({ ok: true, hideHud: hideHudActive });
        return;
      }

      if (msg.action === "theater") {
        const sizeBtn = document.querySelector(".ytp-size-button");
        if (sizeBtn) {
          sizeBtn.click();
          setTimeout(() => reportState(true), 200);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "Theater button not available" });
        }
        return;
      }

      if (msg.action === "fullscreen") {
        const target = player || v;
        if (document.fullscreenElement) {
          try {
            await document.exitFullscreen();
            reportState(true);
            sendResponse({ ok: true, nativeFullscreen: false });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
          return;
        }
        try {
          await target.requestFullscreen();
          reportState(true);
          sendResponse({ ok: true, nativeFullscreen: true });
        } catch (err) {
          // Return fallback hint so background can use debugger/window fullscreen + fillTab
          sendResponse({
            ok: false,
            gestureBlocked: true,
            error: err.message,
          });
        }
        return;
      }

      sendResponse({ ok: false, error: `Unknown YouTube action: ${msg.action}` });
    })();

    return true;
  });

  document.addEventListener("fullscreenchange", () => reportState(true));
  setInterval(() => {
    bindVideoEvents();
    reportState(false);
  }, 1000);
  bindVideoEvents();
  setTimeout(() => reportState(true), 500);
})();
