const allowButton = document.querySelector("#allow");
const settingsButton = document.querySelector("#settings");
const status = document.querySelector("#status");
const auto = new URLSearchParams(location.search).get("auto") === "1";

allowButton.addEventListener("click", () => {
  grant().catch(showFailure);
});

settingsButton.addEventListener("click", () => {
  const scheme = navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
  chrome.tabs.create({
    url: `${scheme}://settings/content/siteDetails?site=chrome-extension://${chrome.runtime.id}`,
  });
});

init().catch(showFailure);

async function init() {
  const state = await micState();
  if (state === "denied") {
    showDenied();
    return;
  }
  if (state === "granted" && auto) {
    await grant();
  }
}

async function micState() {
  try {
    const result = await navigator.permissions.query({ name: "microphone" });
    return result.state;
  } catch {
    return "prompt";
  }
}

async function grant() {
  allowButton.disabled = true;
  status.textContent = "正在请求麦克风…";
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  for (const track of stream.getTracks()) track.stop();
  const { pendingInputHost } = await chrome.storage.session.get({ pendingInputHost: "" });
  await chrome.storage.session.remove(["micErrorName", "pendingInputHost"]);
  if (pendingInputHost) {
    const stored = await chrome.storage.local.get({ siteFlags: {} });
    const siteFlags = { ...(stored.siteFlags || {}) };
    const current = siteFlags[pendingInputHost] || { output: false, input: false };
    siteFlags[pendingInputHost] = { output: current.output === true, input: true };
    await chrome.storage.local.set({ siteFlags });
  }
  status.textContent = pendingInputHost
    ? `已记住 ${pendingInputHost}，下次打开这个网站会自动监听麦克风。`
    : "已允许，正在开始监听。";
  window.close();
}

function showDenied() {
  allowButton.disabled = false;
  status.textContent = "麦克风被拒绝了。请打开设置，把「声浪边框」改成允许，然后回到这里再点一次「允许麦克风」。";
  settingsButton.hidden = false;
}

function showFailure(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    showDenied();
    return;
  }
  allowButton.disabled = false;
  if (name === "NotFoundError") {
    status.textContent = "没有找到可用的麦克风。";
    return;
  }
  if (name === "NotReadableError") {
    status.textContent = "麦克风打不开，可能正被别的程序占用。";
    return;
  }
  status.textContent = "无法打开麦克风，请再点一次。";
}
