if (globalThis.__TAB_SOUND_GLOW__) {
  /* 扩展重载时可能再次注入，保留已经在跑的那一份。 */
} else if (document.documentElement && document.documentElement.tagName === "HTML") {
  globalThis.__TAB_SOUND_GLOW__ = true;
  startGlow();
}

const FRAME_HTML = `
  <style>
    .frame {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: transparent;
    }
    .frame[hidden] { display: none !important; }
    .edge, .banner { position: absolute; pointer-events: none; }
    .top { top: 0; left: 0; right: 0; }
    .bottom { bottom: 0; left: 0; right: 0; }
    .left { left: 0; top: 0; bottom: 0; }
    .right { right: 0; top: 0; bottom: 0; }
    .flow.x { height: 8px; }
    .flow.y { width: 8px; }
    .edge.x, .edge.y { background-color: #0096c7; }
    .edge.x {
      background-image: linear-gradient(90deg, #0077b6, #48cae4, #e0fbff, #00b4d8, #0077b6);
      background-size: 200% 100%;
      animation: tsg-flow-x 2.6s linear infinite;
    }
    .edge.y {
      background-image: linear-gradient(180deg, #0077b6, #48cae4, #e0fbff, #00b4d8, #0077b6);
      background-size: 100% 200%;
      animation: tsg-flow-y 2.6s linear infinite;
    }
    .edge.right { animation-delay: -0.65s; }
    .edge.bottom { animation-delay: -1.3s; animation-direction: reverse; }
    .edge.left { animation-delay: -1.95s; animation-direction: reverse; }
    .banner {
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(127, 29, 29, 0.94);
      color: #fff;
      font: 600 13px/1.2 "Segoe UI", system-ui, sans-serif;
      white-space: nowrap;
      display: none;
    }
    .frame.alert .edge { background-color: #d00000; animation-duration: 1.6s; }
    .frame.alert .edge.x {
      background-image: linear-gradient(90deg, #9d0208, #ff4d6d, #ffe5e9, #e5383b, #9d0208);
    }
    .frame.alert .edge.y {
      background-image: linear-gradient(180deg, #9d0208, #ff4d6d, #ffe5e9, #e5383b, #9d0208);
    }
    .frame.alert .banner { display: block; }
    .frame.is-paused, .frame.is-paused * { animation-play-state: paused; }
    @keyframes tsg-flow-x {
      from { background-position: 0 0; }
      to { background-position: 200% 0; }
    }
    @keyframes tsg-flow-y {
      from { background-position: 0 0; }
      to { background-position: 0 200%; }
    }
    @media print { .frame { display: none !important; } }
  </style>
  <div class="frame">
    <div class="edge flow x top"></div>
    <div class="edge flow y right"></div>
    <div class="edge flow x bottom"></div>
    <div class="edge flow y left"></div>
    <div class="banner">麦克风无输入</div>
  </div>
`;

function startGlow() {
  let host = null;
  let frame = null;
  let liftObserver = null;
  let shakeTimer = null;
  let dead = false;

  function startShake() {
    if (shakeTimer || !host || !frame?.classList.contains("alert")) return;
    const started = performance.now();
    const tick = () => {
      if (!host || !frame?.classList.contains("alert")) {
        stopShake();
        return;
      }
      const t = (performance.now() - started) / 1000;
      const x = Math.sin(t * 28) * 6;
      const y = Math.cos(t * 23) * 4;
      host.style.setProperty("transform", `translate(${x}px, ${y}px)`, "important");
    };
    tick();
    shakeTimer = setInterval(tick, 32);
  }

  function stopShake() {
    if (shakeTimer) clearInterval(shakeTimer);
    shakeTimer = null;
    host?.style.removeProperty("transform");
  }

  function ensureFrame() {
    if (host || dead) return;
    host = document.createElement("div");
    host.id = "tab-sound-glow-host";
    host.setAttribute("aria-hidden", "true");
    for (const [key, value] of Object.entries({
      position: "fixed",
      inset: "0",
      "z-index": "2147483647",
      "pointer-events": "none",
      overflow: "hidden",
      background: "transparent",
      border: "0",
      margin: "0",
      padding: "0",
      display: "block",
    })) {
      host.style.setProperty(key, value, "important");
    }
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = FRAME_HTML;
    frame = shadow.querySelector(".frame");
    frame.classList.toggle("is-paused", document.hidden);
    document.documentElement.appendChild(host);
    liftObserver = new MutationObserver(() => {
      const root = document.documentElement;
      if (host && root && root.lastElementChild !== host) root.appendChild(host);
    });
    liftObserver.observe(document.documentElement, { childList: true });
  }

  function destroyFrame() {
    stopShake();
    liftObserver?.disconnect();
    liftObserver = null;
    host?.remove();
    host = null;
    frame = null;
  }

  function setMode(mode) {
    if (mode === "off") {
      destroyFrame();
      return;
    }
    ensureFrame();
    if (!frame.classList.contains(mode)) {
      frame.classList.remove("wave", "alert");
      frame.classList.add(mode);
    }
    frame.classList.toggle("is-paused", mode === "wave" && document.hidden);
    if (mode === "alert") startShake();
    else stopShake();
  }

  function applyState(state) {
    if (!state || dead) return;
    if (state.inputAlert) setMode("alert");
    else if (state.output) setMode("wave");
    else setMode("off");
  }

  function resumeShake() {
    if (!frame?.classList.contains("alert")) return;
    frame.classList.remove("is-paused");
    stopShake();
    startShake();
  }

  document.addEventListener("visibilitychange", () => {
    if (frame?.classList.contains("alert")) {
      if (!document.hidden) resumeShake();
      return;
    }
    frame?.classList.toggle("is-paused", document.hidden);
  });
  window.addEventListener("pageshow", () => resumeShake());
  window.addEventListener("focus", () => resumeShake());
  setInterval(() => {
    if (!document.hidden && frame?.classList.contains("alert") && !shakeTimer) startShake();
  }, 1000);

  chrome.runtime.onMessage.addListener((message) => {
    if (!chrome.runtime?.id) {
      dead = true;
      destroyFrame();
      return;
    }
    if (message?.type === "state") applyState(message);
  });

  function pullState(attempt) {
    if (dead || !chrome.runtime?.id) return;
    chrome.runtime
      .sendMessage({ type: "query-state" })
      .then(applyState)
      .catch(() => {
        if (attempt < 5) setTimeout(() => pullState(attempt + 1), 400);
      });
  }

  pullState(0);
}
