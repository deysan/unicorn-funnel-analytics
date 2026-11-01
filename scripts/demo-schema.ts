import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Row = Record<string, unknown>;
export const migrationNames = () => readdirSync('migrations').filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
// Read-only metadata; no business payloads, profile data or repair statements.
export const schemaSql = `SELECT json_object(
 'schema', json((SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name))),
 'migrations', json((SELECT json_group_array(name) FROM (SELECT name FROM d1_migrations ORDER BY name))),
 'foreign_keys', json((SELECT json_group_array(json_object('table',"table",'rowid',rowid,'parent',parent,'fkid',fkid)) FROM pragma_foreign_key_check)),
 'system', json((SELECT json_group_array(json_object('singleton_id',singleton_id,'history_available_from',history_available_from,'history_unverified',history_unverified,'integrity_paused',integrity_paused)) FROM system_control)),
 'capacity', json((SELECT json_group_array(json_object('budget_key',budget_key,'used_count',used_count,'capacity_paused',capacity_paused,'capacity_epoch',capacity_epoch)) FROM (SELECT * FROM capacity_control ORDER BY budget_key))),
 'maintenance', json((SELECT json_group_array(singleton_id) FROM maintenance_control)),
 'cursors', json((SELECT json_group_array(phase) FROM (SELECT phase FROM cleanup_cursors ORDER BY phase))),
 'assertions', (SELECT count(*) FROM transaction_assertions)
) AS audit;`;
export function expectedSchema() {
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of migrationNames()) db.exec(readFileSync('migrations/' + name, 'utf8'));
    return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  } finally { db.close(); }
}
const canonical = (rows: Row[]) => rows.map((row) => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.replace(/\s+/g, ' ').trim() : row.sql }));
export function validateSchema(value: unknown, now = Date.now()) {
  const a = value as { schema: Row[]; migrations: string[]; foreign_keys: unknown[]; system: Row[]; capacity: Row[]; maintenance: number[]; cursors: string[]; assertions: number };
  const require = (ok: boolean) => { if (!ok) throw new Error('demo_schema_rejected'); };
  require(JSON.stringify(canonical(a.schema)) === JSON.stringify(canonical(expectedSchema())));
  require(JSON.stringify(a.migrations) === JSON.stringify(migrationNames()));
  require(a.foreign_keys.length === 0 && a.assertions === 0);
  require(a.system.length === 1);
  const system = a.system[0]; const day = system.history_available_from;
  require(system.singleton_id === 1 && system.history_unverified === 0 && system.integrity_paused === 0);
  require(typeof day === 'number' && Number.isSafeInteger(day) && day >= 0 && day <= now && day % 86400000 === 0);
  require(JSON.stringify(a.capacity.map((row) => row.budget_key)) === JSON.stringify(['command_keys', 'events', 'profiles', 'undelivered']));
  require(a.capacity.every((row) => Number.isSafeInteger(row.used_count) && Number(row.used_count) >= 0 && row.capacity_paused === 0 && Number.isSafeInteger(row.capacity_epoch) && Number(row.capacity_epoch) >= 0));
  require(JSON.stringify(a.maintenance) === '[1]');
  require(JSON.stringify(a.cursors) === JSON.stringify(['clicks', 'command_keys', 'email', 'events', 'mock_keys', 'partner_keys', 'profiles', 'results', 'user_keys']));
}
export function parseWranglerAudit(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true || value[0]?.results?.length !== 1) throw new Error('demo_schema_rejected');
  return JSON.parse(value[0].results[0].audit);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'sql' && process.argv.length === 3) process.stdout.write(schemaSql + '\n');
    else if (process.argv[2] === 'check' && process.argv.length === 4) {
      validateSchema(parseWranglerAudit(JSON.parse(readFileSync(process.argv[3], 'utf8')))); console.log('demo_schema_valid');
    } else throw new Error('invalid_arguments');
  } catch { console.error('demo_schema_rejected'); process.exitCode = 1; }
}
