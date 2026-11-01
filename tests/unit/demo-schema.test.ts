import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { migrationNames, parseWranglerAudit, schemaSql, validateSchema } from '../../scripts/demo-schema';
import { newHistorySql } from '../../scripts/report-history';
function database() {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations (name TEXT);');
  for (const name of migrationNames()) { db.exec(readFileSync('migrations/' + name, 'utf8')); db.prepare('INSERT INTO d1_migrations VALUES (?)').run(name); }
  db.exec(newHistorySql(Math.floor(Date.now()/86400000)*86400000)); return db;
}
const audit = (db: DatabaseSync) => JSON.parse(String(db.prepare(schemaSql).get()!.audit));
it('accepts migrated initialized database and only reads it', () => {
  const db = database(); try { const before = db.prepare('SELECT total_changes() AS n').get(); validateSchema(audit(db)); expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before); } finally { db.close(); }
});
it.each([
  'DROP INDEX events_click', 'ALTER TABLE users ADD COLUMN wrong TEXT',
  "DELETE FROM d1_migrations WHERE name LIKE '0005%'", 'UPDATE system_control SET history_available_from=NULL',
  'UPDATE system_control SET history_unverified=1', 'UPDATE capacity_control SET capacity_paused=1',
  "DELETE FROM cleanup_cursors WHERE phase='email'", 'DELETE FROM maintenance_control',
])('rejects drift or unsafe controls: %s', (sql) => { const db = database(); try { db.exec(sql); expect(() => validateSchema(audit(db))).toThrow(); } finally { db.close(); } });
it('rejects foreign-key damage and failed/malformed Wrangler responses', () => {
  const db=database(); try { db.exec("PRAGMA foreign_keys=OFF; INSERT INTO user_offer_leads VALUES ('missing','003',1)"); expect(() => validateSchema(audit(db))).toThrow(); } finally {db.close();}
  for (const value of [[], [{}], [{success:false,results:[]}], [{success:true,results:[]}]]) expect(() => parseWranglerAudit(value)).toThrow();
});
