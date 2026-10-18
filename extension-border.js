(() => {
  const show = globalThis.__TSG_ALERT__ === true;
  const id = "tab-sound-glow-host";
  const existing = document.getElementById(id);
  if (!show) {
    if (existing) {
      clearInterval(existing.__tsgTimer);
      existing.remove();
    }
    return;
  }
  if (existing || !document.documentElement) return;

  const host = document.createElement("div");
  host.id = id;
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    overflow: "hidden",
    background: "transparent",
  });

  const bar = (extra) => {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
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
  const banner = document.createElement("div");
  banner.textContent = "麦克风无输入";
  Object.assign(banner.style, {
    position: "absolute",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
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

  const started = performance.now();
  host.__tsgTimer = setInterval(() => {
    if (!host.isConnected) {
      clearInterval(host.__tsgTimer);
      return;
    }
    const t = (performance.now() - started) / 1000;
    host.style.transform = `translate(${Math.sin(t * 28) * 6}px, ${Math.cos(t * 23) * 4}px)`;
    const shift = (t * 80) % 200;
    top.style.backgroundPosition = `${shift}% 0`;
    bottom.style.backgroundPosition = `${-shift}% 0`;
    left.style.backgroundPosition = `0 ${shift}%`;
    right.style.backgroundPosition = `0 ${-shift}%`;
  }, 32);
})();
