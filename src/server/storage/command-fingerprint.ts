export type NormalizedJson = null | boolean | number | string | NormalizedJson[] | { [key: string]: NormalizedJson };
type FingerprintKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface FingerprintKeyring {
  currentVersion: string;
  keys: ReadonlyMap<string, FingerprintKey>;
}

export interface FingerprintContext {
  userId: string;
  operationId: string;
  operationType: string;
  business: NormalizedJson;
}

export const FINGERPRINT_FORMAT_VERSION = 1;

// Формат 1: рекурсивний порядок ключів; масиви зберігають порядок.
// Caller передає лише вже нормалізований бізнес-зміст, без метаданих спроби.
function canonicalJson(value: NormalizedJson, depth = 0): string {
  if (depth > 32) throw new Error('fingerprint_invalid_content');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`;
  }
  throw new Error('fingerprint_invalid_content');
}

function encodedContext(context: FingerprintContext, formatVersion: number): ArrayBuffer {
  if (formatVersion !== FINGERPRINT_FORMAT_VERSION) throw new Error('fingerprint_unavailable');
  return Uint8Array.from(new TextEncoder().encode(canonicalJson([
    'unicorn.command', formatVersion, context.userId, context.operationId, context.operationType, context.business,
  ]))).buffer;
}

function requireKey(keyring: FingerprintKeyring, version: string): FingerprintKey {
  const key = keyring.keys.get(version);
  if (!key || key.algorithm.name !== 'HMAC' || (key.algorithm as { hash?: { name: string } }).hash?.name !== 'SHA-256') {
    throw new Error('fingerprint_unavailable');
  }
  return key;
}

// Секрет надходить із серверного secret binding, ніколи з D1 або запиту.
export async function importFingerprintKey(secret: Uint8Array<ArrayBuffer>): Promise<FingerprintKey> {
  if (secret.byteLength < 32) throw new Error('fingerprint_invalid_key');
  return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createCommandFingerprint(context: FingerprintContext, keyring: FingerprintKeyring) {
  const keyVersion = keyring.currentVersion;
  if (!keyVersion) throw new Error('fingerprint_unavailable');
  const signature = await crypto.subtle.sign('HMAC', requireKey(keyring, keyVersion), encodedContext(context, FINGERPRINT_FORMAT_VERSION));
  const fingerprint = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { fingerprint, keyVersion, formatVersion: FINGERPRINT_FORMAT_VERSION };
}

export async function verifyCommandFingerprint(
  context: FingerprintContext,
  stored: { fingerprint: string; keyVersion: string; formatVersion: number },
  keyring: FingerprintKeyring,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(stored.fingerprint)) throw new Error('stored_result_invalid');
  const signature = Uint8Array.from(stored.fingerprint.match(/../g)!, (hex) => Number.parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', requireKey(keyring, stored.keyVersion), signature, encodedContext(context, stored.formatVersion));
}
