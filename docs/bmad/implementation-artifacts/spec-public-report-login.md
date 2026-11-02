---
title: 'Публічна пара доступу до чинного звіту'
type: 'chore'
created: '2026-11-02'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '96d297e124479e1b4884e33014e87cad1347ab3e'
context: []
---

<frozen-after-approval reason="Користувач явно погодив пару, мінімальну зміну коду, перевірку, deploy та README 2026-11-02">

## Intent

Чинний звіт приймає пароль лише як 32-byte base64url секрет, тому погоджена
пара `demo` / `unicorn-demo` не працює. Потрібно приймати звичайний пароль
у вже наявному Basic Auth і опублікувати саме цю пару для того самого демо.
Нові середовище, сторінка входу чи функції не потрібні.

## Boundaries & Constraints

Зберегти HTTPS, Basic challenge, no-store, rate limits, доступ лише до читання,
безпечні помилки й timing-safe порівняння. Попередні випадкові паролі лишаються
сумісними. Не змінювати спільний decodeSecret: HMAC, партнерські токени й cookie
зберігають строгий формат. Без змін залежностей, схеми, бізнес-логіки чи даних.
Чинні Worker/D1/URL і normal mode зберегти; GitHub лишити приватним.
Хмарні квіз, постбеки, міграції, restore й імітацію outage не запускати:
перевірка цього релізу — лише вхід і читання звіту/status/health.

## I/O & Edge-Case Matrix

| Сценарій | Вхід | Очікування |
|---|---|---|
| Погоджена пара | demo / unicorn-demo, HTTPS | HTML, status, filters, funnel — 200, no-store, без set-cookie/бізнес-записів |
| Хибний доступ | відсутній auth, хибне ім'я, пароль тієї самої/іншої довжини | 401, Basic challenge; приватні handlers і report limiter не виконуються |
| Старий формат | поточний 43-символьний пароль із тестової фікстури | Чинні auth-тести проходять |
| Пошкоджений Basic / HTTP | невалідний base64, відсутній colon або HTTP | 401, без витоку значень |
| Невалідна конфігурація | відсутній, порожній, <8, >128 або непридатний ASCII пароль | 503 із безпечним повідомленням |

</frozen-after-approval>

## Code Map

- `src/server/http/report.ts`: reportIdentity; змінити тільки перетворення
  report password у байти і перевірку довжини перед timingSafeEqual.
- `src/server/http/security.ts`: decodeSecret НЕ змінювати.
- `tests/worker/report.test.ts`: існують фікстури D1/bindings, allow limiter,
  request helper, auth/no-store/no-cookie/HTTP тести; розширити їх.
- `tests/worker/partner-http.test.ts`: існуючий доказ ізоляції report/partner auth.
- `scripts/demo-artifact.ts`, `scripts/demo-config.ts`, `vite.config.ts`:
  готовий guard/config/build; не змінювати.
- README, docs/decisions, docs/plan та docs/README вже мають незакомічене
  уточнення власника з попереднього повідомлення. Ці зміни зберегти.

## Tasks & Acceptance

**Execution:**
- [x] `tests/worker/report.test.ts`: додати регресії матриці й показати RED
  для погодженої пари до зміни реалізації.
- [x] `src/server/http/report.ts`: локальна перевірка password — 8–128
  друкованих ASCII без пробілів (0x21–0x7e); TextEncoder та рівна довжина
  перед timingSafeEqual. Не hardcode-ити публічну пару у runtime.
- [x] Виконати цільові report/partner тести та typecheck, зберегти фактичні
  результати у Implementation Notes; не змінювати інші файли коду.

**Acceptance Criteria:**
- Given погоджений demo binding, when читається звіт, then доступ працює
  з тією самою сторінкою та захистом, без нового функціоналу.
- Given інші секрети й бізнес-дані, when змінено report auth, then їхній
  код і стан не змінено; нових залежностей немає.

## Implementation Notes

Користувач уже погодив конкретну зміну та deploy; повторне погодження
не потрібне. Стан дерева перед кодом — лише власні пов'язані правки документації.
Dispatch-агент реалізує лише три Execution tasks вище, без commit/push/cloud.
Основний агент після review виконає повний release check за наявним runbook,
оновить документацію, створить чистий release commit, перевірить CI й deploy
на чинний Worker з JSON secrets-file лише для REPORT_USERNAME/REPORT_PASSWORD.
Потім перевірить браузерний вхід і безпечні status поля. Нові історичні
SHA/результати не приписуються M6 від 2026-11-01. Зовнішні дії явно дозволені
останнім дорученням користувача; приватність GitHub не змінюється.

Фактична локальна реалізація dispatch-агента 2026-11-02:

- Змінено лише `src/server/http/report.ts` і `tests/worker/report.test.ts`;
  цей spec доповнено доказами. `reportIdentity` перевіряє configured password
  як 8–128 символів 0x21–0x7e, кодує обидва паролі через `TextEncoder` і
  перевіряє рівність довжин перед `timingSafeEqual`. Публічної пари в runtime
  немає; `security.ts`, залежності, конфігурації й схеми не змінено.
- RED до зміни реалізації: `WRANGLER_WRITE_LOGS=false npm run test:worker --
  tests/worker/report.test.ts -t 'public demo credentials'` — 1 failed,
  45 skipped; на запит із погодженою парою отримано 503 замість 200.
  Перша sandbox-спроба не запустила тести через `listen EPERM 127.0.0.1`;
  RED отримано після дозволеного запуску локального runtime поза sandbox.
- GREEN: `WRANGLER_WRITE_LOGS=false npm run test:worker --
  tests/worker/report.test.ts tests/worker/partner-http.test.ts` — 2 файли,
  58 тестів passed. Додано позитивні перевірки HTML/status/filters/funnel,
  незмінності бізнес-таблиць, no-store/no-cookie, меж 8/128 і ASCII-пунктуації;
  відмови перевіряють 401/503, безпечне тіло відповіді та відсутність викликів
  приватних handlers/report limiter. Старі 43-символьні паролі й ізоляція
  партнерського auth перевірені наявними тестами.
- `WRANGLER_WRITE_LOGS=false npm run typecheck` — passed. Перша спроба
  виявила невідповідність старої анотації `Uint8Array<ArrayBuffer>` типу
  `TextEncoder.encode` у чинних Cloudflare types; локальну анотацію змінено
  на `Uint8Array`, повторна перевірка всіх tsconfig завершилася з exit 0.
  Генерований `worker-configuration.d.ts` не має diff. `git diff --check`
  також завершився з exit 0.
- Dispatch-агент не виконував commit, push, deploy або хмарні запити.
  Повний release check, review та перевірка хмарного входу залишаються
  наступними діями основного агента.

Виправлення після review, 2026-11-02:

- У `scripts/demo-smoke.mjs` змінено лише guard report password: той самий
  діапазон 8–128 символів 0x21–0x7e зі строгим кінцем рядка, що в
  `reportIdentity`. Перевірку партнерського токена не змінено.
- Додано `tests/unit/demo-smoke.test.ts`: імпорт реального smoke-скрипта
  з підставленими `fetch`, Playwright `chromium.launch` і `execFile`;
  таймери та вихід процесу також перехоплені. Дозволена конфігурація
  доходить лише до першого підставленого baseline GET, який навмисно кидає
  помилку. Мережевих запитів, запуску браузера/CLI та бізнес-записів немає.
- RED: `npm run test:unit -- tests/unit/demo-smoke.test.ts -t 'accepts approved'`
  — 1 failed, 16 skipped; фактична стадія `configuration` замість очікуваної
  `baseline`. GREEN після однорядкової зміни: `npm run test:unit --
  tests/unit/demo-smoke.test.ts` — 17 passed. Перевірено погоджений пароль,
  старий формат, межі 8/128, непридатні значення й незмінну строгість
  партнерського токена. Інших тестів у цьому review-виправленні не запускали.

Root verification перед релізним комітом: фінальний
`CI=true WRANGLER_WRITE_LOGS=false npm run check` — **611 Vitest,
89 Playwright, типи й build, exit 0** (`.wrangler/public-login-final-check.log`).
Після patch прочитано код і тести повторно; відкладених findings немає.
Схема remote D1 перевірена лише SELECT — `demo_schema_valid`.
GitHub CLI: PRIVATE; dashboard Workers: Free / $0 / Current plan.
Deploy і перевірка браузерного входу будуть записані після виконання.

## Spec Change Log

## Review Triage Log

| Шар / знахідка | Вердикт | Доказ і дія |
|---|---|---|
| Blind: smoke відхиляє новий пароль | medium → patch | `scripts/demo-smoke.mjs:18` досі вимагає 43 base64url; нова пара завершується на configuration до запитів. Виправлено: лише guard report password та 17 offline регресій, партнерський формат незмінний. |

Edge-case: `[]`; verification-gap: `No verification gaps found.`
Усі три шари виконані в незалежних контекстах. Project override застосовано:
квоти проблем немає. На момент завершення рев’ю deploy і браузерна
перевірка ще були попереду; підсумок виконання наведено в кінці документа.

## Verification

- `WRANGLER_WRITE_LOGS=false npm run test:worker -- tests/worker/report.test.ts tests/worker/partner-http.test.ts`
- `WRANGLER_WRITE_LOGS=false npm run typecheck`
- `npm run test:unit -- tests/unit/demo-smoke.test.ts` — лише offline guard regression.
- Основний агент: `CI=true WRANGLER_WRITE_LOGS=false npm run check`, artifact/schema gates,
  вхід через браузер і GET чинного cloud звіту, без бізнес-мутацій.

API timingSafeEqual і deploy secrets-file звірено з офіційною документацією
2026-11-02: [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal),
[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code).
Types 5.20261102.1 прочитано в /tmp без зміни залежностей проєкту.


## Результат deploy

2026-11-02 виконано: release `2ba32c3ad3b747dc8848394b600a143a54a9a568`,
CI run `41422823606` success (611 Vitest / 89 Playwright), Worker version
`977cd360-8b62-4225-8179-3ae334a4d5c9`, 100%, 09:48:42 UTC.
Нова пара дала 200 HTML/status/filters/funnel, стара/хибна та відсутня — 401.
Chrome відобразив актуальний звіт; no-store/no-cookie, normal, Cron complete,
порожня черга, без пауз/помилок, історія confirmed. Нових бізнес-дій агента немає.
Фінальний запис — docs-only після deploy; GitHub PRIVATE, нових ресурсів немає.
[Повні факти й межі перевірки](../../m6-release-result.md#оновлення-доступу-2026-11-02).
