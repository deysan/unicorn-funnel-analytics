# M6 — фактичний результат ручного релізу

**Завершено 2026-11-01.** [Демо](https://unicorn-demo.unicorn-deysan.workers.dev/),
[захищений звіт](https://unicorn-demo.unicorn-deysan.workers.dev/report).
Демо залишено в режимі `normal`; репозиторій приватний.
[Процедура відтворення](m6-release.md), [Free-докази](m6-free-evidence.md).

## Межі версії документа

Це результат релізу **2026-11-01**, зафіксований документаційним комітом
`fb8a582` після deploy. Код цього історичного релізу — `01aaa04`, а не цей чи наступний
документаційний SHA. [Перевірка лише читанням 2026-11-02](README.md#перевірка-пакета-2026-11-02)
збережена окремо; вона не повторює cloud smoke/recovery й не змінює
історичні числа нижче.

## Версія та перевірки

- Release SHA: `01aaa04d8079d0b12a59e918d51be6515b1a6752`.
- [CI цього SHA](https://github.com/deysan/unicorn-funnel-analytics/actions/runs/41348201985): success.
- Повний локальний `CI=true npm run check`: **571 Vitest, 89 Playwright,
  типи й build, exit 0**; `.wrangler/m6-edge-fix-check.log`.
- Три незалежні BMAD review layers, три виправлені зауваження; додатковий
  review cloud bugfix — без нових знахідок. [Окремі вердикти](bmad/implementation-artifacts/spec-m6-demo-release.md).
  Відкладених зауважень M6 немає.
- Demo artifact перед кожним deploy пройшов перевірку чистого SHA,
  конфігурації, hash seal та відсутності відомих секретів у файлах.
- Push не запускав deploy. Коміти й push — звичайні, без переписування
  історії; cloud secrets у CI не передавалися.

## Ресурси та порядок запуску

Створено одну D1 `unicorn-demo`, ID `699c68b3-ea27-41ef-9d77-346fab7247e9`,
2026-11-01 о 20:34:27.837 UTC, WEUR, read replication disabled.
Перед створенням API показав 0 Workers/0 D1; відповідь створення — 0 таблиць.
Це доказ нової історії, а не висновок лише з порожніх бізнес-таблиць.

Міграції `0001_transaction_assertions.sql`—`0005_maintenance.sql` застосовано
успішно. До Worker/Cron guarded initializer записав один рядок:
`history_available_from=1793491200000` (2026-11-01 00:00 UTC).
Read-only schema gate підтвердив DDL, міграції, FK та control metadata.
Remote SELECT виконано через `--command`: `--file` Wrangler використовує
як import і не повертає потрібний JSON-рядок. Дані не ремонтувалися/reset
не виконувався. П’ять demo secret bindings завантажено через stdin.

Один Worker із assets, одна D1, сім rate-limit bindings, один Cron
`* * * * *`. Остаточна версія Worker:
**`2c37d32e-e7cc-4261-a8c4-fb99ef7c7bd4`**.

| Deploy | Version ID | Результат |
|---|---|---|
| Початковий `3424e22`, normal | `366c62fe-1b7c-4a1f-9470-adb0ece73865` | Upload успішний; baseline smoke503 до бізнес-дій |
| Виправлений release SHA, normal | `eec5bffb-c7bc-4d9e-b5ee-245497957bfe` | Повний числовий smoke успішний |
| Той самий SHA, unavailable | `990ff490-1f0e-4c7b-b7bb-7675478b6bc1` | Реальна помилка доставки й pending |
| Той самий SHA, normal | `2c37d32e-e7cc-4261-a8c4-fb99ef7c7bd4` | ACK і pending=0 без reset |

Початкову помилку діагностовано, а не приховано повтором тесту: прямий edge
запит містив `x-real-ip`; адаптер помилково відхиляв його наявність.
Тепер цей заголовок ігнорується, ключ походить лише з валідованого
`CF-Connecting-IP` за HTTPS/edge context. CF-Worker, pseudo-IP і cross-zone
sentinel досі відхиляються. RED: 2 failed/14 passed; GREEN: 16/16;
після fix повний local check і новий CI успішні. Live tail виводив лише
наявність заголовків; disk logging було вимкнено, адреси не зберігалися.

## Smoke, захист і реальна доставка

Новий Chromium context: women/asia/synthetic email → 003 → CLI Lead →
bypass → Purchase → точний replay → друга Purchase. Прирости від read-only
baseline для entered/completed/transitioned/bypass/leads/buyers/purchases:
**1/1/1/1/1/1/2**. Перевірка проходила після кожного кроку; жодного local DB,
seeded UserID, справжнього партнерського переходу або листа.
`/api/v1/health`: 200; `/report` без credentials: 401 із Basic challenge;
обидва `Cache-Control: no-store`. Усі сім limiter bindings використано
успішними маршрутами квізу, bootstrap, партнера та звіту.

Спостереження через захищений status (UTC):

| Час | Mode | Pending / delivered | Cron / delivery |
|---|---|---|---|
| 20:49:26.917 | normal | 13 / 0 | Успішний Cron до прийняття поточних подій |
| 20:50:55.016 | normal | 4 / 19 | Новий успішний Cron, ACK 20:50:34.447 |
| 20:53:45.420 | normal | 0 / 27 | Черга спорожніла, Cron complete |
| 20:54:52.966 | unavailable | 1 / 27 | `receiver_unavailable`, `partial_failure`, `delivery_items_failed` |
| 20:55:35.299 | normal | 0 / 28 | Cron complete, новий ACK 20:55:33.863, errors=[] |

Після числового smoke власник також переглядав демо; ці додаткові події
входять у технічні delivery totals, а не у контрольні прирости smoke.
Для isolated unavailable/recovery власник тимчасово припинив дії.
Після pending=0 CLI прийняв одну нову синтетичну Purchase. Реальний Cron
спочатку зафіксував помилку/backoff, а після normal доставив ту саму
pending подію. Нових міграцій, ротації секретів, ручного запуску Cron,
reset/restore чи повторного створення події для recovery не було.
Фінально `integrity_paused=false`, `history_unverified=false`, Cron не stale.

## Free та доступ

До запуску й після остаточного recovery dashboard підтвердив
**Workers Free / Active**; сторінка плану — **$0 / Current plan**.
Upgrade/платних підписок не створювали. Rate-limit binding фактично
прийнято й використано на чинному Free за D-182. Billable usage має добове
оновлення: це не гарантія миттєвої видимості обліку чи майбутніх цін.
GitHub Actions використано в доступній включеній квоті, бюджет доплат $0.

**Історично на 2026-11-01:** credentials звіту й CLI зберігалися лише локально у ignored
`.wrangler/demo-secrets.json` з правами 0600; значення не записані в Git,
argv або цей звіт. `REPORT_USERNAME`/`REPORT_PASSWORD` потрібні для Basic Auth;
їх не додають до URL. Секрети не змінювалися між deploy.

Це мале Free-демо. Приймач BigQuery та партнер імітуються; production
навантаження, p95/SLA й benchmark не перевірялися. Реальний restore не
виконувався; мобільні браузери перевірялися лише емуляцією Playwright. Rate limits залишаються
приблизними counters за Cloudflare location. Повний обсяг ТЗ та розвиток
розділено в [дизайні](system-design.md); MVP не розширено.
