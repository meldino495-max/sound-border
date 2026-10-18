export const DEFAULTS = {
  outputEnabled: true,
  inputEnabled: false,
  sensitivity: "medium",
  silenceMs: 3000,
};

export const NOTIFY_EVERY_MS = 30000;
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
  notifyEveryMs,
  onAlertStart,
  onAlertEnd,
  onNotify,
  now = Date.now(),
}) {
  let level = threshold;
  let holdMs = silenceMs;
  let repeatMs = notifyEveryMs;
  let origin = now;
  let silentSince = null;
  let alerting = false;
  let lastNotify = 0;

  return {
    get alerting() {
      return alerting;
    },
    updateSettings(next, at = Date.now()) {
      const changed = next.threshold !== level || next.silenceMs !== holdMs;
      level = next.threshold;
      holdMs = next.silenceMs;
      repeatMs = next.notifyEveryMs;
      if (changed && !alerting && silentSince != null) silentSince = at;
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
      if (at - lastNotify >= repeatMs) {
        lastNotify = at;
        onNotify({ silentMs, rms });
      }
      return alerting;
    },
  };
}
