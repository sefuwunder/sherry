#!/bin/sh
# sherry: set up offline neural voice (Piper TTS + voice model).
# Idempotent — safe to re-run. Everything lands under data/ (gitignored).
# Env overrides: PIPER_VOICE (default en_US-amy-medium),
#                PIPER_RELEASE (default v1.2.0),
#                PIPER_BIN (skip install entirely; src/tts.ts uses this env directly).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDIR="$ROOT/data/piper"
VOICE="${PIPER_VOICE:-en_US-amy-medium}"
RELEASE="${PIPER_RELEASE:-v1.2.0}"
BIN="$WDIR/piper"

mkdir -p "$WDIR"

# ---------- 1. piper binary ----------
if [ -x "$BIN" ]; then
  echo "binary present: $BIN"
else
  ARCH="$(uname -m)"
  OS="$(uname -s)"
  # NOTE: v1.2.0 renamed the assets (piper_amd64.tar.gz, not piper_linux_x86_64.tar.gz).
  if [ "$OS" = "Linux" ]; then
    case "$ARCH" in
      x86_64)  ASSET="piper_amd64.tar.gz" ;;
      aarch64)  ASSET="piper_arm64.tar.gz" ;;
      *)       ASSET="" ;;
    esac
  else
    ASSET=""
  fi

  if [ -n "$ASSET" ]; then
    URL="https://github.com/rhasspy/piper/releases/download/${RELEASE}/${ASSET}"
    echo "downloading prebuilt: $ASSET (release $RELEASE)"
    if curl -fSL --max-time 300 -o "$WDIR/$ASSET" "$URL" 2>/dev/null; then
      PKG="$WDIR/pkg"
      rm -rf "$PKG"
      mkdir -p "$PKG"
      tar -xzf "$WDIR/$ASSET" -C "$PKG"
      rm -f "$WDIR/$ASSET"
      FOUND="$(find "$PKG" -maxdepth 3 -type f -name 'piper' | head -1 || true)"
      if [ -n "$FOUND" ]; then
        ln -sf "$FOUND" "$BIN"
        chmod +x "$FOUND"
        echo "installed prebuilt binary: $BIN -> $FOUND"
      else
        echo "ERROR: piper binary not found inside $ASSET" >&2
        exit 1
      fi
    else
      echo "ERROR: prebuilt download failed (release $RELEASE may be gone)." >&2
      echo "Set PIPER_BIN=/path/to/piper to use your own build, then re-run." >&2
      exit 1
    fi
  else
    echo "ERROR: no prebuilt piper for $OS/$ARCH." >&2
    echo "Set PIPER_BIN=/path/to/piper to use your own build, then re-run." >&2
    exit 1
  fi
fi

# ---------- 2. voice model ----------
# Voices live at huggingface.co/rhasspy/piper-voices:
#   en/en_US/<name>/<quality>/en_US-<name>-<quality>.onnx (+ .onnx.json)
NAME="$(printf '%s' "$VOICE" | cut -d- -f2)"
QUALITY="$(printf '%s' "$VOICE" | cut -d- -f3)"
LOCALE="$(printf '%s' "$VOICE" | cut -d- -f1)"
LANG="$(printf '%s' "$LOCALE" | cut -d_ -f1)"
if [ -f "$WDIR/$VOICE.onnx" ] && [ -f "$WDIR/$VOICE.onnx.json" ]; then
  echo "voice present: $WDIR/$VOICE.onnx"
else
  BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
  echo "downloading voice $VOICE (~60MB)…"
  curl -fSL --max-time 1200 \
    -o "$WDIR/$VOICE.onnx" \
    "$BASE/$LANG/$LOCALE/$NAME/$QUALITY/$VOICE.onnx"
  curl -fSL --max-time 300 \
    -o "$WDIR/$VOICE.onnx.json" \
    "$BASE/$LANG/$LOCALE/$NAME/$QUALITY/$VOICE.onnx.json"
  echo "voice saved: $WDIR/$VOICE.onnx"
fi

# sanity: synthesize a real utterance end to end
if ! printf 'voice check' | "$BIN" --model "$WDIR/$VOICE.onnx" --output_file "$WDIR/test.wav" >/dev/null 2>&1; then
  echo "ERROR: piper could not synthesize (binary or voice broken)." >&2
  echo "Try deleting data/piper and re-running this script." >&2
  exit 1
fi
rm -f "$WDIR/test.wav"

echo "OK — neural voice ready."
echo "Binary: $BIN"
echo "Voice:  $WDIR/$VOICE.onnx"
echo "Swap voices any time: PIPER_VOICE=en_US-lessac-medium sh scripts/setup-tts.sh"
