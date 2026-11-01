# M4 — retention і технічний стан

Дата: 2026-11-01. Реалізовано локально за
[специфікацією](bmad/implementation-artifacts/spec-m4-retention.md), без
коміту/push/deploy. Збережено наявну [доставку](m4-delivery.md).
Весь M4 завершено після [підсумкового аудиту](bmad/reviews/2026-11-01-m4/report.md).
Нижче збережено історію підкроку. Після [діагностики Q1 503](m4-q1-incident.md)
власник дозволив одноразовий виняток D-111; причину не встановлено,
виправлення не приписуємо.

## Реалізація

Міграція `0005_maintenance.sql` додає singleton технічного стану без
секретів або payload. Scheduled handler спершу перевіряє undelivered,
виконує щогодинну звірку, потім bounded cleanup і незалежну доставку.
Підтверджений mismatch ставить integrity/history pause без ремонту
лічильників. Невдале читання не є mismatch. Кожна звичайна cleanup
транзакція має integrity guard; помилка cleanup не скасовує delivery,
помилка експорту не відкочує завершене очищення.

Email дозволено очищати не раніше 30 діб від підтвердження, результати —
7 від створення, events — 90 від отримання, clicks — 90 від створення,
профіль/Lead — 180 неактивності. TTL визначає eligibility, а не точний
момент фізичного стирання: рядок дочекається свого вікна й відсутності
залежностей. Логічний строк доступу від затримки Cron не подовжується.
Уся eligibility перевіряється знову
в mutation batch. Email/deactivation змінюють revision рівно один раз
за фактичну транзакцію; tombstone результату та історія — ні.

Недоставлені events лишаються. Delivered event видаляється тільки без
FK дітей, delivery перед event. Click можна видалити без partner key:
доставка використовує незмінний payload. Partner key лишається, поки
існує click або відповідний detailed event; mock key — поки source event.
Expired user стає мінімальним рядком, поки незалежна історія його утримує.
Після її зникнення command keys очищаються порціями, user — після
останнього ключа. Звільнення counters/epoch та event history boundary
атомарні з фактичним видаленням. Невідома/неправильна boundary блокує
видалення event; metadata не вигадуються. Boundary ніколи не зменшується.

Кожна з восьми звичайних категорій обробляє до **2** raw кандидатів;
command keys — до **10**, плюс один lookahead рядок на вікно. Окремі курсори рухаються за незмінним PK;
composite ключ результатів — `(user_id, operation_id)`. `MATERIALIZED`
вікно `cap+1` береться індексним keyset seek **до** TTL/dependency predicates.
`has_more` означає наступне raw вікно, а не кількість eligible видалень.
Прочитане вікно, контроль паузи й просування курсора — один атомарний batch.
Сам UPDATE cursor має SQL-умову `integrity_paused = 0` і виконується лише
за зміни значення; тимчасові assertion-рядки для вікна не створюються.
Невідомий результат не дозволяє мутацій. Фактичне очищення зберігає
`GuardedBatch` із повторною перевіркою паузи та eligibility.
Кінець таблиці скидає cursor для наступного
обходу: пропущені через збій/конкуренцію рядки та вставки позаду курсора
будуть розглянуті знову. Утримуваний префікс не блокує обхід.

Верхня межа: 26 mutation batches + 9 cursor/window batches + 11 операцій
coordinator/hourly/delivery = **46** D1-запитів за invocation у штатному
максимальному шляху. Невдалий hourly scan має додаткову спробу запису
failure, але cleanup тоді пропускається. Receiver використовує один batch.
Count поточних помилок використовує partial index `delivery_current_errors`,
тому delivered-історія не сканується щохвилини.

Перевірено 2026-11-01 за офіційними
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/): Free
має 50 queries/invocation, а batch рахується як один query. Це облік
API-викликів, не гарантія CPU чи всіх добових квот. Замість попереднього
LIMIT після dependency-фільтра обмежено саме raw examination. Локальний
тест із 1000 профілями й по 4000 events/mock/partner/results перевіряє
всі дев'ять cleanup window batches і count помилок серед 4000 delivered;
`EXPLAIN QUERY PLAN` підтвердив partial index. До оптимізації writes
виміряно **326 rows_read** для вікон і **1** для count помилок.
Регресійні пороги — <1000 та <10 відповідно, без фіксації несуттєвих
відмінностей лічильника runtime. Це конкретна фікстура, не load-test.

Щогодинний claim фіксується перед scan. Лише підтверджений переможець
читає фізичні events/users/request_results та відповідні counters одним
SQL-зрізом; summary й mismatch pause записуються в тому самому batch.
Unknown claim не сканує, failed scan не повторюється в цій UTC-годині,
пропущені години не надолужуються. Старі integrity/history pause не
знімаються навіть після наступної matched звірки.

## Технічний звіт

Закритий status endpoint не має фільтрів чи admin controls. Він показує
counters/limits, ≥80/95% alerts, причину паузи, delivery counts, вік
найстарішого pending/in_flight (>15 хв), останні Cron attempt/success
(>5 хв), ACK лише після фактичного accepted update, безпечні error codes
із кількістю, cleanup та reconciliation summaries. До першого запуску
стан unknown. Порожній успіх рухає Cron success, але не ACK. Збій D1
повертає недоступність, не нулі; UI прибирає недостовірний технічний зріз,
як і раніше, зберігаючи незалежну поведінку бізнес-звіту. Кожен Cron
пише один safe summary: delivery/hourly, phase changed/skipped/has_more/error
та safe error codes; info на успіх, warn на помилку. Ідентифікаторів рядків,
адрес і payload у цьому журналі немає.

## Фактична перевірка

Node 24.22.2, локальні синтетичні fixtures, dev D1 не очищувалася.

- `npm run typecheck` — exit 0.
- `npx vitest run --config vitest.worker.config.ts tests/worker/maintenance.test.ts tests/worker/delivery.test.ts tests/worker/report.test.ts` — **77/77**, exit 0.
- `npm run build` — exit 0.
- `CI=true npm run test:smoke -- --project=chromium --grep='technical state'` — **1/1**, exit 0; unknown, alerts, stale/partial failures і недоступний D1-зріз.
- `git diff --check` — exit 0.

Maintenance suite покриває точні TTL без раннього видалення, залежності,
retained minimal users, bounded повтори й ключі, email/result ревізії,
конкурентну активність/нового FK-нащадка, rollback Lead/profile та
history/counters, pause, null/invalid metadata, hourly overlap/unknown
claim/read failure/наступну годину, три mismatch без repair,
незалежність cleanup/delivery, ACK порожнього запуску, threshold/stale
status та редагування небезпечних error codes. Окремий тест рахує D1 API
операції координатора; наявні публічні delivery tests збережено.

## Виправлення після review

Raw cursor windows усувають full retained scans попереднього eligible LIMIT;
partial index прибирає scan delivered із minute-level count. Додано докази
wrap/insert-behind, конкурентних вікон, unknown committed window без deletion,
безпечного summary log та ACK timestamp для stale/repeated/expired ACK.
Фінальний цільовий запуск лише maintenance+delivery: **63/63**, exit0,
після уточнення ORDER BY у bounded window. `git diff --check` — exit0.
Повний check — у координатора; D-111 не закритий.

## Фінальна перевірка після review

`CI=true npm run check`: **exit 0, 503 Vitest + 89 Playwright**, типи/build пройшли.
Браузерні групи: 26 + 24 + 6 + 9 + 4 + 2 + 14 + 4; CLI 2/2.
Лог: `/tmp/unicorn-m4-retention-final-check.log` поза репозиторієм.
514 локальних Markdown-посилань валідні; 226 repo/client файлів без збігів
із секретами середовища; `git diff --check` пройшов. Original reviewers
повторно прочитали fixes й підтвердили закриття; тестів не перезапускали.

Підкрок реалізовано й перевірено локально. На час цього прогону D-111 лишався відкритим:
причина попереднього одноразового generic 503 не встановлена, а нові
успішні запуски не доводять її виправлення. Немає commit/push/deploy
або очищення dev D1. Увесь M4 не оголошено завершеним.
Поточний стан після наступної діагностики й дозволу власника —
[готово до фінального аудиту M4](m4-q1-incident.md).

## Добова квота записів: виправлення фінального аудиту

Аудит виявив відсутність перевірки `rows_written` повного Cron. Локальний
RED-тест підтвердив **100** записів на першому порожньому запуску та **98**
на наступному: щонайменше **141 120/добу**, понад Free 100 000. Це витрати
службових cursor/assertion-рядків, а не користувацького навантаження.

Для cursor використано умовний UPDATE у тій самій транзакції з читанням
контролю й вікна; незмінне значення не переписується. Порожній claim
виявляється read-only перевіркою; фактичний claim та всі бізнес-мутації
зберігають попередні guards. Відсутній або paused control не дозволяє
просування/очищення; unknown результат не дозволяє використовувати кандидатів.
Додано перевірки паузи перед window batch і після читання кандидатів,
збережено overlap/wrap/unknown-result тести.

Після виправлення повний idle Cron: **4 writes / 17 API calls** зі звіркою,
**2 / 16** без неї; проєкція **2928 writes/добу**. Реальні producers
10 quiz + 5 bypass + 5 Lead створили 95 подій; усі доставлено за десять Cron.
Виміряно 8146 business/provisioning writes, 986 delivery-run writes,
максимум 11 writes для Cron з утриманою історією, +2 для hourly scan.
Консервативна добова проєкція з 10 000 резерву — **35 020 writes**;
метод і межі — [кошторис](capacity-and-delivery.md). Це не benchmark або
доказ CPU/всіх квот за довільного навантаження.

Фінальний цільовий запуск цього виправлення: **67/67** maintenance+delivery,
exit 0; `tsc` для server і worker tests та `git diff --check` — exit 0.
Окремий reviewer прочитав остаточні cleanup/claim зміни: findings `[]`;
тестів він не запускав. Повний check після всіх виправлень — у координатора.

## Підсумок усього M4

Фінальний аудит закрив витрати службових записів, відображення поточного
receiver mode та точність Cron status: перша спроба має власну часову базу,
успіх перекритого запуску зберігається незалежно від token поточної спроби.
517 Vitest + 89 Playwright, типи/build — exit 0. Джерело поточного стану —
[підсумковий звіт](bmad/reviews/2026-11-01-m4/report.md).
