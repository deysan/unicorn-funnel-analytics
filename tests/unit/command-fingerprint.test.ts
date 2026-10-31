import { beforeAll, expect, it } from 'vitest';
import { createCommandFingerprint, importFingerprintKey, verifyCommandFingerprint, type FingerprintKeyring, type NormalizedJson } from '../../src/server/storage/command-fingerprint';

let keyring: FingerprintKeyring;
const context = { userId: 'synthetic-user', operationId: 'synthetic-operation', operationType: 'answer', business: { a: 1, b: [true, null] } };
beforeAll(async () => {
  keyring = { currentVersion: 'v1', keys: new Map([['v1', await importFingerprintKey(new Uint8Array(32).fill(1))]]) };
});

it('фіксує байтовий формат 1 незалежним контрольним HMAC-вектором', async () => {
  // Розраховано окремо через node:crypto для явно заданого канонічного рядка.
  expect(await createCommandFingerprint(context, keyring)).toEqual({
    fingerprint: '7f2d1ff48ab308d6657a541c92ade46518be5e4bf7ea636e6c0a9f2406224a9e',
    keyVersion: 'v1', formatVersion: 1,
  });
});

it('порядок полів об’єкта не змінює відбиток, порядок масиву змінює', async () => {
  const original = await createCommandFingerprint(context, keyring);
  expect(await createCommandFingerprint({ ...context, business: { b: [true, null], a: 1 } }, keyring)).toEqual(original);
  expect(await verifyCommandFingerprint({ ...context, business: { a: 1, b: [null, true] } }, original, keyring)).toBe(false);
});

it.each(['userId', 'operationId', 'operationType'] as const)('пов’язує HMAC з %s', async (field) => {
  const original = await createCommandFingerprint(context, keyring);
  expect(await verifyCommandFingerprint({ ...context, [field]: 'different' }, original, keyring)).toBe(false);
});

it('не нормалізує бізнес-значення вдруге й розрізняє відсутність та null', async () => {
  const original = await createCommandFingerprint({ ...context, business: { email: 'Name@example.test' } }, keyring);
  expect(await verifyCommandFingerprint({ ...context, business: { email: 'name@example.test' } }, original, keyring)).toBe(false);
  expect(await createCommandFingerprint({ ...context, business: {} }, keyring))
    .not.toEqual(await createCommandFingerprint({ ...context, business: { x: null } }, keyring));
});

it.each([undefined, NaN, Infinity, new Date(0), { x: undefined }])('відхиляє не-JSON зміст %#', async (business) => {
  await expect(createCommandFingerprint({ ...context, business: business as NormalizedJson }, keyring))
    .rejects.toThrow('fingerprint_invalid_content');
});

it('слабкий ключ, невідома версія ключа або формату не стають конфліктом', async () => {
  await expect(importFingerprintKey(new Uint8Array(8))).rejects.toThrow('fingerprint_invalid_key');
  const original = await createCommandFingerprint(context, keyring);
  await expect(verifyCommandFingerprint(context, { ...original, keyVersion: 'missing' }, keyring)).rejects.toThrow('fingerprint_unavailable');
  await expect(verifyCommandFingerprint(context, { ...original, formatVersion: 99 }, keyring)).rejects.toThrow('fingerprint_unavailable');
});
