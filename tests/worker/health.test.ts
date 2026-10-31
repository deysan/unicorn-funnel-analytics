import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/server/index';

describe('HTTP у Workers runtime', () => {
  it('читає реальну локальну D1 через основний handler', async () => {
    const response = await exports.default.fetch('https://example.test/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok', value: 1 });
  });

  it('відповідає JSON 404 для невідомого API', async () => {
    const response = await exports.default.fetch('https://example.test/api/v1/missing');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      code: 'not_found', message: 'Маршрут не знайдено.', retryable: false,
    });
  });

  it('при збої binding повертає 503 без внутрішніх подробиць', async () => {
    // Контрольований збій тільки цього виклику; справжній binding не змінюємо.
    const failingDB = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === 'prepare') return () => { throw new Error('private-diagnostic-marker'); };
        return Reflect.get(target, property, receiver);
      },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://example.test/api/v1/health'), { ...env, DB: failingDB }, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      code: 'database_unavailable',
      message: 'Локальна база даних недоступна. Спробуйте ще раз.',
      retryable: true,
    });
  });
});
