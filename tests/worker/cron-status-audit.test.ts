import { beforeEach, expect, it } from 'vitest';
import { runMaintenance } from '../../src/server/maintenance/coordinator';
import { readStatus } from '../../src/server/report/read';
import { DAY } from '../../src/shared/report';
import { db, freshBusinessDb, now, userStatement } from './helpers/business-db';

beforeEach(freshBusinessDb);

it.each([0, 300_000, 300_001])('first unsuccessful Cron becomes stale only after five minutes (%i ms)', async (elapsed) => {
  expect((await readStatus(db, 'normal', now)).cron).toMatchObject({ status: 'unknown', stale: null });
  const result = await runMaintenance({ db, mode: undefined, now: () => now });
  expect(result.errors).toEqual(['delivery_invalid_mode']);
  expect((await readStatus(db, 'normal', now + elapsed)).cron).toMatchObject({
    status: 'partial_failure', last_attempt_at: now, last_success_at: null, stale: elapsed > 300_000,
  });
});

it('subsequent failed attempts preserve the first-attempt baseline; success starts a new freshness interval', async () => {
  await runMaintenance({ db, mode: undefined, now: () => now });
  await runMaintenance({ db, mode: undefined, now: () => now + 240_000 });
  expect(await db.prepare('SELECT cron_first_attempt_at FROM maintenance_control').first('cron_first_attempt_at')).toBe(now);
  expect((await readStatus(db, 'normal', now + 300_000)).cron.stale).toBe(false);
  expect((await readStatus(db, 'normal', now + 300_001)).cron).toMatchObject({
    last_attempt_at: now + 240_000, last_success_at: null, stale: true,
  });
  await runMaintenance({ db, mode: 'normal', now: () => now + 360_000 });
  expect((await readStatus(db, 'normal', now + 660_000)).cron.stale).toBe(false);
  expect((await readStatus(db, 'normal', now + 660_001)).cron.stale).toBe(true);
  expect(await db.prepare('SELECT cron_first_attempt_at FROM maintenance_control').first('cron_first_attempt_at')).toBe(now);
});

it.each(['normal', undefined])('older successful completion preserves the newer run fields (%s)', async (newerMode) => {
  await userStatement().run();
  await db.prepare("UPDATE users SET email = 'synthetic@example.test', email_confirmed_at = ?").bind(now - 30 * DAY).run();
  await db.prepare("UPDATE capacity_control SET used_count = 1 WHERE budget_key = 'profiles'").run();

  let release!: () => void;
  const resume = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const finishing = new Promise<void>((resolve) => { reached = resolve; });
  // Pause only the older run's final status write. All business work and both
  // status writes still execute against the real isolated D1 database.
  const olderDb = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes('cron_success_at = CASE')) return statement;
        const wrap = (prepared: D1PreparedStatement): D1PreparedStatement => new Proxy(prepared, {
          get(item, method) {
            if (method === 'bind') return (...values: unknown[]) => wrap(item.bind(...values));
            if (method === 'run') return async () => { reached(); await resume; return item.run(); };
            const value = Reflect.get(item, method);
            return typeof value === 'function' ? value.bind(item) : value;
          },
        });
        return wrap(statement);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const older = runMaintenance({ db: olderDb, mode: 'normal', now: () => now });
  await finishing;
  try {
    await runMaintenance({ db, mode: newerMode, now: () => now + 60_000 });
    const current = await db.prepare(`SELECT cron_token, cron_attempt_at, cron_result,
      cron_errors_json, cleanup_at, cleanup_json FROM maintenance_control`).first();
    expect(current).toMatchObject({
      cron_attempt_at: now + 60_000,
      cron_result: newerMode === 'normal' ? 'complete' : 'partial_failure',
      cron_errors_json: newerMode === 'normal' ? '[]' : '["delivery_invalid_mode"]',
      cleanup_at: now + 60_000,
    });
    release();
    const completed = await older;
    expect(completed.errors).toEqual([]);
    expect(completed.cleanup?.email.changed).toBe(1);
    expect(await db.prepare(`SELECT cron_token, cron_attempt_at, cron_result,
      cron_errors_json, cleanup_at, cleanup_json FROM maintenance_control`).first()).toEqual(current);
    expect((await readStatus(db, 'normal', now + 60_001)).cron).toMatchObject({
      last_success_at: newerMode === 'normal' ? now + 60_000 : now,
      status: newerMode === 'normal' ? 'complete' : 'partial_failure', stale: false,
    });
  } finally {
    release();
    await older;
  }
});
