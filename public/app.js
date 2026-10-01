/* sherry client: push-to-talk capture (16kHz mono, VAD auto-stop),
   WAV upload -> /api/hear, spoken replies via speechSynthesis. */
"use strict";

const $ = (id) => document.getElementById(id);
const mic = $("mic"), statusEl = $("status"), logEl = $("log");
const SILENCE_MS = 1200;      // auto-stop after this much quiet
const MAX_MS = 30000;         // hard cap per utterance
const RMS_QUIET = 0.015;      // below this counts as silence

const WORKLET_SRC = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const c = new Float32Array(ch);
      this.buf.push(c); this.n += c.length;
      if (this.n >= 4096) {
        let total = 0;
        for (const b of this.buf) total += b.length;
        const out = new Float32Array(total);
        let o = 0;
        for (const b of this.buf) { out.set(b, o); o += b.length; }
        this.port.postMessage(out, [out.buffer]);
        this.buf = []; this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("sherry-capture", Capture);
`;

let rec = null; // active recording state or null

function setStatus(t) { statusEl.innerHTML = t; }

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  const voices = speechSynthesis.getVoices();
  const pick = voices.find((v) => v.lang && v.lang.startsWith("en") && /natural|neural|samantha|google us english/i.test(v.name))
    || voices.find((v) => v.lang && v.lang.startsWith("en"));
  if (pick) u.voice = pick;
  u.onstart = () => setStatus("Speaking… <span style='color:var(--muted);font-size:13px'>(hold the mic to interrupt)</span>");
  u.onend = () => { if (!rec) setStatus(defaultPrompt()); };
  speechSynthesis.speak(u);
}
if ("speechSynthesis" in window) speechSynthesis.getVoices();

function defaultPrompt() {
  return 'Hold the mic — or hold <kbd>space</kbd> — and talk';
}

function addTurn(heard, said, intent) {
  $("urgent-dot").hidden = true; // acknowledged by engaging
  const li = document.createElement("li");
  li.className = "turn";
  const h = document.createElement("p");
  h.className = "heard";
  h.textContent = heard;
  const s = document.createElement("p");
  s.className = "said";
  s.textContent = said;
  li.append(h, s);
  if (intent) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = intent;
    li.append(meta);
  }
  logEl.prepend(li);
}

function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); wstr(8, "WAVE");
  wstr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function startRec() {
  if (rec) return;
  if ("speechSynthesis" in window) speechSynthesis.cancel(); // barge-in
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch (e) {
    setStatus("Microphone blocked — allow mic access and try again.");
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 16000 });
  if (ctx.state === "suspended") await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
  await ctx.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);
  const node = new AudioWorkletNode(ctx, "sherry-capture");

  const chunks = [];
  let lastLoud = performance.now();
  const startedAt = performance.now();
  let stopped = false;

  rec = { ctx, stream, node, stop: null };
  mic.classList.add("listening");
  setStatus("Listening…");

  const finish = async () => {
    if (stopped) return;
    stopped = true;
    rec = null;
    mic.classList.remove("listening");
    try { node.disconnect(); } catch {}
    try { await ctx.close(); } catch {}
    stream.getTracks().forEach((t) => t.stop());
    const total = chunks.reduce((a, c) => a + c.length, 0);
    if (total < 1600) { // <100ms: accidental tap
      setStatus(defaultPrompt());
      return;
    }
    const flat = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { flat.set(c, o); o += c.length; }
    await sendUtterance(encodeWav(flat, ctx.sampleRate));
  };
  rec.stop = finish;

  node.port.onmessage = (ev) => {
    const block = ev.data;
    chunks.push(block);
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    const now = performance.now();
    if (rms >= RMS_QUIET) lastLoud = now;
    if (now - lastLoud > SILENCE_MS || now - startedAt > MAX_MS) finish();
  };
  src.connect(node);
}

async function sendUtterance(wavBlob) {
  setStatus("Transcribing…");
  const form = new FormData();
  form.append("audio", wavBlob, "utterance.wav");
  let data;
  try {
    const r = await fetch("/api/hear", { method: "POST", body: form });
    data = await r.json();
  } catch (e) {
    setStatus("Couldn't reach Sherry's server. " + defaultPrompt());
    return;
  }
  if (data.error && !data.speech) {
    setStatus("Hmm — " + data.error + ". " + defaultPrompt());
    return;
  }
  addTurn(data.transcript || "(silence)", data.speech || "", data.intent);
  setStatus(defaultPrompt());
  if (data.speech) speak(data.speech);
}

// --- input wiring: press-and-hold on mic, hold space ---

let spaceDown = false;
mic.addEventListener("pointerdown", (e) => { e.preventDefault(); startRec(); });
window.addEventListener("pointerup", () => { if (rec && rec.stop) rec.stop(); });
window.addEventListener("pointercancel", () => { if (rec && rec.stop) rec.stop(); });
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !spaceDown && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    spaceDown = true;
    e.preventDefault();
    startRec();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    spaceDown = false;
    if (rec && rec.stop) rec.stop();
  }
});

// --- urgent chime: two low soft tones in succession ---
// Fired by the server over SSE when Switchboard reports a new urgent item.
// No spoken content — the user asks "what was that?" to hear it.
let chimeCtx = null;
function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    chimeCtx = chimeCtx || new AC();
    if (chimeCtx.state === "suspended") chimeCtx.resume();
    const t0 = chimeCtx.currentTime + 0.05;
    for (let i = 0; i < 2; i++) {
      const osc = chimeCtx.createOscillator();
      const gain = chimeCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = 330; // low E — soft, unobtrusive
      const start = t0 + i * 0.5;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.16, start + 0.07); // gentle attack
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42); // soft decay
      osc.connect(gain);
      gain.connect(chimeCtx.destination);
      osc.start(start);
      osc.stop(start + 0.46);
    }
  } catch (e) { /* audio unavailable — the dot still shows */ }
  $("urgent-dot").hidden = false;
}

function watchEvents() {
  let es;
  try {
    es = new EventSource("/api/events");
  } catch (e) {
    return;
  }
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "urgent") chime();
  };
  // onerror: the browser reconnects automatically; nothing to do.
}

// --- integrations status ---

async function refreshIntegrations() {
  let list = [];
  try {
    const r = await fetch("/api/integrations");
    list = (await r.json()).integrations || [];
  } catch { /* leave empty */ }
  const wrap = $("integrations");
  wrap.innerHTML = "";
  const short = { "Daily Briefing": "Briefing", "Ascent": "Ascent", "Relay": "Relay", "Switchboard": "Switchboard" };
  for (const it of list) {
    const chip = document.createElement("span");
    chip.className = "chip " + (it.reachable ? "on" : "off");
    chip.title = it.url + (it.ms != null ? ` — ${it.ms}ms` : "");
    const dot = document.createElement("span");
    dot.className = "dot";
    chip.append(dot, document.createTextNode(short[it.name] || it.name));
    wrap.append(chip);
  }
}

// --- stt status + history ---

async function boot() {
  try {
    const r = await fetch("/api/stt/status");
    const s = await r.json();
    $("stt-note").textContent = s.available
      ? `offline transcription ready (${s.model})`
      : "transcription not set up — run scripts/setup-stt.sh";
  } catch {
    $("stt-note").textContent = "";
  }
  try {
    const r = await fetch("/api/log?limit=10");
    const { entries } = await r.json();
    for (const e of (entries || []).reverse()) addTurn(e.transcript, e.speech, e.intent);
  } catch { /* ignore */ }
  refreshIntegrations();
  setInterval(refreshIntegrations, 30000);
  watchEvents();
}

// --- type-instead fallback ---

$("text-toggle").addEventListener("click", () => {
  const f = $("textform");
  f.hidden = !f.hidden;
  if (!f.hidden) $("textinput").focus();
});
$("textform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("textinput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  setStatus("Thinking…");
  try {
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await r.json();
    addTurn(data.transcript || text, data.speech || data.error || "", data.intent);
    if (data.speech) speak(data.speech);
  } catch {
    addTurn(text, "Couldn't reach Sherry's server.", "");
  }
  setStatus(defaultPrompt());
});

boot();
