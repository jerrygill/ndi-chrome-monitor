(() => {
  if (window.__NDI_MEET_MAIN_HOOKED__) return;
  window.__NDI_MEET_MAIN_HOOKED__ = true;

  let activeDisplayStream = null;
  let pendingCapture = null; // { streamId, keepLocalAudio, createdAt }
  const trackedSenders = new Set();
  const peerConnections = new Set();
  let localMonitorAudioCtx = null;
  let localMonitorSource = null;

  function clearLocalMonitorAudio() {
    try {
      if (localMonitorSource) localMonitorSource.disconnect();
    } catch (_) {}
    localMonitorSource = null;
  }

  function attachLocalAudioIfNeeded(stream, keepLocalAudio) {
    clearLocalMonitorAudio();
    if (!keepLocalAudio) return;
    if (!stream || stream.getAudioTracks().length === 0) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!localMonitorAudioCtx) {
        localMonitorAudioCtx = new AudioCtx();
      }
      if (localMonitorAudioCtx.state === "suspended") {
        localMonitorAudioCtx.resume().catch(() => {});
      }
      localMonitorSource = localMonitorAudioCtx.createMediaStreamSource(stream);
      localMonitorSource.connect(localMonitorAudioCtx.destination);
    } catch (_) {}
  }

  function notifyContentState(extra = {}) {
    const active = Boolean(
      activeDisplayStream &&
        activeDisplayStream.getTracks().some((t) => t.readyState === "live")
    );
    window.postMessage(
      {
        source: "NDI_MEET_MAIN",
        type: "DISPLAY_STREAM_STATUS",
        active,
        ...extra,
      },
      "*"
    );
  }

  function trackStreamLifecycle(stream) {
    activeDisplayStream = stream;
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        const stillLive = stream
          .getTracks()
          .some((t) => t.readyState === "live");
        if (!stillLive) {
          activeDisplayStream = null;
          clearLocalMonitorAudio();
          notifyContentState({ reason: "ended" });
        }
      });
    }
    notifyContentState({ reason: "started" });
  }

  // Track RTCPeerConnections and senders so we can replaceTrack on live tab swaps
  const OrigRTCPeerConnection = window.RTCPeerConnection;
  if (OrigRTCPeerConnection) {
    const OrigAddTrack = OrigRTCPeerConnection.prototype.addTrack;
    OrigRTCPeerConnection.prototype.addTrack = function (track, ...streams) {
      peerConnections.add(this);
      const sender = OrigAddTrack.call(this, track, ...streams);
      if (
        activeDisplayStream &&
        activeDisplayStream.getTracks().includes(track)
      ) {
        trackedSenders.add(sender);
      }
      return sender;
    };
  }

  async function redeemTabStream(streamId, keepLocalAudio) {
    const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    const stream = await origGetUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });
    attachLocalAudioIfNeeded(stream, keepLocalAudio);
    return stream;
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(
      navigator.mediaDevices
    );

    navigator.mediaDevices.getDisplayMedia = async function (constraints) {
      if (
        pendingCapture &&
        pendingCapture.streamId &&
        Date.now() - pendingCapture.createdAt < 10000
      ) {
        const { streamId, keepLocalAudio } = pendingCapture;
        pendingCapture = null;
        try {
          const stream = await redeemTabStream(streamId, keepLocalAudio);
          trackStreamLifecycle(stream);
          return stream;
        } catch (err) {
          window.postMessage(
            {
              source: "NDI_MEET_MAIN",
              type: "MAIN_CAPTURE_ERROR",
              error: String(err && err.message ? err.message : err),
            },
            "*"
          );
          // Fall back to standard browser picker if tabCapture redemption fails
        }
      }

      try {
        const stream = await origGetDisplayMedia(constraints);
        trackStreamLifecycle(stream);
        return stream;
      } catch (err) {
        window.postMessage(
          {
            source: "NDI_MEET_MAIN",
            type: "GET_DISPLAY_MEDIA_ERROR",
            error: String(err && err.message ? err.message : err),
            name: err && err.name ? err.name : "Error",
          },
          "*"
        );
        throw err;
      }
    };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== "NDI_MEET_CONTENT") return;

    if (event.data.type === "SET_PENDING_CAPTURE") {
      pendingCapture = {
        streamId: event.data.streamId,
        keepLocalAudio: event.data.keepLocalAudio !== false,
        createdAt: Date.now(),
      };
      return;
    }

    if (event.data.type === "CLEAR_PENDING_CAPTURE") {
      pendingCapture = null;
      return;
    }

    if (event.data.type === "STOP_DISPLAY_STREAM") {
      if (activeDisplayStream) {
        for (const t of activeDisplayStream.getTracks()) {
          try {
            t.stop();
          } catch (_) {}
        }
        activeDisplayStream = null;
      }
      clearLocalMonitorAudio();
      notifyContentState({ reason: "stopped_by_remote" });
      return;
    }

    if (event.data.type === "SWAP_LIVE_STREAM") {
      const { streamId, keepLocalAudio } = event.data;
      if (!activeDisplayStream || trackedSenders.size === 0) {
        window.postMessage(
          {
            source: "NDI_MEET_MAIN",
            type: "SWAP_RESULT",
            ok: false,
            error: "no_active_senders",
          },
          "*"
        );
        return;
      }
      try {
        const newStream = await redeemTabStream(
          streamId,
          keepLocalAudio !== false
        );
        const newVideo = newStream.getVideoTracks()[0] || null;
        const newAudio = newStream.getAudioTracks()[0] || null;
        const oldStream = activeDisplayStream;

        let replacedAny = false;
        for (const sender of Array.from(trackedSenders)) {
          if (!sender || !sender.track) continue;
          if (sender.track.kind === "video" && newVideo) {
            await sender.replaceTrack(newVideo);
            replacedAny = true;
          } else if (sender.track.kind === "audio" && newAudio) {
            await sender.replaceTrack(newAudio);
            replacedAny = true;
          }
        }

        if (!replacedAny) {
          for (const t of newStream.getTracks()) t.stop();
          window.postMessage(
            {
              source: "NDI_MEET_MAIN",
              type: "SWAP_RESULT",
              ok: false,
              error: "no_matching_senders",
            },
            "*"
          );
          return;
        }

        for (const t of oldStream.getTracks()) {
          try {
            t.stop();
          } catch (_) {}
        }
        trackStreamLifecycle(newStream);
        window.postMessage(
          {
            source: "NDI_MEET_MAIN",
            type: "SWAP_RESULT",
            ok: true,
          },
          "*"
        );
      } catch (err) {
        window.postMessage(
          {
            source: "NDI_MEET_MAIN",
            type: "SWAP_RESULT",
            ok: false,
            error: String(err && err.message ? err.message : err),
          },
          "*"
        );
      }
    }
  });
})();
