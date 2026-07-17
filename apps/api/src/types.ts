import type { Role } from "@screenboard/shared";

export interface Env {
  // Bindings
  DB: D1Database;
  BUCKET: R2Bucket;
  DEVICE_CONN: DurableObjectNamespace;

  // Vars
  HEALTH_RETENTION_DAYS: string;
  OFFLINE_TIMEOUT_SECONDS: string;
  PUBLIC_API_URL: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  CF_ZONE_NAME?: string;
  CF_ACCESS_ALLOWED_EMAILS?: string;

  // Secrets (wrangler secret put ...)
  JWT_SECRET: string; // admin session JWTs
  DEVICE_JWT_SECRET: string; // device access tokens
  BOOTSTRAP_TOKEN?: string; // one-time first-admin creation
  TOTP_ENC_KEY?: string; // base64 32-byte AES key for encrypting TOTP secrets
  CF_API_TOKEN?: string; // Cloudflare API token for Tunnel, DNS and Access provisioning
}

// Authenticated admin context set by requireAuth middleware
export interface AuthUser {
  id: number;
  name: string;
  role: Role;
  jti: string;
}

export type Variables = {
  user: AuthUser;
  deviceUuid: string;
};
