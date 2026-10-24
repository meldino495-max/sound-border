(() => {
  const show = globalThis.__TSG_ALERT__ === true;
  const id = "tab-sound-glow-host";
  const stopId = "tab-sound-glow-stop";
  const existing = document.getElementById(id);
  const existingStop = document.getElementById(stopId);
  if (existing) {
    clearInterval(existing.__tsgTimer);
    existing.remove();
  }
  if (!show) {
    if (existingStop) {
      clearInterval(existingStop.__tsgPin);
      existingStop.remove();
    }
    return;
  }
  if (!document.documentElement) return;

  const edgeSize = () => {
    const size = Math.round(Number(globalThis.__TSG_EDGE_PX__));
    if (!Number.isFinite(size)) return 8;
    return Math.min(32, Math.max(2, size));
  };

  const readPalette = () => {
    const fallback = ["#9d0208", "#ff4d6d", "#ffe5e9", "#e5383b", "#9d0208", "#ff4d6d"];
    const raw = globalThis.__TSG_INPUT_PALETTE__;
    const stops = Array.isArray(raw?.stops)
      ? raw.stops.slice(0, 6).map((item) => {
          const text = String(item || "").trim().toLowerCase();
          return /^#[0-9a-f]{6}$/.test(text) ? text : "";
        })
      : [];
    if (stops.length !== 6 || stops.some((color) => !color)) return { rainbow: false, stops: fallback };
    return { rainbow: raw?.rainbow === true, stops };
  };

  const FX_CSS = `
    .tsg-bar { overflow: visible; position: fixed; }
    .tsg-bar .halo, .tsg-bar .sheen { position: absolute; pointer-events: none; }
    .tsg-bar.x .halo { left: 0; right: 0; top: 100%; height: 20px; }
    .tsg-bar.bottom .halo { top: auto; bottom: 100%; }
    .tsg-bar.y .halo { top: 0; bottom: 0; width: 20px; }
    .tsg-bar.left .halo { left: 100%; }
    .tsg-bar.right .halo { right: 100%; left: auto; }
    .tsg-bar .halo { animation: tsg-bloom 2.6s ease-in-out infinite; }
    .tsg-bar .sheen {
      z-index: 1;
      opacity: 0.9;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), #fff, rgba(255,255,255,0.08), transparent);
    }
    .tsg-bar.x .sheen { top: 0; height: 100%; width: 22%; animation: tsg-sheen-x 1.7s linear infinite; }
    .tsg-bar.y .sheen {
      left: 0; width: 100%; height: 22%;
      background: linear-gradient(180deg, transparent, rgba(255,255,255,0.08), #fff, rgba(255,255,255,0.08), transparent);
      animation: tsg-sheen-y 1.7s linear infinite;
    }
    .tsg-bar .sheen.alt { opacity: 0.5; animation-duration: 2.9s; animation-direction: reverse; }
    .tsg-bar.x .sheen.alt { width: 12%; }
    .tsg-bar.y .sheen.alt { height: 12%; }
    @keyframes tsg-sheen-x { from { transform: translateX(-130%); } to { transform: translateX(480%); } }
    @keyframes tsg-sheen-y { from { transform: translateY(-130%); } to { transform: translateY(480%); } }
    @keyframes tsg-bloom { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
  `;

  const glowShadow = (stops, rainbow, px) => {
    const near = Math.max(6, Math.round(px * 1.5));
    const far = Math.max(16, Math.round(px * 3));
    const core = "inset 0 0 8px rgba(255,255,255,0.72)";
    if (rainbow) return `${core}, 0 0 ${near}px ${stops[0]}, 0 0 ${far}px ${stops[2]}, 0 0 ${far + 10}px ${stops[4]}`;
    return `${core}, 0 0 ${near}px ${stops[0]}, 0 0 ${far}px ${stops[2] || stops[0]}`;
  };

  const barsOf = (root) => {
    const tagged = [...root.children].filter((el) => el.classList?.contains("tsg-bar"));
    if (tagged.length) return tagged;
    const plain = [...root.children].filter((el) => el.tagName === "DIV" && el.dataset?.tsgBanner !== "1").slice(0, 4);
    const names = [
      ["x", "top"],
      ["y", "right"],
      ["x", "bottom"],
      ["y", "left"],
    ];
    plain.forEach((bar, index) => bar.classList.add("tsg-bar", ...(names[index] || [])));
    return plain;
  };

  const ensureFx = (root) => {
    if (!root.querySelector("style.tsg-fx")) {
      const style = document.createElement("style");
      style.className = "tsg-fx";
      style.textContent = FX_CSS;
      root.append(style);
    }
    barsOf(root).forEach((bar) => {
      if (bar.querySelector(".sheen")) return;
      const halo = document.createElement("i");
      halo.className = "halo";
      const sheen = document.createElement("i");
      sheen.className = "sheen";
      const alt = document.createElement("i");
      alt.className = "sheen alt";
      bar.append(halo, sheen, alt);
    });
  };

  const applyLook = (root) => {
    const size = edgeSize();
    const palette = readPalette();
    const across = `linear-gradient(90deg, ${palette.stops.join(",")})`;
    const down = `linear-gradient(180deg, ${palette.stops.join(",")})`;
    const glow = glowShadow(palette.stops, palette.rainbow, size);
    const bloom = Math.min(40, Math.max(12, Math.round(size * 2.6)));
    const light = palette.stops[2] || palette.stops[0];
    const fade = `${light}bb`;
    ensureFx(root);
    barsOf(root).forEach((bar) => {
      bar.style.position = "fixed";
      const vertical = bar.classList.contains("y");
      bar.style.backgroundColor = palette.stops[0];
      bar.style.backgroundImage = vertical ? down : across;
      bar.style.backgroundSize = vertical ? "100% 200%" : "200% 100%";
      bar.style.boxShadow = glow;
      if (vertical) bar.style.width = `${size}px`;
      else bar.style.height = `${size}px`;
      const halo = bar.querySelector(".halo");
      if (!halo) return;
      if (vertical) {
        halo.style.width = `${bloom}px`;
        halo.style.height = "100%";
      } else {
        halo.style.height = `${bloom}px`;
        halo.style.width = "100%";
      }
      if (bar.classList.contains("top")) halo.style.backgroundImage = `linear-gradient(to bottom, ${light}, ${fade}, transparent)`;
      else if (bar.classList.contains("bottom")) halo.style.backgroundImage = `linear-gradient(to top, ${light}, ${fade}, transparent)`;
      else if (bar.classList.contains("left")) halo.style.backgroundImage = `linear-gradient(to right, ${light}, ${fade}, transparent)`;
      else halo.style.backgroundImage = `linear-gradient(to left, ${light}, ${fade}, transparent)`;
    });
    const banner = [...root.children].find((el) => el.dataset?.tsgBanner === "1")
      || [...root.children].find((el) => el.tagName === "DIV" && !el.classList.contains("tsg-bar"));
    if (banner) {
      banner.style.top = `${size + 8}px`;
      banner.style.background = palette.stops[0];
      if (palette.rainbow) {
        banner.style.backgroundImage = across;
        banner.style.backgroundSize = "200% 100%";
      } else {
        banner.style.backgroundImage = "none";
      }
    }
    const stop = document.getElementById(stopId);
    if (stop) stop.style.setProperty("top", `${size + 64}px`, "important");
  };

  const makeStop = () => {
    const stop = document.createElement("button");
    stop.id = stopId;
    stop.type = "button";
    stop.textContent = "停止这次识别";
    for (const [key, value] of Object.entries({
      position: "fixed",
      top: `${edgeSize() + 64}px`,
      left: "50%",
      transform: "translateX(-50%)",
      "z-index": "2147483647",
      margin: "0",
      padding: "18px 40px",
      border: "0",
      "border-radius": "16px",
      background: "#fff",
      color: "#9f1239",
      font: "700 22px/1.2 Segoe UI, system-ui, sans-serif",
      "box-shadow": "0 10px 28px rgba(127, 29, 29, 0.35)",
      cursor: "pointer",
      "pointer-events": "auto",
      "white-space": "nowrap",
      animation: "none",
      transition: "none",
    })) {
      stop.style.setProperty(key, value, "important");
    }
    stop.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      stop.disabled = true;
      const extensionId = globalThis.__TSG_EXT_ID__;
      if (!extensionId || !chrome?.runtime?.sendMessage) return;
      chrome.runtime.sendMessage(extensionId, { type: "pause-input" }, () => {
        void chrome.runtime.lastError;
      });
    });
    return stop;
  };

  const host = document.createElement("div");
  host.id = id;
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    right: "auto",
    bottom: "auto",
    zIndex: "2147483647",
    pointerEvents: "none",
    overflow: "visible",
    background: "transparent",
    transform: "none",
    filter: "none",
  });

  const bar = (extra) => {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed",
      pointerEvents: "none",
      backgroundColor: "#d00000",
      backgroundImage: "linear-gradient(90deg, #9d0208, #ff4d6d, #ffe5e9, #e5383b, #9d0208)",
      backgroundSize: "200% 100%",
    }, extra);
    return el;
  };
  const top = bar({ top: "0", left: "0", right: "0", height: "8px" });
  const bottom = bar({ bottom: "0", left: "0", right: "0", height: "8px" });
  const left = bar({
    top: "0",
    bottom: "0",
    left: "0",
    width: "8px",
    backgroundImage: "linear-gradient(180deg, #9d0208, #ff4d6d, #ffe5e9, #e5383b, #9d0208)",
    backgroundSize: "100% 200%",
  });
  const right = bar({
    top: "0",
    bottom: "0",
    right: "0",
    width: "8px",
    backgroundImage: "linear-gradient(180deg, #9d0208, #ff4d6d, #ffe5e9, #e5383b, #9d0208)",
    backgroundSize: "100% 200%",
  });
  top.classList.add("tsg-bar", "x", "top");
  right.classList.add("tsg-bar", "y", "right");
  bottom.classList.add("tsg-bar", "x", "bottom");
  left.classList.add("tsg-bar", "y", "left");
  const banner = document.createElement("div");
  banner.dataset.tsgBanner = "1";
  banner.textContent = "麦克风无输入";
  Object.assign(banner.style, {
    position: "fixed",
    top: "12px",
    left: "50%",
    translate: "-50% 0",
    padding: "6px 12px",
    borderRadius: "999px",
    background: "rgba(127, 29, 29, 0.94)",
    color: "#fff",
    font: "600 13px/1.2 Segoe UI, system-ui, sans-serif",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  });
  host.append(top, right, bottom, left, banner);
  document.documentElement.appendChild(host);
  applyLook(host);

  const stop = makeStop();
  document.documentElement.appendChild(stop);

  const started = performance.now();
  host.__tsgTimer = setInterval(() => {
    if (!host.isConnected) {
      clearInterval(host.__tsgTimer);
      return;
    }
    if (stop.isConnected && document.documentElement.lastElementChild !== stop) {
      document.documentElement.appendChild(stop);
    }
    const t = (performance.now() - started) / 1000;
    host.style.transform = "none";
    const x = Math.sin(t * 28) * 6;
    const y = Math.cos(t * 23) * 4;
    const nudge = `${x}px ${y}px`;
    top.style.translate = nudge;
    right.style.translate = nudge;
    bottom.style.translate = nudge;
    left.style.translate = nudge;
    banner.style.translate = `calc(-50% + ${x}px) ${y}px`;
    const shift = (t * 80) % 200;
    top.style.backgroundPosition = `${shift}% 0`;
    bottom.style.backgroundPosition = `${-shift}% 0`;
    left.style.backgroundPosition = `0 ${shift}%`;
    right.style.backgroundPosition = `0 ${-shift}%`;
    if (banner.style.backgroundSize === "200% 100%") banner.style.backgroundPosition = `${shift}% 0`;
  }, 32);
})();
