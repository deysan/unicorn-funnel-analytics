---
title: 'M2 — базовий закритий звіт'
type: 'feature'
created: '2026-10-31'
status: 'done'
route: 'dispatch'
baseline_commit: '2c6798642ff5740f742246d2de8fdc6f16542e9c'
review_loop_iteration: 0
context: ['AGENTS.md', 'docs/m2-report-contract.md', 'docs/m2-http-ui.md', 'docs/m2-partner-postbacks.md']
---

<frozen-after-approval reason="Власник доручив наступний підкрок M2; чинні рішення вже погоджені">

## Intent

Показати результати локального наскрізного шляху в закритому звіті:
квіз, Lead, повернення bypass, справжні покупки й повтори. Реалізувати
погоджений контракт звіту з D1, UI, Basic Auth та точними конверсіями.

## Boundaries & Constraints

**Always:** [контракт](../../m2-report-contract.md) конкретизує чинні
рішення. Зберегти весь незакомічений M2 і dev дані. Журнал events,
один SQL-зріз бізнес-метрик, синтетичні тести. За непідтвердженої історії
без чисел. Read-only звіт без поновлення профілю.

**Never:** коміт/push/deploy, reset dev, backfill дати із MIN(events),
реальні зовнішні переходи, секрети в Git/JS, нові бізнес-рішення,
реалізація Cron/cleanup/хмарного adapter чи оголошення всього MVP готовим.

## I/O & Edge-Case Matrix

| Сценарій | Очікування |
|---|---|
| Quiz→Lead→bypass→2Purchase+replay | Правильна атрибуція; 2 покупки, 1 покупець; повтор без приросту |
| SC-14 та offer filter | Неадитивні unique users, quiz незмінний від offer |
| Кінець періоду/повернення/рівний час | Подальші причинно пов’язані результати когорти враховані |
| Bypass/інший ClickID | Bypass не quiz completion; чужий для групи click не конвертує |
| Порожня/стара/непідтверджена історія | Нулі лише ready; інакше без metrics, без автозміни дат |
| Invalid query/auth/limiter/D1 | Суворі безпечні помилки, no-store, без записів |
| Фільтри/URL/reload/late responses | Застосовані фільтри сталі; старі відповіді не перезаписують нові |
| Auto refresh/hidden/error | 60s, без overlap; hidden без polling; помилки приховують числа |

</frozen-after-approval>

## Code Map

- `src/server/index.ts`, `http/security.ts` — Hono/HttpFailure/limit/ipKey;
  reuse local-only protection, не переносити cookie auth на звіт.
- `migrations/0002_business_schema.sql` — events зі зв’язками, system_control;
  не переписувати застосовані міграції. Метадані зараз NULL.
- `src/server/offers/catalog.ts`, `config.ts` — поточний immutable каталог.
- `src/client/App.tsx`, `style.css` — додати окрему report сторінку;
  quiz controller не запускати для report.
- `wrangler.jsonc` — ASSETS binding, Worker-first report, окремі limiter.
- `scripts/setup-local.mjs`, `e2e-server.mjs` — ignored secrets та явний
  new-history provisioning до сервера; стару dev persistence не змінювати.
- `tests/worker/helpers/business-db.ts`, `tests/smoke/partner-cli.spec.ts`
  — готові D1 fixtures і наскрізний бізнес-шлях.

## Tasks & Acceptance

- [x] `src/shared/report.ts` — DTO, query, схеми й форматування.
- [x] `src/server/report/*`, `http/report.ts`, index/config — SQL,
  доступність, auth, status/filters, HTML gate.
- [x] `scripts` — credentials і guarded provisioning тільки нової історії.
- [x] `src/client` — окрема сторінка, фільтри, числа/конверсії/помилки,
  refresh/visibility/stale responses, адаптивний вигляд.
- [x] `tests` — кожний рядок матриці, реальна D1 й браузерний шлях.
- [x] README, plan/implementation-plan, `docs/m2-report.md`, ai-worklog —
  фактичні результати, доступ і межі M2/M4/M5.

Given старий період входу, when прийнято пізню покупку його ClickID,
then конверсія оновлюється без зміни покупок активності старого дня.
Given звіт читається, then користувацькі дані, activity/cookie незмінні.
Given старій базі бракує метаданих, then немає вигаданої дати/чисел.

## Implementation Notes

Два read-only дослідження виявили технічний розрив D-114, описаний у
контракті. Інших бізнес-прогалин немає. Footprint — report shared/server/
client/setup/tests/docs, нових залежностей не потрібно. Дозвіл на цей
підкрок і продовження dirty tree вже є. Працює один implementation agent
послідовно; власних subagents не запускати. Справжню прогалину повідомити
root, не вигадувати рішення. Якщо context path відносний — від кореня repo.

## Verification

Спочатку targeted unit/Worker/browser, потім `CI=true npm run check`:
типи, весь Vitest, build і браузерна матриця. Node24.22.2/npm11.19.1.
Ліміти не підвищувати; за потреби окрема smoke group зі свіжим test server.
Перевірити whitelist DTO, no-store, відсутність секретів у bundle/доках,
посилання й whitespace. Root проводить незалежне BMAD review.

## Spec Change Log

## Review Triage Log

Перевірка реалізації: 2026-10-31, `CI=true npm run check` — exit 0;
416 Vitest (182 unit + 234 Worker), 63 Playwright (24 + 24 + 2 + 9 + 4), типи/build.
Це прогін до незалежного BMAD review; без commit/push/deploy.

Три незалежні контексти завершили review перед triage. Edge-case layer
не знайшов доказового дефекту. Квоти findings немає за AGENTS/project override.

| Finding | Verdict | Доказ / маршрут |
|---|---|---|
| Blind: початковий status запускає funnel після 429 filters | medium | У load() pause встановлюється fail(), але залежний funnel після status не перевіряє її. Досяжна гонка під спільним лімітом. Patch: перевірити pause/stopped перед залежним читанням, регресія порядку відповідей. |
| Blind: позначка поточного дня залежить від status | medium | При помилці status UI очищає його, хоча готовий funnel має власний updated_at; позначка зникає або помиляється на межі UTC-доби. Patch: час бізнес-зрізу для його позначки, регресія. |
| Verification: немає тесту неправильного Basic логіна/пароля | medium | Негативні тести відмовляють до порівняння вмісту credentials. Patch: коректний формат з неправильним значенням, HTML/API401. |
| Verification: UI-конверсії мають однакові fixture-пари без числових asserts | medium | Заміна залишку на numerator або Lead/Purchase місцями непомітна. Patch: різні пари включно1/3, точні підписи/відсотки/залишок2/3. |

Усі чотири виправлення конкретизують чинну поведінку, не додають нового
публічного контракту чи бізнес-рішень; маршрут patch, deferred немає.


## Completion Evidence

Усі чотири findings закриті. Root перевірив мінімальні зміни й регресії:
ordered429/401 initial responses, independent UTC-day label, неправильні
Basic credentials, різні UI-конверсії та залишок2/3. Кожний рядок матриці
покривають виконані unit, Worker/D1 або Playwright тести без skip/retries.
Root `CI=true npm run check`: exit 0, **420 Vitest** (182 unit + 238 Worker)
та **67 Playwright** (24 + 24 + 2 + 13 + 4), типи/build. Desktop/mobile
візуально перевірені. Локальна сторінка й no-store/auth перевірені також
на чинному dev-сервері; його 10 подій та metadata збережено.
Документацію оновлено. Deferred немає. Без коміту/push/deploy.
