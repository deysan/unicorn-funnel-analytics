import { expect, it } from 'vitest';
import { normalizeEmail } from '../../src/shared/email';

it.each([
  ['  Demo.Name+tag@EXAMPLE.TEST  ', 'Demo.Name+tag@example.test'],
  ['A!#$%&\'*+/=?^_`{|}~-@demo.example', 'A!#$%&\'*+/=?^_`{|}~-@demo.example'],
  ['a@XN--DEMO-TEST.example', 'a@xn--demo-test.example'],
  ['a@a.1', 'a@a.1'],
])('нормалізує лише краї U+0020 та домен: %s', (input, expected) => {
  expect(normalizeEmail(input)).toBe(expected);
});
it.each([
  '', null, 1, 'a', 'a@@example.test', '.a@example.test', 'a.@example.test', 'a..b@example.test',
  'a b@example.test', 'a@example', 'a@-example.test', 'a@example-.test', 'a@example..test',
  'a@exam_ple.test', 'a@example.test.', 'a@[127.0.0.1]', '"a"@example.test', 'Demo <a@example.test>',
  'a@example.test,b@example.test', 'a(comment)@example.test', 'а@example.test', 'a@приклад.test',
  '\ta@example.test', 'a@example.test\n', 'a@example.test\r', '\u00a0a@example.test', 'a\0@example.test',
  `${'a'.repeat(65)}@example.test`, `a@${'a'.repeat(64)}.test`,
])('відхиляє непідтримуваний або неправильний email', (input) => {
  expect(normalizeEmail(input)).toBeNull();
});
it('перевіряє точні межі 64/63/254 після нормалізації', () => {
  const local = 'a'.repeat(64);
  const domain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(61)}`;
  const email = `${local}@${domain}`;
  expect(email.length).toBe(254);
  expect(normalizeEmail(` ${email} `)).toBe(email);
  expect(normalizeEmail(`${email}c`)).toBeNull();
});
