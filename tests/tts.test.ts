// sherry: tts unit tests — fake piper binary, no real synthesis.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ttsPaths, isTtsAvailable, getTtsStatus, synthesize } from "../src/tts";

const savedEnv: Record<string, string | undefined> = {};

function saveEnv() {
  for (const k of ["PIPER_BIN", "PIPER_VOICE"]) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ["PIPER_BIN", "PIPER_VOICE"]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

/** A minimal valid WAV: 0.1s of silence, 22050Hz mono 16-bit. */
function tinyWav(): Uint8Array {
  const n = 2205;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const wstr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); wstr(8, "WAVE");
  wstr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 22050, true);
  v.setUint32(28, 44100, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, "data"); v.setUint32(40, n * 2, true);
  return new Uint8Array(buf);
}

let dir = "";
let fakeWav = "";

beforeEach(() => {
  saveEnv();
  dir = mkdtempSync(join(tmpdir(), "sherry-tts-"));
  mkdirSync(join(dir, "piper"), { recursive: true });
  fakeWav = join(dir, "fake.wav");
  writeFileSync(fakeWav, tinyWav());
  // Fake piper: copies $FAKE_WAV to --output_file, consumes stdin.
  const fakeBin = join(dir, "fake-piper");
  writeFileSync(fakeBin, `#!/bin/sh
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--output_file" ]; then out="$a"; fi
  prev="$a"
done
cat > /dev/null
cp "$FAKE_WAV" "$out"
`);
  chmodSync(fakeBin, 0o755);
  process.env.FAKE_WAV = fakeWav;
  process.env.PIPER_BIN = fakeBin;
  process.env.PIPER_VOICE = "test-voice";
  writeFileSync(join(dir, "piper", "test-voice.onnx"), "fake");
  writeFileSync(join(dir, "piper", "test-voice.onnx.json"), "{}");
});

afterEach(() => { restoreEnv(); });

describe("tts", () => {
  test("paths honor env", () => {
    const p = ttsPaths(dir);
    expect(p.voiceName).toBe("test-voice");
    expect(p.voice.endsWith("test-voice.onnx")).toBe(true);
  });

  test("unavailable without voice files", () => {
    delete process.env.PIPER_BIN;
    delete process.env.PIPER_VOICE;
    expect(isTtsAvailable(dir)).toBe(false);
    const s = getTtsStatus(dir);
    expect(s.available).toBe(false);
    expect(s.voice).toBe("en_US-amy-medium"); // default voice name
  });

  test("available with fake engine", () => {
    expect(isTtsAvailable(dir)).toBe(true);
    expect(getTtsStatus(dir)).toEqual({ available: true, voice: "test-voice" });
  });

  test("synthesize returns valid wav bytes", async () => {
    const wav = await synthesize(dir, "hello there");
    expect(wav.length).toBeGreaterThan(44);
    // RIFF....WAVE header
    expect([wav[0], wav[1], wav[2], wav[3]]).toEqual([0x52, 0x49, 0x46, 0x46]);
  });

  test("synthesize rejects empty text", async () => {
    await expect(synthesize(dir, "   ")).rejects.toThrow(/nothing to say/);
  });

  test("synthesize throws when engine missing", async () => {
    delete process.env.PIPER_BIN;
    await expect(synthesize(dir, "hi")).rejects.toThrow(/not set up/);
  });

  test("synthesize throws when piper exits nonzero", async () => {
    const bad = join(dir, "bad-piper");
    writeFileSync(bad, "#!/bin/sh\nexit 3\n");
    chmodSync(bad, 0o755);
    process.env.PIPER_BIN = bad;
    await expect(synthesize(dir, "hi")).rejects.toThrow(/code 3/);
  });
});
