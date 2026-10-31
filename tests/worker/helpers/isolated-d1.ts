import { env } from 'cloudflare:workers';
import { expect } from 'vitest';

export async function verifyFileIsolation(marker: string) {
  expect(await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '__file_isolation'").first()).toBeNull();
  // Обидва файли створюють ту саму таблицю без IF NOT EXISTS:
  // спільне сховище спричинило б конфлікт незалежно від порядку запуску.
  await env.DB.exec('CREATE TABLE __file_isolation (marker TEXT NOT NULL)');
  await env.DB.prepare('INSERT INTO __file_isolation (marker) VALUES (?)').bind(marker).run();
  expect(await env.DB.prepare('SELECT marker FROM __file_isolation').all()).toMatchObject({
    results: [{ marker }],
  });
}
