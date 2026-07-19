import type { Env } from "../types";

// Push a device online/offline transition to every admin console via the global
// presence hub. Best-effort: the devices table stays authoritative and consoles
// re-sync on reconnect, so a failed broadcast only delays visibility, never
// corrupts it. Shared by the DeviceConnection watchdog and the cron backstop so
// every offline flip — however it was detected — reaches the console live.
export async function broadcastDeviceStatus(env: Env, uuid: string, status: string): Promise<void> {
  try {
    const stub = env.PRESENCE_HUB.get(env.PRESENCE_HUB.idFromName("global"));
    await stub.fetch("https://hub/broadcast", {
      method: "POST",
      body: JSON.stringify({ uuid, status }),
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: "presence_broadcast_failed", device_id: uuid, error: String(error) }));
  }
}
