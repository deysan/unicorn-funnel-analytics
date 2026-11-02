---
title: 'M4 — Cron та стійка доставка в імітатор'
type: 'feature'
created: '2026-11-01'
status: 'done'
route: 'dispatch'
baseline_commit: '3c1edc9855e1a1ce48dd4e8fb49c7256d98e3d17'
review_loop_iteration: 0
context: ['docs/decisions.md', 'docs/capacity-and-delivery.md', 'docs/implementation-plan.md', 'AGENTS.md']
---

<frozen-after-approval>

## Intent

Почати M4: прийняті події доставляються без участі браузера через один
Cron щохвилини до внутрішнього стійкого імітатора. Підстава — пряме
доручення власника реалізувати цей підкрок без коміту та погоджені
D-055–060, D-066/067, D-076, D-166–172. Нових бізнес-рішень немає.

## Boundaries & Constraints

Завжди: до 10 готових подій, одна спроба пакета; timeout приймача разом
із ACK 5 с, lease 2 хв без подовження. Спроби збільшуються при claim.
Backoff 1/2/4/8/15 хв від невдачі зі зменшенням 0–10%, без видалення
через кількість спроб. Відбір next_attempt_at, EventID; expired lease
дозволяє новий claim. Надсилаємо лише підтверджено захоплені рядки.
Знімок events незмінний, schema_version=1, 4 KiB подія /64 KiB пакет.
Приймач окремою транзакцією записує mock_received_events, порівнює
нормалізований зміст, незмінний accepted_at, однаковий accepted для
нового й відомого повтору; конфлікт не перезаписує старе.
ACK schema_version=1/results, лише event_id/status accepted|retry|conflict,
до 10 елементів/8 KiB, без невідомих ID, дублів чи зайвих полів.
Некоректний ACK не підтверджує нічого; відсутні ID повторюються.
ACK зміни й зменшення undelivered атомарні; лише фактично прийняті з
чинним token та lease. Застарілі результати пропускаємо незалежно від
інших рядків. Паузи/epoch використовують чинні правила місткості.
Перед доставкою узгоджена звірка undelivered: підтверджений mismatch
ставить integrity_paused/history_unverified без виправлення count.
Integrity-guard перевіряється також транзакціями claim, ACK і приймача.
Режими normal/unavailable — конфіг; решта збоїв лише локальні тести.
Ніколи: commit/push/deploy, реальний BigQuery/партнер, публічний endpoint
приймача, очищення dev-бази, нові залежності без необхідності. Повний
cleanup та щогодинна звірка інших бюджетів залишаються наступним підкроком.

## I/O & Edge-Case Matrix

| Стан | Очікуваний результат |
|---|---|
| 11 ready | 10 доставлено, 1 лишається; наступний запуск доставляє залишок |
| Partial 7/10 | 7 delivered, 3 pending/backoff; count зменшено лише на7 |
| Receiver commit, ACK втрачено | повтор тих самих ID; одна копія, accepted_at незмінний |
| Conflict | pending з кодом conflict; старий payload/лічильник незмінні |
| Invalid/duplicate/foreign ACK | жодного accepted, без звільнення бюджету |
| Concurrent claim/expired lease/stale ACK | лише чинний власник змінює рядок; stale не впливає на інші |
| Unknown claim commit | не надсилати й не повторювати claim в цьому запуску |
| Unknown ACK commit | не компенсувати count, наступний запуск читає стан |
| Timeout/unavailable | pending/backoff, пізня відповідь не застосовується |
| Integrity pause/mismatch | доставки/receiver мутації блокуються; mismatch не ремонтує count |
| Corrupt/unsupported snapshot | не перебудовувати, не delivered; інші готові можуть рухатись |

</frozen-after-approval>

## Code Map

- `src/server/index.ts`: Hono HTTP export; додати scheduled без зміни HTTP.
- `wrangler.jsonc`: локальний runtime; triggers.crons і mode var.
- `migrations/0002_business_schema.sql`: events,
  event_delivery, mock_received_events, capacity_control/system_control вже є.
- `src/server/storage/transaction-guards.ts`: GuardedBatch та SQL CHECK.
- `src/server/storage/capacity.ts`: integrity, epoch і поріг resumeBelow.
- `src/server/quiz/commands.ts`, `src/server/partner/events.ts`: фактичні
  експортні payload; не змінювати бізнес-події/їх snapshots.
- `tests/worker/helpers/business-db.ts`: синтетична D1 ізоляція; fixtures
  мають узгоджені counters, актуальний повний payload, не слабші контракти.

## Tasks & Acceptance

- [x] `src/server/delivery/` — контракт payload/ACK, receiver, claim/ACK executor,
  timeout, backoff, обмежена звірка undelivered; параметризований SQL.
- [x] `src/server/index.ts`, `wrangler.jsonc` — scheduled handler, normal mode.
- [x] `tests/worker/delivery.test.ts` — матриця на справжній локальній D1;
  faults через залежності/моки, не public HTTP endpoints.
- [x] `docs/m4-delivery.md`, `docs/plan.md`, `docs/ai-worklog.md`, README —
  фактичний статус, межі та запуск локальної перевірки.

Given прийнята подія, when scheduled працює без браузера, then snapshot
стійко записаний у receiver та delivered звільняє лише undelivered.
Given збої/конкуренція матриці, when наступний Cron відновлюється, then
прийняті events збережені й бізнес-звіт не отримує дубльованих подій.

## Implementation Notes

Явне доручення користувача та чинні рішення дозволяють реалізацію без
повторного approval. Рішення за специфікацією не розширюють MVP.
Офіційний scheduled API перевірено 2026-11-01:
https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
Композиція fetch + scheduled підтримується; локальні тести не доводять CPU Free.

## Verification

PATH: /Users/deysan/.nvm/versions/node/v24.22.2/bin.
Цільовий Worker тест, потім `CI=true npm run check`, без test retries.
Тести не запускають deploy і не використовують dev persistence.

## Review Triage Log

BMAD Build: blind-hunter і edge-case-hunter повернули порожні переліки.
Verification-gap виконувався в окремому контексті після звільнення слота,
без доступу до попередніх findings. Квоту проблем прибрано за AGENTS.md.

| Finding | Вердикт / підстава | Дія |
|---|---|---|
| Сумісність фактичних snapshots усіх шести типів не покрита | medium: positive delivery fixtures були лише funnel_entered; зміна optional currency могла б непомітно блокувати Purchase | patch: тест реальних quiz/partner producers → delivery, quiz/bypass і Purchase ±amount |
| Тест claim order не перевіряє пріоритетний набір понад 10 | medium: 3 рядки вміщуються, 11-row тест рахував лише кількість; DESC регресія лишалася непомітною | patch: понад10 готових, різні часи та tie, точний набір10 і pending залишок |

Обидва patches виконано у tests/worker/delivery.test.ts. Цільовий набір
31/31 пройшов. Verification reviewer повторно прочитав тести: обидві
прогалини закриті, production-код за результатами review не змінювався.

## Підсумковий аудит M4 — 2026-11-01

Умови етапу виконано, підтверджені findings закрито. Фінальний check:
517 Vitest + 89 Playwright, типи/build — exit 0. Поточний ліміт Cron —
46 D1 calls; оптимізовано службові writes, додано receiver mode й точний
Cron status. Проміжні результати вище збережено як історію.
Деталі — [звіт аудиту](../reviews/2026-11-01-m4/report.md).
Власник дозволив один локальний коміт усього M4; push/deploy не виконувалися.
