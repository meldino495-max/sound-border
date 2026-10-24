import {
  DEFAULT_EDGE_PX,
  DEFAULTS,
  createSilenceMonitor,
  browserUserLabel,
  noiseNoticeText,
  isOffscreenDocument,
  isOtherExtensionPage,
  isOwnContentScript,
  isOwnExtensionPage,
  normalizeBorderColors,
  normalizeEdgePx,
  normalizeFlowSpeed,
  normalizeOutputShakeLevel,
  normalizeOutputScope,
  outputShakePixels,
  normalizeHexColor,
  parseProfileName,
  shouldResumePausedHost,
  shouldShowOutputBorder,
  silenceNoticeText,
  siteHost,
  thresholdFor,
} from "./silence-monitor.js";

const NOTIFY_ID = "tab-sound-glow-silence";
const NOISE_NOTIFY_ID = "tab-sound-glow-noise";
const MIC_ALARM = "tab-sound-glow-mic";
const NOISE_ALARM = "tab-sound-glow-noise-alarm";
const NOISE_REPEAT_MS = 30000;

let settings = {
  ...DEFAULTS,
  siteFlags: {},
  edgePx: DEFAULT_EDGE_PX,
  borderColors: normalizeBorderColors(DEFAULTS.borderColors),
};
let extensionLook = "";
let inputWatching = false;
let inputPausedHosts = new Set();
const tabHost = new Map();
const freshTabs = new Set();
let extensionBorderOn = false;
let extensionBorderError = "";
const paintTasks = new Map();
const paintedTabs = new Set();
let inputAlert = false;
let lastRms = 0;
let lastLevelAt = 0;
let micError = "";
let micGeneration = 0;
let monitor = null;
let offscreenTask = null;
let bootChain = Promise.resolve();

function enqueue(task) {
  const run = bootChain.then(task);
  bootChain = run.catch((error) => console.error(error));
  return run;
}

function boot() {
  return enqueue(doBoot);
}

const ready = boot();

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === NOTIFY_ID) focusSilenceWindow().catch(() => {});
  if (notificationId === NOISE_NOTIFY_ID) focusNoiseWindow().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session
    .set({ forceRereadBrowserUser: true })
    .catch(() => {})
    .then(() => ready)
    .then(injectOpenTabs)
    .then(syncAll)
    .catch((error) => console.error(error));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("silenceMs" in changes) settings.silenceMs = normalizeSilence(changes.silenceMs.newValue);
  if ("sensitivity" in changes) {
    const next = changes.sensitivity.newValue;
    if (next === "high" || next === "medium" || next === "low") settings.sensitivity = next;
  }
  if ("silenceMs" in changes || "sensitivity" in changes) ensureMonitor();
  const heavy = "siteFlags" in changes || "sensitivity" in changes || "silenceMs" in changes;
  const look = "borderColors" in changes || "edgePx" in changes || "flowSpeed" in changes || "outputShake" in changes || "outputShakeLevel" in changes;
  const noise = "noiseAlert" in changes;
  const scope = "outputScope" in changes;
  if (scope) settings.outputScope = normalizeOutputScope(changes.outputScope.newValue);
  if (!heavy && !look && !noise && !scope) return;
  enqueue(async () => {
    if (heavy) {
      if (changes.siteFlags) {
        await reconcilePause(changes.siteFlags.oldValue, changes.siteFlags.newValue);
      }
      await doBoot();
      return;
    }
    if (noise) settings.noiseAlert = changes.noiseAlert.newValue === true;
    const stored = await chrome.storage.local.get({
      borderColors: DEFAULTS.borderColors,
      edgePx: DEFAULT_EDGE_PX,
      flowSpeed: DEFAULTS.flowSpeed,
      outputShake: DEFAULTS.outputShake,
      outputShakeLevel: DEFAULTS.outputShakeLevel,
    });
    settings.borderColors = normalizeBorderColors(stored.borderColors);
    settings.edgePx = normalizeEdgePx(stored.edgePx);
    settings.flowSpeed = normalizeFlowSpeed(stored.flowSpeed);
    settings.outputShake = stored.outputShake === true;
    settings.outputShakeLevel = normalizeOutputShakeLevel(stored.outputShakeLevel);
    if ("outputShake" in changes) await injectOpenTabs();
    await syncAll();
  }).catch((error) => console.error(error));
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id == null) return;
  freshTabs.add(tab.id);
  tabHost.set(tab.id, siteHost(tab.pendingUrl || tab.url));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const next = siteHost(changeInfo.url);
    const prev = tabHost.get(tabId) || "";
    const isFresh = freshTabs.delete(tabId);
    tabHost.set(tabId, next);
    if (shouldResumePausedHost(prev, next, isFresh)) {
      enqueue(() => resumeIfPaused(next));
    }
  }
  if (changeInfo.status === "complete" && typeof tab.url === "string" && tab.url.startsWith("chrome-extension://")) {
    enqueue(async () => {
      if (!extensionBorderOn) return;
      const result = await paintExtensionBorder(tabId, true);
      if (result?.ok) paintedTabs.add(tabId);
      else if (result?.error) extensionBorderError = result.error;
    });
  }
  if ("audible" in changeInfo || changeInfo.url || changeInfo.status === "complete") {
    scheduleSync(tab.windowId);
  }
});

chrome.tabs.onActivated.addListener(({ windowId }) => {
  scheduleSync(windowId);
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  freshTabs.delete(tabId);
  tabHost.delete(tabId);
  scheduleSync();
});

chrome.windows.onFocusChanged.addListener(() => {
  scheduleSync();
});

let syncTimer = null;

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncAll().catch((error) => console.error(error));
  }, 200);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NOISE_ALARM) {
    ready
      .then(async () => {
        const tabs = await chrome.tabs.query({});
        await syncNoiseNotice(tabs, true);
      })
      .catch(() => {});
    return;
  }
  if (alarm.name !== MIC_ALARM) return;
  ready
    .then(async () => {
      if (!inputWatching || micError) return;
      if (!(await hasOffscreen())) await ensureOffscreen();
    })
    .catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "mic") return;
  if (!isOffscreenDocument(port.sender, chrome.runtime.id)) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener((message) => {
    if (message?.type === "mic-level") ready.then(() => handleLevel(message)).catch(() => {});
    if (message?.type === "mic-error") ready.then(() => handleMicError(message)).catch(() => {});
  });
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.type !== "pause-input") return;
  if (!isOtherExtensionPage(sender, chrome.runtime.id)) return;
  enqueue(() => pauseInputNow())
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false, error: "停不了这次输入识别。" }));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const extensionId = chrome.runtime.id;

  if (message.type === "open-mic-permission") {
    if (!isOwnExtensionPage(sender, extensionId)) return;
    openMicWindow(message.auto === true)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "pause-input") {
    if (!isOwnExtensionPage(sender, extensionId) && !isOwnContentScript(sender, extensionId)) return;
    enqueue(() => pauseInputNow())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "query-state") {
    if (!isOwnContentScript(sender, extensionId)) return;
    const tabId = sender.tab.id;
    ready
      .then(() => stateForTab(tabId))
      .then((state) => sendResponse(state))
      .catch(() => sendResponse({ output: false, flash: false, inputAlert: false }));
    return true;
  }

  if (message.type === "get-status") {
    if (!isOwnExtensionPage(sender, extensionId)) return;
    ready
      .then(async () => {
        const listening = inputWatching && (await hasOffscreen()) && !micError;
        sendResponse({
          listening,
          rms: lastRms,
          alerting: inputAlert,
          error: micError,
          threshold: thresholdFor(settings.sensitivity),
          levelAt: lastLevelAt,
          pausedHosts: [...inputPausedHosts],
          extensionBorderError,
        });
      })
      .catch(() => sendResponse({ listening: false, rms: 0, alerting: false, error: "", threshold: 0.02, levelAt: 0 }));
    return true;
  }
});

async function doBoot() {
  const stored = await chrome.storage.local.get({ ...DEFAULTS, siteFlags: {} });
  const session = await chrome.storage.session.get({ micErrorName: "", inputPausedHosts: [] });
  inputPausedHosts = new Set(
    Array.isArray(session.inputPausedHosts)
      ? session.inputPausedHosts.filter((host) => typeof host === "string" && host)
      : []
  );
  settings = {
    outputEnabled: stored.outputEnabled !== false,
    inputEnabled: stored.inputEnabled === true,
    sensitivity: stored.sensitivity || DEFAULTS.sensitivity,
    silenceMs: normalizeSilence(stored.silenceMs),
    noiseAlert: stored.noiseAlert === true,
    edgePx: normalizeEdgePx(stored.edgePx),
    flowSpeed: normalizeFlowSpeed(stored.flowSpeed),
    outputShake: stored.outputShake === true,
    outputShakeLevel: normalizeOutputShakeLevel(stored.outputShakeLevel),
    outputScope: normalizeOutputScope(stored.outputScope),
    borderColors: normalizeBorderColors(stored.borderColors),
    siteFlags: stored.siteFlags && typeof stored.siteFlags === "object" ? stored.siteFlags : {},
  };
  micError = session.micErrorName || "";
  ensureMonitor();
  await releaseOldSoundGroups();
  await snapshotTabHosts();
  await syncAll();
}

function ensureMonitor() {
  const options = {
    threshold: thresholdFor(settings.sensitivity),
    silenceMs: settings.silenceMs,
    onAlertStart: () => {
      inputAlert = true;
      notifySilence();
      syncAll().catch(() => {});
    },
    onAlertEnd: () => {
      inputAlert = false;
      chrome.notifications.clear(NOTIFY_ID).catch(() => {});
      syncAll().catch(() => {});
    },
    onNotify: () => notifySilence(),
  };
  if (!monitor) {
    monitor = createSilenceMonitor(options);
    return;
  }
  monitor.updateSettings(options);
}

async function stopInputMonitor() {
  if (monitor) monitor.reset();
  inputAlert = false;
  lastRms = 0;
  await chrome.notifications.clear(NOTIFY_ID).catch(() => {});
  await closeOffscreen();
}

function handleLevel(message) {
  if (Number(message?.generation) !== micGeneration) return;
  if (!inputWatching || !monitor) return;
  const rms = message.rms;
  if (!Number.isFinite(rms)) return;
  lastRms = rms;
  lastLevelAt = Date.now();
  micError = "";
  monitor.push(rms, lastLevelAt);
}

async function handleMicError(message) {
  if (Number(message?.generation) !== micGeneration) return;
  micError = message?.name || "Error";
  if (monitor) monitor.reset();
  inputAlert = false;
  await chrome.notifications.clear(NOTIFY_ID).catch(() => {});
  await chrome.storage.session.set({ micErrorName: micError });
  await closeOffscreen();
  await syncAll();
  if (micError === "NotAllowedError" || micError === "PermissionDeniedError") {
    await openMicWindow(false);
  }
}

async function openMicWindow(auto) {
  const base = chrome.runtime.getURL("mic-permission.html");
  const url = auto ? `${base}?auto=1` : base;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => typeof tab.url === "string" && tab.url.startsWith(base));
  if (existing?.windowId) {
    await chrome.windows.update(existing.windowId, { focused: true });
    if (existing.id && existing.url !== url) await chrome.tabs.update(existing.id, { url });
    return;
  }
  await chrome.windows.create({
    url,
    type: "popup",
    width: 440,
    height: 380,
    focused: true,
  });
}

function notifySilence() {
  rememberSilenceTarget()
    .then(async (target) => {
      const tab = target?.tabId ? await chrome.tabs.get(target.tabId).catch(() => null) : null;
      const [part] = tab ? await labelForTabs([tab]) : [];
      return { message: silenceNoticeText(part), user: part?.user || "" };
    })
    .catch(() => ({ message: silenceNoticeText(null), user: "" }))
    .then(({ message, user }) => {
      chrome.notifications
        .create(NOTIFY_ID, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: user ? `麦克风没有声音 · ${user}` : "麦克风没有声音",
          message,
          priority: 2,
        })
        .catch(() => {});
    });
}

let noiseSignature = "";
let lastNoiseAt = 0;
let noiseAlarmOn = false;

async function syncNoiseNotice(tabs, fromAlarm = false) {
  if (!settings.noiseAlert) {
    noiseSignature = "";
    lastNoiseAt = 0;
    if (noiseAlarmOn) {
      noiseAlarmOn = false;
      chrome.alarms.clear(NOISE_ALARM).catch(() => {});
    }
    await chrome.notifications.clear(NOISE_NOTIFY_ID).catch(() => {});
    await chrome.storage.session.remove("noiseFocus").catch(() => {});
    return;
  }
  const sources = outputNoticeTabs(tabs, audibleOutputHosts(tabs));
  if (!sources.length) {
    noiseSignature = "";
    lastNoiseAt = 0;
    if (noiseAlarmOn) {
      noiseAlarmOn = false;
      chrome.alarms.clear(NOISE_ALARM).catch(() => {});
    }
    await chrome.notifications.clear(NOISE_NOTIFY_ID).catch(() => {});
    await chrome.storage.session.remove("noiseFocus").catch(() => {});
    return;
  }
  if (!noiseAlarmOn) {
    noiseAlarmOn = true;
    chrome.alarms.create(NOISE_ALARM, { periodInMinutes: 0.5 });
  }
  const signature = sources
    .map((tab) => `${tab.windowId}:${tab.id}`)
    .sort()
    .join("|");
  const changed = signature !== noiseSignature;
  const due = fromAlarm || Date.now() - lastNoiseAt >= NOISE_REPEAT_MS;
  if (!changed && !due) return;
  noiseSignature = signature;
  lastNoiseAt = Date.now();
  const labels = await labelForTabs(sources);
  const message = noiseNoticeText(labels);
  if (!message) return;
  const primary = labels[0];
  await chrome.storage.session.set({
    noiseFocus: { windowId: primary.windowId, tabId: primary.tabId },
  });
  await chrome.notifications.clear(NOISE_NOTIFY_ID).catch(() => {});
  await chrome.notifications
    .create(NOISE_NOTIFY_ID, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: primary.user ? `检测到输出声音 · ${primary.user}` : "检测到输出声音",
      message,
      priority: 2,
    })
    .catch(() => {});
}

async function focusNoiseWindow() {
  const stored = await chrome.storage.session.get({ noiseFocus: null });
  let target = stored.noiseFocus;
  let win = target?.windowId ? await chrome.windows.get(target.windowId).catch(() => null) : null;
  if (!win) {
    const tabs = await chrome.tabs.query({ audible: true });
    const [next] = await labelForTabs(tabs.filter((tab) => siteFlag(tab.url, "output")));
    target = next;
    win = target?.windowId ? await chrome.windows.get(target.windowId).catch(() => null) : null;
  }
  if (!win || !target?.windowId) return;
  const patch = { focused: true };
  if (win.state === "minimized") patch.state = "normal";
  await chrome.windows.update(win.id, patch);
  if (target.tabId) await chrome.tabs.update(target.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(win.id, { focused: true });
}

async function labelForTabs(tabs) {
  const user = await currentBrowserUser();
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const ordered = windows
    .map((win) => win.id)
    .filter((id) => id != null)
    .sort((a, b) => a - b);
  return tabs
    .filter((tab) => tab?.id != null)
    .map((tab) => {
      const index = ordered.indexOf(tab.windowId);
      const which = browserUserLabel(user, index >= 0 ? index + 1 : 0, ordered.length);
      const title = cleanTitle(tab.title).slice(0, 42) || "未命名页面";
      const host = siteHost(tab.url);
      const page = host && !title.includes(host) ? `${title}（${host}）` : title;
      return {
        which,
        page,
        user,
        windowId: tab.windowId,
        tabId: tab.id,
        lastAccessed: tab.lastAccessed || 0,
      };
    })
    .sort((a, b) => b.lastAccessed - a.lastAccessed);
}

function cleanTitle(title) {
  return (title || "").replace(/^(?:\u200b[🔊🔈] )+/, "").trim();
}

let browserUserName = "";
let browserUserTask = null;
let browserUserResolved = false;

async function currentBrowserUser() {
  if (browserUserResolved) return browserUserName;
  if (!browserUserTask) browserUserTask = loadBrowserUserName();
  return Promise.race([
    browserUserTask,
    new Promise((resolve) => setTimeout(() => resolve(browserUserName), 1500)),
  ]);
}

async function loadBrowserUserName() {
  try {
    const version = chrome.runtime.getManifest().version;
    const [session, stored] = await Promise.all([
      chrome.storage.session.get({ forceRereadBrowserUser: false }),
      chrome.storage.local.get({ browserUserName: "", browserUserNameVersion: "" }),
    ]);
    const cached = String(stored.browserUserName || "").trim();
    if (!session.forceRereadBrowserUser && cached && stored.browserUserNameVersion === version) {
      browserUserName = cached;
      browserUserResolved = true;
      return browserUserName;
    }
    await chrome.storage.session.remove("forceRereadBrowserUser").catch(() => {});
    const name = (await readProfileName()) || cached;
    if (name) {
      browserUserName = name;
      await chrome.storage.local.set({ browserUserName: name, browserUserNameVersion: version });
    }
    browserUserResolved = true;
    return browserUserName;
  } finally {
    browserUserTask = null;
  }
}

async function readProfileName() {
  const text = await readInternalPage("chrome://prefs-internals/profile.name");
  return parseProfileName(text);
}

function readInternalPage(url) {
  if (url !== "chrome://prefs-internals/profile.name") return Promise.resolve("");
  return new Promise((resolve) => {
    let windowId = 0;
    let tabId = 0;
    let attached = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value || "");
      if (attached && tabId) chrome.debugger.detach({ tabId }).catch(() => {});
      if (windowId) chrome.windows.remove(windowId).catch(() => {});
    };
    const timer = setTimeout(() => finish(""), 6000);
    chrome.windows
      .create({ url, type: "popup", state: "minimized", focused: false, width: 240, height: 120 })
      .then(async (win) => {
        windowId = win?.id || 0;
        tabId = win?.tabs?.[0]?.id || 0;
        if (!tabId && windowId) {
          const tabs = await chrome.tabs.query({ windowId });
          tabId = tabs[0]?.id || 0;
        }
        if (!tabId) {
          finish("");
          return;
        }
        await waitForTab(tabId);
        await chrome.debugger.attach({ tabId }, "1.3");
        attached = true;
        const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
          expression: "(document.body && document.body.innerText) || ''",
          returnByValue: true,
        });
        finish(result?.result?.value || "");
      })
      .catch(() => finish(""));
  });
}

function waitForTab(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const timer = setTimeout(done, 4000);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") done();
    }).catch(() => {});
  });
}

async function rememberSilenceTarget() {
  const tabs = await chrome.tabs.query({});
  const wanted = tabs.filter((tab) => tab.id && tabWantsInput(tab));
  const chosen = wanted.reduce((best, tab) => {
    if (!best || (tab.lastAccessed || 0) >= (best.lastAccessed || 0)) return tab;
    return best;
  }, null);
  if (!chosen) {
    await chrome.storage.session.remove("silenceFocus");
    return null;
  }
  const target = { windowId: chosen.windowId, tabId: chosen.id };
  await chrome.storage.session.set({ silenceFocus: target });
  return target;
}

async function focusSilenceWindow() {
  const stored = await chrome.storage.session.get({ silenceFocus: null });
  let target = stored.silenceFocus;
  let win = target?.windowId ? await chrome.windows.get(target.windowId).catch(() => null) : null;
  if (!win) {
    target = await rememberSilenceTarget();
    win = target?.windowId ? await chrome.windows.get(target.windowId).catch(() => null) : null;
  }
  if (!win || !target?.windowId) return;
  const patch = { focused: true };
  if (win.state === "minimized") patch.state = "normal";
  await chrome.windows.update(win.id, patch);
  if (target.tabId) await chrome.tabs.update(target.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(win.id, { focused: true });
}

async function injectOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
        .catch(() => {})
    )
  );
}

async function snapshotTabHosts() {
  const tabs = await chrome.tabs.query({});
  tabHost.clear();
  for (const tab of tabs) {
    if (tab.id != null) tabHost.set(tab.id, siteHost(tab.url));
  }
}

async function savePausedHosts() {
  await chrome.storage.session.set({ inputPausedHosts: [...inputPausedHosts] });
}

async function reconcilePause(oldFlags, newFlags) {
  const prev = oldFlags && typeof oldFlags === "object" ? oldFlags : {};
  const next = newFlags && typeof newFlags === "object" ? newFlags : {};
  let changed = false;
  for (const host of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const was = prev[host]?.input === true;
    const now = next[host]?.input === true;
    if (!inputPausedHosts.has(host)) continue;
    if (!now || (now && !was)) {
      inputPausedHosts.delete(host);
      changed = true;
    }
  }
  if (changed) await savePausedHosts();
}

async function resumeIfPaused(host) {
  if (!host || !inputPausedHosts.has(host)) return;
  inputPausedHosts.delete(host);
  await savePausedHosts();
  await syncAll();
}

async function pauseInputNow() {
  const tabs = await chrome.tabs.query({});
  let changed = false;
  for (const tab of tabs) {
    const host = siteHost(tab.url);
    if (!host || !siteFlag(tab.url, "input") || inputPausedHosts.has(host)) continue;
    inputPausedHosts.add(host);
    changed = true;
  }
  if (changed) await savePausedHosts();
  await syncAll();
}

async function syncAll() {
  const tabs = await chrome.tabs.query({});
  await refreshInputWatch(tabs);
  const hosts = audibleOutputHosts(tabs);
  const groups = groupByWindow(tabs);
  for (const group of groups.values()) {
    deliverGroup(group, group.some((tab) => tab.audible), hosts);
  }
  await updateBadge(tabs);
  await syncNoiseNotice(tabs);
  await syncExtensionBorders(false);
}

async function syncExtensionBorders(show) {
  const look = inputLookKey();
  if (show === extensionBorderOn && (!show || look === extensionLook)) return;
  extensionBorderOn = show;
  extensionLook = look;
  const tabs = await chrome.tabs.query({});
  let error = "";
  if (show) {
    for (const tab of tabs) {
      if (!tab.id || !tab.url?.startsWith("chrome-extension://")) continue;
      const result = await paintExtensionBorder(tab.id, true);
      if (result.ok) paintedTabs.add(tab.id);
      else error = result.error;
    }
  } else {
    for (const tabId of paintedTabs) {
      await paintExtensionBorder(tabId, false);
    }
    paintedTabs.clear();
  }
  extensionBorderError = error;
}

function paintExtensionBorder(tabId, show) {
  const previous = paintTasks.get(tabId) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => paintExtensionBorderNow(tabId, show));
  paintTasks.set(tabId, run);
  return run;
}

let borderScript = "";

async function loadBorderScript() {
  if (borderScript) return borderScript;
  const response = await fetch(chrome.runtime.getURL("extension-border.js"));
  borderScript = await response.text();
  return borderScript;
}

async function paintExtensionBorderNow(tabId, show) {
  const target = { tabId };
  let attachedHere = false;
  try {
    try {
      await chrome.debugger.attach(target, "1.3");
      attachedHere = true;
    } catch (error) {
      const message = String(error?.message || "");
      if (!message.includes("Already attached")) throw error;
    }
    const script = await loadBorderScript();
    const palette = settings.borderColors?.inputPalette || normalizeBorderColors(null).inputPalette;
    const stops = Array.isArray(palette.stops)
      ? palette.stops.map((stop) => normalizeHexColor(stop)).filter(Boolean)
      : [];
    const expression = `globalThis.__TSG_ALERT__=${show ? "true" : "false"};globalThis.__TSG_EXT_ID__=${JSON.stringify(chrome.runtime.id)};globalThis.__TSG_EDGE_PX__=${normalizeEdgePx(settings.edgePx)};globalThis.__TSG_INPUT_PALETTE__=${JSON.stringify({ rainbow: palette.rainbow === true, stops })};\n${script}`;
    try {
      await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression,
        allowUnsafeEvalBlockedByCSP: true,
      });
    } catch (error) {
      const message = String(error?.message || "");
      if (!/allowUnsafeEvalBlockedByCSP|Invalid parameters/i.test(message)) throw error;
      await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression });
    }
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    if (attachedHere) await chrome.debugger.detach(target).catch(() => {});
  }
}

async function releaseOldSoundGroups() {
  const stored = await chrome.storage.session.get({ coloredTabIds: [] });
  const ids = new Set(stored.coloredTabIds || []);
  try {
    const groups = await chrome.tabGroups.query({ color: "cyan" });
    for (const group of groups) {
      if (group.title) continue;
      const members = await chrome.tabs.query({ groupId: group.id });
      for (const tab of members) {
        if (tab.id) ids.add(tab.id);
      }
    }
  } catch {
    /* 没有分组权限时跳过，不影响光边。 */
  }
  await Promise.all([...ids].map((tabId) => chrome.tabs.ungroup(tabId).catch(() => {})));
  await chrome.storage.session.remove(["coloredTabIds", "soundGroupByWindow"]);
}

function deliverGroup(tabs, windowHasAudible, audibleHosts) {
  for (const tab of tabs) {
    sendTab(tab.id, visualState(tab, windowHasAudible, audibleHosts));
  }
}

function audibleOutputHosts(tabs) {
  const hosts = new Set();
  for (const tab of tabs) {
    if (!tab?.audible) continue;
    const host = siteHost(tab.url);
    if (host && siteFlag(tab.url, "output")) hosts.add(host);
  }
  return hosts;
}

function outputNoticeTabs(tabs, hosts) {
  if (normalizeOutputScope(settings.outputScope) === "tab") {
    return tabs.filter((tab) => tab?.audible && tab.id != null && siteFlag(tab.url, "output"));
  }
  const chosen = new Map();
  for (const tab of tabs) {
    const host = siteHost(tab.url);
    if (!host || !hosts.has(host) || !siteFlag(tab.url, "output") || tab.id == null) continue;
    const prev = chosen.get(tab.windowId);
    if (!prev || (tab.audible && !prev.audible)) chosen.set(tab.windowId, tab);
  }
  return [...chosen.values()];
}

function siteFlag(url, key) {
  const host = siteHost(url);
  if (!host) return false;
  return settings.siteFlags[host]?.[key] === true;
}

function visualState(tab, windowHasAudible, audibleHosts) {
  const host = siteHost(tab.url);
  const output = shouldShowOutputBorder({
    enabled: siteFlag(tab.url, "output"),
    audible: tab.audible === true,
    hostAudible: !!(host && audibleHosts?.has(host)),
    windowAudible: windowHasAudible === true,
    active: tab.active === true,
    scope: settings.outputScope,
  });
  return {
    type: "state",
    output,
    flash: false,
    inputAlert: inputWatching && inputAlert && tabWantsInput(tab),
    ...lookPayload(),
  };
}

function lookPayload() {
  const colors = settings.borderColors || normalizeBorderColors(null);
  return {
    edgePx: normalizeEdgePx(settings.edgePx),
    flowSpeed: normalizeFlowSpeed(settings.flowSpeed),
    outputShake: settings.outputShake === true,
    outputShakeX: outputShakePixels(settings.outputShakeLevel).x,
    outputShakeY: outputShakePixels(settings.outputShakeLevel).y,
    colors: {
      output: { rainbow: colors.outputPalette.rainbow === true, stops: colors.outputPalette.stops },
      input: { rainbow: colors.inputPalette.rainbow === true, stops: colors.inputPalette.stops },
    },
  };
}

function inputLookKey() {
  const look = lookPayload();
  const input = look.colors.input;
  return `${look.edgePx}:${input.rainbow ? "rainbow" : input.stops.join(",")}`;
}

async function stateForTab(tabId) {
  if (!tabId) return { output: false, flash: false, inputAlert: false };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { output: false, flash: false, inputAlert: false };
  const tabs = await chrome.tabs.query({});
  const hosts = audibleOutputHosts(tabs);
  const windowHasAudible = tabs.some((item) => item.windowId === tab.windowId && item.audible);
  const state = visualState(tab, windowHasAudible, hosts);
  return state;
}

function tabWantsInput(tab) {
  const host = siteHost(tab.url);
  return !!host && siteFlag(tab.url, "input") && !inputPausedHosts.has(host);
}

async function refreshInputWatch(tabs) {
  const next = tabs.some((tab) => tabWantsInput(tab));
  const started = next && !inputWatching;
  const stopped = !next && (inputWatching || inputAlert);
  inputWatching = next;
  if (inputWatching && !micError) {
    await ensureOffscreen();
    if (started) chrome.alarms.create(MIC_ALARM, { periodInMinutes: 1 });
    return;
  }
  if (stopped) {
    micError = "";
    chrome.storage.session.remove("micErrorName").catch(() => {});
    await stopInputMonitor();
    chrome.alarms.clear(MIC_ALARM);
  }
}

async function updateBadge(tabs) {
  const outputAudible = tabs.some((tab) => tab.audible && siteFlag(tab.url, "output"));
  if (inputWatching && inputAlert) {
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    await chrome.action.setBadgeText({ text: "!" });
    return;
  }
  if (outputAudible) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0891b2" });
    await chrome.action.setBadgeText({ text: "~" });
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
}

function sendTab(tabId, payload) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

function groupByWindow(tabs) {
  const groups = new Map();
  for (const tab of tabs) {
    const list = groups.get(tab.windowId);
    if (list) list.push(tab);
    else groups.set(tab.windowId, [tab]);
  }
  return groups;
}

function normalizeSilence(value) {
  const allowed = [2000, 3000, 5000, 8000];
  const parsed = Number(value);
  return allowed.includes(parsed) ? parsed : DEFAULTS.silenceMs;
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

function ensureOffscreen() {
  if (offscreenTask) return offscreenTask;
  offscreenTask = createOffscreen().finally(() => {
    offscreenTask = null;
  });
  return offscreenTask;
}

async function createOffscreen() {
  if (await hasOffscreen()) return;
  micGeneration += 1;
  await chrome.offscreen.createDocument({
    url: `offscreen.html?g=${micGeneration}`,
    reasons: ["USER_MEDIA"],
    justification: "监听麦克风有没有输入声音，没有声音时提醒用户",
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    chrome.runtime.sendMessage({ type: "offscreen-stop" }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}
