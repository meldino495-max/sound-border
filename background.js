import {
  DEFAULTS,
  NOTIFY_EVERY_MS,
  createSilenceMonitor,
  shouldResumePausedHost,
  siteHost,
  thresholdFor,
} from "./silence-monitor.js";

const NOTIFY_ID = "tab-sound-glow-silence";
const MIC_ALARM = "tab-sound-glow-mic";

let settings = { ...DEFAULTS, siteFlags: {} };
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

chrome.runtime.onInstalled.addListener(() => {
  ready
    .then(injectOpenTabs)
    .then(syncAll)
    .catch((error) => console.error(error));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!("siteFlags" in changes || "sensitivity" in changes || "silenceMs" in changes)) {
    return;
  }
  enqueue(async () => {
    if (changes.siteFlags) {
      await reconcilePause(changes.siteFlags.oldValue, changes.siteFlags.newValue);
    }
    await doBoot();
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
  scheduleSync(info.windowId);
});

const syncTimers = new Map();

function scheduleSync(windowId) {
  const pending = syncTimers.get(windowId);
  if (pending) clearTimeout(pending);
  syncTimers.set(
    windowId,
    setTimeout(() => {
      syncTimers.delete(windowId);
      syncWindow(windowId).catch(() => {});
    }, 400)
  );
}

chrome.alarms.onAlarm.addListener((alarm) => {
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
  port.onMessage.addListener((message) => {
    if (message?.type === "mic-level") ready.then(() => handleLevel(message)).catch(() => {});
    if (message?.type === "mic-error") ready.then(() => handleMicError(message)).catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "open-mic-permission") {
    openMicWindow(message.auto === true)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "pause-input") {
    enqueue(() => pauseInputNow())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "query-state") {
    const tabId = sender.tab?.id;
    ready
      .then(() => stateForTab(tabId))
      .then((state) => sendResponse(state))
      .catch(() => sendResponse({ output: false, flash: false, inputAlert: false }));
    return true;
  }

  if (message.type === "get-status") {
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
    notifyEveryMs: NOTIFY_EVERY_MS,
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
  chrome.notifications.create(NOTIFY_ID, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "麦克风没有声音",
    message: "没有检测到输入声音。请检查麦克风是否静音、是否选对，或确认自己有没有在说话。",
    priority: 2,
  }).catch(() => {});
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
  const groups = groupByWindow(tabs);
  for (const group of groups.values()) {
    deliverGroup(group, group.some((tab) => tab.audible));
  }
  await updateBadge(tabs);
  await syncExtensionBorders(inputWatching && inputAlert);
}

async function syncWindow(windowId) {
  const windowTabs = await chrome.tabs.query({ windowId });
  const all = await chrome.tabs.query({});
  await refreshInputWatch(all);
  deliverGroup(windowTabs, windowTabs.some((tab) => tab.audible));
  await updateBadge(all);
  await syncExtensionBorders(inputWatching && inputAlert);
}

async function syncExtensionBorders(show) {
  if (show === extensionBorderOn) return;
  extensionBorderOn = show;
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
    const expression = `globalThis.__TSG_ALERT__=${show ? "true" : "false"};\n${script}`;
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

function deliverGroup(tabs, windowHasAudible) {
  for (const tab of tabs) {
    sendTab(tab.id, visualState(tab, windowHasAudible));
  }
}

function siteFlag(url, key) {
  const host = siteHost(url);
  if (!host) return false;
  return settings.siteFlags[host]?.[key] === true;
}

function visualState(tab, windowHasAudible) {
  const outputOn = siteFlag(tab.url, "output");
  const output = outputOn && (!!tab.audible || (!!tab.active && windowHasAudible));
  return {
    type: "state",
    output,
    flash: false,
    inputAlert: inputWatching && inputAlert,
  };
}

async function stateForTab(tabId) {
  if (!tabId) return { output: false, flash: false, inputAlert: false };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { output: false, flash: false, inputAlert: false };
  const siblings = await chrome.tabs.query({ windowId: tab.windowId, audible: true });
  const state = visualState(tab, siblings.length > 0);
  return { output: state.output, flash: state.flash, inputAlert: state.inputAlert };
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
