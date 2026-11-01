import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page, Route } from '@playwright/test';
import type { Draft } from '../../src/client/draft';
import { test, expect } from './fixtures';

async function seed(context: BrowserContext, index: number) {
  const profiles = JSON.parse(await readFile('.wrangler/e2e-profiles.json', 'utf8')) as { id: string; token: string }[];
  await context.addCookies([{ name: '__Host-unicorn', value: profiles[index].token, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
}
async function reachEmail(page: Page) {
  await page.goto('/');
  for (const label of ['Жінки', 'Азія']) {
    await page.getByLabel(label, { exact: true }).check();
    await page.getByRole('button', { name: 'Продовжити' }).click();
  }
  await expect(page.getByLabel('Email', { exact: true })).toBeEnabled();
}
async function confirm(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Підтвердити та підібрати' }).click();
}
async function draft(page: Page): Promise<Draft> {
  const saved = await page.evaluate(() => sessionStorage.getItem('unicorn.final.v1'));
  expect(saved).not.toBeNull();
  return JSON.parse(saved!) as Draft;
}
async function visible(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test('visibility переплановує очищення за свіжим server_time до deadline @audit', async ({ page, context }) => {
  await seed(context, 80);
  await page.clock.install();
  await reachEmail(page);
  let aPosts = 0, bPosts = 0;
  page.on('request', request => { if (request.url().endsWith('/offer-selections')) bPosts++; });
  await page.route('**/email-confirmations', async route => { aPosts++; await route.abort(); });
  await confirm(page, 'Reschedule@example.test');
  await expect(page.getByRole('button', { name: 'Повторити дію' })).toBeEnabled();
  const before = await draft(page);
  await page.route('**/context?*', async route => {
    const current = await (await route.fetch()).json();
    await route.fulfill({ json: { ...current, server_time: before.deadline - 1000 } });
  });
  const response = page.waitForResponse(r => r.url().includes('/context?'));
  await visible(page);
  await (await response).finished();
  expect((await draft(page)).phase).toBe('a');
  await page.clock.runFor(1001);
  await expect(page.getByRole('status')).toContainText('Строк надсилання минув');
  const expired = await draft(page);
  expect(expired).toMatchObject({ phase: 'expired', a: before.a, b: before.b, entry: before.entry, deadline: before.deadline });
  expect(expired.email).toBeUndefined();
  expect(expired.view).toBeUndefined();
  expect(aPosts).toBe(1);
  expect(bPosts).toBe(0);
});

test('старий visibility identity_lost не перериває ще незавершений ручний retry @audit', async ({ page, context }) => {
  await seed(context, 81);
  await reachEmail(page);
  let aPosts = 0, bPosts = 0;
  await page.route('**/email-confirmations', async route => { aPosts++; await route.fetch(); await route.abort(); });
  page.on('request', request => { if (request.url().endsWith('/offer-selections')) bPosts++; });
  await confirm(page, 'ProbeOwnership@example.test');
  await expect(page.getByRole('button', { name: 'Повторити дію' })).toBeEnabled();
  const before = await draft(page);
  const contexts: Route[] = [];
  await page.route('**/context?*', route => { contexts.push(route); });
  await visible(page);
  await expect.poll(() => contexts.length).toBe(1);
  await page.getByRole('button', { name: 'Повторити дію' }).click();
  await expect.poll(() => contexts.length).toBe(2);
  const oldResponse = page.waitForResponse(r => r.url().includes('/context?') && r.status() === 401);
  await contexts[0].fulfill({ status: 401, json: { error: { code: 'identity_lost', message: 'Застаріла втрата доступу', retryable: false } } });
  await (await oldResponse).finished();
  // Власний GET retry ще утримується; даємо завершитися обробці старої відповіді.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  expect(await draft(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Відновити доступ' })).toHaveCount(0);
  await expect(page.getByRole('status')).not.toContainText('Застаріла втрата доступу');
  await contexts[1].continue();
  await expect(page.getByText('ClickID', { exact: true })).toBeVisible();
  expect(await draft(page)).toMatchObject({ phase: 'done', a: before.a, b: before.b, deadline: before.deadline });
  expect(aPosts).toBe(1);
  expect(bPosts).toBe(1);
});

for (const lookup of ['found', 'unavailable'] as const) test(`явний refresh простроченої B: ${lookup}, старі ключі без нового переходу @audit`, async ({ page, context }) => {
  // Профіль 19 уже має Lead: пропуск перевірки старої B одразу створив би новий перехід.
  await seed(context, 19);
  await page.clock.install();
  let entries = 0, bPosts = 0, click = '';
  page.on('request', request => { if (request.url().endsWith('/entries')) entries++; });
  await page.route('**/offer-selections', async route => {
    bPosts++;
    const result = await (await route.fetch()).json();
    expect(result.code).toBe('offer_selected');
    click = result.click_id;
    await route.abort();
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Повторити дію' })).toBeEnabled();
  const before = await draft(page);
  expect(before.phase).toBe('b');
  expect(click).not.toBe('');
  await page.clock.fastForward(86_400_001);
  await expect(page.getByRole('status')).toContainText('Строк надсилання минув');
  const expired = await draft(page);
  expect(expired).toMatchObject({ phase: 'expired', b: before.b, entry: before.entry, deadline: before.deadline });
  const operationUrl = '**/operations/' + before.b;
  let reads = 0;
  await page.route(operationUrl, async route => {
    reads++;
    if (lookup === 'unavailable' && reads === 1) {
      await route.fulfill({ status: 503, json: { error: { code: 'temporarily_unavailable', message: 'Результат тимчасово недоступний', retryable: true } } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Оновити контекст' }).click();
  if (lookup === 'unavailable') {
    await expect(page.getByRole('status')).toContainText('Результат тимчасово недоступний');
    expect(await draft(page)).toEqual(expired);
    expect(entries).toBe(1);
    expect(bPosts).toBe(1);
    await expect(page.getByText('ClickID', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Повторити дію' }).click();
  }
  await expect(page.locator('dd code')).toHaveText(click);
  expect(await draft(page)).toMatchObject({ phase: 'done', b: before.b, entry: before.entry, deadline: before.deadline });
  expect(reads).toBe(lookup === 'found' ? 1 : 2);
  expect(entries).toBe(1);
  expect(bPosts).toBe(1);
});

test('збій sessionStorage після B залишає результат і попередження; reload читає ту саму B @audit', async ({ page, context }) => {
  await seed(context, 83);
  await reachEmail(page);
  let aPosts = 0, bPosts = 0, click = '';
  page.on('request', request => { if (request.url().endsWith('/email-confirmations')) aPosts++; });
  await page.route('**/offer-selections', async route => {
    bPosts++;
    const response = await route.fetch();
    const result = await response.json();
    expect(result.code).toBe('offer_selected');
    click = result.click_id;
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      (window as unknown as { restoreAuditStorage: () => void }).restoreAuditStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = () => { throw new DOMException('blocked', 'QuotaExceededError'); };
    });
    await route.fulfill({ response });
  });
  await confirm(page, 'AfterB@example.test');
  await expect(page.getByText('ClickID', { exact: true })).toBeVisible();
  await expect(page.locator('dd code')).toHaveText(click);
  await expect(page.getByRole('status')).toContainText('Результат отримано, але не збережено в браузері');
  await expect(page.getByRole('button', { name: 'Повторити дію' })).toHaveCount(0);
  const pending = await draft(page);
  expect(pending.phase).toBe('b');
  expect(pending.email).toBeUndefined();
  expect(pending.view).toBeUndefined();
  expect(aPosts).toBe(1);
  expect(bPosts).toBe(1);
  await page.evaluate(() => (window as unknown as { restoreAuditStorage: () => void }).restoreAuditStorage());
  await page.reload();
  await expect(page.locator('dd code')).toHaveText(click);
  await expect(page.getByRole('status')).not.toContainText('не збережено в браузері');
  expect(await draft(page)).toMatchObject({ phase: 'done', a: pending.a, b: pending.b, entry: pending.entry, deadline: pending.deadline });
  expect(aPosts).toBe(1);
  expect(bPosts).toBe(1);
});
