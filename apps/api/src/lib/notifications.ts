import type { Env, QueueEvent } from "../types";

interface ChannelRow {
  kind: string;
  url: string;
  events: string;
}

function severityColor(sev: string): string {
  if (sev === "critical") return "D13438";
  if (sev === "warning") return "F7A600";
  return "2D7D9A";
}

function matches(channelEvents: string, type: string): boolean {
  if (channelEvents.trim() === "*") return true;
  return channelEvents
    .split(",")
    .map((s) => s.trim())
    .includes(type);
}

async function dispatch(ch: ChannelRow, e: QueueEvent): Promise<void> {
  const title = `[${e.severity}] ${e.type}`;
  const text = e.device_id ? `${e.message} (device ${e.device_id})` : e.message;

  if (ch.kind === "teams") {
    const card = {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      themeColor: severityColor(e.severity),
      summary: e.message,
      title,
      text,
    };
    await fetch(ch.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
  } else {
    // generic webhook
    await fetch(ch.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: e.type,
        severity: e.severity,
        message: e.message,
        device_id: e.device_id ?? null,
        event_id: e.event_id ?? null,
        ts: new Date().toISOString(),
      }),
    });
  }
}

// Queue consumer: fan an event out to all enabled channels that subscribe to it.
export async function consumeEvents(
  batch: MessageBatch<QueueEvent>,
  env: Env,
): Promise<void> {
  const channels = await env.DB.prepare(
    "SELECT kind, url, events FROM notification_channels WHERE enabled = 1",
  ).all<ChannelRow>();

  for (const msg of batch.messages) {
    try {
      const e = msg.body;
      for (const ch of channels.results) {
        if (matches(ch.events, e.type)) {
          await dispatch(ch, e).catch(() => {
            /* best-effort per channel */
          });
        }
      }
      msg.ack();
    } catch {
      msg.retry();
    }
  }
}
