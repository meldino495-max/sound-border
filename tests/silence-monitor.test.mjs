import assert from "node:assert/strict";
import test from "node:test";
import { createSilenceMonitor, shouldResumePausedHost, thresholdFor } from "../silence-monitor.js";

function harness(overrides = {}) {
  const events = [];
  const monitor = createSilenceMonitor({
    threshold: 0.02,
    silenceMs: 3000,
    notifyEveryMs: 30000,
    now: 10_000,
    onAlertStart(info) {
      events.push(["start", info.silentMs]);
    },
    onAlertEnd() {
      events.push(["end"]);
    },
    onNotify(info) {
      events.push(["notify", info.silentMs]);
    },
    ...overrides,
  });
  return { monitor, events };
}

test("warmup ignores silence and sound", () => {
  const { monitor, events } = harness();
  monitor.push(0, 10_100);
  monitor.push(0.5, 10_700);
  assert.equal(monitor.alerting, false);
  assert.deepEqual(events, []);
});

test("silence shorter than the hold does not alert", () => {
  const { monitor, events } = harness();
  monitor.push(0, 11_000);
  monitor.push(0.001, 13_900);
  assert.equal(monitor.alerting, false);
  assert.deepEqual(events, []);
});

test("sustained silence alerts once, then repeats on the notify interval", () => {
  const { monitor, events } = harness();
  monitor.push(0, 11_000);
  monitor.push(0, 14_000);
  monitor.push(0, 20_000);
  monitor.push(0, 44_000);
  assert.equal(monitor.alerting, true);
  assert.deepEqual(events, [
    ["start", 3000],
    ["notify", 33000],
  ]);
});

test("sound at the threshold clears the alert", () => {
  const { monitor, events } = harness();
  monitor.push(0, 11_000);
  monitor.push(0, 14_000);
  monitor.push(0.02, 15_000);
  assert.equal(monitor.alerting, false);
  assert.deepEqual(events, [
    ["start", 3000],
    ["end"],
  ]);
});

test("a new silence stretch alerts again after sound returns", () => {
  const { monitor, events } = harness();
  monitor.push(0, 11_000);
  monitor.push(0, 14_000);
  monitor.push(0.2, 15_000);
  monitor.push(0, 16_000);
  monitor.push(0, 19_000);
  assert.deepEqual(events, [
    ["start", 3000],
    ["end"],
    ["start", 3000],
  ]);
});

test("changing the hold while quiet restarts the silence clock", () => {
  const { monitor, events } = harness();
  monitor.push(0, 12_000);
  monitor.updateSettings({ threshold: 0.02, silenceMs: 8000, notifyEveryMs: 30000 }, 13_000);
  monitor.push(0, 16_000);
  assert.equal(monitor.alerting, false);
  assert.deepEqual(events, []);
  monitor.push(0, 21_000);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "start");
});

test("sensitivity presets", () => {
  assert.equal(thresholdFor("high"), 0.008);
  assert.equal(thresholdFor("medium"), 0.02);
  assert.equal(thresholdFor("low"), 0.05);
  assert.equal(thresholdFor("nope"), 0.02);
});

test("paused input resumes on a new visit, not the same page refreshing", () => {
  assert.equal(shouldResumePausedHost("www.youtube.com", "www.youtube.com", false), false);
  assert.equal(shouldResumePausedHost("www.google.com", "www.youtube.com", false), true);
  assert.equal(shouldResumePausedHost("", "www.youtube.com", true), true);
  assert.equal(shouldResumePausedHost("", "www.youtube.com", false), false);
  assert.equal(shouldResumePausedHost("www.youtube.com", "", true), false);
});
