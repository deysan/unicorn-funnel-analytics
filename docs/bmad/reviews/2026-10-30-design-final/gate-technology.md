# Фінальний gate: технологічна здійсненність

Дата: 2026-10-30. Незалежний контекст технологічного рев’ю за configured
lens `bmad-architecture`; без квоти зауважень. Перевірено frozen input
`/private/tmp/unicorn-design-audit-20261030-863b4a4/final-pass-1/review-input.md`.
Основні об’єкти: architecture spine, system-design, capacity-and-delivery,
implementation-plan, platform-evidence та текст обох форматів діаграми.

**Вердикт: PASS для завершення дизайну. Доказових нових зауважень немає.**
Це не підтвердження працездатності коду, виконання NFR або готовності deploy.
Наявні передумови M0–M6 залишаються чинними; особливо Free/$0 для
rate-limit binding, фактичний SQL/байти/квоти та перевірка runtime.

## Зауваження

```json
[]
```

Немає critical/high/medium/low findings, які вимагали б зміни погодженого
стеку або цього документа до проходження саме технологічного design gate.
Невідомі, які пакет прямо позначає й зупиняє відповідним майбутнім gate,
не видано за нові дефекти.

## Платформа та її реальні гарантії

| Перевірка | Результат |
|---|---|
| Workers Free | Підтверджено 100 000 динамічних запитів/добу, 10 мс CPU для HTTP і Cron; I/O-очікування не є CPU. Дизайн не переносить Paid Cron CPU до Free. |
| Одна D1 | Підтверджено 500 MB на Free-базу, 5 GB сумарно, 5 млн reads і 100 000 writes/добу. Загальна квота не збільшує одну базу. |
| D1 API | Підтверджено 50 query calls/invocation на Free; batch — один call. 100 параметрів та 100 KB застосовуються до окремого statement, а 30 секунд — і до цілого batch. |
| Атомарність | D1 документує rollback усієї batch при помилці statement. Отже AD-4 не спирається на неіснуючу транзакцію. Коректність конкретного CHECK-guard належить M1; жодного вже виконаного SQL-доказу не заявлено. |
| Продуктивність | Одна D1 виконує запити послідовно й може відмовити при перевантаженні. Документи не прирівнюють географію Worker до доведеного p95 усієї операції. |
| Rate Limiting | GA, `ratelimits`, Wrangler ≥4.36.0, вікна 10/60 секунд підтверджені. Лічильник приблизний навіть усередині локації, а між локаціями окремий; його не видано за глобальний точний бюджет. |
| Free rate limit | Явного доказу тарифу/доступності цього binding в акаунті немає. Пакет правильно зберігає це як передумову першого хмарного використання, забороняє автоматичний Paid fallback і не називає успішний deploy доказом $0. |
| Static Assets / Hono | Статичний React-клієнт із Worker API відповідає підтримуваній моделі. Hono має офіційний Workers-посібник; Static Assets мають окремі безкоштовні статичні запити. |

Незалежно прочитані 2026-10-30 первинні джерела:
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[D1 Free enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/),
[Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[Rate Limiting GA](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/),
[Hono Workers](https://hono.dev/docs/getting-started/cloudflare-workers).

## Версії та сумісність

Усі 14 npm-кандидатів у [platform-evidence](platform-evidence.md) незалежно
звірено читанням публічного registry 2026-10-30. Збіглися версії:
React/React DOM 19.3.1; TypeScript 7.0.2; Vite 8.3.5;
`@vitejs/plugin-react` 6.1.2; Hono 4.13.14; Zod 4.6.7; Vitest 5.0.5;
`@playwright/test` 1.64.1; Wrangler 4.156.0;
`@cloudflare/vite-plugin` 1.66.0; `@cloudflare/vitest-plugin` 1.4.11;
`@types/react` та `@types/react-dom` 19.3.0.

Node 24.22.2, дата 2026-10-27, LTS Krypton та npm 11.19.1 підтверджені
[офіційним індексом Node](https://nodejs.org/dist/index.json).
Node 26 уже позначений LTS у цьому індексі; вибір 24 LTS не є помилкою.

Ключові engine/peer ranges з довідки збігаються з registry: запропонований
Node задовольняє вимоги; Vite 8, Vitest 5 та Wrangler 4.156 відповідають
заявленим взаємним діапазонам. Optional React compiler/Babel peers справді
optional. Hono/Zod не мають runtime dependencies. Cloudflare-плагіни
справді містять власні різні Wrangler та prerelease Miniflare/unenv;
довідка цього не приховує. Первинні registry-URL наведені біля кожного
рядка [таблиці кандидатів](platform-evidence.md#2-кандидат-для-майбутнього-lockfile).

[Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
підтверджує поточний `@cloudflare/vitest-plugin`, локальний Workers runtime
та ізоляцію сховища між тестовими файлами.
[Zod](https://zod.dev/) підтверджує TS ≥5.5 і `strict: true`;
[Playwright](https://playwright.dev/docs/intro) — призначення та браузерні рушії.

Це перевірка існування й метаданих, а не dependency resolution чи запуск
застосунку. Spine, рядки 331–334 і 357–364, та M0 узгоджено залишають
lockfile, `compatibility_date`, typecheck/build/integration на початку
реалізації. Конкретний starter не обраний і не проголошений перевіреним,
тому неперевірені defaults стороннього starter не успадковуються.

## Ресурсна арифметика

Незалежний перерахунок [capacity-and-delivery](../../../capacity-and-delivery.md)
не виявив змістовних помилок:

- Модель payload і резерву: 269,906 MiB до індексів; із 35% — 364,373 MiB.
  До десяткових 500 MB лишається 112,464 MiB. Округлення «≈365 / близько
  110 MiB» консервативне. Це модель, не доведений максимальний обсяг.
- Малий день: `10×8 + 5×2 + 5 = 95` подій; за 90 днів — 8550.
  Writes: `95×100 + 1440×4 + 10000 = 25260`.
- Повний scan 10 000 рядків щохвилини — 14,4 млн reads/добу;
  шість проходів на 30 оновлень — 1,8 млн. Ризик додаткових Cron/report
  читань прямо враховано, один SELECT не названо одним scan.
- 12 млн/30 днів — 4,6296 події/с; 16 млн — 6,1728/с.
  Для усунення добового backlog за наступну добу при незмінному вході
  нижні швидкості — 9,2593 та 12,3457/с до запасу на повтори.
- 10 подій/хв — 14 400/добу; backlog 1000 потребує 100 хвилин без нового
  входу. Пік `200×300 = 60000` — 6% виробничого буфера 1 млн.
- 90-денна історія 36–48 млн подій потребує 36–48 GB при 1 KB або
  147,456–196,608 GB при 4 KiB до індексів/копій. Вона не поміститься в
  одну Free D1; цього від демо й не обіцяють.

Фізичний обсяг, SQL query plans, rows_read/rows_written і порції Cron
чесно залишені M1/M4/M5. Локальне тестування не доводить хмарну CPU-межу:
[Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)
описує застосування лімітів у хмарі. Пакет не подає локальні тести або
один майбутній smoke як доказ виконання виробничих NFR.

## BigQuery та імітатор

Розділ 3 capacity-and-delivery правильно відокремлює стійкий ідемпотентний
приймач у D1 від зовнішнього адаптера. HTTP 200 не гарантує прийняття всіх
рядків; потрібна індексна відповідність row errors та EventID. Невідомий
результат може породити повтор; `insertId` не забезпечує строгого dedup.
Raw-дублікати й канонічне читання описані окремо, конфлікт змісту одного
ID не оголошено автоматично вирішеним BigQuery.

Офіційний [REST-посібник](https://docs.cloud.google.com/bigquery/docs/write-api-rest)
підтверджує часткові помилки, best-effort dedup і можливість view для
читання без дублікатів. [gRPC-посібник](https://docs.cloud.google.com/bigquery/docs/write-api-grpc)
підтверджує at-least-once default stream та exactly-once для створеного
потоку з offsets. Отже кандидат транспорту існує; його вибір, OAuth,
ACK/dedup/conflict/visibility ще належить окремій інтеграції. Фізична
унікальність mock не переноситься на raw, однієї мережевої спроби не обіцяють.
Немає підстав додавати BigQuery чи інший сервіс у реалізацію MVP.

## Діаграма, план і межі перевірки

Текст Excalidraw та SVG збігається: один Worker/одна D1, окремі транзакції
приймача й ACK, локальний CLI, BigQuery лише майбутній. Підписи явно
називають компоненти запланованими, NFR невиміряними, код/deploy відсутніми.
Спрощення «заміна адаптера» читається разом із докладнішим контрактом
capacity-and-delivery й не створює окремої гарантії BigQuery.

Перевірка виконана читанням заморожених документів, офіційних вебджерел,
публічних registry-метаданих та арифметичним перерахунком. Пакети не
встановлювалися; SQL/браузерні тести, load tests, deploy та хмарні мутації
не виконувалися. Інших незалежних звітів рев’ю не читано; вихідні проєктні
документи не змінено. Результат обмежений технологічним lens цього gate.
