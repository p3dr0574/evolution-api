import { randomUUID } from 'crypto';

export interface QrTokenEntry {
  instanceName: string;
  /** Unix ms timestamp, or null for no expiry. */
  expiresAt: number | null;
}

const store = new Map<string, QrTokenEntry>();
/** Tracks the single active token per instance so creating a new one revokes the old. */
const activeByInstance = new Map<string, string>();

const DEFAULT_TTL_S = 15 * 60; // 15 minutes

/**
 * Create a public QR token for an instance.
 * @param ttlSeconds Lifetime in seconds. 0 or omitted = no expiry.
 */
export function createQrToken(instanceName: string, ttlSeconds = DEFAULT_TTL_S): string {
  // Revoke previous token for this instance if any
  const prev = activeByInstance.get(instanceName);
  if (prev) store.delete(prev);

  const token = randomUUID();
  const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
  store.set(token, { instanceName, expiresAt });
  activeByInstance.set(instanceName, token);
  return token;
}

export function resolveQrToken(token: string): QrTokenEntry | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
    store.delete(token);
    activeByInstance.delete(entry.instanceName);
    return null;
  }
  return entry;
}

export function deleteQrToken(token: string): void {
  const entry = store.get(token);
  if (entry) activeByInstance.delete(entry.instanceName);
  store.delete(token);
}

export function revokeByInstance(instanceName: string): boolean {
  const token = activeByInstance.get(instanceName);
  if (!token) return false;
  store.delete(token);
  activeByInstance.delete(instanceName);
  return true;
}

export function getActiveToken(instanceName: string): string | null {
  const token = activeByInstance.get(instanceName);
  if (!token) return null;
  const entry = store.get(token);
  if (!entry) { activeByInstance.delete(instanceName); return null; }
  if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
    store.delete(token);
    activeByInstance.delete(instanceName);
    return null;
  }
  return token;
}

// Prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    if (val.expiresAt !== null && now > val.expiresAt) {
      activeByInstance.delete(val.instanceName);
      store.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();
