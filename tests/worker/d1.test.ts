import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

describe('тестова D1 та очищення між тестами одного файла', () => {
  beforeEach(async () => {
    // Лише тестова таблиця. Бізнес-міграції додамо на M1.
    await env.DB.exec('CREATE TABLE IF NOT EXISTS __test_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await env.DB.exec('DELETE FROM __test_probe');
  });

  it.each(['first', 'second'])('починає з порожньої фікстури й зберігає параметри: %s', async (value) => {
    expect(await env.DB.prepare('SELECT COUNT(*) AS total FROM __test_probe').first('total')).toBe(0);
    const synthetic = `synthetic '${value}'`;
    await env.DB.prepare('INSERT INTO __test_probe (id, value) VALUES (?, ?)').bind('same-key', synthetic).run();
    expect(await env.DB.prepare('SELECT value FROM __test_probe WHERE id = ?').bind('same-key').first('value')).toBe(synthetic);
  });
});
