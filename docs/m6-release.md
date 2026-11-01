# M6: ручний реліз демо

Дата: 2026-11-01. M6 завершено; цей документ описує процедуру повторення.
[Фактичні SHA/versions, smoke, Cron і recovery](m6-release-result.md),
[Free-докази](m6-free-evidence.md), [план](implementation-plan.md),
[сценарій](demo-walkthrough.md), [історія звіту](report-operations.md).
Невідомий тариф не дозволяє upgrade; повторний реліз проходить gates.

## Що підготовлено

Cloud IP-адаптер приймає валідний `CF-Connecting-IP` лише через прямий
HTTPS edge-запит із `request.cf.colo`. Він канонізує IPv4/IPv6, зокрема
IPv4-mapped IPv6, й обчислює HMAC. Worker subrequests із `CF-Worker`,
Pseudo IPv4, cross-zone sentinel, відсутні/некоректні IP відхиляються
503 `rate_limit_unavailable`, `Retry-After: 30`, до бізнес-змін.
`X-Forwarded-For` і `x-real-ip` ігноруються як джерела адреси. Сам факт
наявності `x-real-ip` у прямому edge-запиті не є підставою відмови:
описане провайдером stripping стосується передачі до origin.
У local лишається синтетична
адреса, незалежно від підставлених заголовків. IP не журналюється.
Це підтримка прямого `workers.dev`; проксі, custom domains і service
bindings цим релізом не додаються.

`demo:config` створює ignored `.wrangler/wrangler.demo.json` з параметрів
оператора. Секретів у ньому немає. `build:demo` явно обирає цей конфіг,
відхиляє drift та збирає `dist-demo`; звичайні dev/build/check лишаються
локальними, без remote D1. Значення `remote:false` ізолює локальний
runtime; ручні D1-команди нижче явно використовують `--remote`.
Сім limiter budgets незмінні: 300/120/10/300/30/300/30 за 60 секунд.
Namespace IDs 1001–1007 мають бути вільні від чужих binding цього акаунта;
якщо вони вже використовуються, зупиніть реліз для узгодження конфігурації.
Observability вимкнено: цей пакет не додає журналів адрес/HTTP payload.

Demo build вилучає preview-only `.dev.vars`, який Cloudflare Vite plugin
за замовчуванням додає з локального/env оточення; local preview збережено.
Build перевіряє критичні поля фактичного deployment-конфігу, відсутність
додаткових сервісів і відомих локальних/env секретів у всіх артефактах.
`release-evidence.json` зберігає SHA, чистоту дерева й SHA-256 файлів.
Release guard повторно перевіряє їх: змінений або застарілий bundle
не проходить. Це не доказ тарифу чи успішного cloud виконання.

## Передумови й SHA

1. Підтвердити Workers Free, одну D1 Free, актуальні квоти та Actions
   без доплат; записати дату й доказ у [Free evidence](m6-free-evidence.md).
   Практичний малий deploy rate-limit binding дозволений власником на
   чинному Free без upgrade; відмова провайдера зупиняє крок.
2. Переглянути весь diff і виконати `CI=true npm run check` без пропусків
   та retries цілих тестів. Збій потребує діагностики D-111.
3. Власник 2026-11-01 явно погодив технічний поділ M6: коміт
   перевіреного пакета та звичайний push разом із накопиченими M1–M5,
   потім CI/ручний deploy/smoke й окремий документаційний коміт
   фактичних результатів. Це узгоджує D-099 із правилом AGENTS.md
   про межі коміту; історія не переписується.
4. Перевірити чистоту `git status --porcelain` і `git rev-parse HEAD`;
   встановити `RELEASE_SHA` у точний перевірений SHA. Дочекатися CI саме
   цього SHA або зафіксувати обґрунтований локальний шлях D-108/D-177.
   Секретів Cloudflare в CI немає; deploy на push не запускається.

Нижче — послідовні ручні кроки. При помилці не переходьте до наступного,
не очищуйте дані й не виконуйте reset/restore або автоматичний rollback.
Стан shell не є доказом попереднього успіху. Не вмикайте `set -x`.

## Ресурс, конфігурація й секрети

Параметри `DEMO_WORKER_NAME`, `DEMO_DATABASE_NAME`, `DEMO_DATABASE_ID`,
`DEMO_ORIGIN` мають бути реальними перевіреними ресурсами оператора;
заглушки в repository не зберігаються. Origin — точний HTTPS origin
`<worker>.<account-subdomain>.workers.dev`, без path/port/query.
Спочатку read-only перевірте account і наявні ресурси:

```sh
npx wrangler whoami
npx wrangler d1 list
```

Якщо потрібної БД немає і новий ресурс дозволено gates, створіть **одну**:

```sh
npx wrangler d1 create "$DEMO_DATABASE_NAME"
```

Збережіть безпечний доказ новоствореної БД (ID, час, результат створення,
відсутність попереднього Worker/Cron). Не вважайте порожні таблиці доказом
нової історії. Задайте повернений ID та фактичний workers.dev origin:

```sh
export DEMO_RECEIVER_MODE=normal
npm run demo:config
npm run build:demo
export DEMO_FREE_CONFIRMED=yes
npm run demo:release:guard
```

`DEMO_FREE_CONFIRMED=yes` — підтвердження оператором уже зафіксованих
доказів, не автоматична перевірка акаунта. Build на synthetic параметрах
допустимий тільки для локального тесту й не є релізом.

П’ять secret bindings: `COMMAND_HMAC_SECRET`, `IP_HMAC_SECRET`,
`PARTNER_TOKENS` (JSON map для `demo-partner`), `REPORT_USERNAME`,
`REPORT_PASSWORD`. HMAC/partner/password — незалежні 32 випадкові байти
у canonical base64url (43 символи); username відповідає серверному
контракту. Секрети генерує/зберігає оператор поза Git. Встановлюйте їх
через захищене середовище; не вставляйте значення в argv, чат чи лог.
Початкове завантаження secret bindings виконується **після ініціалізації
нової історії нижче**, до Worker deploy:

```sh
node --input-type=module <<'JS' | npx wrangler secret bulk --config .wrangler/wrangler.demo.json
const keys = ['COMMAND_HMAC_SECRET','IP_HMAC_SECRET','PARTNER_TOKENS','REPORT_USERNAME','REPORT_PASSWORD'];
const values = Object.fromEntries(keys.map(key => {
  if (!process.env[key]) throw new Error('secret_missing');
  return [key, process.env[key]];
}));
process.stdout.write(JSON.stringify(values));
JS
```

Pipe передає тільки stdin Wrangler. Не запускайте ліву частину окремо.
Не міняйте чинні секрети при повторному deploy: це зламає HMAC/replay.

## Міграції → початкова історія → schema gate

```sh
npm run demo:guard
npx wrangler d1 migrations apply "$DEMO_DATABASE_NAME" --remote --config .wrangler/wrangler.demo.json
```

Міграції 0001–0005 незмінні й додавальні. **Лише для доведено нової БД**,
до будь-якого Worker/Cron, оператор задає `HISTORY_DAY_MS`: доведений
цілий UTC-день початку обліку, не майбутній. Згенеруйте існуючий guarded
initializer і перегляньте SQL перед виконанням:

```sh
node --input-type=module <<'JS' > .wrangler/demo-new-history.sql
import { newHistorySql } from './scripts/report-history.ts';
const day = Number(process.env.HISTORY_DAY_MS);
if (!process.env.HISTORY_DAY_MS || day > Date.now()) throw new Error('invalid_history_day');
console.log(newHistorySql(day));
JS
npx wrangler d1 execute "$DEMO_DATABASE_NAME" --remote --config .wrangler/wrangler.demo.json --file .wrangler/demo-new-history.sql
```

При повторному deploy **пропустіть initializer**: не змінюйте metadata
або бізнес-дані. Якщо попередня історія сумнівна, застосовуйте
[окрему діагностику](report-operations.md), не «ремонт» під реліз.
Read-only gate перевіряє повну DDL-схему (таблиці, колонки, constraints,
індекси й FK), список міграцій, FK цілісність, singleton/control рядки,
чотири бюджети, дев’ять cleanup cursor фаз і підтверджену history boundary:

```sh
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { schemaSql } from './scripts/demo-schema.ts';
const database = process.env.DEMO_DATABASE_NAME;
if (!database) throw new Error('database_required');
const result = execFileSync('npx', ['wrangler', 'd1', 'execute', database,
  '--remote', '--config', '.wrangler/wrangler.demo.json', '--command', schemaSql, '--json'],
  { encoding: 'utf8', env: { ...process.env, WRANGLER_WRITE_LOGS: 'false' } });
writeFileSync('.wrangler/demo-schema-result.json', result, { mode: 0o600 });
JS
node scripts/demo-schema.ts check .wrangler/demo-schema-result.json
```

Для read-only SELECT використовується `--command`: remote `--file`
проходить import-шлях Wrangler і повертає import statistics замість
потрібних рядків результату. SQL передається окремим аргументом Node
`execFileSync`, без shell interpolation.

Потрібні exit 0 і `demo_schema_valid`. Gate сам не створює й не виправляє
жодного рядка. Це перевірка схеми/control, не повний аудит бізнес-історії.

## Worker/assets → bounded smoke

Після завантаження секретів через stdin і проходження schema gate:

```sh
npm run demo:release:guard
npx wrangler deploy --config "dist-demo/${DEMO_WORKER_NAME//-/_}/wrangler.json"
npm run demo:smoke
```

Команда шляху використовує zsh/bash. Для smoke у env потрібні
`DEMO_ORIGIN`, `REPORT_USERNAME`, `REPORT_PASSWORD`, `PARTNER_TOKEN`.
Токен відповідає `demo-partner`. Не передавайте Basic Auth у URL.
Chromium встановлено через `npx playwright install chromium`.

Smoke має загальний timeout 180 секунд, HTTPS/TLS без обходів, новий
browser context, read-only report baseline **до** квізу. Він проходить
women/asia/synthetic email → 003 → CLI Lead → bypass → Purchase →
точний replay → друга Purchase, звіряє прирости після кожного кроку;
фінально 1/1/1/1/1/1/2. Зовнішня навігація браузера заблокована.
Немає SQLite, seeded UserID, reset, screenshots/trace або сирих bodies/
headers у помилках. За timeout стан може бути частково прийнятим;
не повторюйте весь smoke навмання — використайте збережені ignored CLI
файли для точного replay та діагностики. Не запускайте паралельне демо
і не починайте за три хвилини до UTC-півночі.

## Реальний Cron і відмова приймача

Smoke не доводить Cron. Окремо прочитайте захищений
`/api/v1/report/status` щонайменше двічі з інтервалом понад хвилину:
має зростати `cron.last_attempt_at`, з’явитися успішний запуск,
`delivery.last_ack_at`, delivered; pending має вичерпатися.
Зберігайте лише безпечні status поля/часи. Розповсюдження Cron-конфігурації
може тривати до 15 хвилин; обмежте спостереження 20 хвилинами, без endpoint
ручного запуску й без видавання локального scheduled тесту за cloud Cron.

Демонстрація SC-10 після завершення числового smoke:

1. Змінити лише `DEMO_RECEIVER_MODE=unavailable`, згенерувати конфіг,
   виконати `build:demo` і `demo:release:guard`, вручну deploy той самий
   SHA. Міграції, history initializer і secret rotation не потрібні.
2. Через UI/CLI прийняти одну нову синтетичну подію з новим PartnerEventID.
   Дочекатися реального Cron; status має показати unavailable, pending
   та delivery error/backoff. Зафіксувати технічні числа/часи без payload.
3. Повернути `DEMO_RECEIVER_MODE=normal`, повторити config/build/guard/deploy.
   Після backoff і реального Cron побачити новий ACK та спад pending без
   reset. Саме прийняття постбека не є підтвердженням доставки.
4. Записати deployment IDs, UTC часи, release SHA, smoke результат,
   два Cron спостереження й unavailable/recovery у фактичний release record.
   Якщо 20-хвилинне вікно минуло, зупинити перевірку й діагностувати;
   не продовжувати нескінченне очікування і не позначати M6 завершеним.

## Перевірки та фактичний стан

Фінальний local check: 571 Vitest, 89 Playwright, типи/build, exit 0;
CI release SHA `01aaa04` успішний. Schema gate пройшов на isolated local
D1 та реальній demo D1. Artifact guard перевіряє clean SHA і зміну bundle;
cloud IP має регресію реального edge запиту. Три review зауваження та
два операційні дефекти першої спроби усунені, відкладених немає.

Cloud deploy, числовий smoke, реальний Cron і unavailable → normal
recovery виконано на Free. Демо залишено normal, pending=0 на завершення
перевірки. [Повний фактичний запис](m6-release-result.md) містить версії,
часи, виправлені збої й межі висновків. Dev persistence не змінювалася;
reset/restore, реальних партнерських переходів або листів не було.

## Офіційні джерела

Перевірено 2026-11-01:

- [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/):
  межі CF-Connecting-IP, same/cross-zone subrequests, CF-Worker, Pseudo IPv4.
- [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/):
  лічильники локальні для location, спільні за namespace; це не глобальний
  точний limiter. Фактичний Free допуск — окремі evidence й малий deploy.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) і
  [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/):
  тариф/квоти звіряються також для конкретного акаунта.
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/):
  bindings, Web Crypto, secrets, обмеження logging.
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/):
  scheduled handler і час розповсюдження налаштувань.


- [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/):
  `--command` для read-only query, `--file` для import; звірено 2026-11-01.
