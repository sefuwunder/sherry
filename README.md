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
| “what's new” | Switchboard — spoken digest of live notifications |
| “snooze that” / “dismiss that” | Switchboard — modulates the last-mentioned notification |

## Run

```sh
bun src/server.ts            # http://127.0.0.1:3014 (PORT to override)
```

First run for voice:

```sh
sh scripts/setup-stt.sh      # whisper.cpp + model under data/ (gitignored)
```

Without it, the type-instead box still works and `/api/ask` answers text.

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
4. The action runs against the plugged-in app; the spoken reply goes back
   and the browser reads it aloud (barge-in: grabbing the mic cancels speech).

Multi-turn: outbound Relay messages are staged for 2 minutes — Sherry reads
the message back and only sends on “yes”. Switchboard “snooze that” /
“dismiss that” act on the notification Sherry just mentioned.

## Design rules

- **Voice-first, not voice-only.** Every turn lands in a caption log
  (`hear_log` in SQLite, `GET /api/log`).
- **Confirm before outbound.** Nothing is ever sent without a read-back + “yes”.
- **Deterministic.** The router is a tested pure function; integrations degrade
  to “I can't reach X. Is it running?” instead of guessing.

Bun + zero npm deps + SQLite. No network calls except to your own localhost apps.
