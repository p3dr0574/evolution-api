import { createHash } from 'crypto';

export interface QrTokenEntry {
  instanceName: string;
  /** Unix ms timestamp, or null for no expiry. */
  expiresAt: number | null;
}

const store = new Map<string, QrTokenEntry>();

const DEFAULT_TTL_S = 15 * 60; // 15 minutes

/** Derive a stable, deterministic token from an instance name. Same instance = same URL forever. */
export function instanceToken(instanceName: string): string {
  return createHash('sha256').update('evo-qr:' + instanceName).digest('hex').slice(0, 24);
}

/**
 * Activate (or refresh) the public QR link for an instance.
 * The token is deterministic — the URL never changes between sessions.
 * Pass ttlSeconds=0 for no expiry.
 */
export function createQrToken(instanceName: string, ttlSeconds = DEFAULT_TTL_S): string {
  const token = instanceToken(instanceName);
  const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
  store.set(token, { instanceName, expiresAt });
  return token;
}

export function resolveQrToken(token: string): QrTokenEntry | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
    store.delete(token);
    return null;
  }
  return entry;
}

export function deleteQrToken(token: string): void {
  store.delete(token);
}

export function revokeByInstance(instanceName: string): boolean {
  const token = instanceToken(instanceName);
  if (!store.has(token)) return false;
  store.delete(token);
  return true;
}

export function getActiveToken(instanceName: string): string | null {
  const token = instanceToken(instanceName);
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
    store.delete(token);
    return null;
  }
  return token;
}

// Prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    if (val.expiresAt !== null && now > val.expiresAt) {
      store.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();
