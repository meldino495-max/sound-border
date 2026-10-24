if (typeof globalThis.__TAB_SOUND_GLOW_STOP__ === "function") {
  globalThis.__TAB_SOUND_GLOW_STOP__();
}
document.querySelectorAll("#tab-sound-glow-host, #tab-sound-glow-stop").forEach((node) => node.remove());
if (document.documentElement && document.documentElement.tagName === "HTML") {
  globalThis.__TAB_SOUND_GLOW__ = true;
  startGlow();
}

const FRAME_HTML = `
  <style>
    .frame {
      position: absolute;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      overflow: visible;
      pointer-events: none;
      background: transparent;
      transform: none;
    }
    .frame[hidden] { display: none !important; }
    .edge, .banner { position: fixed; pointer-events: none; }
    .edge {
      overflow: hidden;
      box-shadow: none;
      translate: var(--tsg-sx, 0px) var(--tsg-sy, 0px);
    }
    .top { top: 0; left: 0; right: 0; height: 8px; }
    .bottom { bottom: 0; left: 0; right: 0; height: 8px; }
    .left { left: 0; top: 0; bottom: 0; width: 8px; }
    .right { right: 0; top: 0; bottom: 0; width: 8px; }
    .edge.x, .edge.y { background-color: #0096c7; }
    .edge.x {
      background-image: linear-gradient(90deg, #0077b6, #48cae4, #e0fbff, #00b4d8, #0077b6, #48cae4, #0077b6);
      background-size: 200% 100%;
      animation: tsg-flow-x calc(2.6s / var(--tsg-flow, 1)) linear infinite;
    }
    .edge.y {
      background-image: linear-gradient(180deg, #0077b6, #48cae4, #e0fbff, #00b4d8, #0077b6, #48cae4, #0077b6);
      background-size: 100% 200%;
      animation: tsg-flow-y calc(2.6s / var(--tsg-flow, 1)) linear infinite;
    }
    .frame.wave.is-shaking .edge.x {
      animation:
        tsg-flow-x calc(2.6s / var(--tsg-flow, 1)) linear infinite,
        tsg-shake 0.16s linear infinite;
    }
    .frame.wave.is-shaking .edge.y {
      animation:
        tsg-flow-y calc(2.6s / var(--tsg-flow, 1)) linear infinite,
        tsg-shake 0.16s linear infinite;
    }
    .banner {
      top: 16px;
      left: 50%;
      translate: calc(-50% + var(--tsg-sx, 0px)) var(--tsg-sy, 0px);
      padding: 6px 12px;
      border-radius: 999px;
      background: #9d0208;
      color: #fff;
      font: 600 13px/1.2 "Segoe UI", system-ui, sans-serif;
      white-space: nowrap;
      display: none;
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
    @keyframes tsg-shake {
      0% { translate: 0 0; }
      25% { translate: var(--tsg-amp-x, 12px) calc(var(--tsg-amp-y, 9px) * -1); }
      50% { translate: calc(var(--tsg-amp-x, 12px) * -1) var(--tsg-amp-y, 9px); }
      75% { translate: calc(var(--tsg-amp-x, 12px) * 0.7) calc(var(--tsg-amp-y, 9px) * -0.7); }
      100% { translate: 0 0; }
    }
    @media print { .frame { display: none !important; } }
  </style>
  <div class="frame">
    <div class="edge x top"></div>
    <div class="edge y right"></div>
    <div class="edge x bottom"></div>
    <div class="edge y left"></div>
    <div class="banner">麦克风无输入</div>
  </div>
`;

function startGlow() {
  let host = null;
  let frame = null;
  let stopButton = null;
  let liftObserver = null;
  let lifting = false;
  let shakeTimer = null;
  let dead = false;
  let outputShake = false;
  let outputShakeX = 12;
  let outputShakeY = 9;

  function removeStop() {
    stopButton?.remove();
    stopButton = null;
  }

  function ensureStop() {
    if (dead) return;
    if (!stopButton) {
      stopButton = document.createElement("button");
      stopButton.id = "tab-sound-glow-stop";
      stopButton.type = "button";
      stopButton.textContent = "停止这次识别";
      stopButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!stopButton) return;
        stopButton.disabled = true;
        chrome.runtime.sendMessage({ type: "pause-input" }).catch(() => {
          if (stopButton) stopButton.disabled = false;
        });
      });
    }
    for (const [key, value] of Object.entries({
      position: "fixed",
      top: "72px",
      left: "50%",
      transform: "translateX(-50%)",
      "z-index": "2147483647",
      margin: "0",
      padding: "18px 40px",
      border: "0",
      "border-radius": "16px",
      background: "#fff",
      color: "#9f1239",
      "font": "700 22px/1.2 Segoe UI, system-ui, sans-serif",
      "box-shadow": "0 10px 28px rgba(127, 29, 29, 0.35)",
      cursor: "pointer",
      "pointer-events": "auto",
      "white-space": "nowrap",
      animation: "none",
      transition: "none",
    })) {
      stopButton.style.setProperty(key, value, "important");
    }
    document.documentElement.appendChild(stopButton);
  }

  const OUTPUT_FALLBACK = ["#0077b6", "#48cae4", "#e0fbff", "#00b4d8", "#0077b6", "#48cae4"];
  const INPUT_FALLBACK = ["#9d0208", "#ff4d6d", "#ffe5e9", "#e5383b", "#9d0208", "#ff4d6d"];

  globalThis.__TAB_SOUND_GLOW_STOP__ = () => {
    dead = true;
    destroyFrame();
  };

  function clampShake(value, fallback) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return fallback;
    return Math.min(12, Math.max(0, amount));
  }

  function wantsShake() {
    if (!host || !frame) return false;
    return frame.classList.contains("alert");
  }

  function shakeReach() {
    if (frame?.classList.contains("alert")) return { x: 6, y: 4 };
    return { x: outputShakeX, y: outputShakeY };
  }

  function syncShake() {
    if (wantsShake()) startShake();
    else stopShake();
  }

  function startShake() {
    if (shakeTimer || !wantsShake()) return;
    const started = performance.now();
    const tick = () => {
      if (!wantsShake()) {
        stopShake();
        return;
      }
      const reach = shakeReach();
      const t = (performance.now() - started) / 1000;
      const x = Math.sin(t * 28) * reach.x;
      const y = Math.cos(t * 23) * reach.y;
      host.style.setProperty("transform", "none", "important");
      frame.style.setProperty("--tsg-sx", `${x}px`);
      frame.style.setProperty("--tsg-sy", `${y}px`);
    };
    tick();
    shakeTimer = setInterval(tick, 32);
  }

  function stopShake() {
    if (shakeTimer) clearInterval(shakeTimer);
    shakeTimer = null;
    frame?.style.removeProperty("--tsg-sx");
    frame?.style.removeProperty("--tsg-sy");
    host?.style.setProperty("transform", "none", "important");
    host?.style.setProperty("filter", "none", "important");
    host?.style.setProperty("backdrop-filter", "none", "important");
  }

  function ensureFrame() {
    if (host || dead) return;
    host = document.createElement("div");
    host.id = "tab-sound-glow-host";
    host.setAttribute("aria-hidden", "true");
    for (const [key, value] of Object.entries({
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      right: "auto",
      bottom: "auto",
      "z-index": "2147483647",
      "pointer-events": "none",
      overflow: "visible",
      background: "transparent",
      transform: "none",
      filter: "none",
      "backdrop-filter": "none",
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
    frame.classList.remove("is-paused");
    document.documentElement.appendChild(host);
    liftObserver = new MutationObserver(() => {
      if (lifting || !host) return;
      const root = document.documentElement;
      if (!root) return;
      const top = stopButton?.isConnected ? stopButton : host;
      if (root.lastElementChild === top) return;
      lifting = true;
      try {
        root.appendChild(host);
        if (stopButton?.isConnected) root.appendChild(stopButton);
      } finally {
        lifting = false;
      }
    });
    liftObserver.observe(document.documentElement, { childList: true });
  }

  function destroyFrame() {
    stopShake();
    removeStop();
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
    if (mode === "wave") frame.classList.remove("is-paused");
    frame.classList.toggle("is-shaking", mode === "wave" && outputShake);
    frame.style.setProperty("--tsg-amp-x", `${outputShakeX}px`);
    frame.style.setProperty("--tsg-amp-y", `${outputShakeY}px`);
    if (mode === "alert") ensureStop();
    else removeStop();
    syncShake();
  }

  function applyFrameColors(colors, edgePx, flowSpeed) {
    if (!frame) return;
    const size = Math.round(Number(edgePx));
    const px = Number.isFinite(size) ? Math.min(32, Math.max(2, size)) : 8;
    const speed = Math.round(Number(flowSpeed));
    frame.style.setProperty("--tsg-flow", String(Number.isFinite(speed) ? Math.min(8, Math.max(1, speed)) : 1));
    const alert = frame.classList.contains("alert");
    const stops = safeStops(alert ? colors?.input : colors?.output) || (alert ? INPUT_FALLBACK : OUTPUT_FALLBACK);
    const rainbow = alert ? colors?.input?.rainbow === true : colors?.output?.rainbow === true;
    const flow = stops[stops.length - 1] === stops[0] ? stops : [...stops, stops[0]];
    const across = `linear-gradient(90deg, ${flow.join(", ")})`;
    const down = `linear-gradient(180deg, ${flow.join(", ")})`;
    frame.querySelectorAll(".edge").forEach((edge) => {
      const vertical = edge.classList.contains("y");
      if (vertical) edge.style.width = `${px}px`;
      else edge.style.height = `${px}px`;
      edge.style.backgroundColor = stops[0];
      edge.style.backgroundImage = vertical ? down : across;
      edge.style.backgroundSize = vertical ? "100% 200%" : "200% 100%";
      edge.style.boxShadow = "none";
    });
    const banner = frame.querySelector(".banner");
    if (banner) {
      banner.style.top = `${px + 8}px`;
      banner.style.backgroundColor = stops[0];
      banner.style.backgroundImage = alert && rainbow ? across : "none";
      if (alert && rainbow) banner.style.backgroundSize = "200% 100%";
    }
    if (stopButton) stopButton.style.setProperty("top", `${px + 56}px`, "important");
  }

  function safeStops(palette) {
    if (!palette || !Array.isArray(palette.stops)) return null;
    const stops = palette.stops.slice(0, 6).map((item) => {
      const text = String(item || "").trim().toLowerCase();
      return /^#[0-9a-f]{6}$/.test(text) ? text : "";
    });
    if (stops.length !== 6 || stops.some((color) => !color)) return null;
    return stops;
  }

  function rememberOutputShake(enabled, level) {
    outputShake = enabled === true;
    const step = Math.round(Number(level));
    const safe = Number.isFinite(step) ? Math.min(5, Math.max(1, step)) : 3;
    outputShakeX = clampShake(safe * 4, 12);
    outputShakeY = clampShake(safe * 3, 9);
    if (frame?.classList.contains("wave")) setMode("wave");
  }

  function applyState(state) {
    if (!state || dead) return;
    if (state.inputAlert) setMode("alert");
    else if (state.output) setMode("wave");
    else setMode("off");
    if (frame) applyFrameColors(state.colors, state.edgePx, state.flowSpeed);
  }

  function resumeShake() {
    if (frame?.classList.contains("alert")) frame.classList.remove("is-paused");
    stopShake();
    syncShake();
  }

  document.addEventListener("visibilitychange", () => {
    if (frame?.classList.contains("wave")) frame.classList.remove("is-paused");
    if (frame?.classList.contains("alert") && !document.hidden) frame.classList.remove("is-paused");
    syncShake();
  });
  window.addEventListener("pageshow", () => resumeShake());
  window.addEventListener("focus", () => resumeShake());
  setInterval(() => {
    if (wantsShake() && !shakeTimer) startShake();
  }, 1000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || dead) return;
    if (!("outputShake" in changes) && !("outputShakeLevel" in changes)) return;
    chrome.storage.local.get({ outputShake: false, outputShakeLevel: 3 }, (stored) => {
      if (dead) return;
      rememberOutputShake(stored.outputShake, stored.outputShakeLevel);
    });
  });
  chrome.storage.local.get({ outputShake: false, outputShakeLevel: 3 }, (stored) => {
    if (dead) return;
    rememberOutputShake(stored.outputShake, stored.outputShakeLevel);
  });

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
