import { DEFAULT_BORDER_COLORS, DEFAULTS, normalizeBorderColors, normalizeEdgePx, normalizeFlowSpeed, normalizeOutputShakeLevel, outputShakePixels, siteHost } from "./silence-monitor.js";

const outputToggle = document.querySelector("#output-toggle");
const noiseToggle = document.querySelector("#noise-toggle");
const outputScope = document.querySelector("#output-scope");
const inputToggle = document.querySelector("#input-toggle");
const sensitivity = document.querySelector("#sensitivity");
const silence = document.querySelector("#silence");
const inputOptions = document.querySelector("#input-options");
const meterFill = document.querySelector("#meter-fill");
const meterMark = document.querySelector("#meter-mark");
const meter = document.querySelector(".meter");
const micStatus = document.querySelector("#mic-status");
const micError = document.querySelector("#mic-error");
const notifyNote = document.querySelector("#notify-note");
const audibleList = document.querySelector("#audible-list");
const audibleEmpty = document.querySelector("#audible-empty");
const footprint = document.querySelector("#footprint");
const siteName = document.querySelector("#site-name");
const stopInput = document.querySelector("#stop-input");
const LOOK_PRESETS = [
  { id: "minimal", name: "简约", output: "#38bdf8", input: "#fb7185" },
  { id: "neon", name: "夜霓", output: "#22d3ee", input: "#e879f9" },
  { id: "forest", name: "森林", output: "#34d399", input: "#f59e0b" },
  { id: "dusk", name: "暮色", output: "#fb923c", input: "#c084fc" },
];
const edgeSize = document.querySelector("#edge-size");
const edgeSizeLabel = document.querySelector("#edge-size-label");
const flowSpeed = document.querySelector("#flow-speed");
const flowSpeedLabel = document.querySelector("#flow-speed-label");
const outputShake = document.querySelector("#output-shake");
const shakeLevel = document.querySelector("#shake-level");
const shakeLevelLabel = document.querySelector("#shake-level-label");
const shakeLevelField = document.querySelector("#shake-level-field");
const SHAKE_WORDS = ["", "很轻", "轻", "中等", "重", "很重"];
const liveOutput = document.querySelector("#live-output");
const liveInput = document.querySelector("#live-input");
const rainbowOutput = document.querySelector("#rainbow-output");
const rainbowInput = document.querySelector("#rainbow-input");
const colorOutput = document.querySelector("#color-output");
const colorInput = document.querySelector("#color-input");
const resetLook = document.querySelector("#reset-look");

let lookTimer = null;
let lookDirty = false;

let currentHost = "";
let currentUrl = "";

const EXTENSION_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "silence-monitor.js",
  "offscreen.html",
  "offscreen.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "extension-border.js",
  "mic-permission.html",
  "mic-permission.css",
  "mic-permission.js",
  "README.md",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "scripts/make-icons.ps1",
  "tests/silence-monitor.test.mjs",
];

const METER_FULL = 0.12;
let pollTimer = null;

init().catch((error) => showError(error.message || String(error)));

outputToggle.addEventListener("change", () => {
  if (!currentHost) return;
  saveSite({ output: outputToggle.checked });
});

noiseToggle.addEventListener("change", () => {
  chrome.storage.local.set({ noiseAlert: noiseToggle.checked });
});

outputScope.addEventListener("change", () => {
  chrome.storage.local.set({ outputScope: outputScope.value === "tab" ? "tab" : "sync" });
});

inputToggle.addEventListener("change", async () => {
  clearError();
  if (!currentHost) {
    inputToggle.checked = false;
    return;
  }
  if (!inputToggle.checked) {
    await chrome.storage.session.remove("micErrorName");
    await saveSite({ input: false });
    syncInputOptions();
    refreshMic();
    return;
  }
  if ((await micPermissionState()) === "granted") {
    await chrome.storage.session.remove("micErrorName");
    await saveSite({ input: true });
    syncInputOptions();
    refreshMic();
    return;
  }
  inputToggle.checked = false;
  syncInputOptions();
  setStatus("请在弹出的窗口里允许麦克风", "");
  await chrome.storage.session.set({ pendingInputHost: currentHost });
  try {
    await chrome.runtime.sendMessage({ type: "open-mic-permission", auto: true });
  } catch (error) {
    showError(error.message || "打不开麦克风授权窗口。");
  }
});

sensitivity.addEventListener("change", () => {
  chrome.storage.local.set({ sensitivity: sensitivity.value });
});

silence.addEventListener("change", () => {
  chrome.storage.local.set({ silenceMs: Number(silence.value) });
});

stopInput.addEventListener("click", async () => {
  stopInput.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "pause-input" });
    if (response && response.ok === false) showError(response.error || "停不了这次输入识别。");
  } catch (error) {
    showError(error.message || "停不了这次输入识别。");
  }
  await refreshMic();
});

chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if ("audible" in info || info.status === "complete") refreshTabs();
  if (tab.active && (info.url || info.status === "complete")) refreshSite();
});
chrome.tabs.onRemoved.addListener(() => refreshTabs());
chrome.tabs.onActivated.addListener(() => {
  refreshSite();
  refreshTabs();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.siteFlags) refreshSite();
  if (area !== "local" || lookDirty) return;
  if (!changes.borderColors && !changes.edgePx && !changes.flowSpeed && !changes.outputShake && !changes.outputShakeLevel) return;
  chrome.storage.local.get({
    borderColors: DEFAULT_BORDER_COLORS,
    edgePx: DEFAULTS.edgePx,
    flowSpeed: DEFAULTS.flowSpeed,
    outputShake: DEFAULTS.outputShake,
    outputShakeLevel: DEFAULTS.outputShakeLevel,
  }).then(applyStoredLook);
});

async function init() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  sensitivity.value = ["high", "medium", "low"].includes(stored.sensitivity) ? stored.sensitivity : "medium";
  silence.value = String([2000, 3000, 5000, 8000].includes(Number(stored.silenceMs)) ? stored.silenceMs : 3000);
  noiseToggle.checked = stored.noiseAlert === true;
  outputScope.value = stored.outputScope === "tab" ? "tab" : "sync";
  await refreshSite();
  await refreshTabs();
  await refreshNotifyNote();
  showFootprint().catch(() => {
    footprint.textContent = "暂时算不出占用空间。";
  });
  const session = await chrome.storage.session.get({ micErrorName: "" });
  if (!inputToggle.checked && session.micErrorName) showError(micErrorText({ name: session.micErrorName }));
  await refreshMic();
  applyStoredLook(stored);
  pollTimer = setInterval(() => {
    refreshMic();
  }, 800);
  window.addEventListener("unload", () => clearInterval(pollTimer));
}

function syncInputOptions() {
  const on = inputToggle.checked;
  inputOptions.classList.toggle("is-off", !on);
  sensitivity.disabled = false;
  silence.disabled = false;
  outputToggle.disabled = !currentHost;
  inputToggle.disabled = !currentHost;
}

async function refreshSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  currentUrl = url;
  currentHost = siteHost(url);
  const stored = await chrome.storage.local.get({ siteFlags: {} });
  const flags = currentHost ? stored.siteFlags?.[currentHost] : null;
  outputToggle.checked = flags?.output === true;
  inputToggle.checked = flags?.input === true;
  if (url.startsWith("chrome-extension://")) {
    siteName.textContent = "当前是本地插件页面。这里不能打开输入识别，也不会出现输入红边。";
  } else if (!currentHost) {
    siteName.textContent = "当前页面不能按网站记住。请打开普通网页后再开关。";
  } else {
    const parts = [];
    if (flags?.output) parts.push("输出");
    if (flags?.input) parts.push("输入");
    siteName.textContent = parts.length
      ? `当前网站 ${currentHost}。已记住${parts.join("和")}，下次打开会自动开启。`
      : `当前网站 ${currentHost}。打开后会记住，下次自动开启。`;
  }
  syncInputOptions();
  refreshMic();
}

async function saveSite(patch) {
  if (!currentHost) return;
  const stored = await chrome.storage.local.get({ siteFlags: {} });
  const siteFlags = { ...(stored.siteFlags || {}) };
  const current = siteFlags[currentHost] || { output: false, input: false };
  const next = { output: current.output === true, input: current.input === true, ...patch };
  if (!next.output && !next.input) delete siteFlags[currentHost];
  else siteFlags[currentHost] = next;
  await chrome.storage.local.set({ siteFlags });
}

async function micPermissionState() {
  try {
    const result = await navigator.permissions.query({ name: "microphone" });
    return result.state;
  } catch {
    return "";
  }
}

async function refreshMic() {
  let status = null;
  try {
    status = await chrome.runtime.sendMessage({ type: "get-status" });
  } catch {
    status = null;
  }
  const active = !!(status && (status.listening || status.alerting));
  stopInput.disabled = !active;
  showBorderProblem(status);
  const pausedHere = !!(currentHost && status?.pausedHosts?.includes(currentHost));
  if (pausedHere) {
    setMeter(0, status?.threshold || 0.02, false);
    setStatus("红边已取消。下次打开这个网站会自动再开始输入识别。", "");
    return;
  }
  if (!inputToggle.checked) {
    setMeter(0, status?.threshold || 0.02, !!status?.alerting);
    setStatus(status?.alerting ? "没有输入声音，边框已变红" : "未开启", status?.alerting ? "is-alert" : "");
    return;
  }
  if (!status) {
    setStatus("正在连接…", "");
    return;
  }
  if (status.error) {
    inputToggle.checked = false;
    syncInputOptions();
    showError(micErrorText({ name: status.error }));
    setStatus("未开启", "");
    setMeter(0, status.threshold || 0.02, false);
    return;
  }
  const stale = !status.levelAt || Date.now() - status.levelAt > 2000;
  setMeter(status.rms || 0, status.threshold || 0.02, status.alerting);
  if (!status.listening || stale) setStatus("正在打开麦克风…", "");
  else if (status.alerting) setStatus("没有输入声音，边框已变红", "is-alert");
  else setStatus("检测到输入声音", "is-ok");
}

function showBorderProblem(status) {
  const relevant = !!(
    status?.extensionBorderError &&
    (status.alerting || currentUrl.startsWith("chrome-extension://"))
  );
  if (!relevant) {
    if (micError.dataset.source === "border") clearError();
    return;
  }
  showError(borderErrorText(status.extensionBorderError));
  micError.dataset.source = "border";
}

function borderErrorText(message) {
  if (/different extension|Cannot access a chrome-extension|Cannot access a chrome:/i.test(message)) {
    return "本地插件页面被浏览器拦住了。请打开 chrome://flags 或 edge://flags，搜索 silent-debugger-extension-api，改成 Enabled，然后重启浏览器。";
  }
  return `本地插件页面暂时画不上红边：${message}`;
}

function setMeter(rms, threshold, alerting) {
  const width = Math.max(0, Math.min(100, (rms / METER_FULL) * 100));
  const mark = Math.max(0, Math.min(100, (threshold / METER_FULL) * 100));
  meterFill.style.width = `${width}%`;
  meterMark.style.left = `${mark}%`;
  meter.classList.toggle("is-alert", alerting);
}

function setStatus(text, kind) {
  micStatus.textContent = text;
  micStatus.classList.remove("is-ok", "is-alert");
  if (kind) micStatus.classList.add(kind);
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({ audible: true });
  audibleList.replaceChildren();
  audibleEmpty.classList.toggle("hidden", tabs.length > 0);
  for (const tab of tabs) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = cleanTitle(tab.title) || "未命名标签页";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = tab.active ? "当前标签 · 点击仍可聚焦窗口" : "点击切到这个标签";
    button.append(title, meta);
    button.addEventListener("click", async () => {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    });
    item.append(button);
    audibleList.append(item);
  }
}

function cleanTitle(title) {
  return (title || "").replace(/^(?:\u200b[🔊🔈] )+/, "");
}

async function refreshNotifyNote() {
  const level = await chrome.notifications.getPermissionLevel();
  if (level === "granted") {
    notifyNote.classList.add("hidden");
    return;
  }
  notifyNote.textContent = "系统通知当前是关闭的。边框仍会变化，但噪音和没输入都弹不出通知。";
  notifyNote.classList.remove("hidden");
}

function showError(text) {
  micError.textContent = text;
  micError.classList.remove("hidden");
}

function clearError() {
  micError.textContent = "";
  micError.classList.add("hidden");
}

function micErrorText(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "麦克风被拒绝了。请再打开一次输入识别，在弹出的窗口里允许；若没有提示，点窗口里的「打开麦克风设置」，把「声浪边框」改成允许。";
  }
  if (name === "NotFoundError") return "没有找到可用的麦克风。";
  if (name === "NotReadableError") return "麦克风打不开，可能正被别的程序占用。";
  return "无法打开麦克风，请重试。";
}

async function showFootprint() {
  const sizes = await Promise.all(
    EXTENSION_FILES.map(async (file) => {
      const response = await fetch(chrome.runtime.getURL(file));
      if (!response.ok) return 0;
      return (await response.arrayBuffer()).byteLength;
    })
  );
  const bytes = sizes.reduce((sum, size) => sum + size, 0);
  footprint.textContent = `此插件占用 ${formatBytes(bytes)}。没有声音时不绘制光边。`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

edgeSize.addEventListener("input", () => {
  showEdgeSize(edgeSize.value);
  queueLook();
});
edgeSize.addEventListener("change", () => commitLook());
flowSpeed.addEventListener("input", () => {
  showFlowSpeed(flowSpeed.value);
  queueLook();
});
flowSpeed.addEventListener("change", () => commitLook());
outputShake.addEventListener("change", () => commitLook());
shakeLevel.addEventListener("input", () => {
  showShakeLevel(shakeLevel.value);
  queueLook();
});
shakeLevel.addEventListener("change", () => commitLook());
colorOutput.addEventListener("input", () => {
  rainbowOutput.checked = false;
  queueLook();
});
colorInput.addEventListener("input", () => {
  rainbowInput.checked = false;
  queueLook();
});
colorOutput.addEventListener("change", () => {
  rainbowOutput.checked = false;
  commitLook();
});
colorInput.addEventListener("change", () => {
  rainbowInput.checked = false;
  commitLook();
});
rainbowOutput.addEventListener("change", () => commitLook());
rainbowInput.addEventListener("change", () => commitLook());
document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const preset = LOOK_PRESETS.find((item) => item.id === button.dataset.preset);
    if (!preset) return;
    applyPreset(preset);
  });
});
resetLook.addEventListener("click", () => {
  applyStoredLook({
    borderColors: DEFAULT_BORDER_COLORS,
    edgePx: DEFAULTS.edgePx,
    flowSpeed: DEFAULTS.flowSpeed,
    outputShake: DEFAULTS.outputShake,
    outputShakeLevel: DEFAULTS.outputShakeLevel,
  });
  commitLook();
});
window.addEventListener("pagehide", () => {
  if (lookDirty) flushLook();
});

function showEdgeSize(value) {
  const px = normalizeEdgePx(value);
  if (document.activeElement !== edgeSize) edgeSize.value = String(px);
  edgeSizeLabel.textContent = `${px} px`;
}

function showFlowSpeed(value) {
  const speed = normalizeFlowSpeed(value);
  if (document.activeElement !== flowSpeed) flowSpeed.value = String(speed);
  flowSpeedLabel.textContent = `${speed} 倍`;
}

function showShakeLevel(value) {
  const level = normalizeOutputShakeLevel(value);
  if (document.activeElement !== shakeLevel) shakeLevel.value = String(level);
  shakeLevelLabel.textContent = `${level} · ${SHAKE_WORDS[level]}`;
}

function formColors() {
  return normalizeBorderColors({
    output: rainbowOutput.checked ? "rainbow" : colorOutput.value,
    outputHex: colorOutput.value,
    input: rainbowInput.checked ? "rainbow" : colorInput.value,
    inputHex: colorInput.value,
  });
}

function paintBar(bar, palette, px, speed) {
  const light = palette.stops[2] || palette.stops[0];
  bar.style.height = `${px}px`;
  bar.style.setProperty("--flow-speed", String(speed));
  bar.style.backgroundImage = `linear-gradient(90deg, ${palette.stops.join(",")})`;
  bar.style.boxShadow = palette.rainbow
    ? `0 0 8px ${palette.stops[0]}, 0 0 14px ${light}`
    : `0 0 10px ${light}`;
}

function paintLive() {
  const colors = formColors();
  const px = normalizeEdgePx(edgeSize.value);
  const speed = normalizeFlowSpeed(flowSpeed.value);
  const reach = outputShakePixels(shakeLevel.value);
  paintBar(liveOutput, colors.outputPalette, px, speed);
  paintBar(liveInput, colors.inputPalette, px, speed);
  liveOutput.style.setProperty("--shake-x", `${reach.x}px`);
  liveOutput.style.setProperty("--shake-y", `${reach.y}px`);
  liveOutput.classList.toggle("is-shaking", outputShake.checked);
  shakeLevelField.classList.toggle("is-off", !outputShake.checked);
  markPreset(colors);
}

function applyPreset(preset) {
  const outputRainbow = preset.output === "rainbow";
  const inputRainbow = preset.input === "rainbow";
  rainbowOutput.checked = outputRainbow;
  rainbowInput.checked = inputRainbow;
  colorOutput.value = outputRainbow ? preset.outputHex : preset.output;
  colorInput.value = inputRainbow ? preset.inputHex : preset.input;
  commitLook();
}

function markPreset(colors) {
  document.querySelectorAll("[data-preset]").forEach((button) => {
    const preset = LOOK_PRESETS.find((item) => item.id === button.dataset.preset);
    if (!preset) return;
    const outputMatches = preset.output === "rainbow"
      ? colors.output === "rainbow"
      : colors.output !== "rainbow" && colors.outputHex === preset.output;
    const inputMatches = preset.input === "rainbow"
      ? colors.input === "rainbow"
      : colors.input !== "rainbow" && colors.inputHex === preset.input;
    button.classList.toggle("is-on", outputMatches && inputMatches);
  });
}

function applyStoredLook(stored) {
  const colors = normalizeBorderColors(stored.borderColors);
  showEdgeSize(stored.edgePx);
  showFlowSpeed(stored.flowSpeed);
  outputShake.checked = stored.outputShake === true;
  showShakeLevel(stored.outputShakeLevel);
  if (document.activeElement !== colorOutput) colorOutput.value = colors.outputHex;
  if (document.activeElement !== colorInput) colorInput.value = colors.inputHex;
  rainbowOutput.checked = colors.output === "rainbow";
  rainbowInput.checked = colors.input === "rainbow";
  paintLive();
}

function queueLook() {
  paintLive();
  lookDirty = true;
  if (lookTimer) return;
  lookTimer = setTimeout(() => {
    lookTimer = null;
    flushLook();
  }, 70);
}

function commitLook() {
  paintLive();
  if (lookTimer) {
    clearTimeout(lookTimer);
    lookTimer = null;
  }
  lookDirty = true;
  flushLook();
}

function flushLook() {
  if (!lookDirty) return;
  lookDirty = false;
  const colors = formColors();
  chrome.storage.local.set({
    borderColors: {
      output: colors.output,
      outputHex: colors.outputHex,
      input: colors.input,
      inputHex: colors.inputHex,
    },
    edgePx: normalizeEdgePx(edgeSize.value),
    flowSpeed: normalizeFlowSpeed(flowSpeed.value),
    outputShake: outputShake.checked,
    outputShakeLevel: normalizeOutputShakeLevel(shakeLevel.value),
  });
}
