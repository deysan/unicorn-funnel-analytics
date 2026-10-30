# Технічна здійсненність: платформа та версії

Дата перевірки: **2026-10-30**. Статус: доказова довідка агента для фінального
аудиту дизайну; не нове рішення власника і не результат запуску системи.
Перевірено офіційні Cloudflare Docs через Cloudflare Docs MCP, документацію
Node.js/Zod/Playwright та метадані публічного npm registry. Пакети не
встановлювалися; ресурсів, конфігурації, секретів і deploy не створено.

Контекст: [межі Free](../../../cloudflare-free-tier.md),
[деталі дизайну](../../../architecture-notes.md), зокрема P-29/P-30/P-58, P-35–P-37,
P-75 та P-83. Джерелом прийнятих рішень лишаються
[requirements](../../../requirements.md) і [decisions](../../../decisions.md).

## 1. Workers Rate Limiting API

**Підтверджено:** binding має статус GA; поточна конфігурація використовує
`ratelimits`, потрібен Wrangler ≥ 4.36.0. Вікно — 10 або 60 секунд.
Лічильник приблизний, окремий для кожної локації; синхронізація асинхронна,
тому навіть у межах однієї локації можливе перевищення порога. Це відповідає
обмеженому захисту демо D-101, але не є строгим глобальним бюджетом.
Джерела: [binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[оголошення GA](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/).

**Не підтверджено:** доступність саме цього binding на Workers Free нашого
акаунта та відсутність додаткової оплати. У перевірених binding, GA і
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
матеріалах не знайдено явного тарифного твердження, достатнього для такого
висновку. Приклади `FREE_USER_RATE_LIMITER` стосуються тарифів користувачів
застосунку; вони не підтверджують Workers Free. Спільна інфраструктура з WAF
також не переносить умови WAF на Worker binding. Відсутність окремого рядка
ціни сама по собі не означає $0.

**Висновок агента:** зберегти статус кандидата P-75. Обмежена передумова
першого хмарного розгортання — отримати явне офіційне або доступне в акаунті
підтвердження Free-доступності та умов оплати, зафіксувати його, а потім
перевірити binding малим синтетичним сценарієм. Успішний локальний запуск
або сам deploy не доводить безоплатність. Якщо Free/$0 підтвердити не можна,
механізм потребує окремого погодження; це не дозвіл увімкнути Paid чи
непомітно прибрати погоджений rate limit. Невідоме обмежене тарифом/доступом,
а поведінка 429/503 та ключі вже визначені D-101–D-107.

## 2. Кандидат для майбутнього lockfile

Нижче — **пропозиція версій**, а не вже прийнятий або протестований lockfile.
npm `/latest` на дату перевірки повернув наведені прямі релізи без prerelease
суфіксів. Для Node запропоновано актуальний patch гілки 24 LTS; Node 26 також
уже LTS, але переходити на нього для цього набору не потрібно.

| Компонент | Кандидат | Перевірені умови та первинне джерело |
|---|---|---|
| Node.js | 24.22.2 LTS | Опубліковано 2026-10-27, npm 11.19.1 у дистрибутиві: [індекс релізів](https://nodejs.org/dist/index.json), [статус LTS](https://nodejs.org/en/about/previous-releases) |
| React / React DOM | 19.3.1 / 19.3.1 | DOM вимагає React `^19.3.1`: [React](https://registry.npmjs.org/react/latest), [React DOM](https://registry.npmjs.org/react-dom/latest) |
| TypeScript | 7.0.2 | Node `>=16.20.0`: [registry](https://registry.npmjs.org/typescript/latest) |
| Vite | 8.3.5 | Node `^20.19.0 \|\| >=22.12.0`: [registry](https://registry.npmjs.org/vite/latest) |
| `@vitejs/plugin-react` | 6.1.2 | Vite `^8.0.0`, та сама межа Node, що у Vite: [registry](https://registry.npmjs.org/%40vitejs%2Fplugin-react/latest) |
| Hono | 4.13.14 | Node engine `>=16.9.0`, без runtime dependencies: [registry](https://registry.npmjs.org/hono/latest) |
| Zod | 4.6.7 | Без runtime dependencies: [registry](https://registry.npmjs.org/zod/latest); [документація](https://zod.dev/) підтримує TS ≥ 5.5 та вимагає `strict: true` |
| Vitest | 5.0.5 | Node `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`; Vite `^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0`: [registry](https://registry.npmjs.org/vitest/latest) |
| `@playwright/test` | 1.64.1 | Node `>=20`, залежність `playwright=1.64.1`: [registry](https://registry.npmjs.org/%40playwright%2Ftest/latest); [документація](https://playwright.dev/docs/intro) рекомендує актуальні Node 22/24/26 |
| Wrangler | 4.156.0 | Node `>=22.0.0`: [registry](https://registry.npmjs.org/wrangler/latest); задовольняє мінімум rate-limit binding |
| `@cloudflare/vite-plugin` | 1.66.0 | Vite `^6.1.0 \|\| ^7.0.0 \|\| ^8.0.0`, Wrangler `^4.154.0`: [registry](https://registry.npmjs.org/%40cloudflare%2Fvite-plugin/latest) |
| `@cloudflare/vitest-plugin` | 1.4.11 | Vitest `^4.1.0 \|\| ^5.0.0`, власна залежність Wrangler `4.156.0`: [registry](https://registry.npmjs.org/%40cloudflare%2Fvitest-plugin/latest) |
| React type declarations | `@types/react=19.3.0`, `@types/react-dom=19.3.0` | DOM types вимагає React types `^19.3.0`: [React types](https://registry.npmjs.org/%40types%2Freact/latest), [DOM types](https://registry.npmjs.org/%40types%2Freact-dom/latest) |

**Перевірений висновок із метаданих:** Node 24.22.2 задовольняє наведені
engine ranges; Vite 8.3.5, Vitest 5.0.5, Wrangler 4.156.0 та плагіни
задовольняють наведені взаємні peer ranges. Optional peers React-плагіна
для додаткових compiler/Babel можливостей не означають, що ці можливості
обрані для MVP. Пакет Hono працює у Worker, а Node потрібен інструментам
розробки; engine range не перетворює Worker на Node runtime.

**Межі цього доказу:** npm metadata не замінюють повне dependency resolution,
typecheck, збірку, D1/Vitest integration та Playwright. Опубліковані стабільні
пакети Cloudflare містять власні prerelease-залежності (`miniflare` 5 beta,
`unenv` 2 rc); отже весь транзитивний граф не можна називати виключно stable.
Vite plugin також містить власний Wrangler 4.154.0, а Vitest plugin — 4.156.0;
не припускаємо одну фізичну копію всіх інструментів. Остаточний граф і
`compatibility_date` фіксуються лише на етапі реалізації після повторної
перевірки. `latest` у джерелах рухомий; наведені числа — знімок цієї дати.

Поточна [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
підтверджує саме `@cloudflare/vitest-plugin`, локальний Workers runtime
через Miniflare та ізоляцію сховища між файлами. Старий
`@cloudflare/vitest-pool-workers` не слід механічно переносити у новий
стартер. Доказів фактичної сумісності коду Unicorn поки немає.

## 3. Межі однієї D1 та Cron на Free

| Підтверджений факт | Наслідок для погодженого демо |
|---|---|
| D1 Free: 500 MB на базу, 5 GB на акаунт, 10 баз | Загальна квота не збільшує місткість єдиної бази D-029/D-030. Рядкові бюджети демо не доводять фізичну місткість із payload та індексами. |
| 5 млн прочитаних, 100 000 записаних рядків/добу | Індекси й очищення також витрачають квоту; batch не зменшує кількість облікованих рядків. |
| 50 D1 query calls на Worker invocation у Free; `batch()` рахується як один call | Потрібно рахувати суму викликів усіх фаз Cron. Межі окремих statements усередині batch зберігаються. |
| 100 bound parameters на statement; 100 KB SQL; максимум 30 секунд на query/цілий batch | Порції та SQL-протоколи мають враховувати ці межі. Кількість рядків у порції сама по собі не визначає кількість параметрів. |
| Окрема D1 виконує запити по одному; перевантаження може повертати помилку | Звіт, команди, очищення та доставка конкурують за одну базу. Це не доказ піка або p95 з NFR. |
| Workers Free: 10 мс CPU на HTTP **і на Cron invocation**, 5 Cron Triggers на акаунт | 30 секунд/15 хвилин CPU для Cron належать Paid. Очікування мережі/D1 не входить у CPU; JS-обробка, валідація, серіалізація та інші обчислення входять. |

Джерела: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time).
З 2026-09-01 перевищення добових D1 Free row quotas призводить до помилок
до 00:00 UTC; збережені дані не видаляються:
[офіційне оголошення](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

**Висновок агента:** P-29/P-30 вже коректно визнають ризик 10 мс CPU.
Пакет до 10 подій не гарантує вкладення, особливо разом із перевірками
цілісності й очищенням P-58. До першого deploy потрібні конкретні обмежені
порції та підрахунок D1 calls/parameters/рядкових квот; після реалізації —
звичайна функціональна перевірка малих сценаріїв і поведінки після збою.
Це не пропозиція навантажувального benchmark і не підстава заявляти
досягнення NFR. Відсутність CPU-збою в одному сценарії також не є гарантією
для всіх наборів даних. Платний тариф або зміна архітектури цим memo не погоджені.
