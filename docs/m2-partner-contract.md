# Контракт M2: партнерські постбеки та CLI

2026-10-31. Конкретизація погоджених рішень, не нові бізнес-правила.
Поточне доручення — локальна реалізація, без коміту/deploy. Джерело —
[рішення](decisions.md), D-009–012/019/025/033–037/069–078/081–082/
092–093/103–108/112/120–123/132/161/167.

## HTTP та валідація

`POST /api/v1/partner/events`, одна strict JSON-подія. Обов’язкові
`event_type` (Lead/Purchase), `partner_event_id`, `click_id`, `occurred_at`.
Для Purchase необов’язкова повна пара `amount_minor` (ціле число
1–1_000_000) та `currency: USD`. Lead не приймає грошових полів.
Null, зайві поля, coercion, email, масив, отримані від клієнта UserID,
PartnerID, OfferID, received_at та внутрішній EventID — відмова.

ClickID — UUID v4/variant, hex нормалізується lowercase без trim.
PartnerEventID — case-sensitive 1–128 ASCII `[A-Za-z0-9._:-]`, без trim;
перевіряти справжній кінець рядка, не допускати кінцевий newline.
Час — RFC3339 subset з великими T/Z, Z або ±HH:mm, 0–3 дробових цифри.
Неможлива дата, leap second, -00:00, зайва точність — відмова.
Еквівалентні моменти нормалізуються в цілі Unix-ms; зовнішні приклади UTC .sssZ.
Тіло ≤8192 фактичних байтів, UTF-8 JSON, без compression. Origin для
партнерського запиту не потрібен; quiz Origin guard зберігається.

Непрозорий Bearer визначає PartnerID. Поточна авторизація потрібна й
для повтору; cookie/Basic/ID тіла її не замінюють. Технічний формат
конфігурації: секрет `PARTNER_TOKENS` — JSON-мапа partner_id → випадковий
32-байтовий base64url token. Local setup додає лише відсутнє значення для
`demo-partner`, не виводить/не змінює старих секретів. Це серверна мапа
чинних доступів, незалежна від поточного каталогу; невірна конфігурація
fail-closed, порівняння токенів timing-safe. Секретів у client bundle немає.

Окремі bindings: IP partner 300/60s до auth, PartnerID 30/60s після auth.
Спільне очікування limiter ≤1s, без внутрішніх повторів. 429/60s та
503 rate_limit_unavailable/30s; чинний локальний loopback IP-адаптер,
поза ним fail-closed до окремої хмарної реалізації. Не використовувати
сирий token як ключ limiter. Окрема область IP, не спільний бюджет quiz.

## Запис, повтори та пізні дані

Ключ `(partner_id,event_type,partner_event_id)`. Спочатку перевірити ключ,
потім новий ClickID. Порівняти нормалізовані click_id, occurred_at,
presence/value amount/currency; received_at не є бізнес-змістом.
Відомий повтор після очищення ClickID/events підтверджується без
відновлення історії; змінений зміст — conflict, навіть якщо новий click
відсутній. Новий ключ має перевіряти повний збережений ClickID та
його історичний partner_id; поточні active/catalog не обмежують постбек.

Новий час включно: click.created_at − 300000 ≤ occurred_at ≤ received_at + 300000.
Received_at фіксує сервер для поточного приймання. Click старше 90 днів
не відхиляється лише через вік. FK/guards узгоджують приймання з cleanup;
профіль-залишок може отримати історичну подію, але не оживає.

Один batch: partner_events + events з тим самим серверним EventID,
незмінний payload_json/schema_version=1 (≤4KiB), event_delivery pending,
резерв events/undelivered і потрібна зміна компактного Lead/revision.
Немає request_results, command_keys, cookie чи поновлення last_active_at.
Purchase не потребує/не створює Lead і не змінює selection_revision.
Lead для непростроченого профілю оновлює лише більший максимум на
user–offer; реальна зміна збільшує revision один раз. Старий/рівний Lead
або replay — ні. TTL/expired_at перевірити на commitTime окремо від
revision; простроченому профілю компактний Lead не відновлювати.
Відкликання cookie саме по собі не забороняє історичний postback (D-142).

Використати GuardedBatch/reserveCapacity, але не executeCommand: останній
має браузерну авторизацію та поновлює активність. Унікальний ключ визначає
переможця concurrent duplicate. Після збою batch — перечитати ключ;
доведений ідентичний commit підтверджується. Невідомий результат без
доказу не є ACK. Для доведеного revision-конфлікту максимум три спроби;
довільний timeout не запускає сліпий повтор запису. Повтор не потребує
нового місця навіть при capacity/integrity pause; нові записи — guards.

ACK: HTTP200 `{"status":"accepted"}` для нового та replay.
HTTP409 postback_conflict,false; HTTP422 click_unavailable,false для
нового відсутнього/очищеного/чужого ClickID. Невалідні дані —
validation_failed,false; 413 payload_too_large,false. D1 failure —
тимчасова 503, не click_unavailable. Загальний envelope error має
code/message/retryable, без сирих SQL/payload/секретів; no-store.

## CLI та докази

Окремі `prepare` та `send`: підготовка зберігає JSON без секрету/email
у ignored локальній директорії, надсилання читає його незмінним.
Новий ID/час лише під час явного prepare, не під час send/retry.
Секрет із environment, не argv/URL/файлу запиту; target явно задає
власник як local/demo API, HTTPS. Для локального TLS використовувати
наявний сертифікат через NODE_EXTRA_CA_CERTS, не вимикати перевірку TLS.
Redirect не слідувати. Мережеве очікування обмежене; помилки без секретів.
Для відомих limiter кодів Retry-After або fallback60/30s +0–10% jitter,
до3 автоматичних повторів; решта помилок — явний повтор того самого файлу.

README: Lead → Purchase → повтор → друга Purchase → конфлікт старого ID.
CLI не має D1/admin/reset чи переходів до партнера. Синтетичний E2E
проходить звичайний API: квіз → CLI Lead → повернення bypass → покупки.
Звіт/Cron/cleanup/хмарний deploy лишаються наступними підкроками.

Перевірені 2026-10-31 офіційні технічні джерела:
[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
[Workers practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
Сигнатури звірені з generated Worker types та встановленою Wrangler schema.
Це не підтвердження cloud Free bindings або production-навантаження.
