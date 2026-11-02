# M4 — Cron та стійка доставка в імітатор

> Межі цього документа: етап станом на 2026-11-01. Проміжні статуси й
> результати нижче — історія відповідного етапу. Актуальний підсумок M0–M6:
> [хмарний реліз](m6-release-result.md), [план](plan.md).

Дата: 2026-11-01. Перший підкрок M4 реалізовано локально без коміту,
push або deploy. Підстава — пряме доручення власника та
[специфікація](bmad/implementation-artifacts/spec-m4-delivery.md).
Весь M4 завершено після [підсумкового аудиту](bmad/reviews/2026-11-01-m4/report.md),
включно з [cleanup і технічним станом](m4-retention.md).
Нижче збережено історію першого підкроку та його перевірки.

## Реалізовано

Один `* * * * *` у `wrangler.jsonc` викликає scheduled handler того самого
Worker; HTTP працює через попередній Hono fetch. Публічного маршруту
для запуску доставки чи приймача немає. Доставка не потребує браузера.

Перед claim один узгоджений SQL зріз звіряє `undelivered.used_count`
із pending + in_flight, з обмеженим проходом до 1001 рядка. Підтверджений
mismatch атомарно встановлює `integrity_paused` і `history_unverified`,
без ремонту count або автоматичного зняття паузи. Порожній здоровий
запуск не змінює постійних службових рядків.

Claim — guarded D1 batch з UPDATE RETURNING: до 10 готових рядків
за next_attempt_at/EventID, також expired leases. Новий token, lease
на 2 хвилини, attempt_count +1. Лише успішно повернений набір можна
надіслати. Невідомий commit завершує спробу без повтору claim чи send.

Експортер читає збережений payload, не перебудовує його з профілю чи
каталогу. Строгі schema_version=1 контракти відповідають поточним шести
типам бізнес-подій; не допускають email/відповідей/зайвих полів.
Пошкоджений snapshot лишається pending/backoff з `invalid_snapshot`,
інші готові події можуть доставлятися. Межі — 4 KiB подія, 64 KiB пакет,
10 подій; ACK — 8 KiB і до 10 результатів.

Внутрішній приймач окремим guarded batch записує mock_received_events
та читає результат. Той самий нормалізований зміст (незалежно від порядку
полів JSON) дає accepted; конфлікт не перезаписує payload чи accepted_at.
SHA-256 зберігається поруч, але тотожність перевіряється за повним
нормалізованим змістом. Копія приймача не входить до бізнес-звіту.

Таймаут 5 секунд охоплює отримання тексту ACK. Після таймауту пізній
результат не застосовується; можливий commit приймача без ACK безпечний
для повтору того самого ID. ACK спершу валідується цілком: exact fields,
version/status, лише надіслані ID без дублів. Некоректний ACK нічого
не підтверджує; пропущений ID повторюється.

ACK одним guarded batch змінює лише рядки з чинним token/lease.
Безпосередній `changes()` після кожного accepted UPDATE визначає
фактичне звільнення undelivered; stale=0 не заважає іншим рядкам.
Поріг 800→799 змінює epoch і знімає capacity pause; інші бюджети
незмінні. Retry/conflict/missing/timeout повертаються у pending:
1/2/4/8/15 хвилин від невдачі зі зменшенням 0–10%. Немає ліміту спроб,
який видаляє або доставляє подію. Невідомий ACK commit не компенсується.
Integrity-guard присутній у claim, receiver та ACK транзакціях.

## Режими та локальна перевірка

`MOCK_RECEIVER_MODE` у wrangler.jsonc явно `normal`; дозволено також
`unavailable` (збій до запису). Vite build перевіряє режим із прочитаного
Wrangler config; runtime також відхиляє відсутній/невідомий режим.
Решта аварійних режимів доступні лише тестовими залежностями, без HTTP.
Зміна режиму не скидає дані, backoff чи lease.

```sh
npm run test:worker -- tests/worker/delivery.test.ts
CI=true npm run check
```

Тести застосовують міграції до ізольованої локальної D1 через Workers
runtime; не читають dev persistence. Scheduled тест викликає справжній
handler із керованим серверним часом без HTTP/браузера. Матриця включає
11 подій, 7/10 ACK, втрату ACK після commit, repeat/conflict, некоректний
ACK, конкурентні claims/expired lease/stale ACK, невідомі commits,
таймаут/late ACK, integrity, corrupt snapshot, rollback ACK, epoch та
байтові межі. Перший цільовий запуск: **29/29**.
Перший повний `CI=true npm run check`: **exit 0, 469 Vitest, 88 Playwright**,
типізація та build; без test retries.

## Стан перевірок після BMAD review

Три незалежні контексти: blind-hunter/edge-case-hunter без findings;
verification-gap виявив дві прогалини тестів. Додано справжній шлях
quiz/partner producers → 13 подій усіх шести типів → receiver, з quiz/bypass
та Purchase із сумою/без; також точний пріоритетний набір 10 із 14 ready.
Reviewer повторно прочитав тести й підтвердив закриття обох прогалин.
Production-код за результатом review не змінювався. Цільові **31/31** пройшли.

## Межі доказу та джерела

Спільна D1 — спільний домен відмови. Імітатор не доводить роботу мережі,
авторизації чи квот справжнього BigQuery. Немає production throughput
або доказу вкладення у 10 мс CPU Free. Cleanup та відновлення довіри
після restore цим підкроком не реалізовано.

Офіційний [scheduled API](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
перевірено 2026-11-01. Композиція fetch/scheduled звірена з локальними
Wrangler types і схемою triggers.crons; додатково основний агент звірив
`@cloudflare/workers-types` 5.20261101.1 у тимчасовому каталозі без зміни
залежностей репозиторію. Ліміти й ресурсні припущення — у
[місткості та доставці](capacity-and-delivery.md), рішення D-055–060,
D-066/067, D-076, D-166–172 — у [журналі рішень](decisions.md).
