---
title: M4 — обмежене очищення й технічний стан Cron
status: 'done'
baseline_commit: 3c1edc9855e1a1ce48dd4e8fb49c7256d98e3d17
context:
  - AGENTS.md
  - docs/requirements.md
  - docs/decisions.md
  - docs/scenarios.md
  - docs/m4-delivery.md
  - docs/bmad/implementation-artifacts/spec-m4-delivery.md
  - migrations/0002_business_schema.sql
  - src/server/storage/transaction-guards.ts
  - src/server/storage/capacity.ts
  - src/server/delivery/executor.ts
  - src/server/report/read.ts
  - src/shared/report.ts
  - src/client/Report.tsx
  - docs/implementation-plan.md
---

## Доручення й межі

Користувач дозволив продовжити M4 без коміту. Мета — наявний Cron безпечно
звільняє прострочені дані й показує перевіряючому фактичний стан обслуговування.
У checkout вже є авторизована незакомічена доставка: зберегти її. Немає
нового deployment, сервісів, зовнішніх запитів, commit/push чи очищення dev D1.
Попередній D-111 gate залишається відкритим: один full-check дав generic503
на початковому question_view; bounded діагностика не відтворила причину.
Не оголошувати наступний pass виправленням. Локальні fixtures лише синтетичні.
Реалізаційні параметри порцій — технічний вибір, не нові бізнес-рішення.
Якщо погоджені джерела виявлять справжню суперечність, повідомити координатора.

## Code Map і правила

D-019/037/084/088–092/114–116/161/165/166 і SC-10–12 визначають cleanup.
`GuardedBatch` + `addIntegrityGuard` захищають кожну мутаційну транзакцію;
`releaseCapacity` звільняє лише фактичні видалення разом із counters/epoch.
`availableFrom` вже рахує консервативну межу звіту. FK RESTRICT не обходити.
`readStatus` і UI досі мають not_implemented; потрібен справжній стан.

TTL: email 30 діб від email_confirmed_at; results 7 від created_at;
events 90 від received_at; clicks 90 від created_at; profiles/Lead
180 неактивності від last_active_at. Повтори/постбеки строки не продовжують.
Після 7 діб результат стає tombstone (усі поля payload/fingerprint NULL),
ключ і command_keys лишаються. Після 180 профіль атомарно деактивується:
Lead видалити; created_at,last_active_at,prefs,email,email_confirmed_at,
access_secret_hash,revoked_at NULL; user_id,expired_at,revision лишити.
Рівно +1 revision за транзакцію фактичних змін email/prefs/Lead/deactivation;
очищення історії/результатів саме revision не змінює. Перевіряти TTL/активність
знову всередині batch, щоб конкурентна дія не була стерта.

Pending/in_flight events не видаляти. Delivered events після TTL очищати
лише без FK дітей (events entry/view/completion і clicks entry/completion),
спочатку event_delivery, потім events атомарно. Click після TTL можна
видалити незалежно від partner key; незмінний snapshot не потребує повного
click для експорту. Partner key видаляти лише коли немає ані click, ані
detailed event. Mock key — лише після видалення source event. Expired user
утримується незалежними events/clicks/partner_events; коли їх немає, видалити
command keys перед user в одній транзакції, не створювати tombstone-cycle.
Ключі можна видаляти обмеженими порціями, профіль — лише після останнього.
Облік фізичних rows і консервативна незворотна history boundary оновлюються
атомарно з видаленнями; null/invalid boundary не вигадувати й не приховувати.

## Tasks & Acceptance

- [ ] Додати additive migration `migrations/0005_maintenance.sql` і модулі
  `src/server/maintenance/`: bounded cleanup, hourly reconciliation, coordinator.
  Кожна категорія має явний скінченний cap, без циклу всієї історії; зберігати
  безпечний phase result/backlog (можна bounded has_more, без full scans щохвилини).
- [ ] Hourly claim атомарний до scan, тільки підтверджений переможець; один
  узгоджений SQL-зріз physical events/users/request_results проти counters;
  невідомий claim не сканує, failed scan не повторюється в цій UTC-годині.
  Missed hours не надолужуються. Зберегти attempt/read time та summary.
  Підтверджена mismatch атомарно ставить integrity_paused/history_unverified,
  без repair. Read failure не mismatch. Вже наявна пауза не скидається.
- [ ] `src/server/index.ts`: integrity checks → bounded cleanup → delivery;
  усі normal writes (включно cleanup) під integrity guard. Cleanup failure
  не зупиняє незалежну delivery; export failure не скасовує cleanup.
  Забезпечити що undelivered mismatch виявляється до cleanup, а existing
  runDelivery і його public tests залишаються сумісними.
- [ ] Оновити `src/shared/report.ts`, `src/server/report/read.ts`,
  `src/client/Report.tsx`: закритий технічний зріз без фільтрів, counters/limits,
  80/95% alerts і pause reason; oldest pending/inflight age (>15min), last
  Cron attempt/success (>5min), last ACK (порожній run не оновлює), errors
  count/safe codes, cleanup і reconciliation summaries. До першого run
  unknown, не healthy. Partial failures видно. D1 failure не нуль/green;
  existing UI stale behavior зберегти. No admin controls, secrets/payload.
- [ ] Додати ізольовані Worker/D1 тести cleanup+hourly+status і адаптувати
  існуючі report fixtures; мінімальний browser proof technical UI. Given
  boundary age, when cleanup runs, then exact TTL applies without early delete.
  Given retained dependencies/undelivered, then preserved until eligible.
  Given expired user with/without dependencies, then minimal/full removal,
  tombstone keys eventually removed with exact counter deltas.
  Given refreshed profile or concurrent parent reference, then atomic guard
  preserves accepted data. Given integrity pause then every cleanup no-op.
  Given mismatch then all normal writes pause, no autorepair; read error
  does not set mismatch. Given overlapping/unknown hourly claim then at most
  one scan; next hour can scan. Given expired children, then bounded repeated
  runs make progress and report window never regresses. Given empty run then
  Cron success advances but ACK does not. Given phase failure then independent
  delivery proceeds and status reports failure. Given thresholds/stale data
  then technical UI truthfully warns. Cover rollback counters/revision.
- [ ] Update `docs/m4-retention.md`, README, plan/implementation-plan and
  AI-worklog with actual results; no all-M4 completion or hidden D111.
  Node24.22.2 PATH, targeted Vitest then coordinator full npm check.

## Verification / review

Implementation agent runs focused tests/typecheck; coordinator runs full check
and independent blind/edge/verification reviews. Record results and triage here.


## Implementation evidence (2026-11-01)

Реалізовано migration0005, maintenance cleanup/hourly/coordinator, scheduled
інтеграцію, durable ACK time, status schema/read/UI, fixtures і документацію.
Технічні caps:2 на звичайну категорію,10 command keys; до45 D1 API calls
за invocation з резервом delivery. Офіційні D1 limits перевірено2026-11-01,
джерело/арифметика — docs/m4-retention.md.

Typecheck і build exit 0. Цільові maintenance + delivery + report =
**77/77**. Chromium technical-state smoke **1/1**. Diff-check exit 0.
Повний check та independent review залишено координатору; checkbox повного
acceptance не заявляє результатів, яких ще немає. Попередній D-111 відкритий.

## Review Triage Log

Три незалежні контексти: blind, edge, verification; третій після звільнення
слота, без попередніх findings. Edge повернув порожній перелік.

| Finding | Вердикт і доказ | Дія |
|---|---|---|
| LIMIT eligible keys не обмежує retained-row scans | medium: mock_keys перевіряє весь retained набір щохвилини; 4000 рядків дають 5,76 млн outer reads/добу, вище Free5млн ще до інших запитів. Аналогічні dependency-фільтри потребують bounded candidate examination. | Технічний patch: indexed bounded candidate windows/cursors, без зміни TTL, з тестом rows_read/progress і збереженням invocation cap. |
| Stale accepted ACK не перевірений на незмінність last_ack_at | medium regression gap: наявні тести перевіряють counter/status, а timestamp лише для успіху/empty run; removal changes() guard не був би помічений. | Patch: distinct-time stale/expired/repeated ACK timestamp assertions. |

Обидва findings передано оригінальному implementation-контексту.


### Review patch: bounded examination / ACK / logs

Cleanup використовує raw MATERIALIZED PK keyset windows перед predicate,
per-phase durable cursor із atomic read+advance; unknown window не видаляє,
wrap відновлює progress. 9 window batches замість 9 reads; max 45 calls збережено.
Partial delivery_current_errors index виключає delivered scan поточних помилок.
На 1000 users і по 4000 events/mock/partner/results: 326 cleanup rows_read і 1 error-count
row; EXPLAIN підтвердив індекс. Додано wrap/concurrency/unknown-window тести,
ACK last_ack_at assertions зі distinct timestamps та один safe Cron summary log.
Нових бізнес-правил/TTL немає; fullcheck/review лишаються координатору.

Фінальна цільова перевірка review-patch: maintenance31 + delivery32 =
**63/63**, exit 0. Повні тести/typecheck/build тут не повторювалися —
їх запускає координатор після повернення patch. Diff-check exit 0.
`has_more` описує raw traversal; TTL дозволяє очищення, не гарантує фізичне
стирання саме в момент deadline. D-111 залишається відкритим.

Original blind reviewer повторно прочитав raw-window/cursor/index зміни та
regressions: початковий finding закрито, залишкових проблем у його межах
не виявлено. Original verification reviewer перевірив assertions через
readStatus: repeated ACK у пізніший час не змінює попередній timestamp,
замінений token і expired lease лишають null. Прогалину закрито.
Reviewers тестів повторно не запускали; implementation targeted 63/63 пройшов.
Основний агент додатково перевірив safe summary log за D-084, partial index
поточного errorcount та документування raw has_more/physical TTL lag.

До review patches повний check: exit 0,496 Vitest + 89 Playwright, types/build.
Після production patches запущено новий повний check; результат нижче.

Фінальна перевірка: `CI=true npm run check` exit 0,
503 Vitest + 89 Playwright, типи/build пройшли. 514 локальних посилань валідні,
226 repo/client файлів без збігів із секретами; diff-check пройшов.
Status лишається in-review через попередній незакритий D-111 generic 503;
поточні passes не доводять причину чи виправлення. Без commit/push/deploy.

Наступне доручення власника дозволило одноразовий виняток для цього
інциденту, якщо bounded діагностика не знайде причину. Перевірено 84/84,
production-код не змінено; причина невідома. [Звіт і межі дозволу](../../m4-q1-incident.md).
Поточний status — ready-for-final-audit, загальне D-111 не послаблено.

## Підсумковий аудит M4 — 2026-11-01

Умови етапу виконано, підтверджені findings закрито. Фінальний check:
517 Vitest + 89 Playwright, типи/build — exit 0. Поточний ліміт Cron —
46 D1 calls; оптимізовано службові writes, додано receiver mode й точний
Cron status. Проміжні результати вище збережено як історію.
Деталі — [звіт аудиту](../reviews/2026-11-01-m4/report.md).
Власник дозволив один локальний коміт усього M4; push/deploy не виконувалися.
