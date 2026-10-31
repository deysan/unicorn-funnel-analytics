# M0 — локальне середовище

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
| vitest (наступна частина M0, ще не встановлено) | 5.0.5 | [registry](https://registry.npmjs.org/vitest/5.0.5) |
| @cloudflare/vitest-plugin (ще не встановлено) | 1.4.11 | [registry](https://registry.npmjs.org/@cloudflare/vitest-plugin/1.4.11) |
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
  `a19a3d88eb1e45813d10ac488fc416488016440f46979074712174e5d6da2513`.
- `npm run typecheck` і `npm run build` пройшли з генерованими типами
  Worker; використано схему встановленого Wrangler і сигнатури D1.
- `npm run test:smoke`: **4/4 Chromium тести** проти preview збірки —
  справжній запит UI → Worker → D1, JSON 404 для невідомого API,
  мережевий збій із ручним повтором, відхилення невалідної відповіді.
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
Повні рівні Vitest, браузерна матриця й CI залишаються наступними частинами M0.

Первинні джерела, прочитані 2026-10-31:
[Cloudflare Vite tutorial](https://developers.cloudflare.com/workers/vite-plugin/tutorial/),
[D1 local development](https://developers.cloudflare.com/d1/best-practices/local-development/),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
