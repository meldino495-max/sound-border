import { DEFAULTS, siteHost } from "./silence-monitor.js";

const outputToggle = document.querySelector("#output-toggle");
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
});

async function init() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  sensitivity.value = ["high", "medium", "low"].includes(stored.sensitivity) ? stored.sensitivity : "medium";
  silence.value = String([2000, 3000, 5000, 8000].includes(Number(stored.silenceMs)) ? stored.silenceMs : 3000);
  await refreshSite();
  await refreshTabs();
  await refreshNotifyNote();
  showFootprint().catch(() => {
    footprint.textContent = "暂时算不出占用空间。";
  });
  const session = await chrome.storage.session.get({ micErrorName: "" });
  if (!inputToggle.checked && session.micErrorName) showError(micErrorText({ name: session.micErrorName }));
  await refreshMic();
  pollTimer = setInterval(() => {
    refreshMic();
  }, 800);
  window.addEventListener("unload", () => clearInterval(pollTimer));
}

function syncInputOptions() {
  const on = inputToggle.checked;
  inputOptions.classList.toggle("is-off", !on);
  sensitivity.disabled = !on;
  silence.disabled = !on;
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
    siteName.textContent = "当前是本地插件页面。麦克风没有输入时，这个页面也会一直红边抖动。";
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
  notifyNote.textContent = "系统通知当前是关闭的。无输入时边框仍会变红抖动，但弹不出通知。";
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
