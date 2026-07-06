import { randomUUID } from 'crypto';

interface QrTokenEntry {
  instanceName: string;
  expiresAt: number;
}

const store = new Map<string, QrTokenEntry>();

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function createQrToken(instanceName: string): string {
  const token = randomUUID();
  store.set(token, { instanceName, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function resolveQrToken(token: string): QrTokenEntry | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(token);
    return null;
  }
  return entry;
}

export function deleteQrToken(token: string): void {
  store.delete(token);
}

// Prune expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    if (now > val.expiresAt) store.delete(key);
  }
}, 5 * 60 * 1000).unref();
