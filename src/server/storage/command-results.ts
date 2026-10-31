import { z } from 'zod';
import { createCommandFingerprint, verifyCommandFingerprint, type FingerprintKeyring, type NormalizedJson } from './command-fingerprint';

export const COMMAND_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const bytes = (limit: number) => z.string().min(1).refine((value) => new TextEncoder().encode(value).length <= limit);
const operationTypeSchema = z.enum(['entry', 'question_view', 'answer', 'email_confirmation', 'offer_selection']);
export type OperationType = z.infer<typeof operationTypeSchema>;

// Внутрішній контракт сховища; HTTP DTO підключаються окремо.
const resultSchema = z.discriminatedUnion('code', [
  z.strictObject({ code: z.literal('accepted'), event_id: uuid }),
  z.strictObject({ code: z.literal('no_offer'), catalog_version: hash }),
  z.strictObject({
    code: z.literal('offer_selected'), event_id: uuid, click_id: uuid,
    catalog_version: hash, offer_id: z.string().regex(/^\d{3}$/),
    offer_name: bytes(256), target_url: bytes(2048),
  }),
]).refine((result) => {
  if (result.code !== 'offer_selected') return true;
  try {
    const url = new URL(result.target_url);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.searchParams.getAll('click_id').length === 1 && url.searchParams.get('click_id') === result.click_id;
  } catch { return false; }
});
export type CommandResult = z.infer<typeof resultSchema>;
export interface CommandIdentity { userId: string; operationId: string }
export interface NormalizedCommand extends CommandIdentity { operationType: OperationType; business: NormalizedJson }
export type ResultLookup = { status: 'not_found' } | { status: 'expired' } | { status: 'found'; result: CommandResult };
export type ReplayLookup = ResultLookup | { status: 'conflict' };

interface ResultRow {
  created_at: number;
  expired: number;
  operation_type: OperationType | null;
  request_fingerprint: string | null;
  fingerprint_key_version: string | null;
  fingerprint_format_version: number | null;
  result_json: string | null;
}

function checkIdentity(identity: CommandIdentity, now: number) {
  if (!uuid.safeParse(identity.userId).success || !uuid.safeParse(identity.operationId).success
    || !Number.isSafeInteger(now) || now < 0) throw new Error('storage_invalid_context');
}

function parseResult(value: unknown, operationType: OperationType): CommandResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success || ((operationType === 'offer_selection') === (parsed.data.code === 'accepted'))) {
    throw new Error('stored_result_invalid');
  }
  if (new TextEncoder().encode(JSON.stringify(parsed.data)).length > 4096) throw new Error('stored_result_too_large');
  return parsed.data;
}

function storedResult(row: ResultRow): CommandResult {
  if (!row.operation_type || !row.result_json) throw new Error('stored_result_invalid');
  let decoded: unknown;
  try { decoded = JSON.parse(row.result_json); } catch { throw new Error('stored_result_invalid'); }
  return parseResult(decoded, row.operation_type);
}

function isExpired(row: ResultRow, now: number) {
  return row.expired === 1 || now - row.created_at >= COMMAND_RESULT_TTL_MS;
}

async function find(db: D1Database, identity: CommandIdentity, now: number) {
  checkIdentity(identity, now);
  return db.prepare(`SELECT created_at, expired, operation_type, request_fingerprint,
    fingerprint_key_version, fingerprint_format_version, result_json
    FROM request_results WHERE user_id = ? AND operation_id = ?`)
    .bind(identity.userId, identity.operationId).first<ResultRow>();
}

// Після перевірки cookie/контексту caller. UserID сам по собі не авторизує.
export async function readCommandResult(db: D1Database, identity: CommandIdentity, now: number): Promise<ResultLookup> {
  const row = await find(db, identity, now);
  if (!row) return { status: 'not_found' };
  if (isExpired(row, now)) return { status: 'expired' };
  return { status: 'found', result: storedResult(row) };
}

export async function checkCommandReplay(
  db: D1Database, command: NormalizedCommand, keyring: FingerprintKeyring, now: number,
): Promise<ReplayLookup> {
  const row = await find(db, command, now);
  if (!row) return { status: 'not_found' };
  if (isExpired(row, now)) return { status: 'expired' };
  if (!row.request_fingerprint || !row.fingerprint_key_version || row.fingerprint_format_version === null) {
    throw new Error('stored_result_invalid');
  }
  const matches = await verifyCommandFingerprint(command, {
    fingerprint: row.request_fingerprint, keyVersion: row.fingerprint_key_version,
    formatVersion: row.fingerprint_format_version,
  }, keyring);
  return matches && row.operation_type === command.operationType
    ? { status: 'found', result: storedResult(row) } : { status: 'conflict' };
}

// Лише INSERT statement: caller включає його в batch з усіма бізнес-ефектами,
// guard доступу/revision/бюджетів. Тут немає окремого commit або running.
export async function prepareCommandResult(
  db: D1Database, command: NormalizedCommand, result: CommandResult, keyring: FingerprintKeyring, now: number,
): Promise<D1PreparedStatement> {
  checkIdentity(command, now);
  if (!operationTypeSchema.safeParse(command.operationType).success) throw new Error('storage_invalid_context');
  const resultJson = JSON.stringify(parseResult(result, command.operationType));
  const signature = await createCommandFingerprint(command, keyring);
  return db.prepare(`INSERT INTO request_results
    (user_id, operation_id, created_at, operation_type, request_fingerprint,
      fingerprint_key_version, fingerprint_format_version, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(command.userId, command.operationId, now,
      command.operationType, signature.fingerprint, signature.keyVersion, signature.formatVersion, resultJson);
}

// Примітив очищення, не Cron: caller додає guard integrity-паузи в тому самому
// batch. Позначка ключа зберігається; бюджет command_keys не зменшується.
export function prepareExpireCommandResult(db: D1Database, identity: CommandIdentity, now: number): D1PreparedStatement {
  checkIdentity(identity, now);
  return db.prepare(`UPDATE request_results SET expired = 1, operation_type = NULL,
    request_fingerprint = NULL, fingerprint_key_version = NULL,
    fingerprint_format_version = NULL, result_json = NULL
    WHERE user_id = ? AND operation_id = ? AND expired = 0 AND created_at <= ?`)
    .bind(identity.userId, identity.operationId, now - COMMAND_RESULT_TTL_MS);
}
