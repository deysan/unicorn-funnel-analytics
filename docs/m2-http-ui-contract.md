# Робочий контракт підкроку HTTP/UI

2026-10-31. Технічна конкретизація погоджених рішень, не нові бізнес-вимоги.
Доручено реалізацію локального HTTP і квізу без коміту.

## Сервер

Застосувати Hono, наявні executeQuizCommand/readQuizContext/readCommandResult,
GuardedBatch/reserveCapacity. Не дублювати алгоритм оферів або M1.

- `/api/v1/quiz/context?preland_id=demo`: 200 identity_status ready/missing/
  invalid + server_time; лише ready містить user_id, answers, email за TTL,
  next_action. Не створює дані/не поновлює активність або cookie.
- POST `/identity`, `/identity/restart`, лише `{}`. Identity: ready → наявний
  ID/200, missing → новий/201, invalid → identity_lost. Restart: missing/
  invalid → новий/201, ready → identity_already_ready/409, без заміни.
  Новий профіль + profiles budget атомарні; відмова не видає cookie.
- Cookie: тільки 32 random bytes, base64url без padding (43 символи),
  SHA-256 вихідних байтів у users.access_secret_hash. Lookup secret hash →
  user_id; не довіряти UserID із запиту. HttpOnly/Secure/SameSite=Lax/Path=/,
  без Domain, 180 діб із серверною перевіркою TTL/revoked/expired.
  Secure не послаблювати для тестів: перевірити loopback браузерами,
  за потреби використати localhost або локальний HTTPS.
- POST entries/question-views/answers/email-confirmations/offer-selections
  відповідають внутрішнім DTO без поля type; маршрут задає type. Надісланий
  type або зайві поля відхиляти. Канонічні UUID v4: uppercase → lowercase,
  без trim. Нормалізувати лише ID-поля, email вже нормалізує A.
- Команди й GET operations/:operation_id: X-Expected-User-ID обов’язковий.
  Cookie авторизує, заголовок лише звіряє контекст; mismatch identity_lost,
  не стирати cookie іншого ready-профілю. GET result: 200 result,
  404 operation_not_found, 410 operation_expired; не потребує HMAC keyring.
- Помилки бізнес-API: `{error:{code,message,retryable,fields?}}`, без raw
  exceptions/payload/секретів. Не маскувати D1 failure під missing/not_found.
  No-store для API, без CORS доступу чужих origin. POST потребує точного
  явно налаштованого Origin (missing/null/чужий → 403 request_origin_rejected),
  JSON UTF-8 без compression, фактичний bounded-read ≤8192 bytes (413).
- Поновлювати cookie лише після нового commit, включно з no_offer;
  GET/replay не поновлюють. Потрібний надійний внутрішній сигнал commit
  від executor, а не read-before race; не ламати старі результати.
  Строк брати зі збереженої активності; невідомий commit не доводить новий.

Джерела: D-051/052/069/075/077/081/083/133–142 у decisions.md.
Новий секрет HMAC команд — стабільний через .dev.vars, не при кожному старті;
окремий HMAC secret для IP. Не друкувати їх, не включати в client bundle.

## Частота й локальний запуск

D-101–107: IP quiz 300/60s до auth; UserID 120/60s після auth;
bootstrap 10/60s лише для спроб видачі, не ready. IP ключ — HMAC
нормалізованої адреси з окремим секретом. 429 rate_limited + Retry-After60;
збій/недоступна адреса/timeout →503 rate_limit_unavailable +30. Сумарне
очікування limiter ≤1s, без внутрішніх повторів, пізня відповідь не запускає
бізнес-команду. Нема відкритого query/header перемикача обходу.

Для локального runtime використати реальні rate-limit bindings з
wrangler schema або явний серверний тестовий адаптер з тими самими правилами;
синтетична IP дозволена лише локально (D-106). Production/акаунт Free
не оголошувати перевіреним. Local конфіг не може видати себе за cloud:
loopback restriction і документована перевірка перед майбутнім deploy.
Не довіряти довільним X-Forwarded-For/клієнтським fallback.

Офіційно перевірено 2026-10-31:
[Workers practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[Rate Limit API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
Binding `limit({key}) → {success}`, конфіг ratelimits/name/namespace_id/
simple.limit/period(60), ліміт приблизний на локацію. Поточні типи:
wrangler types → generated worker-configuration.d.ts (RateLimit), schema
node_modules/wrangler/config-schema.json. Нових залежностей не потрібно.

Setup має створювати лише відсутні локальні секрети (окремі random 32 bytes),
зберігати їх у ignored .dev.vars; example — тільки placeholders.
Міграції 0001–0004 до тієї persistence, що читає Vite. Dev не очищати;
E2E користується окремою тестовою persistence. Не підвищувати rate/budget
пороги і не додавати публічні тестові endpoint заради браузерних тестів.
Можна серверно seed-ити синтетичні тестові профілі/cookies через приватний
Node test setup, коли потрібно ізолювати багато тестів від bootstrap10/min.

## Клієнт

Один чистий адаптивний український квіз на `/`, демо preland=demo.
Health UI зберегти на `/diagnostics` і оновити старі smoke-тести.
Q1 women/men; Q2 asia/europe/latam із залежним від Q1 формулюванням;
email підставляється з контексту, редагується та явно підтверджується.
Результат показує назву, URL, ClickID без зовнішнього переходу.
Доступні labels, focus, keyboard, статуси/error, мобільна ширина.

- GET context → під exclusive Web Lock ще раз context → один POST identity
  → GET підтверджує ready/очікуваний ID. Lock лише на bootstrap/restart,
  wait≤30s; без Web Locks готовий профіль працює, новий не створювати.
  Не створювати цикл профілів при блокуванні cookie. Missing зі старою
  роботою/invalid — явний restart; ready restart не замінює користувача.
- `step=preferred_gender|preferred_ethnicity|email`: без step/невідомий →Q1;
  передумови обмежують step, URL замінити на фактичний. Lead/bypass раніше.
  Відповіді — D1, не URL/localStorage. Reload питання →новий entry/view;
  Back/Forward →тільки view. React rerender/StrictMode не додають фактів.
  Вхід/показ/Q1/Q2 pending — пам’ять документа, незмінний payload на retry.
  Показ фактично рендериться до події; підтвердження чекає його ACK;
  застарілий ACK не розблоковує новий екран.
- A/B: перед A зберегти єдиний validated versioned JSON у sessionStorage:
  user/preland, IDs/links, phase/payload, immutable deadline із свіжого
  server_time+24h. До запису A не відправляти. Після A прибрати email,
  зберегти фазу B; storage failure →B не запускати, IDs у пам’яті,
  спробувати видалити власний старий запис, ручне відновлення. Після B
  storage failure не приховує результат, лише попередження.
- Reload/retry спочатку GET B, потім A; повторити лише відсутню команду
  зі старим payload/key. Pending має пріоритет над новим bypass. Час TTL
  перевіряти свіжим context, до цього draft-email не показувати. На межі
  прибрати payload, мінімальні IDs лишити для GET. Corrupt/unknown draft
  не відправляти, запропонувати явне відновлення; без пошуку «останнього».
- No_offer зберігається; reload читає результат, «Спробувати ще раз» —
  нова B, чинна A не повторюється. Bypass: прийнятий entry →тільки B.
- Timeout10s/мережа →ручний retry, не скидати профіль. Rate-limit коди:
  пауза60/30s+0–10%, до3 автоматичних циклів; незмінні ключі, bootstrap
  reread під lock, пауза без lock. Ручний retry паузу не скорочує.
- Identity loss: приховати дані, очистити draft, зупинити старі команди,
  явний restart. Reference/selection/step errors →явне refresh контексту
  без скидання профілю. Пізній результат старої дії не замінює новий екран.

Джерела: D-004–007/015/038–050/078–085/105/124–130/133–139/157–159.
Це необхідна основа UI, не твердження про завершення всього M3. Не
послаблювати відомі правила; повну матрицю аварій M3 можна окремо розширювати.
