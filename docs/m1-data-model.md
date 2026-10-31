# M1 — бізнес-схема та результати команд

Стан на 2026-10-31: друга міграція й внутрішній шар сховища реалізовані,
міграції застосовуються лише до ізольованих тестових D1. HTTP-контракти,
cookie-авторизація та Cron ще попереду. Внутрішній admission/revision-шар
додано наступним підкроком: [протокол команд](m1-command-protocol.md).
Це продовження [доказу атомарності](m1-atomicity.md). Весь M1 пізніше
закрито [підсумковим аудитом](bmad/reviews/2026-10-31-m1/report.md).

## Схема

`migrations/0002_business_schema.sql`: SQLite STRICT, час — INTEGER Unix
milliseconds UTC, ID — TEXT. Каталогу оферів у БД немає.

| Таблиця | Призначення та ключові обмеження |
|---|---|
| users | Поточні вподобання/email, activity/revision, унікальний SHA-256 секрету, revoked_at; expired_at дозволяє мінімальний залишок без персональних полів |
| events | Шість типів; факти, причинні посилання, schema_version і JSON-знімок ≤4 KiB; значення відповідей не мають окремих колонок |
| clicks | Незмінний за контрактом знімок офера/URL/версії, quiz/bypass, entry/completion; назва ≤256, URL ≤2048 UTF-8 байтів |
| partner_events | UNIQUE(partner_id, event_type, partner_event_id); внутрішній EventID, історична атрибуція; пара сума/валюта лише для Purchase, 1–1 000 000 центів USD |
| user_offer_leads | PRIMARY KEY(user_id, offer_id), latest_lead_at; не залежить від детальної події |
| request_results | PRIMARY KEY(user_id, operation_id) спільний для п’яти команд; чинний результат або мінімальна expired-позначка |
| event_delivery | Один стан на EventID; pending/in_flight/delivered із узгодженими lease/часовими полями |
| mock_received_events | Незалежний знімок приймача й відбиток, унікальний EventID; не джерело звіту |
| capacity_control | Чотири нульові початкові лічильники, незалежні paused/epoch; admission та облік — у протоколі команд |
| system_control | Окремі integrity_paused/history_unverified; дата доступності спочатку NULL до початку обліку |

Фізичні FK з RESTRICT: бізнес-рядки → users, event_delivery → events,
entry/view/completion → events. Це утримує потрібні докази, але не
подовжує їх логічні 90 діб. Тип, належність користувачу/преленду й TTL
посилання перевірятиме командний SQL-guard; самого FK недостатньо.

Партнерські ClickID/EventID, events.click_id і EventID імітатора — історичні
ідентифікатори, не FK до джерела. Інакше ключ не міг би пережити його
очищення. Немає ON DELETE CASCADE, каталог не має фізичного FK.
Видалення — явний порядок; під час очищення профілю спочатку прибираються
дозволені ключі/Lead, щоб не утворити цикл утримання. Повний cleanup у M4.

Індекси покривають користувача, строки, причинні зв’язки, групу входу,
готові pending/прострочені lease. Їхня наявність не доводить продуктивність.
SQL забезпечує типи, обов’язкові поля, форму стану й частину інваріантів.
Він не підміняє сувору валідацію DTO, безпечний експортний serializer,
звірку копій атрибуції чи заборону зміни прийнятих знімків командним кодом.

## Ключі та результати

`src/server/storage/command-results.ts` — внутрішні функції після перевірки
доступу caller. Переданий UserID не є авторизацією; нових HTTP-маршрутів немає.

- `prepareCommandResult` перевіряє результат і готує звичайний INSERT;
  caller додає його в один batch із бізнес-ефектами, guard і бюджетами.
  Немає окремого commit, running, upsert, IGNORE чи REPLACE.
- `readCommandResult` повертає found/not_found/expired. Читання не змінює
  даних або activity. not_found не доводить rollback невідомого запиту.
- `checkCommandReplay` розрізняє незмінний результат і conflict за типом
  та HMAC. Довільна помилка D1 не перетворюється на повтор/відсутність.
- `prepareExpireCommandResult` — лише prepared UPDATE для майбутнього
  очищення з guard integrity-паузи. Не запускає Cron самостійно.

Внутрішній result: `accepted` + EventID; `offer_selected` + EventID,
ClickID, каталог, назва/URL/OfferID; `no_offer` + catalog_version.
Це строгі Zod-об’єкти, не довільний JSON. URL переходу має HTTPS без
userinfo й один відповідний click_id. Повний серіалізований результат
≤4096 UTF-8 байтів; зайві поля, email/відповіді як поля результату та
невідповідний тип відхиляються до підготовки INSERT.

Логічне вікно: `now - created_at < 7 діб`. На межі вже expired, навіть
якщо Cron не очистив рядок. Фізичне очищення залишає user_id, operation_id,
created_at, expired=1; решта колонок NULL, включно з operation_type та
версіями HMAC. Позначка не звільняє бюджет command_keys. Повтор після
новішої команди повертає старий результат і не повертає профіль назад.

## Відбиток

`command-fingerprint.ts`: Web Crypto HMAC-SHA-256, окремий неекспортований
CryptoKey із секрету щонайменше 32 байти. Ключі не зберігаються у D1 або
коді застосунку. Тестові байти синтетичні; secret binding підключатиметься
разом із командним шаром.

Формат 1 — UTF-8 JSON масиву `["unicorn.command", 1, user_id, operation_id,
operation_type, normalized_business]`. Ключі об’єктів рекурсивно сортовані
за порядком JS string, порядок масивів збережено. JSON-пропуски, undefined,
нечислові/нескінченні числа, не-JSON об’єкти відхиляються. Це власний
версійований формат, не заява про RFC 8785. Контрольний HMAC-вектор
обчислено окремо через node:crypto для фіксованого канонічного рядка.

Нормалізація email/часу й відбір бізнес-полів належать caller: не передавати
received_at, revision, кандидата офера, lease чи номер спроби. Helper не
вгадує семантику полів. База зберігає лише HMAC і версії, не payload.
Повтор перевіряється старою версією ключа й формату; відсутня підтримка —
технічна відмова. GET не потребує HMAC-ключа. Прострочення перевіряється
раніше відбитка. Автоматичної ротації чи нового OperationID немає.

## Перевірки та межі

Тести використовують справжні бізнес-таблиці й локальну D1: FK-порядок,
незалежний retention ключів/Lead, покупки й повтори, байти/JSON/STRICT,
HMAC, межа семи діб, tombstone, конкурентний ключ, rollback усіх ефектів,
відсутній ключ/формат, збережений no_offer/перехід, пошкоджений результат.
Початковий тестовий batch ефектів не є production executor. Бюджети,
доступ і revision з’єднані наступним підкроком у [протоколі](m1-command-protocol.md);
його окремі тести не підміняють майбутні перевірки доменних handlers.

На завершення підкроку схеми локальний `CI=true npm run check` 2026-10-31: типи,
**57 Vitest** (18 unit + 39 Worker), збірка й **21 Playwright** пройшли.
Браузерні перевірки досі охоплюють каркас M0, не нові бізнес-сценарії.
Незалежний BMAD Build рев’юер не виявив доказових дефектів у цьому обсязі
та окремо відтворив HMAC-вектор через node:crypto; тести він не перезапускав.
M1 перевірено локально; попередній GitHub CI стосується M0.

Джерела, перевірені 2026-10-31:
[D1 FK](https://developers.cloudflare.com/d1/sql-api/foreign-keys/),
[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).
Погоджені правила — D-031–037, D-065, D-083, D-090–091, D-133,
D-156, D-164/D-166, D-174 у [журналі рішень](decisions.md).
