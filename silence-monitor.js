export const DEFAULTS = {
  outputEnabled: true,
  inputEnabled: false,
  sensitivity: "medium",
  silenceMs: 3000,
  noiseAlert: false,
  edgePx: 8,
  flowSpeed: 1,
  outputShake: false,
  outputShakeLevel: 3,
  outputScope: "sync",
  borderColors: {
    output: "#0096c7",
    outputHex: "#0096c7",
    input: "#d00000",
    inputHex: "#d00000",
  },
};

export const DEFAULT_EDGE_PX = 8;
export const DEFAULT_BORDER_COLORS = {
  output: "#0096c7",
  outputHex: "#0096c7",
  input: "#d00000",
  inputHex: "#d00000",
};
export const RAINBOW_STOPS = ["#ff2d55", "#ff9f1a", "#ffe14a", "#3ddc84", "#2ec4ff", "#7b61ff"];
const OUTPUT_STOPS = ["#0077b6", "#48cae4", "#e0fbff", "#00b4d8", "#0077b6", "#48cae4"];
const INPUT_STOPS = ["#9d0208", "#ff4d6d", "#ffe5e9", "#e5383b", "#9d0208", "#ff4d6d"];

export function silenceNoticeText(part) {
  if (!part?.which || !part?.page) return "没有检测到输入声音。点击通知会回到正在识别的浏览器窗口。";
  return `${part.which}没有输入声音：${part.page}。点击通知会回到这个窗口。`;
}

export function noiseNoticeText(parts) {
  if (!Array.isArray(parts) || !parts.length || !parts[0]?.which || !parts[0]?.page) return "";
  const lines = parts.slice(0, 3).map((part) => `${part.which}正在出声：${part.page}`);
  const extra = parts.length > 3 ? `另有 ${parts.length - 3} 个窗口也在出声。` : "";
  return `${lines.join("。")}。${extra}点击通知会回到${parts[0].which}。`;
}

export function browserUserLabel(userName, windowIndex, windowCount) {
  const name = String(userName || "").trim();
  const many = Number(windowCount) > 1 && Number(windowIndex) > 0;
  if (name && many) return `浏览器用户「${name}」的窗口 ${windowIndex}`;
  if (name) return `浏览器用户「${name}」`;
  if (many) return `浏览器窗口 ${windowIndex}`;
  return "这个浏览器窗口";
}

export function parseProfileName(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.startsWith("Preference not found")) return "";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "string") return "";
    return parsed.replace(/[\t\r\n]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 100);
  } catch {
    return "";
  }
}

export function normalizeEdgePx(value) {
  const size = Math.round(Number(value));
  if (!Number.isFinite(size)) return DEFAULT_EDGE_PX;
  return Math.min(32, Math.max(2, size));
}

export function normalizeFlowSpeed(value) {
  const speed = Math.round(Number(value));
  if (!Number.isFinite(speed)) return 1;
  return Math.min(8, Math.max(1, speed));
}

export function normalizeOutputScope(value) {
  return value === "tab" ? "tab" : "sync";
}

export function shouldShowOutputBorder({ enabled, audible, hostAudible, windowAudible, active, scope }) {
  if (!enabled) return false;
  if (normalizeOutputScope(scope) === "tab") return audible === true;
  return audible === true || hostAudible === true || (active === true && windowAudible === true);
}

export function normalizeOutputShakeLevel(value) {
  const level = Math.round(Number(value));
  if (!Number.isFinite(level)) return 3;
  return Math.min(5, Math.max(1, level));
}

export function outputShakePixels(level) {
  const step = normalizeOutputShakeLevel(level);
  return { x: step * 4, y: step * 3 };
}

export function normalizeHexColor(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : "";
}

function mixHex(hex, target, amount) {
  const channel = (color, index) => Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);
  const parts = [0, 1, 2].map((index) => {
    const from = channel(hex, index);
    const to = channel(target, index);
    return Math.round(from + (to - from) * amount);
  });
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function toneStops(hex, kind) {
  if (kind === "output" && hex === DEFAULT_BORDER_COLORS.outputHex) return OUTPUT_STOPS.slice();
  if (kind === "input" && hex === DEFAULT_BORDER_COLORS.inputHex) return INPUT_STOPS.slice();
  const deep = mixHex(hex, "#000000", 0.28);
  const soft = mixHex(hex, "#ffffff", 0.45);
  const light = mixHex(hex, "#ffffff", 0.82);
  return [deep, soft, light, hex, deep, soft];
}

export function borderPalette(value, fallbackHex, kind) {
  const rainbow = value === "rainbow";
  const hex = normalizeHexColor(rainbow ? fallbackHex : value) || normalizeHexColor(fallbackHex) || DEFAULT_BORDER_COLORS.outputHex;
  if (rainbow) return { rainbow: true, stops: RAINBOW_STOPS.slice() };
  return { rainbow: false, stops: toneStops(hex, kind) };
}

export function normalizeBorderColors(value) {
  const source = value && typeof value === "object" ? value : {};
  const outputHex = normalizeHexColor(source.outputHex) || normalizeHexColor(source.output) || DEFAULT_BORDER_COLORS.outputHex;
  const inputHex = normalizeHexColor(source.inputHex) || normalizeHexColor(source.input) || DEFAULT_BORDER_COLORS.inputHex;
  const output = source.output === "rainbow" ? "rainbow" : outputHex;
  const input = source.input === "rainbow" ? "rainbow" : inputHex;
  return {
    output,
    outputHex,
    input,
    inputHex,
    outputPalette: borderPalette(output, outputHex, "output"),
    inputPalette: borderPalette(input, inputHex, "input"),
  };
}

const WARMUP_MS = 800;

export function siteHost(url) {
  try {
    const parsed = new URL(url || "");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname;
  } catch {
    return "";
  }
}

export function shouldResumePausedHost(prevHost, nextHost, isFresh) {
  if (!nextHost) return false;
  if (isFresh) return true;
  return Boolean(prevHost) && prevHost !== nextHost;
}

export function thresholdFor(sensitivity) {
  if (sensitivity === "high") return 0.008;
  if (sensitivity === "low") return 0.05;
  return 0.02;
}

export function createSilenceMonitor({
  threshold,
  silenceMs,
  onAlertStart,
  onAlertEnd,
  onNotify,
  now = Date.now(),
}) {
  let level = threshold;
  let holdMs = silenceMs;
  let origin = now;
  let silentSince = null;
  let alerting = false;
  let lastNotify = 0;

  return {
    get alerting() {
      return alerting;
    },
    updateSettings(next, at = Date.now()) {
      const nextLevel = Number(next.threshold);
      const nextHold = Number(next.silenceMs);
      const levelChanged = Number.isFinite(nextLevel) && nextLevel !== level;
      const holdChanged = Number.isFinite(nextHold) && nextHold > 0 && nextHold !== holdMs;
      if (Number.isFinite(nextLevel)) level = nextLevel;
      if (Number.isFinite(nextHold) && nextHold > 0) holdMs = nextHold;
      if (holdChanged) {
        if (alerting) {
          alerting = false;
          onAlertEnd();
        }
        lastNotify = 0;
        if (silentSince != null) silentSince = at;
        return alerting;
      }
      if (levelChanged && !alerting && silentSince != null) silentSince = at;
      return alerting;
    },
    reset(at = Date.now()) {
      origin = at;
      silentSince = null;
      alerting = false;
      lastNotify = 0;
    },
    push(rms, at = Date.now()) {
      if (!Number.isFinite(rms)) return alerting;
      if (at - origin < WARMUP_MS) return alerting;
      if (rms >= level) {
        silentSince = null;
        if (alerting) {
          alerting = false;
          onAlertEnd();
        }
        return alerting;
      }
      if (silentSince == null) silentSince = at;
      const silentMs = at - silentSince;
      if (silentMs < holdMs) return alerting;
      if (!alerting) {
        alerting = true;
        lastNotify = at;
        onAlertStart({ silentMs, rms });
        return alerting;
      }
      if (at - lastNotify >= holdMs) {
        lastNotify = at;
        onNotify({ silentMs, rms });
      }
      return alerting;
    },
  };
}

export function isOwnExtensionPage(sender, extensionId) {
  if (!extensionId || sender?.id !== extensionId || sender.tab) return false;
  return String(sender.url || "").startsWith(`chrome-extension://${extensionId}/`);
}

export function isOwnContentScript(sender, extensionId) {
  return Boolean(extensionId) && sender?.id === extensionId && Number.isInteger(sender.tab?.id);
}

export function isOwnBackend(sender, extensionId) {
  if (!extensionId || sender?.id !== extensionId || sender.tab) return false;
  const url = String(sender.url || "");
  if (!url) return true;
  return url.startsWith(`chrome-extension://${extensionId}/`);
}

export function isOffscreenDocument(sender, extensionId) {
  if (!extensionId || sender?.id !== extensionId || sender.tab) return false;
  try {
    const url = new URL(sender.url || "");
    return url.protocol === "chrome-extension:" && url.hostname === extensionId && url.pathname === "/offscreen.html";
  } catch {
    return false;
  }
}

export function isOtherExtensionPage(sender, extensionId) {
  if (!sender?.id || sender.id === extensionId) return false;
  return String(sender.url || "").startsWith("chrome-extension://");
}
