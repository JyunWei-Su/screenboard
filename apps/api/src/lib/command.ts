import type { Env } from "../types";
import type { CommandType } from "@screenboard/shared";

export function deviceStub(env: Env, uuid: string) {
  return env.DEVICE_CONN.get(env.DEVICE_CONN.idFromName(uuid));
}

// Persist a command and attempt live delivery through the device's Durable Object.
export async function issueCommand(
  env: Env,
  uuid: string,
  type: CommandType,
  payload: Record<string, unknown> | undefined,
  issuedBy: number | null,
): Promise<{ id: string; delivered: boolean }> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO commands (id, device_id, type, payload, status, issued_by) VALUES (?, ?, ?, ?, 'queued', ?)",
  )
    .bind(id, uuid, type, payload ? JSON.stringify(payload) : null, issuedBy)
    .run();

  let delivered = false;
  try {
    const res = await deviceStub(env, uuid).fetch("https://do/command", {
      method: "POST",
      body: JSON.stringify({ id, type, payload }),
    });
    const j = (await res.json()) as { delivered?: boolean };
    delivered = !!j.delivered;
  } catch {
    delivered = false;
  }
  return { id, delivered };
}
