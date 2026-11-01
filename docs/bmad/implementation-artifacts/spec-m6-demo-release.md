---
title: 'M6 — підготовка та ручний реліз демо на Free'
type: 'feature'
created: '2026-11-01'
status: 'in-review'
route: 'dispatch'
baseline_commit: '12e5cc1854803add1ae090065c26e6e264fc3c92'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/implementation-plan.md'
  - '{project-root}/docs/demo-walkthrough.md'
  - '{project-root}/docs/report-operations.md'
---

<frozen-after-approval reason="доручення власника перейти до M6; чинні D-096–111/172/177">

## Intent

**Проблема:** M0–M5 перевірено локально; конфігурація й IP-адаптер поки
локальні. Потрібне одне відтворюване хмарне демо за планом M6.

**Підхід:** підготувати cloud IP, окремий demo build/config, захисні перевірки
релізу та малий smoke. Після підтвердження Free виконати міграції, перевірити
схему, вручну розгорнути Worker/assets і зафіксувати фактичний результат.

## Boundaries & Constraints

**Завжди:** лише Workers Free + одна D1; сім limiter bindings із чинними
бюджетами; HTTPS; HMAC IP без журналювання адрес; захищений звіт; секрети
поза Git/argv/виводом. Local/tests ізольовані від cloud. D-099 вимагає
чистий перевірений коміт, D-108/D-177 — локальні перевірки та CI або
обґрунтований локальний шлях. Для rate-limit binding власник 2026-11-01
погодив малий практичний deploy на підтвердженому Free без upgrade,
з перевіркою binding та billing після запуску; інші невідомі тарифи
блокують зовнішній крок.

**Ніколи:** Paid, reset/restore, зміна бізнес-контрактів, реальні партнерські
переходи чи листи, benchmark, cloud secrets у CI, автоматичний deploy на push.
Перший history boundary лише після доказу новоствореної БД й до Worker/Cron;
повторний deploy не змінює history metadata або бізнес-дані.

## I/O & Edge-Case Matrix

| Стан | Дія | Очікування |
|---|---|---|
| Валідна довірена IPv4/IPv6 | Cloud request | Канонічний HMAC-ключ; еквівалентні адреси дають однаковий ключ |
| Немає IP, адреса некоректна або proxy-path недовірений | Cloud request | 503 rate_limit_unavailable / Retry-After 30, без бізнес-змін |
| Local runtime | Підставлені forwarded headers | Чинний локальний синтетичний адаптер, заголовки ігноруються |
| Небезпечний demo config | Перевірка build/release | Відмова до зовнішніх дій: local flag, placeholder D1, origin, mode, limiter drift |
| Чинний demo config | Build | Worker/assets; серверні секрети відсутні в артефакті |

</frozen-after-approval>

## Code Map

- `src/server/http/security.ts`: ipKey/localRequest; місце cloud-адаптера;
  не змінювати limit/auth/cookie/бізнес-протокол.
- `wrangler.jsonc`, `vite.config.ts`: нині локальні. Вибір demo config має
  бути явним; валідувати саме використаний конфіг. Локальний default зберегти.
- `scripts/report-history.ts`: newHistorySql повторно використати з доказом
  нової БД; міграції 0001–0005 не переписувати.
- `scripts/partner-cli.ts`, `tests/smoke/partner-cli.spec.ts`: готовий HTTPS CLI,
  зразок UI-проходження; cloud smoke не використовує seeded UserID/SQLite.
- `src/server/maintenance/coordinator.ts`, `src/server/http/report.ts`:
  Cron та status; публічного запуску/перемикача не додавати.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/demo-artifact.ts` — artifact/config/secret guard, SHA/hash seal
  і відмова релізу для dirty/stale пакета; без автоматичного deploy.
- [x] `src/server/http/security.ts`, `tests/worker/cloud-ip.test.ts` — cloud
  IP adapter з валідованим CF-Connecting-IP, канонізацією, fail-closed;
  тестувати IPv4/IPv6, missing/invalid/forwarded, відсутність мутацій.
- [x] `scripts/demo-config.ts`, `vite.config.ts`, `package.json`,
  `tsconfig.node.json`, `tests/unit/demo-config.test.ts` — окремий demo config
  та явний build/guard. Resource ID/origin задаються оператором без заглушок;
  секрети не генерувати у tracked файлах. Deployment config відтворюється
  з перевірених параметрів, не з довільного копіювання local config.
- [x] `scripts/demo-schema.ts`, відповідний unit-тест — read-only SQL/schema
  gate для міграцій, таблиць/колонок/індексів, foreign keys і controls;
  перевірка не повинна сама ремонтувати БД. Перевірити на локальній ізольованій
  D1. Лише runbook застосовує чинні міграції й newHistorySql.
- [x] `scripts/demo-smoke.mjs` — окремий bounded Chromium smoke через HTTPS
  та CLI без local DB/reset. Baseline звіту, новий context, women/asia/email,
  офер 003, Lead, bypass, Purchase/replay/друга Purchase, точні прирости;
  credentials лише env; жодних сирих HTTP bodies/headers у помилках.
- [x] `docs/m6-release.md`, `README.md`, `docs/plan.md`, `docs/ai-worklog.md`
  — runbook, офіційні датовані джерела й чесний стан gate/test/deploy.

**Acceptance Criteria:**
- Given локальна база, when звичайний npm run check, then усі рівні
  проходять без remote binding, пропусків та retries цілих тестів.
- Given підтверджені Free й перевірений release SHA, when ручний реліз,
  then міграція → schema gate → Worker/assets → bounded smoke;
  збій зупиняє послідовність без rollback даних.
- Given реальна cloud D1, when smoke, then прирости entered/completed/
  transitioned/bypass/leads/buyers/purchases = 1/1/1/1/1/1/2;
  реальний Cron підтверджений окремими спостереженнями.
- Given режим unavailable, when ручний deploy і синтетичні події, then
  delivery error/pending видно через status; після normal та backoff ACK
  поновлюється без reset. Цей cloud крок виконує основний агент після gates.

## Implementation Notes

Доручення M6 уже дозволяє необхідні локальні зміни й ручне розгортання;
нових бізнес-рішень spec не приймає. Основний агент виконує перевірки акаунта,
операційні gates і зовнішні дії. Виконавець spec готує лише локальний код,
тести та runbook; не комітить, не пушить, не створює хмарних ресурсів.
Невідомі параметри залишаються входами команд, а не вигаданими значеннями.

## Spec Change Log

- 2026-11-01: implementation task уточнено artifact seal/guard за D-099;
  frozen intent/acceptance не змінено виконавцем.

## Review Triage Log

Три незалежні context-free layers завершені 2026-11-01; без квоти знахідок.
Blind review не знайшов доказових дефектів. Кожна знахідка інших layers нижче.

| Знахідка | Вердикт | Доказ і маршрут |
|---|---|---|
| Verification: різні cloud IP не перевірено на різні HMAC | medium | Тести рівності пропустять константний ключ для всіх клієнтів; спільний бюджет порушить ізоляцію IP. Patch: assertions нерівності IPv4/IPv6. |
| Verification: зміна bundle після seal без регресійного тесту | medium | CI не викликає artifact release; видалене порівняння manifest залишиться непоміченим. Patch: справжній CLI в ізольованому repo, success до зміни і rejection після. |
| Edge: timeout скасовано перед browser.close | medium | Playwright close не має власного timeout; зависле закриття виходить за 180 секунд. Patch: тримати watchdog до завершення close. |

Виправлення: 14/14 cloud-IP тестів, 1/1 artifact CLI, `node --check`
smoke — успішно. Таймер очищується лише після browser.close. Відкладених
знахідок немає. Повний check після patch: 569 Vitest, 89 Playwright, типи/build, exit 0;
`.wrangler/m6-reviewed-check.log`. Хмарні acceptance criteria ще pending.

## Verification

- Targeted unit/Worker tests, локальний schema gate, demo build із
  синтетичними конфігураційними параметрами (не доказ cloud deployment).
- `CI=true npm run check` після змін — типи, Vitest, build, п'ять browser
  configurations. Падіння діагностувати за D-111, не перезапускати до green.
- Read-only audit diff/посилань; cloud smoke лише після всіх передумов.
