// sherry: optional online voice engine via the Gemini Live API (WebSocket).
// When GEMINI_API_KEY is set and SHERRY_STT/SHERRY_TTS select "live", this
// replaces the local whisper.cpp / Piper engines. The key stays server-side;
// it is never sent to the browser. Zero npm deps.
//
// Wire protocol (v1beta, camelCase), verified against the public Live API:
//   wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=KEY
//   -> { setup: { model, generationConfig, ... } } ; wait for { setupComplete: {} }
//   STT: { realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data } } }
//        ... { realtimeInput: { audioStreamEnd: true } }
//        <- { serverContent: { inputTranscription: { text }, turnComplete } }
//   TTS: { clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }
//        <- { serverContent: { modelTurn: { parts: [{ inlineData: { data } }] }, turnComplete } }
// Audio out is 16-bit PCM mono at 24kHz.

const LIVE_WSS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const TRANSCRIBE_INSTRUCTION =
  "You are a precise speech transcription engine. Output only the exact words " +
  "spoken by the user, with no commentary, no preamble, and no extra punctuation " +
  "beyond what was spoken.";

export function liveModel(): string {
  return process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
}

export function liveVoice(): string {
  return process.env.GEMINI_LIVE_VOICE || "Kore";
}

export function liveAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

export function sttEngine(): "local" | "live" {
  return process.env.SHERRY_STT === "live" ? "live" : "local";
}

export function ttsEngine(): "local" | "live" {
  return process.env.SHERRY_TTS === "live" ? "live" : "local";
}

/** Public status for GET /api/live/status. Never exposes the key. */
export function getLiveStatus(): {
  available: boolean;
  model: string;
  voice: string;
  stt: "local" | "live";
  tts: "local" | "live";
} {
  return {
    available: liveAvailable(),
    model: liveModel(),
    voice: liveVoice(),
    stt: sttEngine(),
    tts: ttsEngine(),
  };
}

function modelPath(): string {
  const m = liveModel().trim();
  return m.includes("/") ? m : `models/${m}`;
}

interface LiveChannel {
  send(obj: any): void;
  next(): Promise<any>;
  close(): void;
}

/**
 * Open a Live session, wait for setupComplete, run fn, then close.
 * Exactly one session per call — no shared state, no reconnect logic.
 */
async function withLiveSession<T>(
  setup: any,
  fn: (ch: LiveChannel) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Gemini Live not configured — set GEMINI_API_KEY");
  const base = (process.env.GEMINI_LIVE_URL || LIVE_WSS).replace(/\/$/, "");
  const url = `${base}?key=${encodeURIComponent(key)}`;
  return await new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn2: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn2();
    };
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      finish(() => reject(new Error("Gemini Live timed out")));
    }, timeoutMs);

    const queue: any[] = [];
    let waiter: ((m: any) => void) | null = null;
    const ws = new WebSocket(url);
    const ch: LiveChannel = {
      send: (o: any) => ws.send(JSON.stringify(o)),
      next: () =>
        new Promise<any>((res) => {
          const m = queue.shift();
          if (m !== undefined) res(m);
          else waiter = res;
        }),
      close: () => {
        try { ws.close(); } catch { /* noop */ }
      },
    };
    ws.onopen = () => ch.send({ setup });
    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(m);
      } else queue.push(m);
    };
    ws.onerror = () => finish(() => reject(new Error("Gemini Live connection failed")));
    ws.onclose = (ev: any) =>
      finish(() => reject(new Error(`Gemini Live closed unexpectedly (code ${ev?.code ?? "?"})`)));

    (async () => {
      try {
        for (;;) {
          const m = await ch.next();
          if (m.setupComplete) break;
          if (m.error) throw new Error(`Gemini Live: ${m.error.message || JSON.stringify(m.error)}`);
        }
        const out = await fn(ch);
        ch.close();
        finish(() => resolve(out));
      } catch (e: any) {
        try { ch.close(); } catch { /* noop */ }
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    })();
  });
}

/**
 * Transcribe 16kHz mono PCM16 bytes via a TEXT-modality Live session.
 * Returns the transcript (possibly empty).
 */
export async function transcribeLive(pcm: Uint8Array, timeoutMs = 45000): Promise<string> {
  return withLiveSession(
    {
      model: modelPath(),
      generationConfig: { responseModalities: ["TEXT"] },
      systemInstruction: { parts: [{ text: TRANSCRIBE_INSTRUCTION }] },
      inputAudioTranscription: {},
    },
    async (ch) => {
      const CHUNK = 64000;
      for (let o = 0; o < pcm.length; o += CHUNK) {
        ch.send({
          realtimeInput: {
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: Buffer.from(pcm.subarray(o, o + CHUNK)).toString("base64"),
            },
          },
        });
      }
      ch.send({ realtimeInput: { audioStreamEnd: true } });
      let text = "";
      for (;;) {
        const m = await ch.next();
        const sc = m.serverContent;
        if (!sc) continue;
        if (sc.inputTranscription?.text) text += sc.inputTranscription.text;
        // Fallback: some models answer with a text turn instead of (or in
        // addition to) inputTranscription — take it only if we have nothing.
        if (!text && Array.isArray(sc.modelTurn?.parts)) {
          for (const p of sc.modelTurn.parts) if (typeof p.text === "string") text += p.text;
        }
        if (sc.turnComplete) break;
      }
      return text.trim();
    },
    timeoutMs
  );
}

/**
 * Speak text via an AUDIO-modality Live session.
 * Returns 16-bit PCM mono at 24kHz.
 */
export async function speakLive(
  text: string,
  timeoutMs = 30000
): Promise<{ pcm: Uint8Array; sampleRate: number }> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!clean) throw new Error("nothing to say");
  const pcm = await withLiveSession(
    {
      model: modelPath(),
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: liveVoice() } } },
      },
    },
    async (ch) => {
      ch.send({
        clientContent: { turns: [{ role: "user", parts: [{ text: clean }] }], turnComplete: true },
      });
      const chunks: Uint8Array[] = [];
      for (;;) {
        const m = await ch.next();
        const sc = m.serverContent;
        if (!sc) continue;
        for (const p of sc.modelTurn?.parts || []) {
          if (typeof p.inlineData?.data === "string") chunks.push(Buffer.from(p.inlineData.data, "base64"));
        }
        if (sc.turnComplete) break;
      }
      const total = chunks.reduce((a, c) => a + c.length, 0);
      if (!total) throw new Error("Gemini Live returned no audio");
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      return out;
    },
    timeoutMs
  );
  return { pcm, sampleRate: 24000 };
}

/** Encode raw PCM16 mono bytes as a WAV buffer. */
export function encodeWavPcm(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const n = pcm.length / 2;
  const buf = new ArrayBuffer(44 + pcm.length);
  const v = new DataView(buf);
  const wstr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data");
  v.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/**
 * Extract raw PCM16 bytes from a WAV buffer (locates the data chunk rather
 * than assuming a fixed header size).
 */
export function extractPcm16(wav: Uint8Array): Uint8Array {
  for (let i = 0; i + 8 <= wav.length; i++) {
    if (wav[i] === 0x64 && wav[i + 1] === 0x61 && wav[i + 2] === 0x74 && wav[i + 3] === 0x61) {
      const size = new DataView(wav.buffer, wav.byteOffset + i + 4, 4).getUint32(0, true);
      return wav.subarray(i + 8, i + 8 + size);
    }
  }
  throw new Error("no data chunk in WAV");
}
