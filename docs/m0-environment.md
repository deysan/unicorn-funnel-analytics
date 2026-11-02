# M0 — локальне середовище

> Межі цього документа: етап станом на 2026-10-31. Проміжні статуси й
> результати нижче — історія відповідного етапу. Актуальний підсумок M0–M6:
> [хмарний реліз](m6-release-result.md), [план](plan.md).

Перевірено: 2026-10-31. npm погоджено як D-180, Node/npm та створення
локального каркаса — D-181. Каркас встановлено й перевірено; точні
залежності зафіксовані в `package.json` і `package-lock.json`.

## Версії для старту

Встановлено Node **24.22.2 LTS** із комплектним npm **11.19.1** через
наявний nvm, із перевіркою SHA-256 дистрибутива. Для активації у новому
shell потрібно виконати `nvm use`. Гілка Node 24 підтримується й задовольняє перевірені вимоги
інструментів. Node потрібен інструментам розробки; сервер працюватиме
у Workers runtime.

Джерела: [релізи Node](https://nodejs.org/dist/index.json),
[підтримувані гілки](https://nodejs.org/en/about/previous-releases).

| Пакет | Версія | Первинне джерело метаданих |
|---|---|---|
| react / react-dom | 19.3.1 / 19.3.1 | [React](https://registry.npmjs.org/react/19.3.1), [DOM](https://registry.npmjs.org/react-dom/19.3.1) |
| typescript | 7.0.2 | [registry](https://registry.npmjs.org/typescript/7.0.2) |
| vite | 8.3.5 | [registry](https://registry.npmjs.org/vite/8.3.5) |
| @vitejs/plugin-react | 6.1.2 | [registry](https://registry.npmjs.org/@vitejs/plugin-react/6.1.2) |
| hono | 4.13.14 | [registry](https://registry.npmjs.org/hono/4.13.14) |
| zod | 4.6.7 | [registry](https://registry.npmjs.org/zod/4.6.7) |
| wrangler | 4.156.0 | [registry](https://registry.npmjs.org/wrangler/4.156.0) |
| @cloudflare/vite-plugin | 1.66.0 | [registry](https://registry.npmjs.org/@cloudflare/vite-plugin/1.66.0) |
| vitest | 5.0.5 | [registry](https://registry.npmjs.org/vitest/5.0.5) |
| @cloudflare/vitest-plugin | 1.4.11 | [registry](https://registry.npmjs.org/@cloudflare/vitest-plugin/1.4.11) |
| @playwright/test | 1.64.1 | [registry](https://registry.npmjs.org/@playwright/test/1.64.1) |
| @types/react / @types/react-dom | 19.3.0 / 19.3.0 | [React](https://registry.npmjs.org/@types/react/19.3.0), [DOM](https://registry.npmjs.org/@types/react-dom/19.3.0) |

Прочитано `/latest` публічного npm registry для кожного пакета; таблиця
посилається на повернені конкретні версії. Набір збігається з кандидатом
фінального аудиту від 2026-10-30. Нової перевірки тарифів тут не проводили.

Додатково встановлено `@types/node` 24.19.2 — актуальна версія гілки 24
за [registry](https://registry.npmjs.org/@types/node/24.19.2).

## Що підтверджено

- Node 24.22.2 відповідає заявленим `engines` перевірених пакетів.
- Vite 8.3.5 задовольняє peer requirements React- і Cloudflare-плагінів
  та Vitest; Wrangler 4.156.0 — вимоги Cloudflare Vite plugin.
- Vitest 5.0.5 підтримується peer range Cloudflare Vitest plugin.
- React DOM і типи React DOM сумісні з відповідними версіями React/типів
  за метаданими. Необов’язкові peers не додаємо без потреби.

Метадані доповнено встановленням, збіркою та браузерним запуском нижче.
`compatibility_date` встановлено на **2026-10-30**: спроба 2026-10-31
була відхилена локальним workerd як непідтримувана. Wrangler містить транзитивні
Miniflare beta та unenv rc; стабільні номери прямих пакетів не означають,
що весь граф складається лише зі стабільних релізів.

## Фактичний результат

- `npm ci` пройшов; SHA-256 lockfile до/після однаковий:
  `e2089e1b01eaf3ae2ab01965623652818724f71f085784e8898bd20bed0bce1b`.
- `npm run typecheck` і `npm run build` пройшли з генерованими типами
  Worker; використано схему встановленого Wrangler і сигнатури D1.
- `npm run test:unit`: **6/6** перевірок shared-контракту у Node.
- `npm run test:worker`: **7/7** перевірок HTTP/D1 у workerd: успішний
  handler, 404, контрольований збій binding/503, SQL із параметрами,
  очищення всередині файла та ізоляція двох файлів.
- `npm test`: **13/13** через спільну конфігурацію projects.
- `npm run test:smoke`: **21/21** проти preview збірки — 5 Chromium і
  по 4 Firefox/WebKit/mobile-Chromium/mobile-WebKit:
  справжній запит UI → Worker → D1, JSON 404 для невідомого API,
  мережевий збій із ручним повтором, відхилення невалідної відповіді,
  доступна кнопка й відсутність горизонтального переповнення.
- `npm run dev` також перевірено браузером: результат D1 = 1.
  Оглянуто desktop 1100×760 і mobile 375×812; переповнення по ширині немає.
- Прочитано імпорти client/server/shared; shared не залежить від платформних
  API. У клієнтській збірці немає перевірених серверних маркерів SQL,
  коду `database_unavailable` і локального ID D1. Це обмежена перевірка,
  не загальний автоматичний аналіз секретів чи всього графа імпортів.
- Незалежний огляд BMAD Build: доказових зауважень до коду/конфігів/тестів
  немає. Рев’юер не запускав тести; фактичні запуски виконав основний агент.

npm повідомив про install scripts esbuild/workerd/fsevents, не покриті
`allowScripts`. Масового дозволу скриптів не додавали; перевірений запуск
на macOS arm64 пройшов. Інші ОС тут не перевіряли. npm audit під час
встановлення не повідомив про відомі вразливості; це не гарантія їх відсутності.

Команди відтворення — [README](../README.md). Cloudflare login, хмарні
ресурси та секрети не потрібні. D1 працює локально (`remote: false`),
бізнес-таблиць немає. Технічний маршрут не замінює майбутній захищений звіт.
Vitest налаштований для обох рівнів, але бізнес-правила й транзакційні
сценарії перевірятимуться разом з їх реалізацією. Погоджені п’ять
браузерних конфігурацій налаштовано; це покриття технічного каркаса,
не майбутніх бізнес-сценаріїв. Мобільні пресети — емуляція, не пристрої.

Тестові фікстури не потрапили в dev D1: read-only перевірка 7 локальних
SQLite-файлів не знайшла `__test_probe` або `__file_isolation`. Плагін
ізолює сховище на файл; усередині файла `beforeEach` очищує лише тестову
таблицю. Загальний `npm run check` пройшов після `npm ci`.
За дорученням власника фіксація відбувається після завершення всього
M0, M1 тощо. Існуючий коміт каркаса не переписували.

## Браузери та CI: перевірка 2026-10-31

- `CI=true npm run check`: typecheck, **13 Vitest**, build і **21 Playwright**
  успішні на macOS 27.0.1 arm64. Немає retries/skip; browser workers = 1.
- Бінарні версії Playwright 1.64.1: Chromium 156, Firefox 157, WebKit 27.2.
- Firefox спочатку завершувався до тестів через `Could not find profile folder`.
  Виявлено відповідний [upstream issue](https://github.com/microsoft/playwright/issues/42768).
  Ізоляція через новий системний home запустила тести, але дала помилку очищення;
  цей варіант прибрано. Остаточна fixture задає лише `MOZ_APP_DATA` та
  `MOZ_LOCAL_APP_DATA` для Firefox на macOS, за рекомендацією
  [Mozilla](https://bugzilla.mozilla.org/show_bug.cgi?id=2078511).
  Тести й teardown пройшли; особисті профілі/системні дозволи не змінювали.
- Браузерний TypeScript має окремий конфіг із DOM для `page.evaluate`.
- Workflow для стандартного Ubuntu 24.04 перевірено **actionlint 1.7.12**:
  exit 0, без зауважень. SHA-256 офіційного завантаження actionlint звірено.
- `actions/checkout` 7.0.1 і `actions/setup-node` 7.1.0 перевірено за
  офіційними release/tag і зафіксовано повними SHA в workflow.
- Read-only перевірка GitHub API/UI: приватний репозиторій, Actions
  доступні; Free, включена квота доступна, платне використання Actions
  зупинене нульовим бюджетом. Billing-налаштування не змінювали.
  Особисті деталі обліку не зберігаються в Git.
- CI: PR/push у master зі змінами поза docs/Markdown, ручний запуск,
  read-only token, без збереження git credentials, скасування застарілих
  run; job 15 хвилин, браузери 5 хвилин, test.only заборонено.
  Кеш/upload артефактів вимкнені; діагностика в логах, SHA — фактичний checkout.
- **Перший GitHub Actions успішний**, перевірено 2026-10-31:
  [run 41192836436](https://github.com/deysan/unicorn-funnel-analytics/actions/runs/41192836436)
  для `552be84de926b7f76823c41b1689f0200fd7b34f`, Ubuntu 24.04.
  Журнал підтверджує типи, 13 Vitest, build та 21 Playwright. Коміти M0
  запушено звичайним fast-forward; історію не переписували.
  Cloudflare demo/deploy/binding лишаються окремою передумовою M6.
- Незалежне рев’ю BMAD Build браузерного/CI-блоку не знайшло доказових
  дефектів; рев’юер читав код і перевірив diff, тестів повторно не запускав.

Джерела CI, перевірені 2026-10-31:
[Playwright CI](https://playwright.dev/docs/ci-intro),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-node 7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0),
[actionlint 1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12).

Первинні джерела, прочитані 2026-10-31:
[Cloudflare Vite tutorial](https://developers.cloudflare.com/workers/vite-plugin/tutorial/),
[D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

Джерела налаштування тестів (2026-10-31):
[Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/),
[початок роботи](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/),
[ізоляція](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/),
[Vitest projects](https://vitest.dev/guide/projects).
