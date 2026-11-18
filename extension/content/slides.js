(() => {
  if (window.__NDI_SLIDES_CONTENT_LOADED__) return;
  window.__NDI_SLIDES_CONTENT_LOADED__ = true;

  const isTopFrame = window === window.top;
  let lastReportedJson = "";

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function clickEl(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function getActiveDocs() {
    const docs = [document];
    const frames = document.querySelectorAll("iframe.punch-present-iframe, iframe");
    for (const f of frames) {
      try {
        if (f.contentDocument) docs.push(f.contentDocument);
      } catch (_) {}
    }
    return docs;
  }

  function findInDocs(selectors) {
    for (const doc of getActiveDocs()) {
      for (const sel of selectors) {
        const els = Array.from(doc.querySelectorAll(sel)).filter(isVisible);
        if (els.length > 0) return { el: els[0], doc };
      }
    }
    return null;
  }

  function findByAriaInDocs(substrs) {
    for (const doc of getActiveDocs()) {
      const els = Array.from(
        doc.querySelectorAll('[role="button"], button, .goog-flat-menu-button, .punch-viewer-nav-rounded')
      ).filter(isVisible);
      for (const sub of substrs) {
        for (const el of els) {
          const aria = (el.getAttribute("aria-label") || "").toLowerCase();
          const tip = (el.getAttribute("data-tooltip") || "").toLowerCase();
          if (aria.includes(sub) || tip.includes(sub)) {
            return { el, doc };
          }
        }
      }
    }
    return null;
  }

  function parseSlideNumbers() {
    // Try presenter navbar first ("3" / "Slide 3 of 12")
    for (const doc of getActiveDocs()) {
      const pageBtn = doc.querySelector(
        '.punch-viewer-navbar-page, [aria-label*="Slide "][role="button"], .punch-viewer-navbar [role="listbox"]'
      );
      if (pageBtn) {
        const text = (pageBtn.getAttribute("aria-label") || pageBtn.textContent || "").trim();
        const m = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
        if (m) {
          return { currentSlide: parseInt(m[1], 10), totalSlides: parseInt(m[2], 10) };
        }
        const single = text.match(/^(\d+)$/);
        if (single) {
          return { currentSlide: parseInt(single[1], 10), totalSlides: null };
        }
      }

      // Try filmstrip in edit mode
      const thumbs = Array.from(
        doc.querySelectorAll('.punch-filmstrip-thumbnail, [role="option"][aria-label*="Slide"]')
      );
      if (thumbs.length > 0) {
        let current = null;
        thumbs.forEach((t, idx) => {
          if (
            t.getAttribute("aria-selected") === "true" ||
            t.classList.contains("punch-filmstrip-selected") ||
            t.querySelector('[aria-selected="true"]')
          ) {
            current = idx + 1;
          }
        });
        return { currentSlide: current, totalSlides: thumbs.length };
      }
    }
    return { currentSlide: null, totalSlides: null };
  }

  function isPresentingNow() {
    if (location.pathname.includes("/present")) return true;
    const viewer = findInDocs([
      ".punch-present-iframe",
      ".punch-viewer-content",
      ".punch-viewer-container",
      ".punch-viewer-navbar",
    ]);
    return Boolean(viewer);
  }

  function readSlidesState() {
    const title = document.title.replace(/\s*-\s*Google Slides\s*$/i, "").trim();
    const nums = parseSlideNumbers();
    return {
      url: location.href,
      title: title || "Google Slides",
      isPresenting: isPresentingNow(),
      currentSlide: nums.currentSlide,
      totalSlides: nums.totalSlides,
    };
  }

  function reportState(force = false) {
    if (!isTopFrame) return;
    const state = readSlidesState();
    const raw = JSON.stringify(state);
    if (!force && raw === lastReportedJson) return;
    lastReportedJson = raw;
    try {
      chrome.runtime.sendMessage({ type: "SLIDES_STATE_UPDATE", state });
    } catch (_) {}
  }

  function dispatchSlideKey(key, code, keyCode) {
    for (const doc of getActiveDocs()) {
      const target =
        doc.querySelector(".punch-viewer-content, .punch-viewer-container, canvas") ||
        doc.activeElement ||
        doc.body;
      if (!target) continue;
      const evtInit = {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      };
      target.dispatchEvent(new KeyboardEvent("keydown", evtInit));
      target.dispatchEvent(new KeyboardEvent("keyup", evtInit));
    }
  }

  function startPresentUrlMode() {
    const hash = location.hash || "";
    if (location.pathname.includes("/edit")) {
      const nextPath = location.pathname.replace(/\/edit.*$/, "/present");
      location.href = `${location.origin}${nextPath}${hash}`;
      return true;
    }
    return false;
  }

  function exitPresentUrlMode() {
    const hash = location.hash || "";
    if (location.pathname.includes("/present")) {
      const nextPath = location.pathname.replace(/\/present.*$/, "/edit");
      location.href = `${location.origin}${nextPath}${hash}`;
      return true;
    }
    return false;
  }

  function stepFilmstrip(delta) {
    const thumbs = Array.from(
      document.querySelectorAll('.punch-filmstrip-thumbnail, [role="option"][aria-label*="Slide"]')
    );
    if (thumbs.length === 0) return false;
    let curIdx = thumbs.findIndex(
      (t) =>
        t.getAttribute("aria-selected") === "true" ||
        t.classList.contains("punch-filmstrip-selected")
    );
    if (curIdx < 0) curIdx = 0;
    const nextIdx = Math.max(0, Math.min(thumbs.length - 1, curIdx + delta));
    return clickEl(thumbs[nextIdx]);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "slides" || !isTopFrame) return;

    (async () => {
      if (msg.action === "getState") {
        sendResponse({ ok: true, state: readSlidesState() });
        return;
      }

      if (msg.action === "present") {
        if (isPresentingNow()) {
          sendResponse({ ok: true, message: "Already presenting" });
          return;
        }
        // Prefer switching cleanly to /present in-tab so Meet/NDI keeps capturing smoothly without fullscreen escape traps
        if (msg.inTab !== false && location.pathname.includes("/edit")) {
          startPresentUrlMode();
          sendResponse({ ok: true, message: "Opening Slideshow view" });
          return;
        }
        const btn =
          findInDocs(["#punch-start-presentation-left"]) ||
          findByAriaInDocs(["slideshow", "start presentation"]);
        if (btn && clickEl(btn.el)) {
          setTimeout(() => reportState(true), 450);
          sendResponse({ ok: true });
          return;
        }
        if (startPresentUrlMode()) {
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, needDebuggerFallback: "Ctrl+F5" });
        return;
      }

      if (msg.action === "exit") {
        const exitBtn =
          findInDocs([".punch-viewer-icon-exit"]) ||
          findByAriaInDocs(["exit slideshow", "exit full screen", "exit presentation"]);
        if (exitBtn && clickEl(exitBtn.el)) {
          setTimeout(() => reportState(true), 350);
          sendResponse({ ok: true });
          return;
        }
        if (exitPresentUrlMode()) {
          sendResponse({ ok: true });
          return;
        }
        dispatchSlideKey("Escape", "Escape", 27);
        setTimeout(() => reportState(true), 300);
        sendResponse({ ok: true, needDebuggerFallback: "Escape" });
        return;
      }

      if (msg.action === "next") {
        if (isPresentingNow()) {
          const nextBtn =
            findByAriaInDocs(["next slide", "next"]) ||
            findInDocs([".punch-viewer-navbar-next"]);
          if (nextBtn && clickEl(nextBtn.el)) {
            setTimeout(() => reportState(true), 150);
            sendResponse({ ok: true });
            return;
          }
          // Clicking slide stage itself advances Google Slides in /present mode
          const stage = findInDocs([".punch-viewer-content", ".punch-viewer-svgpage-svgcontainer"]);
          if (stage && clickEl(stage.el)) {
            setTimeout(() => reportState(true), 150);
            sendResponse({ ok: true });
            return;
          }
          dispatchSlideKey("ArrowRight", "ArrowRight", 39);
          setTimeout(() => reportState(true), 150);
          sendResponse({ ok: true, needDebuggerFallback: "ArrowRight" });
          return;
        } else {
          const ok = stepFilmstrip(1);
          setTimeout(() => reportState(true), 150);
          sendResponse({ ok, needDebuggerFallback: ok ? null : "ArrowRight" });
          return;
        }
      }

      if (msg.action === "prev") {
        if (isPresentingNow()) {
          const prevBtn =
            findByAriaInDocs(["previous slide", "previous"]) ||
            findInDocs([".punch-viewer-navbar-prev"]);
          if (prevBtn && clickEl(prevBtn.el)) {
            setTimeout(() => reportState(true), 150);
            sendResponse({ ok: true });
            return;
          }
          dispatchSlideKey("ArrowLeft", "ArrowLeft", 37);
          setTimeout(() => reportState(true), 150);
          sendResponse({ ok: true, needDebuggerFallback: "ArrowLeft" });
          return;
        } else {
          const ok = stepFilmstrip(-1);
          setTimeout(() => reportState(true), 150);
          sendResponse({ ok, needDebuggerFallback: ok ? null : "ArrowLeft" });
          return;
        }
      }

      if (msg.action === "goto") {
        const slideNum = Math.max(1, parseInt(msg.slide || 1, 10));
        const thumbs = Array.from(
          document.querySelectorAll('.punch-filmstrip-thumbnail, [role="option"][aria-label*="Slide"]')
        );
        if (!isPresentingNow() && thumbs[slideNum - 1]) {
          clickEl(thumbs[slideNum - 1]);
          setTimeout(() => reportState(true), 150);
          sendResponse({ ok: true });
          return;
        }
        // In presenting mode, request background to send trusted number+Enter if possible
        sendResponse({ ok: false, needDebuggerGoto: slideNum });
        return;
      }

      sendResponse({ ok: false, error: `Unknown Slides action: ${msg.action}` });
    })();

    return true;
  });

  if (isTopFrame) {
    window.addEventListener("hashchange", () => reportState(true));
    const obs = new MutationObserver(() => reportState(false));
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => reportState(false), 1500);
    setTimeout(() => reportState(true), 600);
  }
})();
