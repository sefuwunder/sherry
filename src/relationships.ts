// sherry: relationship & behavior analysis across channels. Reads Relay
// conversations and message history, then derives deterministic insights:
// who you talk to most, who you've neglected, per-contact channel habits,
// and your reply-speed patterns. No LLM — pure arithmetic over the data.

import { bases, get } from "./clients";

export interface ContactStats {
  name: string;
  isGroup: boolean;
  totalMessages: number;
  inbound: number;
  outbound: number;
  daysSinceContact: number;
  preferredChannel: string;
  channelBreakdown: Record<string, number>;
  /** Median hours from their message to your reply (null when incalculable). */
  medianReplyHours: number | null;
  /** Share of messages that are yours (0..1). */
  yourShare: number;
}

interface RelayMsg {
  direction: "in" | "out";
  channel: string;
  created_at: string;
}

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

/** Median of a number array, null when empty. */
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function statsFor(name: string, isGroup: boolean, msgs: RelayMsg[]): ContactStats {
  const inbound = msgs.filter((m) => m.direction === "in").length;
  const outbound = msgs.filter((m) => m.direction === "out").length;
  const channels: Record<string, number> = {};
  for (const m of msgs) {
    const c = m.channel || "unknown";
    channels[c] = (channels[c] || 0) + 1;
  }
  const preferred = Object.entries(channels).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  // Reply latency: for each inbound message, hours until the next outbound.
  const latencies: number[] = [];
  const sorted = [...msgs].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].direction !== "in") continue;
    const tIn = +new Date(sorted[i].created_at);
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].direction === "out") {
        const h = (+new Date(sorted[j].created_at) - tIn) / 3600_000;
        if (h >= 0 && h < 24 * 14) latencies.push(h); // cap at 2 weeks
        break;
      }
    }
  }

  const lastAt = sorted.length ? sorted[sorted.length - 1].created_at : "";
  return {
    name,
    isGroup,
    totalMessages: msgs.length,
    inbound,
    outbound,
    daysSinceContact: lastAt ? daysSince(lastAt) : Infinity,
    preferredChannel: preferred,
    channelBreakdown: channels,
    medianReplyHours: median(latencies),
    yourShare: msgs.length ? outbound / msgs.length : 0,
  };
}

export interface RelationshipReport {
  ok: boolean;
  speech: string;
  stats: ContactStats[];
  error?: string;
}

function fmtDays(d: number): string {
  if (!isFinite(d)) return "never";
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 7) return `${Math.round(d)} days ago`;
  if (d < 14) return "a week ago";
  if (d < 30) return `${Math.round(d / 7)} weeks ago`;
  if (d < 60) return "a month ago";
  return `${Math.round(d / 30)} months ago`;
}

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} minutes`;
  if (h < 24) return `${Math.round(h)} hours`;
  return `${Math.round(h / 24)} days`;
}

/**
 * Analyze relationships. Fetches the conversation list, then message history
 * for the most recent ones (bounded: 8 conversations × 50 messages).
 */
export async function analyzeRelationships(): Promise<RelationshipReport> {
  const b = bases();
  const convR = await get(b.relay, "/api/conversations");
  if (!convR.ok) {
    return { ok: false, speech: "I can't reach Relay. Is it running?", stats: [], error: "unreachable" };
  }
  const convs: any[] = convR.data?.conversations || [];
  if (!convs.length) {
    return { ok: true, speech: "No conversations to analyze yet.", stats: [] };
  }

  // Most recent first, cap the work.
  const recent = [...convs]
    .sort((a, z) => +new Date(z.last_at || 0) - +new Date(a.last_at || 0))
    .slice(0, 8);

  const stats: ContactStats[] = [];
  for (const c of recent) {
    const name = String(c.title || "Unknown");
    const msgR = await get(b.relay, `/api/conversations/${encodeURIComponent(c.id)}/messages?limit=50`);
    const msgs: RelayMsg[] = msgR.ok ? msgR.data?.messages || [] : [];
    if (!msgs.length) continue;
    stats.push(statsFor(name, !!c.is_group, msgs));
  }
  if (!stats.length) {
    return { ok: true, speech: "Couldn't read any message history.", stats: [] };
  }

  const lines: string[] = [];
  const people = stats.filter((s) => !s.isGroup);

  // Most active
  const byVolume = [...stats].sort((a, z) => z.totalMessages - a.totalMessages)[0];
  if (byVolume && byVolume.totalMessages >= 5) {
    lines.push(`You talk to ${byVolume.name} most — ${byVolume.totalMessages} recent messages, mostly by ${byVolume.preferredChannel}.`);
  }

  // Neglected: no contact in 14+ days, but they were active before
  const neglected = people
    .filter((s) => s.daysSinceContact >= 14 && s.totalMessages >= 5)
    .sort((a, z) => z.daysSinceContact - a.daysSinceContact)
    .slice(0, 2);
  for (const n of neglected) {
    lines.push(`${n.name} has gone quiet — last contact ${fmtDays(n.daysSinceContact)}.`);
  }

  // Reply speed: who you answer fastest (needs 3+ measured replies)
  const withLatency = people.filter((s) => s.medianReplyHours != null);
  if (withLatency.length >= 2) {
    const fastest = [...withLatency].sort((a, z) => a.medianReplyHours! - z.medianReplyHours!)[0];
    const slowest = [...withLatency].sort((a, z) => z.medianReplyHours! - a.medianReplyHours!)[0];
    if (fastest.medianReplyHours! < slowest.medianReplyHours! / 2 && slowest.medianReplyHours! >= 4) {
      lines.push(`You reply to ${fastest.name} fastest (about ${fmtHours(fastest.medianReplyHours!)}), slower with ${slowest.name} (${fmtHours(slowest.medianReplyHours!)}).`);
    }
  }

  // Channel habits: contacts where one channel dominates
  const channelHabits = people.filter((s) => {
    const total = Object.values(s.channelBreakdown).reduce((n, x) => n + x, 0);
    const top = Math.max(...Object.values(s.channelBreakdown));
    return total >= 8 && top / total >= 0.8 && s.preferredChannel !== "unknown";
  }).slice(0, 2);
  for (const h of channelHabits) {
    lines.push(`You stick to ${h.preferredChannel} with ${h.name}.`);
  }

  // Balance: who talks more
  const unbalanced = people.find((s) => s.totalMessages >= 10 && (s.yourShare > 0.75 || s.yourShare < 0.25));
  if (unbalanced) {
    lines.push(unbalanced.yourShare > 0.5
      ? `You do most of the talking with ${unbalanced.name}.`
      : `${unbalanced.name} does most of the talking.`);
  }

  if (!lines.length) {
    return { ok: true, speech: "Your relationships look steady — nothing notable in recent patterns.", stats };
  }
  return { ok: true, speech: lines.join(" "), stats };
}

/** Contacts neglected 14+ days, for the suggestion engine. */
export function neglectedContacts(stats: ContactStats[]): ContactStats[] {
  return stats
    .filter((s) => !s.isGroup && s.daysSinceContact >= 14 && s.totalMessages >= 5)
    .sort((a, z) => z.daysSinceContact - a.daysSinceContact);
}
