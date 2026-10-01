// sherry: server-side offline speech synthesis via Piper.
// Native binary, CPU, fully local. Zero npm deps.
// Setup via scripts/setup-tts.sh. Pattern shared with src/stt.ts.
import { join, basename } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { isValidWav } from "./stt";

export interface TtsPaths {
  bin: string;
  voice: string;
  voiceName: string;
}

/** Resolve binary + voice locations. Env overrides (read per call, so tests
 *  can point at fakes): PIPER_BIN, PIPER_VOICE (voice name, files live under
 *  data/piper/). */
export function ttsPaths(dataDir: string): TtsPaths {
  const bin = process.env.PIPER_BIN || join(dataDir, "piper", "piper");
  const voiceName = process.env.PIPER_VOICE || "en_GB-jenny_dioco-medium";
  const voice = join(dataDir, "piper", `${voiceName}.onnx`);
  return { bin, voice, voiceName };
}

/** True when the binary is executable and the voice model + config exist. */
export function isTtsAvailable(dataDir: string): boolean {
  const { bin, voice } = ttsPaths(dataDir);
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    return false;
  }
  return existsSync(voice) && existsSync(voice + ".json");
}

/** Public status for GET /api/tts/status. Never exposes paths. */
export function getTtsStatus(dataDir: string): { available: boolean; voice: string } {
  const { voiceName } = ttsPaths(dataDir);
  return { available: isTtsAvailable(dataDir), voice: voiceName };
}

const MAX_CHARS = 1000;

/**
 * Synthesize text to a WAV buffer (22050Hz mono for stock Piper voices).
 * Returns the raw WAV bytes. Throws on missing engine, non-zero exit, or
 * timeout. Piper reads the text from stdin; the WAV lands in a temp dir.
 */
export async function synthesize(
  dataDir: string,
  text: string,
  timeoutMs = 30 * 1000
): Promise<Uint8Array> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  if (!clean) throw new Error("nothing to say");
  const { bin, voice } = ttsPaths(dataDir);
  if (!isTtsAvailable(dataDir)) {
    throw new Error("voice not set up — run scripts/setup-tts.sh");
  }
  const tmpDir = mkdtempSync(join(tmpdir(), "sherry-tts-"));
  const outPath = join(tmpDir, "out.wav");
  // NOTE: env is passed explicitly — Bun.spawn does not pick up
  // runtime mutations of process.env on its own.
  const proc = Bun.spawn([bin, "--model", voice, "--output_file", outPath], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  try {
    proc.stdin.write(clean);
    proc.stdin.end();
    const code = await proc.exited;
    if (timedOut) throw new Error("synthesis timed out");
    if (code !== 0) throw new Error(`piper exited with code ${code}`);
    let wav: Uint8Array;
    try {
      wav = new Uint8Array(readFileSync(outPath));
    } catch {
      throw new Error("piper produced no audio output");
    }
    if (!isValidWav(wav)) throw new Error("piper produced invalid audio");
    return wav;
  } finally {
    clearTimeout(killer);
    try {
      proc.kill();
    } catch {
      /* noop */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
