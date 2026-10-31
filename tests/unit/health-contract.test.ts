import { describe, expect, it } from 'vitest';
import { healthSchema } from '../../src/shared/health';

describe('контракт технічної відповіді', () => {
  it('приймає повний результат успішного запиту', () => {
    const payload: unknown = { status: 'ok', database: 'ok', value: 1 };
    expect(healthSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    ['рядок замість числа', { status: 'ok', database: 'ok', value: '1' }],
    ['неповна відповідь', { status: 'ok' }],
    ['невдалий результат D1', { status: 'ok', database: 'ok', value: 0 }],
    ['null замість відповіді', null],
    ['зайве поле', { status: 'ok', database: 'ok', value: 1, debug: 'internal' }],
  ])('відхиляє: %s', (_label, payload) => {
    expect(healthSchema.safeParse(payload).success).toBe(false);
  });
});
