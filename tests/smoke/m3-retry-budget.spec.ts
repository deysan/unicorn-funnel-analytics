import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';

test('нова B після no_offer має власні три автоматичні повтори @audit', async ({ page, context }) => {
  const profiles = JSON.parse(await readFile('.wrangler/e2e-profiles.json', 'utf8')) as { token: string }[];
  await context.addCookies([{ name: '__Host-unicorn', value: profiles[95].token,
    domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  await page.clock.install();
  await page.addInitScript(() => { Math.random = () => 0; });

  const noOffer = { code: 'no_offer', catalog_version: 'a'.repeat(64) };
  const results = new Map<string, typeof noOffer>();
  const attempts = new Map<string, string[]>();
  let emailPosts = 0;
  page.on('request', request => { if (request.url().endsWith('/email-confirmations')) emailPosts++; });
  await page.route('**/operations/*', async route => {
    const key = route.request().url().split('/').at(-1)!;
    if (results.has(key)) await route.fulfill({ json: results.get(key) });
    else await route.continue();
  });
  await page.route('**/offer-selections', async route => {
    const key = route.request().postDataJSON().operation_id as string;
    const payloads = attempts.get(key) ?? [];
    payloads.push(route.request().postData()!);
    attempts.set(key, payloads);
    if (payloads.length <= 3) {
      await route.fulfill({ status: 429, headers: { 'Retry-After': '60' }, json: {
        error: { code: 'rate_limited', message: `Пауза B${attempts.size}, спроба ${payloads.length}`, retryable: true },
      } });
      return;
    }
    results.set(key, noOffer);
    await route.fulfill({ json: noOffer });
  });

  await page.goto('/');
  await page.getByLabel('Жінки', { exact: true }).check();
  await page.getByRole('button', { name: 'Продовжити' }).click();
  await page.getByLabel('Азія', { exact: true }).check();
  await page.getByRole('button', { name: 'Продовжити' }).click();
  await page.getByLabel('Email', { exact: true }).fill('RetryBudget@example.test');
  await page.getByRole('button', { name: 'Підтвердити та підібрати' }).click();

  for (const action of [1, 2]) {
    if (action === 2) await page.getByRole('button', { name: 'Спробувати ще раз' }).click();
    for (const attempt of [1, 2, 3]) {
      await expect(page.getByRole('status')).toContainText(`Пауза B${action}, спроба ${attempt}`);
      await expect(page.getByRole('button', { name: 'Повторити дію' })).toBeDisabled();
      expect(attempts.size).toBe(action);
      const payloads = [...attempts.values()][action - 1];
      expect(payloads).toHaveLength(attempt);
      await page.clock.fastForward(60_000);
    }
    await expect(page.getByRole('heading', { name: 'Зараз немає пропозиції' })).toBeVisible();
    expect([...attempts.values()][action - 1]).toHaveLength(4);
  }

  const keys = [...attempts.keys()];
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  for (const payloads of attempts.values()) expect(new Set(payloads).size).toBe(1);
  expect(emailPosts).toBe(1);
  const draft = JSON.parse((await page.evaluate(() => sessionStorage.getItem('unicorn.final.v1')))!);
  expect(draft).toMatchObject({ phase: 'done', b: keys[1] });
  expect(draft.email).toBeUndefined();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Зараз немає пропозиції' })).toBeVisible();
  expect([...attempts.values()].map(payloads => payloads.length)).toEqual([4, 4]);
  expect(emailPosts).toBe(1);
});
