# Unicorn — система подій та аналітики воронок

Тестове завдання Senior Full-Stack Engineer — AI & Automation.
Система має збирати події квізу, обирати партнерський офер, приймати
підтверджені Lead/Purchase та будувати звіт за записаними подіями.

**Стан на 2026-11-01:** проєктування та локальні M0–M5 завершено.
Працює квіз → A/B → назва/URL і ClickID → CLI Lead → повернення без
квізу → Purchase/повтор → закритий звіт за подіями D1.
[Підсумковий BMAD-аудит M2](docs/bmad/reviews/2026-11-01-m2/report.md)
містить звірку з ТЗ, виправлення й фактичні результати перевірок.

M3 перевірено за матрицею відновлення й захисту SC-03–09/13;
[BMAD-аудит M3](docs/bmad/reviews/2026-11-01-m3/report.md) містить
виправлення й докази. M4 — [Cron і доставка](docs/m4-delivery.md),
[retention і технічний стан](docs/m4-retention.md) — завершено після
[підсумкового BMAD-аудиту](docs/bmad/reviews/2026-11-01-m4/report.md).
M5 завершено: [операційна процедура історії](docs/report-operations.md),
[демонстрація](docs/demo-walkthrough.md), [підсумковий BMAD-аудит](docs/bmad/reviews/2026-11-01-m5/report.md).
Локальний check: 534 Vitest, 89 Playwright, типи/build — успішно.
Хмарне демо — наступний M6.
Хмарного deploy немає. [CI на Ubuntu](https://github.com/deysan/unicorn-funnel-analytics/actions/runs/41192836436)
підтверджено для M0 (`552be84`); для M1–M5 виконано локальні перевірки.
Деталі: [каталог](docs/m2-offer-selection.md), [команди квізу](docs/m2-quiz-commands.md),
[A/B](docs/m2-final-commands.md), [HTTP/UI](docs/m2-http-ui.md),
[постбеки/CLI](docs/m2-partner-postbacks.md), [звіт](docs/m2-report.md),
[відновлення й захист M3](docs/m3-recovery.md).

## Локальний запуск

Потрібні Node **24.22.2** і npm **11.19.1**. Через наявний nvm:

```sh
nvm install
nvm use
npm ci
npm run dev
```

Без nvm встановіть ці самі версії своїм менеджером середовища.
`.nvmrc` фіксує Node, а `.npmrc` відхиляє несумісні версії Node/npm.
Відкрийте <https://localhost:5173>: «Жінки» → «Азія» → синтетичний
email (наприклад, `Synthetic@example.test`) → пропозиція 003.
Назва, URL і ClickID показуються без переходу на зовнішній сайт.
HTTP-адаптер результату B перевіряється окремо: 303, Location зі збереженим
ClickID і відсутність зовнішніх запитів. Публічний демо-API повертає JSON.
Технічна перевірка з’єднання з D1 збережена на `/diagnostics`.

`dev` створює лише відсутні стабільні секрети у ignored `.dev.vars`,
локальний self-signed TLS-сертифікат у `.wrangler/tls` (потрібен OpenSSL)
та додавально застосовує міграції 0001–0005 до `.wrangler/state`.
Дані не скидаються. Окремо доступний `npm run setup:local`.
Для ручного запуску браузер попросить прийняти локальний сертифікат.
HTTPS потрібен для Secure cookie в WebKit; захисні атрибути не послаблено.

Cloudflare login і створення хмарної бази для цього запуску не потрібні.
Binding `DB` має `remote: false`, локальні дані зберігаються в `.wrangler/`
і не потрапляють у Git. `database_id` у конфігу — локальний ідентифікатор;
хмарну базу не створено. Команди deploy відсутні.

## Локальна демонстрація партнерських подій

Залиште `npm run dev` працювати; виконайте квіз і скопіюйте ClickID.
В іншому терміналі підготуйте середовище. `PARTNER_TOKENS` містить чинні
серверні доступи; CLI отримує тільки токен одного партнера через env.
Команди нижче не виводять секрет і не передають його в argv або URL:

```sh
export PARTNER_TOKEN="$(node --env-file=.dev.vars -p 'JSON.parse(process.env.PARTNER_TOKENS)["demo-partner"]')"
export NODE_EXTRA_CA_CERTS="$PWD/.wrangler/tls/cert.pem"
CLICK_ID='вставте-ClickID-із-квізу'

npm run partner -- prepare --file lead.json --type Lead --click "$CLICK_ID"
npm run partner -- send --file lead.json --target https://localhost:5173
```

Відкрийте свіжий `/` у тому самому браузері: Lead для 003 дає bypass
без нового квізу/email. Далі — Purchase, точний повтор, друга Purchase
і конфлікт першого ID зі зміненою сумою:

```sh
PURCHASE_ID="$(node -p 'crypto.randomUUID()')"
PURCHASE_AT="$(node -p 'new Date().toISOString()')"
npm run partner -- prepare --file purchase.json --type Purchase --click "$CLICK_ID" --id "$PURCHASE_ID" --at "$PURCHASE_AT" --amount-minor 2500 --currency USD
npm run partner -- send --file purchase.json --target https://localhost:5173
npm run partner -- send --file purchase.json --target https://localhost:5173
npm run partner -- prepare --file purchase-2.json --type Purchase --click "$CLICK_ID" --amount-minor 2500 --currency USD
npm run partner -- send --file purchase-2.json --target https://localhost:5173
npm run partner -- prepare --file conflict.json --type Purchase --click "$CLICK_ID" --id "$PURCHASE_ID" --at "$PURCHASE_AT" --amount-minor 2600 --currency USD
npm run partner -- send --file conflict.json --target https://localhost:5173
unset PARTNER_TOKEN
```

Успіх друкує `accepted`; останній send повертає `postback_conflict` і
ненульовий exit code. Два різні Purchase рахуються як окремі події;
повтор не змінює даних. Результати доступні у закритому звіті нижче. `prepare` створює файл
у ignored `.wrangler/partner-events/` і відмовляє, якщо він уже існує.
Для нової демонстрації використайте нові назви файлів. `send` завжди
читає ті самі байти; нові ID/час створюються тільки через `prepare`.
Після мережевої помилки явно повторіть `send` того самого файла.
Лише 429 `rate_limited` / 503 `rate_limit_unavailable` мають до трьох
автоматичних повторів із Retry-After або 60/30s та jitter 0–10%.
Мережеве очікування обмежено 10s на запит. HTTPS/TLS перевіряються,
redirect не виконується. CLI не змінює D1 напряму й не відкриває партнера.

## Закритий локальний звіт

Відкрийте [звіт](https://localhost:5173/report/). Браузер попросить
Basic Auth: значення `REPORT_USERNAME` і `REPORT_PASSWORD` містяться
тільки у локальному ignored `.dev.vars`. Setup генерує їх лише за
відсутності; не додавайте їх до URL, Git або клієнтського коду.
Звіт не поновлює cookie/профіль. Початковий період — поточний UTC-день
за серверним часом; фільтри застосовуються кнопкою і зберігаються в URL.
Квіз не змінюється від фільтра офера. Покупки та унікальні покупці —
окремі числа; конверсії враховують також пізні результати своїх ClickID.

Повна історія **нової** persistence підтверджується перед першим запуском
сервера: setup доводить відсутність D1 storage до міграцій і guarded SQL
атомарно записує UTC-день. Наявна dev-база з відсутніми метаданими
залишається без бізнес-чисел; setup не вигадує дату, не очищує дані й
не знімає `history_unverified`. Для неї потрібне [окреме доказове підтвердження
повноти](docs/report-operations.md). Ізольований E2E доводить повний шлях на новій тестовій історії.
Не видаляйте dev persistence заради нульового звіту.

API: `/api/v1/report/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD` з опційними
`preland_id`/`offer_id`; `/api/v1/report/status` і `/api/v1/report/filters`
без параметрів. HTML/API мають `no-store`, окремі IP300/min і спільний
report30/min ліміти. Поточний adapter призначено лише для localhost.
Автооновлення — через 60s після завершення спроби у видимій вкладці;
помилка або недоступна історія приховує числа. [Cron/очищення](docs/m4-retention.md)
та імітатор експорту реалізовані локально. Технічний стан показує фактичні
counts, capacity alerts, Cron/ACK, безпечні помилки й підсумки обслуговування.
[Контракт і межі](docs/m2-report-contract.md), [реалізація й перевірки](docs/m2-report.md).

## Перевірка

```sh
npx playwright install chromium firefox webkit
npm run check
```

`check` генерує типи Worker з конфігу, перевіряє TypeScript (включно з
тестами), виконує Vitest, збирає клієнт і Worker та виконує браузерну матрицю
проти локального preview збірки.
Перед перевіркою створюються лише відсутні локальні секрети/TLS-файли.
Повний smoke розділений на базовий Chromium, решту матриці, M3, аудит,
concurrency, CLI та дві report-групи з окремим запуском
тестової persistence для кожної групи; реальні rate limits незмінні.
Порт 4173 має бути вільним; тест сам запускає й зупиняє preview.
Окремо доступні `npm run typecheck`, `npm run build` і `npm run test:smoke`
(останній потребує попередньої збірки). Для ручного перегляду збірки —
`npm run preview` на <https://localhost:4173> після `npm run setup:local` і build.

Перевірки охоплюють M0–M5, внутрішні команди та локальний шлях
HTTP → D1 → квіз. Playwright використовує окрему `.wrangler/e2e-state`,
що очищується перед прогоном; dev-база не змінюється. Синтетичні тестові
профілі створює приватний Node setup, без публічних test/admin endpoints.
Фінальний локальний `CI=true npm run check` M5: **534 Vitest**
(193 unit + 341 Worker) та **89 Playwright** (26 базових Chromium +
24 матриця + 6 M3 + 9 аудит + 4 concurrency + 2 CLI + 14 report +
4 report матриця); типи/build — exit 0, без test retries.
Для одного попереднього Q1 503 причина лишилася невідомою; власник
дозволив [виняток лише для цього інциденту](docs/m4-q1-incident.md).
У поточному аудиті нових збоїв немає; загальне правило D-111 чинне.
Конфіг локального runtime використовує `compatibility_date: 2026-10-30`:
встановлений workerd ще не підтримує 2026-10-31.

## Vitest

Окремі запуски без браузера:

```sh
npm run test:unit
npm run test:worker
npm test
npm run test:watch
```

`unit` запускає чисті перевірки в Node: shared-контракт і HMAC команд.
Додано правила вибору офера, email-нормалізацію та контракти recovery.
`worker` виконується в локальному workerd:
реальний D1 binding для HTTP/SQL та контрольований збій binding для 503.
Звичайний `npm test` запускає обидва набори, `test:watch` — режим розробки.
Автоматичних повторів і успіху при порожньому наборі немає.

Vitest створює окреме тестове сховище для кожного Worker-файла й не
використовує dev-базу `.wrangler/`. Усередині одного файла очищення
тестових таблиць виконується явно в `beforeEach`; залежні від такої
фікстури тести не запускаємо через `it.concurrent`. Синтетичні таблиці
каркаса відокремлені від бізнес-міграцій. Файли `isolation-a/b` перевіряють ізоляцію
на однаковому імені таблиці без взаємного очищення.

Міграції 0001–0005 перевіряються у справжній ізольованій D1:
CHECK/UNIQUE/FK, rollback цілого batch, ключі/результати, конкурентні
зміни, бюджети, атомарний ClickID і партнерські події. Каталог
перевіряється до Vite/build; некоректний конфіг зупиняє весь запуск.
Звіт перевіряється числовою SC-14, часовими межами, фільтрами й
відмовами доступу/метаданих. Історія доказів — у
[протоколі M1](docs/m1-command-protocol.md) і [аудиті M2](docs/bmad/reviews/2026-11-01-m2/report.md).

## Браузерна матриця й CI

| Проєкт | Обсяг | Емуляція |
|---|---|---|
| chromium | Усі браузерні тести | Desktop Chrome |
| firefox | `@critical` | Desktop Firefox |
| webkit | `@critical` | Desktop Safari |
| mobile-chromium | `@critical` | Pixel 7, 412×839 |
| mobile-webkit | `@critical` | iPhone 13, 390×664 |

Мобільні проєкти — емуляція Playwright, не реальні телефони; WebKit не є
перевіркою встановленого Safari. Зараз перевіряємо зв’язок UI → Worker → D1,
помилку мережі/повтор, невалідну відповідь і доступність кнопки без
горизонтального прокручування. API 404 додатково перевіряється в Chromium.
Підключені квіз/A/B, reload результату, Back, storage/network recovery
та bootstrap двох вкладок. Звіт перевіряє серверний HTML/API gate,
URL/refresh/visibility/error і справжній CLI → D1 → покупки/покупців.

Браузерні тести імпортують `test`/`expect` із `tests/smoke/fixtures.ts`.
Він ізолює app-data Firefox на macOS і прибирає тимчасові каталоги після
закриття браузера. Критичні для сумісності сценарії позначаємо `@critical`.
Окремий запуск: `npm run test:smoke -- --project=firefox` після збірки.
Повна перевірка перед фіксацією — `npm run check`; пропуски/падіння
обов’язкових тестів не зараховуємо як успіх. Автоматичних повторів немає.

[CI](.github/workflows/ci.yml) на стандартному `ubuntu-24.04` запускається
для PR/push у `master` та вручну. Зміни лише `docs/**`/Markdown не запускають
обчислювальний job. Один job до 15 хвилин виконує `npm ci`, встановлює
браузери із системними бібліотеками та запускає `npm run check`.
Застарілі запуски того самого PR/гілки скасовуються; `test.only` у CI заборонено.
Логи містять SHA фактично перевіреного checkout, включно з merge SHA для PR.
Кеш і завантаження артефактів не ввімкнені; діагностика є в журналі run.
Секрети Cloudflare, доступ до демо-D1, міграції та deploy у workflow відсутні.

Free-передумови D-177 перевірено 2026-10-31: Actions доступні, включена
квота є, доплати заблоковані нульовим бюджетом. Перед майбутнім хмарним
використанням повторно звіряємо актуальні умови. При вичерпаній квоті —
локальна перевірка конкретного SHA з явною позначкою, що CI не виконувався.

## Структура

- `src/client` — React-сторінка та звернення до API.
- `src/server` — Hono Worker і прямий SQL через D1 binding.
- `src/shared` — безпечні для браузера контракти квізу, постбеків і звіту.
- `tests/smoke` — квіз, recovery, CLI/постбеки та закритий звіт у браузерах.
- `tests/unit` — чисті перевірки у Node (`vitest.unit.config.ts`).
- `tests/worker` — HTTP/D1 у Workers runtime (`vitest.worker.config.ts`).

Дозволені імпорти: client → shared, server → shared. Серверні конфігурації
та секрети не належать shared або клієнтському bundle. Згенерований
`src/server/worker-configuration.d.ts` відновлюється через `npm run types`.

## Документація

- [План роботи](docs/plan.md) — етапи, результати та поточний прогрес.
- [Вимоги та припущення](docs/requirements.md) — вимоги з ТЗ, відкриті питання,
  пропозиції та критерії перевірки.
- [Журнал рішень](docs/decisions.md) — прийняті рішення та їхня підстава.
- [Основні сценарії](docs/scenarios.md) — покрокова поведінка й очікувані
  результати.
- [Аудит сценаріїв](docs/scenarios-audit.md) — покриття ТЗ, виправлення
  та питання AR-01–AR-10 для архітектури.
- [Дизайн системи](docs/system-design.md) — коротке тематичне зведення й схема Excalidraw.
- [План реалізації](docs/implementation-plan.md) — залежності, наскрізний зріз, перевірки та реліз.
- [Місткість і доставка](docs/capacity-and-delivery.md) — межі Free та шлях до BigQuery.
- [Деталі й історія дизайну](docs/architecture-notes.md) — збережені контракти P/D.
- [BMAD](docs/bmad/README.md) — версія, відтворення підключення, порядок рев'ю
  та використання наявної документації у фреймворку.
- [Аудит вимог](docs/requirements-audit.md) — перевірки, усунені прогалини
  й обов'язкові завдання для архітектурного дизайну.
- [Робота з AI](docs/ai-worklog.md) — суттєві доручення, пропозиції, рішення людини
  та перевірки.
- [Інструкції агенту](AGENTS.md) — правила роботи з репозиторієм.

Поточна перевірка комплектності — [звірка з ТЗ](docs/design-scope-check.md).
Аудит усього M4 завершено; [звіт і докази](docs/bmad/reviews/2026-11-01-m4/report.md).
M5 завершено: [звірка з ТЗ й докази](docs/bmad/reviews/2026-11-01-m5/report.md).
Наступний блок — M6: перевірка Free-передумов і ручне хмарне демо.

## Джерела та статус

Основне джерело — [текст тестового завдання](https://docs.google.com/document/d/1gitcbjFaNR_rz8BGErQgLVJqi2njv494-tsCNPPIbRY/edit).
Вимоги опрацьовано 2026-10-29. Процес здачі уточнений у листуванні 2026-10-27:
обидва етапи виконуються без очікування проміжного погодження компанії.
2026-10-29 Андрій підтвердив, що додаткових вимог на співбесіді не було.

Приватний репозиторій: <https://github.com/deysan/unicorn-funnel-analytics>.
Листування, персональні дані та секрети до репозиторію не копіюємо.

Хмарного демо поки немає. Перший CI M0 успішний; межі перевірки —
[середовище M0](docs/m0-environment.md).
