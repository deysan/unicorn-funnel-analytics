---
title: 'M3 — пізні відповіді контексту вкладки'
type: 'bugfix'
created: '2026-11-01'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>

## Intent

За D-124 старі відповіді не змінюють стан іншої дії/екрана. Перевірка
контексту після повернення у вкладку має застосовувати success/error
та серверний час лише до чинної дії й чернетки. Зберегти ключі, дедлайн,
серверні команди й можливість пізнього commit. Без коміту.

</frozen-after-approval>

## Implementation Notes

Малий oneshot без нових бізнес-рішень і незворотних дій. Dirty tree —
погоджені попередні зміни M3, які користувач доручив накопичувати.
Code map: controller.ts visibility handler, run, getContext;
quiz.spec.ts — затримані browser responses. Перевірка власника probe
до оновлення clock; нова дія, hide та новий probe роблять старий нечинним.
Під час busy/Retry-After лише локальна перевірка TTL, без додаткового GET.


## Review Triage Log

- false: reviewer припустив спільну persistence Chromium/Firefox.
  scripts/run-smoke.mjs розділяє групи, e2e-server очищає тестову базу,
  playwright.config.ts обмежує інші проєкти critical-тестами.
  Рев’юер перечитав runner та відкликав finding. Решта findings: [].
- Тестова фікстура 19 спеціально містить Lead; загальний seed її пропускає.
  Проміжний прогін зупинено при цій колізії; залишений preview4173
  завершено перед чистою перевіркою. Dev persistence не змінювалася.


## Verification

Фінальний `CI=true npm run check`: exit 0, 431 Vitest, 75 Playwright,
типи/build. Нові 4 browser-регресії пройшли. Коміт не виконано за
дорученням власника; цей підкрок завершено, M3 загалом триває.
