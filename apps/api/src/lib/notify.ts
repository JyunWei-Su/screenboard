import type { Env } from "../types";
import type { EventSeverity, EventType } from "@screenboard/shared";

// Record an event row and enqueue it for asynchronous notification dispatch.
export async function recordEvent(
  env: Env,
  e: {
    type: EventType;
    device_id?: string | null;
    severity?: EventSeverity;
    message: string;
  },
): Promise<void> {
  const severity = e.severity ?? "info";
  const res = await env.DB.prepare(
    "INSERT INTO events (type, device_id, severity, message) VALUES (?, ?, ?, ?)",
  )
    .bind(e.type, e.device_id ?? null, severity, e.message)
    .run();

  const eventId = res.meta.last_row_id;
  try {
    await env.EVENTS_QUEUE.send({
      type: e.type,
      device_id: e.device_id ?? null,
      severity,
      message: e.message,
      event_id: eventId,
    });
  } catch {
    // Queue send failures shouldn't block the request; the event row is persisted.
  }
}
