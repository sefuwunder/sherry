// Gemini Live voice engine: protocol + wiring, against a stub Live server.
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  liveAvailable,
  getLiveStatus,
  transcribeLive,
  speakLive,
  encodeWavPcm,
  extractPcm16,
} from "../src/live";

const ENV_KEYS = ["GEMINI_API_KEY", "GEMINI_LIVE_MODEL", "GEMINI_LIVE_VOICE", "GEMINI_LIVE_URL", "SHERRY_STT", "SHERRY_TTS"];
let baseline: Record<string, string | undefined> = {};
function restoreEnv(from: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    const v = from[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
afterEach(() => restoreEnv(baseline));

// --- stub Live API server ---

const seen: { setup?: any; audioBytes: number; gotStreamEnd: boolean; ttsText?: string } = {
  audioBytes: 0,
  gotStreamEnd: false,
};

function sinePcm16(samples: number, sampleRate: number, freq = 440): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    v.setInt16(i * 2, Math.round(s * 16000), true);
  }
  return out;
}

const stub = Bun.serve({
  port: 0,
  websocket: {
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      if (m.setup) {
        seen.setup = m.setup;
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (m.realtimeInput?.audio?.data) {
        seen.audioBytes += Buffer.from(m.realtimeInput.audio.data, "base64").length;
        return;
      }
      if (m.realtimeInput?.audioStreamEnd) {
        seen.gotStreamEnd = true;
        ws.send(JSON.stringify({
          serverContent: { inputTranscription: { text: "hello world" }, turnComplete: true },
        }));
        return;
      }
      if (m.clientContent) {
        seen.ttsText = m.clientContent.turns?.[0]?.parts?.[0]?.text;
        const pcm = sinePcm16(2400, 24000); // 0.1s of tone
        ws.send(JSON.stringify({
          serverContent: {
            modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from(pcm).toString("base64") } }] },
          },
        }));
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
        return;
      }
    },
  },
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined as any;
    return new Response("no", { status: 400 });
  },
});

beforeAll(() => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_LIVE_URL = `ws://127.0.0.1:${stub.port}`;
  delete process.env.GEMINI_LIVE_MODEL;
  delete process.env.GEMINI_LIVE_VOICE;
  for (const k of ENV_KEYS) baseline[k] = process.env[k];
});
afterAll(() => stub.stop(true));

function resetSeen() {
  seen.setup = undefined;
  seen.audioBytes = 0;
  seen.gotStreamEnd = false;
  seen.ttsText = undefined;
}
beforeEach(resetSeen);

describe("live status", () => {
  test("unavailable without a key", () => {
    delete process.env.GEMINI_API_KEY;
    expect(liveAvailable()).toBe(false);
    expect(getLiveStatus().available).toBe(false);
  });

  test("reports model, voice, and engine selection", () => {
    const s = getLiveStatus();
    expect(s.available).toBe(true);
    expect(s.model).toBe("gemini-3.8-live");
    expect(s.voice).toBe("Kore");
    expect(s.stt).toBe("local");
    expect(s.tts).toBe("local");
    process.env.SHERRY_STT = "live";
    process.env.SHERRY_TTS = "live";
    expect(getLiveStatus().stt).toBe("live");
    expect(getLiveStatus().tts).toBe("live");
  });
});

describe("transcribeLive", () => {
  test("streams pcm and returns the transcript", async () => {
    const pcm = sinePcm16(16000, 16000); // 1s of tone
    const text = await transcribeLive(pcm, 10000);
    expect(text).toBe("hello world");
    expect(seen.audioBytes).toBe(32000);
    expect(seen.gotStreamEnd).toBe(true);
  });

  test("setup uses TEXT modality with transcription enabled", async () => {
    await transcribeLive(sinePcm16(1600, 16000), 10000);
    expect(seen.setup.model).toBe("models/gemini-3.8-live");
    expect(seen.setup.generationConfig.responseModalities).toEqual(["TEXT"]);
    expect(seen.setup.inputAudioTranscription).toBeDefined();
  });

  test("throws without a key", async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(transcribeLive(new Uint8Array(320))).rejects.toThrow(/GEMINI_API_KEY/);
  });
});

describe("speakLive", () => {
  test("returns 24kHz pcm audio", async () => {
    const { pcm, sampleRate } = await speakLive("hello there", 10000);
    expect(sampleRate).toBe(24000);
    expect(pcm.length).toBe(4800);
    expect(seen.ttsText).toBe("hello there");
  });

  test("setup uses AUDIO modality with the configured voice", async () => {
    process.env.GEMINI_LIVE_VOICE = "Aoede";
    await speakLive("hi", 10000);
    expect(seen.setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(seen.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Aoede");
  });
});

describe("wav helpers", () => {
  test("encodeWavPcm writes a valid 24kHz wav", () => {
    const pcm = sinePcm16(2400, 24000);
    const wav = encodeWavPcm(pcm, 24000);
    expect(wav.length).toBe(44 + 4800);
    const t = (o: number, s: string) => String.fromCharCode(...wav.subarray(o, o + s.length)) === s;
    expect(t(0, "RIFF")).toBe(true);
    expect(t(8, "WAVE")).toBe(true);
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(24000);
  });

  test("extractPcm16 strips the wav header", () => {
    const pcm = sinePcm16(2400, 24000);
    const wav = encodeWavPcm(pcm, 24000);
    const back = extractPcm16(wav);
    expect(back.length).toBe(pcm.length);
    expect(Buffer.from(back).equals(Buffer.from(pcm))).toBe(true);
  });
});
