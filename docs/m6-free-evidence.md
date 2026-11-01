# M6 — фактична перевірка Free-передумов

Дата перевірки: **2026-11-01**. Докази відділено від майбутніх кроків
[ручного релізу](m6-release.md). Це не benchmark і не гарантія production-навантаження.

## Акаунт Cloudflare

- Read-only API: один доступний акаунт; список Workers порожній, D1 —
  порожній (total_count=0). Отже до M6 у цьому акаунті немає demo Worker/D1.
- `workers/subdomain`: 404, workers.dev ще не налаштований. Адресу демо
  не вигадано; її потрібно отримати під час початкового налаштування.
- `workers/account-settings`: `default_usage_model=standard`; це поле
  **не доводить Paid або Free**. `entitlements` повернув порожній список,
  що також не є підтвердженням доступності конкретного binding.
- Billing subscriptions через OAuth connector повернули 403: endpoint
  не має OAuth scope і вимагає Billing Read/Write API token. Токени не
  запитували й права не розширювали; використано dashboard.
- Після входу власника dashboard **Workers plans** показав **Free,
  $0, Current plan**. Upgrade не виконували. Персональні деталі акаунта
  та скриншоти billing у репозиторій не копіюються.

Окремий Wrangler OAuth підтвердив власник у Chrome; `whoami --json`
показав loggedIn=true та той самий account ID. Запитані account/user read,
Worker/D1 write і tail read; billing scope не запитано. Credentials
зберігає Wrangler поза Git; значень токенів у доказах немає.

## Офіційні межі

| Компонент | Перевірений факт | Наслідок |
|---|---|---|
| Workers Free | 100 000 запитів/добу, 10 мс CPU/invocation; 100 Workers, 5 Cron на акаунт | Один малий Worker/Cron вкладається в кількість ресурсів; CPU треба підтвердити smoke |
| Static Assets | 20 000 файлів/version, до 25 MiB кожний; пряма статика безкоштовна | API та run_worker_first витрачають Worker quota |
| D1 Free | 10 баз, 500 MB на базу, 5 GB сумарно; 5 млн reads і 100 000 writes/добу | Одна мала синтетична база; індекси й cleanup враховуються |
| D1 calls | 50 на invocation; batch рахується одним call, окремі SQL-ліміти залишаються | Не плутати API calls із rows read/written |
| Time Travel | 7 днів Free | Restore не виконується в M6 |

Джерела, прочитані 2026-11-01:
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
Локальне обґрунтування малого сценарію та його обмеження —
[місткість і доставка](capacity-and-delivery.md).

## Rate-limit binding: погоджена практична перевірка

[Офіційний changelog](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/)
підтверджує GA. [Документація binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
підтверджує конфігурацію, приблизність лімітів і окремі counters за
Cloudflare location; це не строгий глобальний ліміт. Приклади free/paid
users стосуються клієнтів застосунку, а не тарифу Cloudflare акаунта.

У перевірених pricing/runtime/changelog джерелах не знайдено явного
підтвердження Free/$0 саме цього binding. Dashboard Workers Free не
усуває цю окрему невідомість. Збережено gate з
[плану місткості](capacity-and-delivery.md): перед першим deploy підтвердити
умови; відсутність доказу не означає ні платність, ні дозвіл на оплату.

Власник 2026-11-01 явно погодив уточнення: **перевірити на чинному Free
без upgrade**. Після готовності коду й тестів дозволено малий deploy,
перевірку binding та повторну звірку billing. Це погоджений спосіб
закрити невідомість, а не вигадане документальне підтвердження $0.
Будь-яка потреба змінити тариф/підписку зупиняє операцію.

## GitHub Actions

GitHub plugin не зміг прочитати приватний repo (404). Read-only `gh api`
підтвердив `private=true`, `archived=false`, default branch `master`;
видимість не змінювали. Actions enabled=true. Віддалений master усе ще
на M0 `552be84de926b7f76823c41b1689f0200fd7b34f`.

Read-only dashboard підтвердив GitHub Free, доступну включену compute та
storage квоту, account-level Actions budget **$0, Usage blocked** для
платного використання. Отже передумови нового CI підтверджено; billing
налаштування не змінювали. Детальні персональні відомості usage не зберігаємо.
Це дозвільні передумови, не результат ще не виконаного запуску CI.

[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
прочитано 2026-11-01: Free включає $12 compute/місяць і 500 MB artifact
storage; standard Linux має тариф $0.006/хв для обліку включеного ресурсу.
Це актуальні одиниці документації, а не підтвердження залишку акаунта.
У проєкті cache/upload artifacts вимкнені. CI не містить cloud secrets
і не запускає deploy. Перевірка M0 не є CI-доказом нового release SHA.

## Перший фактичний запуск

CI `3424e22` успішний: [run](https://github.com/deysan/unicorn-funnel-analytics/actions/runs/41346931123).
Створено одну D1 `unicorn-demo` (WEUR, replication disabled), міграції й
schema gate успішні. Workers.dev налаштовано; перший Worker deploy прийняв
сім rate-limit bindings без upgrade. Це ще не доказ їх роботи: baseline
smoke503 зупинився до квізу через надмірну перевірку x-real-ip; виправлення
з регресійним тестом перевіряється окремим clean SHA. Результати smoke й
повторна звірка billing лишаються незавершеними.
