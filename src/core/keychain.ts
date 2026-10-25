/**
 * Secrets live in the macOS login Keychain (service "Margin"), never in the repo, the DB, or logs.
 * Tests and MARGIN_KEYCHAIN=memory use an in-memory map.
 */
export interface Keychain {
  get(account: string): string | null;
  set(account: string, secret: string): void;
  delete(account: string): void;
  has(account: string): boolean;
}

const SERVICE = 'Margin';

export async function createKeychain(): Promise<Keychain> {
  if (process.env.MARGIN_KEYCHAIN === 'memory') return memoryKeychain();
  const { Entry } = await import('@napi-rs/keyring');
  const entry = (a: string) => new Entry(SERVICE, a);
  return {
    get(a) { try { return entry(a).getPassword() ?? null; } catch { return null; } },
    set(a, s) { entry(a).setPassword(s); },
    delete(a) { try { entry(a).deletePassword(); } catch { /* already gone */ } },
    has(a) { try { return !!entry(a).getPassword(); } catch { return false; } },
  };
}

export function memoryKeychain(): Keychain {
  const m = new Map<string, string>();
  return {
    get: (a) => m.get(a) ?? null,
    set: (a, s) => void m.set(a, s),
    delete: (a) => void m.delete(a),
    has: (a) => m.has(a),
  };
}
