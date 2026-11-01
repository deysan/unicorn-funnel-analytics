# M2 — партнерські постбеки та CLI

Історичний запис підкроку. Актуальний підсумок усього M2 на 2026-11-01 —
[фінальний аудит](bmad/reviews/2026-11-01-m2/report.md).

2026-10-31. Локальна реалізація [погодженого контракту](m2-partner-contract.md).
Незакомічений M2 збережено; без commit/push/deploy або зовнішніх переходів.

## Приймання

`POST /api/v1/partner/events` приймає Lead/Purchase через HTTPS.
Авторизація — чинна `PARTNER_TOKENS` JSON-мапа partner_id → 32-байтовий
base64url Bearer. Мапа незалежна від поточного каталогу; malformed IDs,
неправильні токени чи неоднозначне призначення токена відхиляються
fail-closed. Порівняння — Workers Web Crypto timingSafeEqual.
Локальний setup додає тільки відсутній `PARTNER_TOKENS` для demo-partner,
не змінює попередніх секретів. Cookie/Origin для постбеків не потрібні;
Origin guard квізу збережено. Партнерський endpoint cookie не видає.

Тіло обмежено 8192 фактичними байтами UTF-8 JSON без compression.
DTO суворий; UUID v4 нормалізується lowercase, opaque ID зберігає case.
Час перевіряється за календарем/RFC3339 subset і нормалізується в Unix-ms.
Purchase допускає повну пару amount_minor/currency USD або її відсутність.
Lead грошових полів не приймає. Email/внутрішні ID/атрибуція/received_at
з тіла та зайві поля відхиляються.

Окремі bindings: partner IP300/min до auth, PartnerID30/min після auth.
Спільне очікування limiter ≤1s, внутрішніх повторів немає.
429 має Retry-After60s; збій limiter — 503/30s. IP використовує чинний
локальний HMAC-адаптер; поза loopback fail-closed. Це не cloud adapter.

## Атомарність та історія

Перед ClickID читається ключ `(partner_id,event_type,partner_event_id)`.
Ідентичний нормалізований вміст дає HTTP200 `{"status":"accepted"}`;
новий і повтор мають однаковий ACK. Конфлікт — 409 postback_conflict,
навіть якщо змінений ClickID відсутній. Повтор після видалення click/event
підтверджує збережений ключ, не відновлюючи історію й не витрачаючи budgets.
Повтор працює також за capacity/integrity pause; поточна auth обов’язкова.

Новий ключ потребує повного збереженого click з історичним партнером.
Відсутній/чужий click — 422; D1 failure — 503. Retained click старше
90 днів приймається. Час включно від click.created_at−5min до
received_at+5min. Поточний active/catalog не змінює атрибуцію.

Один guarded batch резервує events/undelivered, записує partner_events,
events з одним серверним EventID, незмінний payload/schema1 та pending
delivery. Lead оновлює лише більший максимум user–offer й тоді збільшує
selection_revision один раз. TTL/expired_at перевіряються на commitTime
окремо від revision; прострочений профіль отримує тільки історію.
Відкликана cookie сама по собі не забороняє Lead. Purchase не потребує
Lead і не змінює revision. last_active_at, request_results і command_keys
цим шляхом не змінюються.

Після збою batch перечитується ключ: тільки доведений commit дає ACK.
Для розпізнаного revision-конфлікту — максимум три спроби; довільний
timeout, stale epoch або SQL failure не повторюють запис автоматично.
Guards та FK узгоджують приймання з очищенням. Capacity pause
зберігається через чинний awaited helper після перевірки переможця.
HTTP повертає безпечний error envelope і no-store, без SQL/секретів.

## CLI та перевірка

[README](../README.md#локальна-демонстрація-партнерських-подій) містить
команди Lead → повернення bypass → Purchase → повтор → друга Purchase →
конфлікт старого ID. `npm run partner -- prepare` створює незмінний JSON
у `.wrangler/partner-events`, без overwrite. `send` бере секрет лише env,
надсилає збережені байти через звичайний API, не має D1/admin/reset.
HTTPS із NODE_EXTRA_CA_CERTS, redirect:error, 10s timeout; до трьох
авторизованих limiter-повторів із Retry-After/fallback/jitter.

Цільові перевірки: 43 unit і 34 Worker/D1 пройшли, typecheck/build — exit0.
Перевірені strict DTO/час, еквівалентні offset, max Lead/revision,
Purchase до Lead, дві покупки, concurrent duplicate, конфлікт,
late/foreign/deleted click, revoked/logical TTL/stub, TTL на commitTime,
rollback, lost commit з/без доказу, revision 1–3 і останній winner,
cleanup race, capacity boundaries/pause, stale epoch, integrity/control,
auth/конфіг, body/media/UTF8, два limiter й сумарний deadline.

Реальний CLI smoke використовує окремий запуск `.wrangler/e2e-state`
і справжній HTTPS → D1. Read-only SQLite inspection належить тесту,
не CLI; dev-база не змінюється. Окремий TLS redirect server перевіряє
відсутність переходу. Підсумковий `CI=true npm run check` — exit 0:
**374 Vitest** (162 unit + 212 Worker), типи/build та **50 Playwright**
(24 Chromium + 24 решта матриці + 2 CLI). CLI має окремий старт runtime,
щоб зберегти реальні IP/PartnerID limits. Повний прогін після рев’ю
виконав основний агент, exit 0.

Три незалежні BMAD Build шари завершені. Blind та edge-case не знайшли
доказових дефектів. Verification reviewer виявив відсутність прямих
перевірок грошових полів у Purchase payload_json. Додано дві Worker-регресії:
точна пара amount/currency та відсутність обох полів; спільний EventID,
атрибуція й незмінність після replay також перевіряються. Усі зауваження
закриті, відкладених немає. [Triage](bmad/implementation-artifacts/spec-m2-partner-postbacks.md).

Перший focused Worker запуск заблокований loopback EPERM у середовищі
виконання; дозволений повтор пройшов. Перший CLI smoke пройшов бізнес-шлях,
але впав на зайвому NO_COLOR/FORCE_COLOR warning Node у stderr. Тестовий
дочірній процес більше не успадковує FORCE_COLOR; focused і full прогони
після виправлення пройшли без retries тестів. Окрема тимчасова копія setup
довела додавання лише відсутньої partner-мапи й byte-identical повтор,
попередні секрети збережені. Перевірені `git diff --check`, локальні
посилання та відсутність значень локальних секретів у Git-кандидатах
і client bundle. Хмарних перевірок і commit/push не було.

## Межі

Звіт, Cron, cleanup, відправлення pending events, cloud adapter/deploy і
повний M3 лишаються наступними підкроками. M2 загалом не завершено.
Тести capacity використовують синтетичні counts, не доводять reconciliation
або cloud Free-навантаження. Партнер і всі дані демонстраційні.
