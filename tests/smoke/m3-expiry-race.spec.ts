import { readFile } from 'node:fs/promises';
import type { APIResponse, Route } from '@playwright/test';
import { test, expect } from './fixtures';

test('M3 context затриманий через deadline не відновлює email і не повторює A @audit', async ({ page, context }) => {
  const profiles = JSON.parse(await readFile('.wrangler/e2e-profiles.json', 'utf8')) as { token: string }[];
  await context.addCookies([{ name: '__Host-unicorn', value: profiles[96].token, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);

  // Frozen monotonic time makes the last delivered server_time an exact expiry anchor.
  const clockStart = new Date('2026-11-01T00:00:00.000Z');
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
  let lastContextTime = 0;
  let holdNextContext = false;
  let held: { route: Route; response: APIResponse; serverTime: number } | undefined;
  await page.route('**/context?*', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const dto = await response.json() as { server_time: number };
    if (holdNextContext) {
      holdNextContext = false;
      held = { route, response, serverTime: dto.server_time };
      return;
    }
    lastContextTime = dto.server_time;
    await route.fulfill({ response });
  });
  let postsA = 0;
  let postsB = 0;
  const resultReads: string[] = [];
  await page.route('**/email-confirmations', async route => { postsA++; await route.abort(); });
  page.on('request', request => {
    if (request.url().endsWith('/offer-selections')) postsB++;
    if (request.url().includes('/operations/')) resultReads.push(new URL(request.url()).pathname.split('/').at(-1)!);
  });

  await page.goto('/');
  await page.getByLabel('Жінки', { exact: true }).check();
  await page.getByRole('button', { name: 'Продовжити' }).click();
  await page.getByLabel('Азія', { exact: true }).check();
  await page.getByRole('button', { name: 'Продовжити' }).click();
  await page.getByLabel('Email', { exact: true }).fill('ExpiryRace@example.test');
  await page.getByRole('button', { name: 'Підтвердити та підібрати' }).click();
  await expect(page.getByRole('button', { name: 'Повторити дію' })).toBeEnabled();
  expect(postsA).toBe(1);

  // Reload adopts the shortened deadline; every A is aborted before reaching the server.
  const saved = await page.evaluate(deadline => {
    const draft = JSON.parse(sessionStorage.getItem('unicorn.final.v1')!);
    draft.deadline = deadline;
    sessionStorage.setItem('unicorn.final.v1', JSON.stringify(draft));
    return { a: draft.a as string, b: draft.b as string, entry: draft.entry as string,
      user: draft.user as string, deadline: draft.deadline as number };
  }, lastContextTime + 8000);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Повторити дію' })).toBeEnabled();
  expect(postsA).toBe(2);
  const expiryAnchor = lastContextTime;
  const remaining = saved.deadline - expiryAnchor;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThanOrEqual(8000);
  resultReads.length = 0;
  holdNextContext = true;
  await page.getByRole('button', { name: 'Повторити дію' }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  expect(held!.serverTime).toBeLessThan(saved.deadline);
  await expect(page.locator('section.card')).toHaveAttribute('aria-busy', 'true');

  // Cross the exact stored boundary while the older real response is still in flight.
  await page.clock.fastForward(remaining);
  await expect(page.getByRole('status')).toContainText('Строк надсилання минув');
  const expired = await page.evaluate(() => JSON.parse(sessionStorage.getItem('unicorn.final.v1')!));
  expect(expired).toMatchObject({ ...saved, phase: 'expired' });
  expect(expired.email).toBeUndefined();
  expect(expired.view).toBeUndefined();

  await held!.route.fulfill({ response: held!.response });
  await expect(page.locator('section.card')).toHaveAttribute('aria-busy', 'false');
  // Both reads prove that the held context was accepted, rather than timing out.
  expect(resultReads).toEqual([saved.b, saved.a]);
  expect(postsA).toBe(2);
  expect(postsB).toBe(0);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('unicorn.final.v1')!))).toEqual(expired);
  await expect(page.getByRole('button', { name: 'Оновити контекст' })).toBeEnabled();
});
