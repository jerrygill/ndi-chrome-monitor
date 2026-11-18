const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  ws: null,
  wsConnected: false,
  reconnectTimer: null,
  pingTimer: null,
  audioEnabled: false,
  audioCtx: null,
  nextAudioTime: 0,
  vuDecayTimer: null,
  lastFrameAt: 0,
  decodingVideo: false,
  pendingVideoBlob: null,
  ndi: null,
  chrome: null,
  pendingCommands: new Map(),
  selectedSlidesTabId: null,
  selectedYtTabId: null,
  selectedMeetTabId: null,
  selectedShareTabId: null,
  ytDraggingScrub: false,
  ytDraggingVol: false,
  leaveArmedUntil: 0,
};

const appShell = $("#appShell");
const wsDot = $("#wsDot");
const ndiSourceSelect = $("#ndiSourceSelect");
const extStatusPill = $("#extStatusPill");
const audioToggleBtn = $("#audioToggleBtn");
const audioIcon = $("#audioIcon");
const audioLabel = $("#audioLabel");
const toggleControlsBtn = $("#toggleControlsBtn");
const toggleControlsIcon = $("#toggleControlsIcon");

const ndiCanvas = $("#ndiCanvas");
const ndiCtx = ndiCanvas.getContext("2d", { alpha: false });
const monitorFrame = $("#monitorFrame");
const monitorTally = $("#monitorTally");
const hudSourceName = $("#hudSourceName");
const hudTelemetry = $("#hudTelemetry");
const vuFillL = $("#vuFillL");
const vuFillR = $("#vuFillR");
const standbyOverlay = $("#standbyOverlay");
const standbyTitle = $("#standbyTitle");
const standbySub = $("#standbySub");

// --- Toast Feedback ---
function showToast(msg, kind = "ok") {
  const stack = $("#toastStack");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  stack.appendChild(el);
  while (stack.children.length > 3) {
    stack.removeChild(stack.firstChild);
  }
  setTimeout(() => {
    el.remove();
  }, 2800);
}

// --- Formatting Helpers ---
function formatTime(secs) {
  if (!Number.isFinite(secs) || secs < 0) return "00:00";
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function shortHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return url || "";
  }
}

async function copyTextSafe(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (_) {}
  ta.remove();
  return ok;
}

// --- WebSocket & Commands ---
function sendWs(obj) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(obj));
  return true;
}

function sendChromeCommand(action, payload = {}, { quiet = false } = {}) {
  if (!state.wsConnected) {
    showToast("Bridge server disconnected", "err");
    return Promise.resolve({ ok: false, error: "Server disconnected" });
  }
  if (!state.chrome || !state.chrome.connected) {
    showToast("Chrome extension not connected", "err");
    return Promise.resolve({ ok: false, error: "Chrome extension offline" });
  }

  const requestId = Math.random().toString(36).slice(2, 12);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingCommands.delete(requestId);
      if (!quiet) showToast(`Timed out: ${action}`, "err");
      resolve({ ok: false, error: "Timed out" });
    }, 8500);

    state.pendingCommands.set(requestId, {
      resolve: (res) => {
        clearTimeout(timer);
        if (!res.ok) {
          showToast(res.error || `Failed: ${action}`, "err");
        } else if (!quiet && res.message) {
          showToast(res.message, "ok");
        }
        resolve(res);
      },
    });

    sendWs({
      type: "chrome:command",
      action,
      payload,
      request_id: requestId,
    });
  });
}

function connectWebSocket() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/monitor`);
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  ws.onopen = () => {
    state.wsConnected = true;
    wsDot.classList.add("online");
    sendWs({
      type: "monitor:prefs",
      video_enabled: true,
      audio_enabled: state.audioEnabled,
    });
    if (state.pingTimer) clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
      sendWs({ type: "ping" });
    }, 15000);
  };

  ws.onmessage = (evt) => {
    if (typeof evt.data === "string") {
      try {
        handleJsonMessage(JSON.parse(evt.data));
      } catch (_) {}
    } else if (evt.data instanceof ArrayBuffer) {
      handleBinaryPacket(evt.data);
    }
  };

  ws.onclose = () => {
    state.wsConnected = false;
    state.ws = null;
    wsDot.classList.remove("online");
    if (state.pingTimer) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
    if (!state.reconnectTimer) {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        connectWebSocket();
      }, 2000);
    }
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch (_) {}
  };
}

function handleJsonMessage(msg) {
  if (msg.type === "pong") return;

  if (msg.type === "state_snapshot") {
    if (msg.ndi) applyNdiStatus(msg.ndi);
    if (msg.chrome) applyChromeState(msg.chrome);
    return;
  }
  if (msg.type === "ndi_status" && msg.ndi) {
    applyNdiStatus(msg.ndi);
    return;
  }
  if (msg.type === "ndi_sources" && Array.isArray(msg.sources)) {
    if (!state.ndi) state.ndi = {};
    state.ndi.sources = msg.sources;
    renderNdiSources();
    return;
  }
  if (msg.type === "chrome_state" && msg.chrome) {
    applyChromeState(msg.chrome);
    return;
  }
  if (msg.type === "command_result") {
    const pending = state.pendingCommands.get(msg.request_id);
    if (pending) {
      state.pendingCommands.delete(msg.request_id);
      pending.resolve(msg);
    }
  }
}

// --- Video & Audio Packet Decoding ---
function handleBinaryPacket(buf) {
  if (buf.byteLength < 2) return;
  const view = new Uint8Array(buf);
  const kind = view[0];

  if (kind === 1) {
    // Video JPEG packet
    const blob = new Blob([buf.slice(1)], { type: "image/jpeg" });
    state.pendingVideoBlob = blob;
    if (!state.decodingVideo) {
      drainVideoQueue();
    }
  } else if (kind === 2 && buf.byteLength > 8) {
    // Audio Int16 PCM packet: <BBHI + stereo samples
    const dv = new DataView(buf);
    const channels = Math.max(1, Math.min(2, dv.getUint8(1)));
    const sampleRate = dv.getUint32(4, true) || 48000;
    const pcm = new Int16Array(buf, 8);
    const frameCount = Math.floor(pcm.length / channels);
    if (frameCount <= 0) return;

    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    let sumL = 0;
    let sumR = 0;
    for (let i = 0; i < frameCount; i++) {
      const l = pcm[i * channels] / 32768.0;
      const r = channels > 1 ? pcm[i * channels + 1] / 32768.0 : l;
      left[i] = l;
      right[i] = r;
      sumL += l * l;
      sumR += r * r;
    }

    const rmsL = Math.sqrt(sumL / frameCount);
    const rmsR = Math.sqrt(sumR / frameCount);
    updateVuMeter(rmsL, rmsR);

    if (state.audioEnabled && state.audioCtx) {
      scheduleAudioSamples(left, right, sampleRate);
    }
  }
}

async function drainVideoQueue() {
  state.decodingVideo = true;
  try {
    while (state.pendingVideoBlob) {
      const blob = state.pendingVideoBlob;
      state.pendingVideoBlob = null;
      await renderJpegBlob(blob);
    }
  } finally {
    state.decodingVideo = false;
  }
}

async function renderJpegBlob(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      if (ndiCanvas.width !== bitmap.width || ndiCanvas.height !== bitmap.height) {
        ndiCanvas.width = bitmap.width;
        ndiCanvas.height = bitmap.height;
      }
      ndiCtx.drawImage(bitmap, 0, 0);
      bitmap.close();
      onVideoFrameDrawn();
      return;
    } catch (_) {}
  }

  const url = URL.createObjectURL(blob);
  await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (ndiCanvas.width !== img.naturalWidth || ndiCanvas.height !== img.naturalHeight) {
        ndiCanvas.width = img.naturalWidth;
        ndiCanvas.height = img.naturalHeight;
      }
      ndiCtx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      onVideoFrameDrawn();
      resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    img.src = url;
  });
}

function onVideoFrameDrawn() {
  state.lastFrameAt = Date.now();
  standbyOverlay.classList.add("hidden");
}

function updateVuMeter(rmsL, rmsR) {
  const pctL = Math.min(100, Math.round(Math.pow(rmsL * 3.0, 0.65) * 100));
  const pctR = Math.min(100, Math.round(Math.pow(rmsR * 3.0, 0.65) * 100));
  vuFillL.style.width = `${pctL}%`;
  vuFillR.style.width = `${pctR}%`;
  if (state.vuDecayTimer) clearTimeout(state.vuDecayTimer);
  state.vuDecayTimer = setTimeout(() => {
    vuFillL.style.width = "0%";
    vuFillR.style.width = "0%";
  }, 300);
}

function scheduleAudioSamples(left, right, sampleRate) {
  const ctx = state.audioCtx;
  if (!ctx || ctx.state !== "running") return;
  const audioBuf = ctx.createBuffer(2, left.length, sampleRate);
  audioBuf.copyToChannel(left, 0);
  audioBuf.copyToChannel(right, 1);

  const src = ctx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(ctx.destination);

  const now = ctx.currentTime;
  if (state.nextAudioTime < now || state.nextAudioTime - now > 0.22) {
    state.nextAudioTime = now + 0.045;
  }
  src.start(state.nextAudioTime);
  state.nextAudioTime += audioBuf.duration;
}

const AUDIO_SVG_OFF =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
const AUDIO_SVG_ON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';

async function toggleAudio() {
  if (!state.audioEnabled) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      showToast("WebAudio unavailable in this browser", "err");
      return;
    }
    if (!state.audioCtx) {
      state.audioCtx = new AudioCtx({ sampleRate: 48000 });
    }
    try {
      await state.audioCtx.resume();
      // 1-sample silent prime unlocks iOS Safari hardware audio session reliably
      const prime = state.audioCtx.createBuffer(1, 1, 48000);
      const src = state.audioCtx.createBufferSource();
      src.buffer = prime;
      src.connect(state.audioCtx.destination);
      src.start(0);
    } catch (_) {}

    state.audioEnabled = true;
    state.nextAudioTime = 0;
    audioToggleBtn.classList.add("active");
    audioIcon.innerHTML = AUDIO_SVG_ON;
    audioLabel.textContent = "Audio On";
    sendWs({ type: "monitor:prefs", audio_enabled: true });
    showToast("NDI audio enabled", "ok");
  } else {
    state.audioEnabled = false;
    audioToggleBtn.classList.remove("active");
    audioIcon.innerHTML = AUDIO_SVG_OFF;
    audioLabel.textContent = "Audio";
    sendWs({ type: "monitor:prefs", audio_enabled: false });
    if (state.audioCtx && state.audioCtx.state === "running") {
      state.audioCtx.suspend().catch(() => {});
    }
  }
}

// --- NDI State Rendering ---
function applyNdiStatus(ndi) {
  state.ndi = ndi;
  renderNdiSources();

  const srcName = ndi.selected_source || "No NDI Source";
  hudSourceName.textContent = srcName;
  hudTelemetry.textContent = `${ndi.width || 0}×${ndi.height || 0} · ${(ndi.actual_fps || 0).toFixed(1)} fps`;

  const cfg = ndi.config || {};
  if (cfg.max_width) $("#ndiResSelect").value = String(cfg.max_width);
  if (cfg.fps) $("#ndiFpsSelect").value = String(cfg.fps);
  if (cfg.quality) $("#ndiQualitySelect").value = String(cfg.quality);
  if (cfg.bandwidth) $("#ndiBandwidthSelect").value = String(cfg.bandwidth);

  if (ndi.connected) {
    if (Date.now() - state.lastFrameAt < 3000) {
      standbyOverlay.classList.add("hidden");
    }
  } else {
    standbyOverlay.classList.remove("hidden");
    if (ndi.selected_source) {
      standbyTitle.textContent = `Connecting to "${ndi.selected_source}"…`;
      standbySub.textContent = ndi.ndi_error
        ? `NDI notice: ${ndi.ndi_error}`
        : "Waiting for video frames from NDI sender…";
    } else {
      standbyTitle.textContent = "Waiting for NDI Signal";
      standbySub.textContent =
        "Select a source above or launch the built-in test signal to preview immediately.";
    }
  }

  updateTallyIndicators();
}

function renderNdiSources() {
  const ndi = state.ndi || {};
  const sources = ndi.sources || [];
  const selected = ndi.selected_source || "";

  ndiSourceSelect.innerHTML = "";
  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "Select NDI Source…";
  ndiSourceSelect.appendChild(emptyOpt);

  for (const src of sources) {
    const opt = document.createElement("option");
    opt.value = src;
    opt.textContent = src;
    if (src === selected) opt.selected = true;
    ndiSourceSelect.appendChild(opt);
  }
}

function updateTallyIndicators() {
  const ndiConnected = Boolean(state.ndi && state.ndi.connected);
  const meetMap = (state.chrome && state.chrome.meet) || {};
  const anyPresenting = Object.values(meetMap).some((m) => m && m.isPresenting);

  monitorFrame.classList.remove("tally-live", "tally-on-air");
  monitorTally.classList.remove("live", "on-air");

  if (anyPresenting) {
    monitorFrame.classList.add("tally-on-air");
    monitorTally.classList.add("on-air");
    monitorTally.textContent = "SHARING";
  } else if (ndiConnected) {
    monitorFrame.classList.add("tally-live");
    monitorTally.classList.add("live");
    monitorTally.textContent = "LIVE";
  } else {
    monitorTally.textContent = "STANDBY";
  }
}

// --- Chrome Extension State Rendering ---
function getActiveOrFirstTab(kind, preferredId) {
  const tabs = (state.chrome && state.chrome.tabs) || [];
  const matches = tabs.filter((t) => t.kind === kind);
  if (matches.length === 0) return { matches, current: null };
  let current = matches.find((t) => t.id === preferredId);
  if (!current) current = matches.find((t) => t.id === state.chrome.shared_tab_id);
  if (!current) current = matches.find((t) => t.active);
  if (!current) current = matches[0];
  return { matches, current };
}

function applyChromeState(chrome) {
  state.chrome = chrome;

  // Header status pill
  extStatusPill.classList.remove("ok", "studio", "offline");
  if (!chrome.connected) {
    extStatusPill.textContent = "Offline";
    extStatusPill.classList.add("offline");
  } else if (chrome.studio_mode) {
    extStatusPill.textContent = "Studio";
    extStatusPill.classList.add("studio");
  } else {
    extStatusPill.textContent = "Chrome";
    extStatusPill.classList.add("ok");
  }

  const tabs = chrome.tabs || [];
  const meetTabs = tabs.filter((t) => t.kind === "meet");
  const slidesTabs = tabs.filter((t) => t.kind === "slides");
  const ytTabs = tabs.filter((t) => t.kind === "youtube");

  // Badges on Dock Tabs
  $("#badgeTabs").textContent = String(tabs.length);
  const bSlides = $("#badgeSlides");
  bSlides.hidden = slidesTabs.length === 0;
  bSlides.textContent = String(slidesTabs.length);

  const bYt = $("#badgeYoutube");
  bYt.hidden = ytTabs.length === 0;
  bYt.textContent = String(ytTabs.length);

  const bMeet = $("#badgeMeet");
  const anyPresenting = Object.values(chrome.meet || {}).some((m) => m && m.isPresenting);
  bMeet.hidden = meetTabs.length === 0;
  bMeet.textContent = anyPresenting ? "SHARE" : String(meetTabs.length);
  bMeet.classList.toggle("live", anyPresenting);

  renderQuickShareBar(tabs, chrome);
  renderSlidesPanel();
  renderYoutubePanel();
  renderMeetPanel();
  renderTabsList(tabs, chrome);
  updateTallyIndicators();
}

function renderQuickShareBar(tabs, chrome) {
  const select = $("#quickShareSelect");
  const shareable = tabs.filter((t) => t.kind !== "meet");
  // Put Slides & YouTube first for fast presenter selection
  const order = { slides: 0, youtube: 1, web: 2 };
  const sorted = [...shareable].sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));

  if (!sorted.some((t) => t.id === state.selectedShareTabId)) {
    const shared = sorted.find((t) => t.id === chrome.shared_tab_id);
    const slides = sorted.find((t) => t.kind === "slides");
    const yt = sorted.find((t) => t.kind === "youtube");
    state.selectedShareTabId = (shared || slides || yt || sorted[0] || {}).id || null;
  }

  select.innerHTML = "";
  if (sorted.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = chrome.connected ? "No non-Meet tabs open" : "Extension offline…";
    select.appendChild(opt);
  } else {
    for (const t of sorted) {
      const opt = document.createElement("option");
      opt.value = String(t.id);
      const tag = t.kind === "slides" ? "[Slides] " : t.kind === "youtube" ? "[YT] " : "";
      const sharedMark = t.id === chrome.shared_tab_id ? "● " : "";
      opt.textContent = `${sharedMark}${tag}${t.title}`;
      if (t.id === state.selectedShareTabId) opt.selected = true;
      select.appendChild(opt);
    }
  }

  const { current: meetTab } = getActiveOrFirstTab("meet", state.selectedMeetTabId);
  const meetSt = (meetTab && chrome.meet && chrome.meet[String(meetTab.id)]) || {};
  const isPresenting = Boolean(meetSt.isPresenting || chrome.shared_tab_id);

  const shareBtn = $("#quickShareBtn");
  shareBtn.textContent = isPresenting ? "Swap Tab" : "Share Tab";
  shareBtn.disabled = !chrome.connected || sorted.length === 0 || !meetTab;
  $("#quickStopShareBtn").disabled = !chrome.connected || !isPresenting;

  const micBtn = $("#quickMicBtn");
  micBtn.disabled = !chrome.connected || !meetTab;
  micBtn.classList.toggle("is-alert", meetSt.micMuted === true);
  micBtn.classList.toggle("is-on", meetSt.micMuted === false);
  micBtn.textContent = meetSt.micMuted === true ? "Mic Off" : "Mic On";

  const camBtn = $("#quickCamBtn");
  camBtn.disabled = !chrome.connected || !meetTab;
  camBtn.classList.toggle("is-alert", meetSt.camOff === true);
  camBtn.classList.toggle("is-on", meetSt.camOff === false);
  camBtn.textContent = meetSt.camOff === true ? "Cam Off" : "Cam On";
}

function renderSlidesPanel() {
  const { matches, current } = getActiveOrFirstTab("slides", state.selectedSlidesTabId);
  if (current) state.selectedSlidesTabId = current.id;

  const select = $("#slidesTabSelect");
  select.innerHTML = "";
  if (matches.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No Google Slides tab open";
    select.appendChild(opt);
  } else {
    for (const t of matches) {
      const opt = document.createElement("option");
      opt.value = String(t.id);
      opt.textContent = t.title;
      if (current && t.id === current.id) opt.selected = true;
      select.appendChild(opt);
    }
  }

  const st = (current && state.chrome.slides && state.chrome.slides[String(current.id)]) || {};
  const chip = $("#slidesStatusChip");
  chip.classList.toggle("live", Boolean(st.isPresenting));

  if (!current) {
    chip.textContent = "No Slides tab";
  } else {
    const mode = st.isPresenting ? "Presenting" : "Edit";
    const num = st.currentSlide
      ? st.totalSlides
        ? `Slide ${st.currentSlide} / ${st.totalSlides}`
        : `Slide ${st.currentSlide}`
      : "Ready";
    chip.textContent = `${mode} · ${num}`;
  }

  const hasSlides = Boolean(current && state.chrome && state.chrome.connected);
  ["#slidesPrevBtn", "#slidesNextBtn", "#slidesPresentBtn", "#slidesExitBtn", "#slidesFocusBtn"].forEach((id) => {
    $(id).disabled = !hasSlides;
  });
  $("#slidesPresentBtn").classList.toggle("is-on", Boolean(st.isPresenting));
  $("#slidesShareBtn").disabled =
    !hasSlides || !((state.chrome.tabs || []).some((t) => t.kind === "meet"));
}

function renderYoutubePanel() {
  const { matches, current } = getActiveOrFirstTab("youtube", state.selectedYtTabId);
  if (current) state.selectedYtTabId = current.id;

  const select = $("#ytTabSelect");
  select.innerHTML = "";
  if (matches.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No YouTube tab open";
    select.appendChild(opt);
  } else {
    for (const t of matches) {
      const opt = document.createElement("option");
      opt.value = String(t.id);
      opt.textContent = t.title;
      if (current && t.id === current.id) opt.selected = true;
      select.appendChild(opt);
    }
  }

  const st = (current && state.chrome.youtube && state.chrome.youtube[String(current.id)]) || {};
  const hasYt = Boolean(current && state.chrome && state.chrome.connected);
  const dur = Number(st.duration || 0);
  const cur = Number(st.currentTime || 0);

  $("#ytTimeChip").textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  if (!state.ytDraggingScrub) {
    const scrub = $("#ytScrubRange");
    scrub.max = dur > 0 ? String(Math.floor(dur)) : "100";
    scrub.value = dur > 0 ? String(Math.floor(cur)) : "0";
    scrub.disabled = !hasYt || dur <= 0;
  }

  if (!state.ytDraggingVol) {
    $("#ytVolRange").value = String(typeof st.volume === "number" ? st.volume : 100);
    $("#ytVolRange").disabled = !hasYt;
  }

  const playBtn = $("#ytPlayPauseBtn");
  playBtn.textContent = st.hasVideo && !st.paused ? "⏸ Pause" : "▶ Play";
  playBtn.disabled = !hasYt;

  const muteBtn = $("#ytMuteBtn");
  muteBtn.textContent = st.muted ? "Unmute" : "Mute";
  muteBtn.classList.toggle("is-alert", Boolean(st.muted));
  muteBtn.disabled = !hasYt;

  $("#ytFillTabBtn").classList.toggle("is-on", Boolean(st.fillTab));
  $("#ytHideHudBtn").classList.toggle("is-on", Boolean(st.hideHud));
  $("#ytTheaterBtn").classList.toggle("is-on", Boolean(st.theater));
  $("#ytFullscreenBtn").classList.toggle("is-on", Boolean(st.nativeFullscreen));

  [
    "#ytBack10Btn",
    "#ytFwd10Btn",
    "#ytFillTabBtn",
    "#ytHideHudBtn",
    "#ytTheaterBtn",
    "#ytFullscreenBtn",
    "#ytFocusBtn",
  ].forEach((id) => {
    $(id).disabled = !hasYt;
  });

  $("#ytShareBtn").disabled =
    !hasYt || !((state.chrome.tabs || []).some((t) => t.kind === "meet"));
}

function renderMeetPanel() {
  const { matches, current } = getActiveOrFirstTab("meet", state.selectedMeetTabId);
  if (current) state.selectedMeetTabId = current.id;

  const select = $("#meetTabSelect");
  select.innerHTML = "";
  if (matches.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No Google Meet tab open";
    select.appendChild(opt);
  } else {
    for (const t of matches) {
      const opt = document.createElement("option");
      opt.value = String(t.id);
      opt.textContent = t.title;
      if (current && t.id === current.id) opt.selected = true;
      select.appendChild(opt);
    }
  }

  const st = (current && state.chrome.meet && state.chrome.meet[String(current.id)]) || {};
  const chip = $("#meetModeChip");
  const connected = Boolean(current && state.chrome && state.chrome.connected);

  if (!current) {
    chip.textContent = "Open meet.google.com";
    chip.classList.remove("live");
  } else if (st.isPresenting) {
    chip.textContent = `Sharing · ${st.meetingCode || "Meet"}`;
    chip.classList.add("live");
  } else {
    const modeLabel = state.chrome.studio_mode ? "Studio Ready" : "Normal Picker";
    chip.textContent = `${st.meetingCode || "In Meet"} · ${modeLabel}`;
    chip.classList.toggle("live", Boolean(st.inMeeting));
  }

  $("#meetFocusBtn").disabled = !connected;
  $("#meetShareBtn").disabled =
    !connected || !((state.chrome.tabs || []).some((t) => t.kind !== "meet"));
  $("#meetStopShareBtn").disabled = !connected || !st.isPresenting;
  $("#meetMicBtn").disabled = !connected;
  $("#meetCamBtn").disabled = !connected;
  $("#meetLeaveBtn").disabled = !connected;

  $("#meetMicBtn").classList.toggle("is-alert", st.micMuted === true);
  $("#meetCamBtn").classList.toggle("is-alert", st.camOff === true);
}

function renderTabsList(tabs, chrome) {
  const list = $("#tabsList");
  const summary = $("#tabsSummary");
  if (!chrome.connected) {
    summary.textContent = "Waiting for Chrome extension connection…";
    list.innerHTML = "";
    return;
  }

  summary.textContent = `${tabs.length} open Chrome tab${tabs.length === 1 ? "" : "s"}`;
  const hasMeet = tabs.some((t) => t.kind === "meet");
  list.innerHTML = "";

  for (const t of tabs) {
    const row = document.createElement("div");
    row.className = "tab-row";
    if (t.active) row.classList.add("is-active");
    if (t.id === chrome.shared_tab_id) row.classList.add("is-shared");

    const meta = document.createElement("div");
    meta.className = "tab-meta";

    const tag = document.createElement("span");
    tag.className = `kind-tag kind-${t.kind}`;
    tag.textContent = t.kind === "youtube" ? "YT" : t.kind.toUpperCase();

    const titleWrap = document.createElement("div");
    titleWrap.className = "tab-title-wrap";
    const titleEl = document.createElement("span");
    titleEl.className = "tab-title";
    titleEl.textContent = (t.id === chrome.shared_tab_id ? "● SHARING · " : "") + t.title;
    const urlEl = document.createElement("span");
    urlEl.className = "tab-url";
    urlEl.textContent = shortHost(t.url) + (t.audible ? " · 🔊 Audio" : "");
    titleWrap.append(titleEl, urlEl);

    meta.append(tag, titleWrap);

    const acts = document.createElement("div");
    acts.className = "tab-actions";

    if (t.kind !== "meet" && hasMeet) {
      const shareBtn = document.createElement("button");
      shareBtn.className = "btn btn-emerald btn-sm";
      shareBtn.type = "button";
      shareBtn.textContent = t.id === chrome.shared_tab_id ? "Sharing" : "Share";
      shareBtn.addEventListener("click", () => {
        state.selectedShareTabId = t.id;
        shareTabInMeet(t.id);
      });
      acts.appendChild(shareBtn);
    }

    const focusBtn = document.createElement("button");
    focusBtn.className = "btn btn-subtle btn-sm";
    focusBtn.type = "button";
    focusBtn.textContent = "Focus";
    focusBtn.addEventListener("click", () => {
      sendChromeCommand("tabs:activate", { tabId: t.id });
    });

    const muteBtn = document.createElement("button");
    muteBtn.className = `btn btn-subtle btn-sm ${t.muted ? "is-alert" : ""}`;
    muteBtn.type = "button";
    muteBtn.textContent = t.muted ? "Unmute" : "Mute";
    muteBtn.addEventListener("click", () => {
      sendChromeCommand("tabs:mute", { tabId: t.id }, { quiet: true });
    });

    const reloadBtn = document.createElement("button");
    reloadBtn.className = "btn-icon";
    reloadBtn.type = "button";
    reloadBtn.title = "Reload tab";
    reloadBtn.textContent = "↻";
    reloadBtn.addEventListener("click", () => {
      sendChromeCommand("tabs:reload", { tabId: t.id });
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn-icon";
    closeBtn.type = "button";
    closeBtn.title = "Close tab";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => {
      sendChromeCommand("tabs:close", { tabId: t.id });
    });

    acts.append(focusBtn, muteBtn, reloadBtn, closeBtn);
    row.append(meta, acts);
    list.appendChild(row);
  }
}

// --- High-level Actions ---
function shareTabInMeet(targetTabId) {
  const id = Number(targetTabId || $("#quickShareSelect").value);
  if (!id) {
    showToast("Pick a Chrome tab to share first", "err");
    return;
  }
  sendChromeCommand("meet:share_tab", {
    tabId: state.selectedMeetTabId,
    targetTabId: id,
    focusTarget: $("#focusAfterShareChk").checked,
  });
}

// --- UI Event Wiring ---
function initUi() {
  // Source dropdown & refresh
  ndiSourceSelect.addEventListener("change", () => {
    sendWs({ type: "ndi:select_source", source: ndiSourceSelect.value });
  });
  $("#refreshSourcesBtn").addEventListener("click", () => {
    sendWs({ type: "ndi:refresh_sources" });
    showToast("Scanning LAN for NDI sources…", "ok");
  });
  $("#standbyRefreshBtn").addEventListener("click", () => {
    sendWs({ type: "ndi:refresh_sources" });
    showToast("Scanning LAN for NDI sources…", "ok");
  });
  $("#standbyDemoBtn").addEventListener("click", () => {
    sendWs({ type: "ndi:select_source", source: "Built-in Test Signal (Demo)" });
  });
  $("#ndiDemoBtn").addEventListener("click", () => {
    sendWs({ type: "ndi:select_source", source: "Built-in Test Signal (Demo)" });
  });

  // Audio unlock
  audioToggleBtn.addEventListener("click", toggleAudio);

  // Collapse / expand top controls
  toggleControlsBtn.addEventListener("click", () => {
    const collapsed = appShell.classList.toggle("controls-collapsed");
    toggleControlsIcon.textContent = collapsed ? "▼" : "▲";
  });

  // Monitor Fullscreen (native or iOS pseudo-fullscreen)
  $("#monitorFullscreenBtn").addEventListener("click", async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      appShell.classList.remove("monitor-pseudo-fullscreen");
      return;
    }
    if (appShell.classList.contains("monitor-pseudo-fullscreen")) {
      appShell.classList.remove("monitor-pseudo-fullscreen");
      return;
    }
    if (monitorFrame.requestFullscreen) {
      try {
        await monitorFrame.requestFullscreen();
        return;
      } catch (_) {}
    }
    appShell.classList.add("monitor-pseudo-fullscreen");
  });

  // Dock tab navigation
  $$(".dock-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.panel;
      $$(".dock-tab").forEach((b) => b.classList.toggle("active", b === btn));
      $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === target));
    });
  });

  // Open URL Form & Quick Presets
  $("#openUrlForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#urlInput");
    const raw = input.value.trim();
    if (!raw) return;
    sendChromeCommand("tabs:open_url", { url: raw, active: true }).then((res) => {
      if (res && res.ok) input.value = "";
    });
  });

  $$("[data-open-url]").forEach((btn) => {
    btn.addEventListener("click", () => {
      sendChromeCommand("tabs:open_url", { url: btn.dataset.openUrl, active: true });
    });
  });

  // Quick Meet Bar
  $("#quickShareSelect").addEventListener("change", (e) => {
    state.selectedShareTabId = Number(e.target.value) || null;
  });
  $("#quickShareBtn").addEventListener("click", () => {
    shareTabInMeet($("#quickShareSelect").value);
  });
  $("#quickStopShareBtn").addEventListener("click", () => {
    sendChromeCommand("meet:stop_share", { tabId: state.selectedMeetTabId });
  });
  $("#quickMicBtn").addEventListener("click", () => {
    sendChromeCommand("meet:toggle_mic", { tabId: state.selectedMeetTabId }, { quiet: true });
  });
  $("#quickCamBtn").addEventListener("click", () => {
    sendChromeCommand("meet:toggle_cam", { tabId: state.selectedMeetTabId }, { quiet: true });
  });

  // Slides Controls
  $("#slidesTabSelect").addEventListener("change", (e) => {
    state.selectedSlidesTabId = Number(e.target.value) || null;
  });
  $("#slidesFocusBtn").addEventListener("click", () => {
    sendChromeCommand("slides:focus", { tabId: state.selectedSlidesTabId });
  });
  $("#slidesPrevBtn").addEventListener("click", () => {
    sendChromeCommand("slides:prev", { tabId: state.selectedSlidesTabId }, { quiet: true });
  });
  $("#slidesNextBtn").addEventListener("click", () => {
    sendChromeCommand("slides:next", { tabId: state.selectedSlidesTabId }, { quiet: true });
  });
  $("#slidesPresentBtn").addEventListener("click", () => {
    sendChromeCommand("slides:present", { tabId: state.selectedSlidesTabId, inTab: true });
  });
  $("#slidesExitBtn").addEventListener("click", () => {
    sendChromeCommand("slides:exit", { tabId: state.selectedSlidesTabId });
  });
  $("#slidesShareBtn").addEventListener("click", async () => {
    const id = state.selectedSlidesTabId;
    if (!id) return;
    const st = (state.chrome && state.chrome.slides && state.chrome.slides[String(id)]) || {};
    if (!st.isPresenting) {
      await sendChromeCommand("slides:present", { tabId: id, inTab: true }, { quiet: true });
    }
    state.selectedShareTabId = id;
    shareTabInMeet(id);
  });
  $("#slidesGotoForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const num = parseInt($("#slidesGotoInput").value, 10);
    if (!num || num < 1) return;
    sendChromeCommand("slides:goto", { tabId: state.selectedSlidesTabId, slide: num });
  });

  // YouTube Controls
  $("#ytTabSelect").addEventListener("change", (e) => {
    state.selectedYtTabId = Number(e.target.value) || null;
  });
  $("#ytFocusBtn").addEventListener("click", () => {
    sendChromeCommand("youtube:focus", { tabId: state.selectedYtTabId });
  });
  $("#ytShareBtn").addEventListener("click", () => {
    if (!state.selectedYtTabId) return;
    state.selectedShareTabId = state.selectedYtTabId;
    shareTabInMeet(state.selectedYtTabId);
  });
  $("#ytPlayPauseBtn").addEventListener("click", () => {
    sendChromeCommand("youtube:togglePlay", { tabId: state.selectedYtTabId }, { quiet: true });
  });
  $("#ytBack10Btn").addEventListener("click", () => {
    sendChromeCommand("youtube:seek", { tabId: state.selectedYtTabId, delta: -10 }, { quiet: true });
  });
  $("#ytFwd10Btn").addEventListener("click", () => {
    sendChromeCommand("youtube:seek", { tabId: state.selectedYtTabId, delta: 10 }, { quiet: true });
  });
  $("#ytMuteBtn").addEventListener("click", () => {
    sendChromeCommand("youtube:mute", { tabId: state.selectedYtTabId }, { quiet: true });
  });
  $("#ytFillTabBtn").addEventListener("click", () => {
    sendChromeCommand("youtube:fillTab", { tabId: state.selectedYtTabId });
  });
  $("#ytHideHudBtn").addEventListener("click", () => {
    sendChromeCommand("youtube:hideHud", { tabId: state.selectedYtTabId });
  });
  $("#ytTheaterBtn").addEventListener("click", () => {
    sendChromeCommand("youtube:theater", { tabId: state.selectedYtTabId }, { quiet: true });
  });
  $("#ytFullscreenBtn").addEventListener("click", () => {
    sendChromeCommand("youtube:fullscreen", { tabId: state.selectedYtTabId });
  });

  const scrub = $("#ytScrubRange");
  scrub.addEventListener("pointerdown", () => (state.ytDraggingScrub = true));
  scrub.addEventListener("change", () => {
    state.ytDraggingScrub = false;
    sendChromeCommand(
      "youtube:seek",
      { tabId: state.selectedYtTabId, time: Number(scrub.value) },
      { quiet: true }
    );
  });

  const volRange = $("#ytVolRange");
  volRange.addEventListener("pointerdown", () => (state.ytDraggingVol = true));
  volRange.addEventListener("change", () => {
    state.ytDraggingVol = false;
    sendChromeCommand(
      "youtube:setVolume",
      { tabId: state.selectedYtTabId, volume: Number(volRange.value) },
      { quiet: true }
    );
  });

  // Tabs Panel Controls
  $("#tabsRefreshBtn").addEventListener("click", () => {
    sendChromeCommand("tabs:list", {}, { quiet: true });
  });
  $("#winFullscreenBtn").addEventListener("click", () => {
    sendChromeCommand("tabs:window_fullscreen", {});
  });

  // Meet Panel Controls
  $("#meetTabSelect").addEventListener("change", (e) => {
    state.selectedMeetTabId = Number(e.target.value) || null;
  });
  $("#meetFocusBtn").addEventListener("click", () => {
    sendChromeCommand("meet:focus", { tabId: state.selectedMeetTabId });
  });
  $("#meetShareBtn").addEventListener("click", () => {
    shareTabInMeet($("#quickShareSelect").value);
  });
  $("#meetStopShareBtn").addEventListener("click", () => {
    sendChromeCommand("meet:stop_share", { tabId: state.selectedMeetTabId });
  });
  $("#meetMicBtn").addEventListener("click", () => {
    sendChromeCommand("meet:toggle_mic", { tabId: state.selectedMeetTabId }, { quiet: true });
  });
  $("#meetCamBtn").addEventListener("click", () => {
    sendChromeCommand("meet:toggle_cam", { tabId: state.selectedMeetTabId }, { quiet: true });
  });

  const leaveBtn = $("#meetLeaveBtn");
  leaveBtn.addEventListener("click", () => {
    const now = Date.now();
    if (now > state.leaveArmedUntil) {
      state.leaveArmedUntil = now + 3500;
      leaveBtn.textContent = "Confirm Leave?";
      setTimeout(() => {
        if (Date.now() >= state.leaveArmedUntil) {
          leaveBtn.textContent = "Leave Call";
        }
      }, 3600);
      return;
    }
    state.leaveArmedUntil = 0;
    leaveBtn.textContent = "Leave Call";
    sendChromeCommand("meet:leave", { tabId: state.selectedMeetTabId });
  });

  // NDI Config Controls
  function pushNdiConfig() {
    sendWs({
      type: "ndi:config",
      max_width: Number($("#ndiResSelect").value),
      fps: Number($("#ndiFpsSelect").value),
      quality: Number($("#ndiQualitySelect").value),
      bandwidth: $("#ndiBandwidthSelect").value,
    });
  }
  ["#ndiResSelect", "#ndiFpsSelect", "#ndiQualitySelect", "#ndiBandwidthSelect"].forEach((id) => {
    $(id).addEventListener("change", pushNdiConfig);
  });

  // QR Modal
  const qrModal = $("#qrModal");
  $("#qrBtn").addEventListener("click", async () => {
    qrModal.showModal();
    try {
      const [infoRes, svgRes] = await Promise.all([
        fetch("/api/info"),
        fetch("/api/qr.svg"),
      ]);
      const info = await infoRes.json();
      const svgText = await svgRes.text();
      $("#qrLanUrl").textContent = info.lan_url || location.origin;
      $("#qrExtWsUrl").textContent = info.extension_ws_local || "";
      $("#qrBox").innerHTML = svgText;
    } catch (_) {
      $("#qrBox").textContent = "Unable to load QR info.";
    }
  });
  $("#closeQrBtn").addEventListener("click", () => qrModal.close());
  qrModal.addEventListener("click", (e) => {
    if (e.target === qrModal) qrModal.close();
  });

  $$(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      const ok = await copyTextSafe(target.textContent || "");
      if (ok) {
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy"), 1000);
      }
    });
  });

  // Keyboard shortcuts when on desktop browser (not typing inside an input)
  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "ArrowRight") {
      if (state.selectedSlidesTabId) {
        sendChromeCommand("slides:next", { tabId: state.selectedSlidesTabId }, { quiet: true });
      }
    } else if (e.key === "ArrowLeft") {
      if (state.selectedSlidesTabId) {
        sendChromeCommand("slides:prev", { tabId: state.selectedSlidesTabId }, { quiet: true });
      }
    } else if (e.key === " ") {
      if (state.selectedYtTabId) {
        e.preventDefault();
        sendChromeCommand("youtube:togglePlay", { tabId: state.selectedYtTabId }, { quiet: true });
      }
    }
  });

  // Re-sync WS and iOS Safari audio session when returning to foreground
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (!state.ws || state.ws.readyState === WebSocket.CLOSED) {
        connectWebSocket();
      }
      if (state.audioEnabled && state.audioCtx && state.audioCtx.state === "suspended") {
        state.nextAudioTime = 0;
        state.audioCtx.resume().catch(() => {});
      }
    }
  });
}

initUi();
connectWebSocket();
