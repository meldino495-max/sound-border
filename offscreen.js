const TICK_MS = 500;
const generation = Number(new URLSearchParams(location.search).get("g")) || 0;

let audioContext = null;
let stream = null;
let timer = null;

function rmsOf(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = (buffer[i] - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / buffer.length);
}

let port = null;

function post(message) {
  try {
    if (!port) {
      port = chrome.runtime.connect({ name: "mic" });
      port.onDisconnect.addListener(() => {
        port = null;
      });
    }
    port.postMessage(message);
  } catch {
    port = null;
  }
}

function reportError(error) {
  const name = error && error.name ? error.name : "Error";
  const message = error && error.message ? error.message : String(error);
  post({ type: "mic-error", name, message, generation });
}

async function start() {
  if (timer) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);
    timer = setInterval(() => {
      analyser.getByteTimeDomainData(buffer);
      post({ type: "mic-level", rms: rmsOf(buffer), generation });
    }, TICK_MS);
  } catch (error) {
    reportError(error);
  }
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  stream = null;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "offscreen-stop") stop();
});

start();
