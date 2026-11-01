# Підсумковий аудит M4

Дата: 2026-11-01. База M3: `3c1edc9855e1a1ce48dd4e8fb49c7256d98e3d17`.
Обсяг: усі накопичені зміни доставки, retention, звірок і технічного
звіту, включно з успадкованими гарантіями admission та постбеків.
Доручення власника: перевірити весь M4 за ТЗ/рішеннями із BMAD;
за успіху зробити один локальний коміт. Push/deploy не входять.

Статус: **M4 пройшов підсумкову перевірку**. Підтверджені зауваження
закрито; нових бізнес-рішень немає. Власник дозволив один локальний коміт.

## Джерела й незалежність

[Вимоги](../../../requirements.md) відображають
[оригінальне ТЗ](https://docs.google.com/document/d/1gitcbjFaNR_rz8BGErQgLVJqi2njv494-tsCNPPIbRY/edit),
повторно прочитане цього ж дня під час аудиту M2. Погоджені
[рішення](../../../decisions.md), [сценарії](../../../scenarios.md) та
[план реалізації](../../../implementation-plan.md) залишаються джерелом істини.

BMAD 6.12.4, bmad-review із resolved
[project override](../../../../_bmad/custom/bmad-review.toml). Три окремі
контексти — adversarial, edge-case-hunter, verification-gap — отримали
повний tracked/untracked diff і джерела до обробки будь-якого висновку.
Чужі findings не передавалися, квоти зауважень немає. Старе design-only
формулювання override не скасовує явного доручення на реалізацію/аудит.
Редакторські lenses не застосовували: предмет перевірки — код і контракти.

## Відповідність умовам M4

| Вимога / рішення | Реалізація й докази |
|---|---|
| NFR-03/05, FR-10, SC-10; D-017/055–058/167–171 | [delivery](../../../../src/server/delivery/executor.ts), [D1-тести](../../../../tests/worker/delivery.test.ts): окремі commit приймача/ACK, 10 подій, lease/timeout/backoff, частковий і втрачений ACK, unknown claim/ACK, stale lease, незмінний snapshot, шість типів подій |
| SC-10, NFR-07; D-059/066/088/089/163–166 | [capacity](../../../../src/server/storage/capacity.ts), [reconciliation](../../../../src/server/maintenance/reconciliation.ts): atomic admission/release, незалежні capacity-паузи, hysteresis/epoch, matched snapshot, mismatch без repair і без автоматичного відновлення |
| SC-11, FR-09/10; D-010/012/092 | [partner tests](../../../../tests/worker/partner-events.test.ts): пізні події, час партнера, repeat/conflict, Purchase без Lead; cleanup зберігає ключ, поки існує click або detailed event |
| SC-12, NFR-06; D-019/037/084/090/091 | [cleanup](../../../../src/server/maintenance/cleanup.ts), [maintenance tests](../../../../tests/worker/maintenance.test.ts): 7/30/90/180 діб, мінімальний профіль, pending retention, FK-залежності, tombstones, конкурентна активність/новий FK, rollback counters/history, integrity guard |
| D-165/166, NFR-07 | Підтверджений hourly claim до scan, не більше однієї спроби за UTC-годину, unknown claim не читає; три лічильники одним узгодженим зрізом; mismatch ставить integrity/history pause |
| NFR-02/07, D-060/100 | [технічний звіт](../../../../src/server/report/read.ts), [UI](../../../../src/client/Report.tsx), [browser proof](../../../../tests/smoke/report.spec.ts): фактичні Cron/ACK, unknown/stale, queue age, пороги, safe codes, недоступність без нульових підстановок |
| D-026, Free-обмеження | Raw keyset windows до TTL/dependency predicates, bounded calls, partial error index; тести рахують API calls і rows_read на retained fixtures. Це не benchmark і не доказ production CPU/добових квот |

Офіційні [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
повторно перевірено 2026-11-01: 50 queries/invocation на Free, batch
рахується одним зверненням; per-statement обмеження залишаються чинними.
Поточна оцінка coordinator — до 46 D1-викликів у штатному максимальному
шляху; локальні докази й обмеження описано в [retention](../../../m4-retention.md).

## Висновки й виправлення

[JSON усіх висновків](findings.json) зберігає результати кожного lens,
включно з перекриттями. Вісім findings описують чотири дефекти й дві
прогалини перевірок; відсутній receiver mode незалежно знайшли всі три
рев’юери. Усі прийнято після звірки коду й рішень; нової бізнес-поведінки
не вводимо.

| Findings | Підтвердження та виправлення |
|---|---|
| M4-01 | Порожній Cron писав 98 рядків за повторний запуск, тобто 141120/добу без трафіку. Cursor/control/read лишаються атомарними, cursor змінюється лише за потреби; фактичні бізнес-мутації зберігають CHECK-guards. Empty claim має read-only preflight. Регресії вимірюють rows_written і API calls |
| M4-02/05/08 | Поточний env mode проходить receiverMode validation, API schema та UI. HTTP тести перевіряють normal/unavailable, некоректний конфіг і збереження історії старих спроб; браузер — показ режиму |
| M4-03 | cron_first_attempt_at задається один раз. До першого успіху саме він є часовою базою порога; повторна невдача не відкладає попередження |
| M4-04 | Глобальний MAX успіху оновлюється й для старішого успішного запуску; token захищає статус/errors/cleanup новішої спроби. Перевірено обидва порядки success/failure |
| M4-06 | Реальний пізній Purchase: occurred_at на 89 діб старіший за received_at; після видалення ClickID подія, ключ і бюджет зберігаються до власного received_at+90 діб |
| M4-07 | Proxy вимірює rows_read саме SQL, який виконує production runMaintenance на 4000 delivered рядках; копія SQL у тесті більше не є єдиним доказом |

Код режиму й assertions повторно прочитав verification reviewer;
оптимізацію cursor/claim незалежно перечитав edge reviewer: нових
підтверджених дефектів немає. Ці повторні перевірки були читанням коду,
не окремими запусками тестів рев’юерами.

## Фактичні перевірки

- До виправлень цього аудиту повний check: 503 Vitest, 89 Playwright,
  типи/build — exit 0. Зелений набір не доводив відсутності прогалин.
- RED для порожнього Cron підтвердив витрати до fix. Після нього цільові
  maintenance/delivery — 67/67; Cron status — 6/6. [Вимірювання](../../../capacity-and-delivery.md):
  2 rows_written на idle run, 2928/добу з hourly; малий день 95 подій
  з консервативним резервом — 35020 writes/добу. Це не production benchmark.
- **Фінальний `CI=true npm run check`: exit 0**, **517 Vitest**
  (193 unit + 324 Worker), **89 Playwright**: 26 + 24 + 6 + 9 + 4 +
  2 CLI + 14 report + 4 report matrix; типи/build пройшли.
  Нових збоїв чи test retries немає. Локальний лог поза Git:
  `/tmp/unicorn-m4-audit-final-fixed.log`.
- Чотири фактичні секрети `.dev.vars` перевірено у файлах репозиторію
  й `dist/client`: збігів немає, значення не виводилися.
- Read-only metadata dev D1 підтвердили лише міграції 0001–0004;
  нова 0005 не застосовувалася до dev-даних, тестові бази ізольовані.
- Перевірено 235 локальних посилань у 14 змінених Markdown-файлах:
  цілі існують. JSON артефактів аудиту валідний; `git diff --check` пройшов.

Після фінального check змінювалася лише документація. Це не результат
GitHub CI поточного SHA. Vite попереджає про майбутній native config
loader; поточні типи й збірка успішні.

## Прийнятий виняток і межі

Один попередній generic Q1 503 має явний дозвіл власника продовжити
після обмеженої діагностики: [докази та межі](../../../m4-q1-incident.md).
Причина невідома, виправлення не заявляємо. Це не дозвіл пропускати
нові або повторні збої поточного аудиту і не зміна загального D-111.

Локальна D1 та внутрішній приймач не доводять зовнішню мережу, авторизацію
чи квоти BigQuery. Навантаження, p95, CPU Free не вимірювалися.
Dev persistence не очищується. M5 завершує звіт/пакет здачі та операційне
підтвердження історії; M6 — перевірка Free-передумов і ручне хмарне демо.
