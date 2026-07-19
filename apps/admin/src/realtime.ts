import { useEffect, useRef } from "react";
import { apiBase, getToken } from "./api";

export interface DeviceStatusEvent {
  uuid: string;
  status: string;
}

interface DeviceStreamHandlers {
  // Fired for each device online/offline transition pushed by the server.
  onEvent: (e: DeviceStatusEvent) => void;
  // Fired on every (re)connect. Re-fetch the full list here so transitions that
  // happened while the socket was down are picked up rather than lost.
  onReady?: () => void;
}

// Subscribe to the presence hub's live device-status stream over a WebSocket.
// A browser can't set an Authorization header on a WebSocket, so the admin JWT
// travels as ?token= (verified by signature server-side). Reconnects with
// backoff; a 25s keepalive ping keeps the connection warm through edge proxies.
export function useDeviceStream(handlers: DeviceStreamHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const base = apiBase() || location.origin;
    const wsBase = base.replace(/^http/, "ws");
    let ws: WebSocket | null = null;
    let closed = false;
    let backoff = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      const token = getToken();
      if (!token) return;
      ws = new WebSocket(`${wsBase}/api/realtime/devices?token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        backoff = 1000;
        ref.current.onReady?.();
        pingTimer = setInterval(() => {
          try {
            ws?.send("ping");
          } catch {
            /* closing */
          }
        }, 25000);
      };

      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === "device_status" && typeof msg.uuid === "string") {
            ref.current.onEvent({ uuid: msg.uuid, status: String(msg.status) });
          }
        } catch {
          /* ignore malformed frames */
        }
      };

      const scheduleReconnect = () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined; }
        if (closed) return;
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
      ws.onclose = scheduleReconnect;
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* already closing */
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    };
  }, []);
}
