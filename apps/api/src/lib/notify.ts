import type { Env } from "../types";
import type { EventSeverity, EventType } from "@screenboard/shared";

// Record an event row for the dashboard and audit history.
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
  await env.DB.prepare(
    "INSERT INTO events (type, device_id, severity, message) VALUES (?, ?, ?, ?)",
  )
    .bind(e.type, e.device_id ?? null, severity, e.message)
    .run();

}
