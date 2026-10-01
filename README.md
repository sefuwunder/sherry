# Sherry — voice-first desktop agent

Hold the mic (or hold <kbd>space</kbd>) and talk. Sherry transcribes offline,
routes the command deterministically, and speaks the answer back.

**Plugs into** (all optional — whatever's running lights up green):

| Say | App |
|---|---|
| “brief me” | Daily Briefing — weather, tasks, headlines, mood, read aloud |
| “what's on my plate” | Ascent — today's tasks across projects |
| “add task buy milk to Groceries” | Ascent — creates the task |
| “message Shy I'll be late” | Relay — stages the message, reads it back, **“yes” sends** |
| “any new messages” | Relay — unread conversations |
| “what's new” | Switchboard — spoken triage digest (see below) |
| “mute GitHub for today” / “unmute GitHub” | Switchboard — channel-level mute |

### Switchboard: the honest integration

Sherry consumes Switchboard's attention model instead of reimplementing it:

- **Triage loop, not a monologue.** "What's new" opens a digest and reads items
  one at a time — say **next**, **snooze** (optionally "for 10 minutes"),
  **dismiss**, or **stop** per item.
- **Routing-aware.** Muted, disabled, and channel-snoozed channels are excluded,
  so the spoken digest agrees with the dashboard on what "new" means.
- **Quiet-hours-aware.** During Switchboard's quiet hours only urgent items
  surface (when urgent breaks through); otherwise she says it's quiet hours
  and stays quiet. No backdoor around your own attention policy.
- **Urgent chime.** A background watcher polls Switchboard; a *new* urgent
  notification plays **two low soft tones** in the browser — no spoken content.
  Ask **"what was that?"** to hear it. The chime fires once per item, never
  repeats, and stays silent during quiet hours unless urgent breaks through.
- **Channel-level voice commands.** "Mute GitHub for today" / "for 2 hours" /
  "unmute GitHub" — broad strokes are what voice is good at.

## Run

```sh
bun src/server.ts            # http://127.0.0.1:3014 (PORT to override)
```

First run for voice:

```sh
sh scripts/setup-stt.sh      # whisper.cpp + model under data/ (gitignored)
sh scripts/setup-tts.sh      # piper + neural voice under data/ (gitignored)
```

Without them, the type-instead box still works and `/api/ask` answers text
(spoken replies fall back to the browser's built-in voice).

## Wiring

Base URLs, localhost defaults, override with env:

- `BRIEFING_URL` (default `http://127.0.0.1:3000`), `BRIEFING_CITY` (default `Cincinnati`)
- `ASCENT_URL` (default `http://127.0.0.1:3004`)
- `RELAY_URL` (default `http://127.0.0.1:3006`)
- `SWITCHBOARD_URL` (default `http://127.0.0.1:3002`)

`/api/integrations` reports reachability; the header shows a dot per app.

## Voice pipeline

1. Browser captures 16 kHz mono via AudioWorklet, VAD auto-stops after ~1.2 s
   of silence (30 s hard cap), encodes WAV, POSTs to `/api/hear`.
2. Server transcribes with local whisper.cpp (nothing leaves the machine).
3. `src/router.ts` classifies the intent — pure function, no LLM.
4. The action runs against the plugged-in app; the reply text goes back and
   the browser plays it through the server's neural voice (`POST /api/speak`
   → Piper WAV, `GET /api/tts/status` for readiness). Without the voice
   engine it falls back to the browser's built-in speech. Barge-in (grabbing
   the mic) cuts off either playback path.

Swap voices any time: `PIPER_VOICE=en_US-lessac-medium sh scripts/setup-tts.sh`
(default `en_US-amy-medium`). `PIPER_BIN` points at your own Piper build.

Multi-turn: outbound Relay messages are staged for 2 minutes — Sherry reads
the message back and only sends on “yes”. Switchboard digests are a triage
loop — “next”, “snooze”, “dismiss”, “stop”.

## Design rules

- **Voice-first, not voice-only.** Every turn lands in a caption log
  (`hear_log` in SQLite, `GET /api/log`).
- **Confirm before outbound.** Nothing is ever sent without a read-back + “yes”.
- **Deterministic.** The router is a tested pure function; integrations degrade
  to “I can't reach X. Is it running?” instead of guessing.

Bun + zero npm deps + SQLite. No network calls except to your own localhost apps.
