import assert from "node:assert/strict";
import test from "node:test";
import {
  borderPalette,
  browserUserLabel,
  createSilenceMonitor,
  noiseNoticeText,
  normalizeBorderColors,
  normalizeEdgePx,
  normalizeFlowSpeed,
  normalizeOutputShakeLevel,
  normalizeOutputScope,
  outputShakePixels,
  isOffscreenDocument,
  isOtherExtensionPage,
  isOwnBackend,
  isOwnContentScript,
  isOwnExtensionPage,
  parseProfileName,
  shouldResumePausedHost,
  shouldShowOutputBorder,
  silenceNoticeText,
  thresholdFor,
} from "../silence-monitor.js";

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

test("sustained silence alerts once, then reminds again after the same hold", () => {
  const { monitor, events } = harness();
  monitor.push(0, 11_000);
  monitor.push(0, 14_000);
  monitor.push(0, 16_000);
  monitor.push(0, 17_000);
  assert.equal(monitor.alerting, true);
  assert.deepEqual(events, [
    ["start", 3000],
    ["notify", 6000],
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

test("changing the hold restarts the wait from that moment", () => {
  const { monitor, events } = harness();
  monitor.push(0, 12_000);
  monitor.updateSettings({ threshold: 0.02, silenceMs: 8000, notifyEveryMs: 30000 }, 13_000);
  monitor.push(0, 16_000);
  monitor.push(0, 20_000);
  assert.equal(monitor.alerting, false);
  assert.deepEqual(events, []);
  monitor.push(0, 21_000);
  assert.deepEqual(events, [["start", 8000]]);
});

test("a longer hold clears the current alert and waits the full new time", () => {
  const { monitor, events } = harness();
  monitor.push(0, 11_000);
  monitor.push(0, 14_000);
  monitor.updateSettings({ threshold: 0.02, silenceMs: 8000, notifyEveryMs: 30000 }, 15_000);
  assert.equal(monitor.alerting, false);
  monitor.push(0, 18_000);
  monitor.push(0, 22_000);
  assert.deepEqual(events, [
    ["start", 3000],
    ["end"],
  ]);
  monitor.push(0, 23_000);
  assert.deepEqual(events, [
    ["start", 3000],
    ["end"],
    ["start", 8000],
  ]);
});

test("a shorter hold waits out the new time instead of alerting immediately", () => {
  const { monitor, events } = harness();
  monitor.push(0, 11_000);
  const changed = monitor.updateSettings({ threshold: 0.02, silenceMs: 2000, notifyEveryMs: 30000 }, 14_000);
  assert.equal(changed, false);
  assert.deepEqual(events, []);
  monitor.push(0, 15_000);
  monitor.push(0, 16_000);
  assert.deepEqual(events, [["start", 2000]]);
});

test("notices use the custom browser user name", () => {
  assert.equal(browserUserLabel("审核", 2, 3), "浏览器用户「审核」的窗口 2");
  assert.equal(browserUserLabel("审核", 1, 1), "浏览器用户「审核」");
  assert.equal(browserUserLabel("", 2, 2), "浏览器窗口 2");
  assert.equal(parseProfileName('"审核github"\n'), "审核github");
  assert.equal(parseProfileName('"A\\tB"'), "A B");
  assert.equal(parseProfileName("Preference not found: profile.name"), "");
  assert.equal(parseProfileName(""), "");
});

test("notices name the browser window", () => {
  assert.equal(
    silenceNoticeText({ which: "浏览器窗口 2", page: "会议（meet.example）" }),
    "浏览器窗口 2没有输入声音：会议（meet.example）。点击通知会回到这个窗口。"
  );
  assert.match(silenceNoticeText(null), /没有检测到输入声音/);
  assert.equal(
    noiseNoticeText([{ which: "这个浏览器窗口", page: "歌曲（music.example）" }]),
    "这个浏览器窗口正在出声：歌曲（music.example）。点击通知会回到这个浏览器窗口。"
  );
  assert.match(
    noiseNoticeText([
      { which: "浏览器窗口 1", page: "甲" },
      { which: "浏览器窗口 2", page: "乙" },
      { which: "浏览器窗口 3", page: "丙" },
      { which: "浏览器窗口 4", page: "丁" },
    ]),
    /浏览器窗口 1正在出声：甲。浏览器窗口 2正在出声：乙。浏览器窗口 3正在出声：丙。另有 1 个窗口也在出声/
  );
  assert.equal(noiseNoticeText([]), "");
});

test("sensitivity presets", () => {
  assert.equal(thresholdFor("high"), 0.008);
  assert.equal(thresholdFor("medium"), 0.02);
  assert.equal(thresholdFor("low"), 0.05);
  assert.equal(thresholdFor("nope"), 0.02);
});

test("flow speed is a whole multiple from 1 to 8", () => {
  assert.equal(normalizeFlowSpeed(1), 1);
  assert.equal(normalizeFlowSpeed(8), 8);
  assert.equal(normalizeFlowSpeed(8.6), 8);
  assert.equal(normalizeFlowSpeed(0), 1);
  assert.equal(normalizeFlowSpeed("3.2"), 3);
  assert.equal(normalizeFlowSpeed("很快"), 1);
});

test("output shake level is 1 to 5 and scales the distance", () => {
  assert.equal(normalizeOutputShakeLevel(undefined), 3);
  assert.equal(normalizeOutputShakeLevel(0), 1);
  assert.equal(normalizeOutputShakeLevel(5.4), 5);
  assert.equal(normalizeOutputShakeLevel("2"), 2);
  assert.deepEqual(outputShakePixels(1), { x: 4, y: 3 });
  assert.deepEqual(outputShakePixels(3), { x: 12, y: 9 });
  assert.deepEqual(outputShakePixels(5), { x: 20, y: 15 });
});

test("edge thickness stays an integer from 2 to 32", () => {
  assert.equal(normalizeEdgePx(undefined), 8);
  assert.equal(normalizeEdgePx("nope"), 8);
  assert.equal(normalizeEdgePx(1), 2);
  assert.equal(normalizeEdgePx(8.6), 9);
  assert.equal(normalizeEdgePx(40), 32);
});

test("rainbow is only the exact word, and the last solid color is kept", () => {
  const colors = normalizeBorderColors({
    output: "rainbow",
    outputHex: "#112233",
    input: "Rainbow",
    inputHex: "#445566",
  });
  assert.equal(colors.output, "rainbow");
  assert.equal(colors.outputHex, "#112233");
  assert.equal(colors.input, "#445566");
  assert.equal(colors.outputPalette.rainbow, true);
  assert.deepEqual(colors.outputPalette.stops[0], "#ff2d55");
  assert.equal(colors.inputPalette.rainbow, false);
  assert.equal(borderPalette("rainbow", "#0096c7", "output").rainbow, true);
  assert.equal(borderPalette("#0096c7", "#0096c7", "output").rainbow, false);
});

test("one sounding window lights every window of that site", () => {
  const synced = { enabled: true, audible: false, hostAudible: true, windowAudible: false, active: false, scope: "sync" };
  assert.equal(shouldShowOutputBorder(synced), true);
  assert.equal(shouldShowOutputBorder({ enabled: true, audible: false, hostAudible: false, windowAudible: true, active: true, scope: "sync" }), true);
  assert.equal(shouldShowOutputBorder({ enabled: true, audible: false, hostAudible: false, windowAudible: true, active: false, scope: "sync" }), false);
  assert.equal(shouldShowOutputBorder({ enabled: false, audible: true, hostAudible: true, windowAudible: true, active: true, scope: "sync" }), false);
});

test("per-tab borders ignore other tabs and windows", () => {
  assert.equal(normalizeOutputScope("tab"), "tab");
  assert.equal(normalizeOutputScope("sync"), "sync");
  assert.equal(normalizeOutputScope("browser"), "sync");
  const alone = { enabled: true, audible: false, hostAudible: true, windowAudible: true, active: true, scope: "tab" };
  assert.equal(shouldShowOutputBorder(alone), false);
  assert.equal(shouldShowOutputBorder({ ...alone, audible: true }), true);
  assert.equal(shouldShowOutputBorder({ ...alone, audible: true, enabled: false }), false);
});

test("paused input resumes on a new visit, not the same page refreshing", () => {
  assert.equal(shouldResumePausedHost("www.youtube.com", "www.youtube.com", false), false);
  assert.equal(shouldResumePausedHost("www.google.com", "www.youtube.com", false), true);
  assert.equal(shouldResumePausedHost("", "www.youtube.com", true), true);
  assert.equal(shouldResumePausedHost("", "www.youtube.com", false), false);
  assert.equal(shouldResumePausedHost("www.youtube.com", "", true), false);
});

test("message senders are limited to this extension", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const page = { id, url: `chrome-extension://${id}/popup.html` };
  const content = { id, url: `chrome-extension://${id}/content.js`, tab: { id: 4 } };
  const offscreen = { id, url: `chrome-extension://${id}/offscreen.html?g=2` };
  const other = { id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", url: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/page.html" };
  const web = { id: "", url: "https://example.com/" };
  assert.equal(isOwnExtensionPage(page, id), true);
  assert.equal(isOwnExtensionPage(content, id), false);
  assert.equal(isOwnContentScript(content, id), true);
  assert.equal(isOwnContentScript(page, id), false);
  assert.equal(isOwnBackend({ id }, id), true);
  assert.equal(isOwnBackend(content, id), false);
  assert.equal(isOffscreenDocument(offscreen, id), true);
  assert.equal(isOffscreenDocument(page, id), false);
  assert.equal(isOtherExtensionPage(other, id), true);
  assert.equal(isOtherExtensionPage(web, id), false);
  assert.equal(isOtherExtensionPage(page, id), false);
});
