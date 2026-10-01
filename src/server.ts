// sherry: voice-first desktop agent. Bun + zero deps + SQLite.
import { handle, startUrgentWatcher } from "./app";

const PORT = Number(process.env.PORT || 3014);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    try {
      return await handle(req);
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
});

console.log(`sherry listening on http://127.0.0.1:${server.port}`);

// Watch Switchboard for urgent items; chime the browser via SSE.
startUrgentWatcher();
