import { test, expect } from '@playwright/test';

test('UI отримує результат справжнього локального запиту Worker → D1', async ({ page }) => {
  await page.goto('/');
  const responsePromise = page.waitForResponse('/api/v1/health');
  await page.getByRole('button', { name: 'Перевірити з’єднання' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ok', database: 'ok', value: 1 });
  await expect(page.getByRole('status')).toContainText('З’єднання працює. D1 повернула: 1.');
});

test('невідомий API повертає JSON 404, включно з навігаційним запитом', async ({ request }) => {
  const response = await request.get('/api/v1/unknown', { headers: { 'Sec-Fetch-Mode': 'navigate' } });
  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ code: 'not_found', message: 'Маршрут не знайдено.', retryable: false });
});

test('мережева помилка дозволяє ручний повтор', async ({ page }) => {
  await page.goto('/');
  await page.route('**/api/v1/health', (route) => route.abort());
  await page.getByRole('button').click();
  await expect(page.getByRole('status')).toContainText('Не вдалося');
  await page.unroute('**/api/v1/health');
  await page.getByRole('button').click();
  await expect(page.getByRole('status')).toContainText('З’єднання працює');
});

test('невалідна відповідь не видається за успіх', async ({ page }) => {
  await page.goto('/');
  await page.route('**/api/v1/health', (route) => route.fulfill({ json: { status: 'ok' } }));
  await page.getByRole('button').click();
  await expect(page.getByRole('status')).toContainText('Не вдалося');
});
