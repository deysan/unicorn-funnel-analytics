---
title: 'M2 — HTTP та робочий квіз'
type: 'feature'
created: '2026-10-31'
status: 'done'
route: 'dispatch'
baseline_commit: '2c6798642ff5740f742246d2de8fdc6f16542e9c'
review_loop_iteration: 0
context: ['AGENTS.md', 'docs/m2-http-ui-contract.md', 'docs/m2-final-commands.md', 'docs/implementation-plan.md']
---

<frozen-after-approval reason="Власник явно доручив реалізувати HTTP і квіз, без коміту; погоджені правила незмінні">

## Intent

Підключити існуючі серверні команди до HTTP та доступного українського
інтерфейсу: Q1 → Q2 → email → A/B → назва офера/URL/ClickID.
Прийняті дані зберігаються в D1, ідентичність — у серверній cookie.
Підтримати погоджені повернення, step, повтори та відновлення фінальної дії.

## Boundaries & Constraints

**Always:** джерело правил — requirements/decisions; конкретизація й
докази — m2-http-ui-contract. Зберегти попередній незакомічений M2.
Секрети поза Git; синтетичні дані. Міграції локальної dev-бази лише
додавальні, без reset. E2E — окрема persistence, не dev-база.

**Never:** коміт/push/deploy, реальні переходи або листи, нові бізнес-правила,
публічні test/admin endpoints, спрощення захисту заради тестів.
Постбеки/CLI/звіт/Cron поза цим підкроком. M3 не оголошувати завершеним.

## I/O & Edge-Case Matrix

| Стан / дія | Очікуваний результат |
|---|---|
| Новий браузер → квіз | Один профіль, перевірена cookie, прийняті вхід/показ перед відповіддю |
| women + asia + email | A, потім B; 003 і ClickID; URL показаний без переходу |
| Reload/Back/step | Збережені відповіді, коректні нові події, без дублювання від ререндеру |
| Втрата відповіді A/B | Ті самі ключі, спочатку GET результату, один ClickID |
| Чужий контекст / Origin / поганий JSON | Без витоку та мутацій, безпечний код помилки |
| Заблокована cookie / втрата доступу | Зупинка без циклу нових профілів; явне відновлення |
| no_offer / bypass | Збережений результат або B без штучного email; нова спроба лише явно |
| Збій storage / TTL / limiter | Погоджена зупинка/пауза/відновлення; не підмінювати ключі |

</frozen-after-approval>

## Code Map

- `src/server/quiz/commands.ts`, `storage/*` — reuse A/B, replay, guards і бюджети.
- `src/server/index.ts`, `src/shared/*` — HTTP-адаптер, спільні DTO, auth/init.
- `src/client/App.tsx`, `style.css` — зараз health UI; перенести його на
  diagnostics, корінь віддати квізу, controllers відокремити від React render.
- `wrangler.jsonc`, `vite.config.ts`, `scripts/*`, `playwright.config.ts` —
  стабільні локальні секрети, loopback/config, міграції, ізольований E2E.
- `tests/worker/*`, `tests/unit/*`, `tests/smoke/*` — реальний D1/HTTP,
  чисті правила recovery і браузерний шлях.

## Tasks & Acceptance

- [x] `src/server`, `src/shared` — HTTP/auth/identity/limiter/DTO, replay
  і коректне поновлення cookie лише після нового commit.
- [x] `src/client` — адаптивний доступний квіз, navigation/event lifecycle,
  Web Lock/bootstrap, A/B draft/recovery та безпечний результат.
- [x] `scripts`, configs — локальний setup без секретів у Git, ізольований
  preview для E2E, збереження dev-даних, міграції 0001–0004.
- [x] `tests` — покрити матрицю; не підвищувати погоджені ліміти для E2E.
- [x] `docs`, README — описати запуск, реалізовані гарантії й залишок M2/M3.

Given чинний профіль, when команда повторена, then ні нових ефектів,
ні поновлення cookie. Given квіз завершено, when сторінку перезавантажено,
then відновлюється власний B, а не створюється новий ClickID.
Given новий bootstrap, when cookie не повернулася, then дії квізу зупинені.
Given код готовий, when CI=true npm run check, then типи/unit/Worker/build/
Playwright проходять; скриншот перевіряє desktop/mobile без переповнення.

## Implementation Notes

- Intent gaps: немає після двох незалежних досліджень. Footprint більший
  за попередні підкроки, route dispatch. Дозвіл на реалізацію вже є в
  поточному дорученні, нових бізнес-погоджень не потрібно.
- Можна уточнювати технічні DTO/модулі в межах джерел; при справжній
  прогалині не вигадувати рішення. Реалізацію та перевірку не скорочувати.

## Verification

- `CI=true npm run check` — exit 0, без пропуску обов’язкових тестів.
- `git diff --check` і цілісність локальних документних посилань.
- Незалежне BMAD review; reviewer не приписує собі чужі запуски.

## Review Triage Log

| Finding | Verdict | Доказ і маршрут |
|---|---|---|
| Blind: зміна власника під час navigation/після answer | medium | Підтверджено читанням controller: обидві гілки присвоюють ready context без порівняння попереднього UserID. Із result Back новий профіль може автоматично отримати entry/B; на питанні лишається старий entry. Patch: застосувати наявну перевірку identity_lost до заміни контексту, додати регресії. |
| Edge: Back із результату після заміни cookie | medium | Незалежний reviewer відтворив на реальному controller із mock API; knownUser лишається попереднім, команди йдуть новому UserID. Той самий корінь, що Blind; одна спільна поправка. |
| Verification: UserID/bootstrap limiter не мають негативних HTTP-тестів | medium | Наявні тести підміняють лише IP binding; перевірка limit() окремо не доводить виклик двох інших bindings маршрутом. Patch: deny/throw для обох, незмінність D1/відсутність cookie, ready identity не витрачає bootstrap limit. |
| Root: timeout/abort очікування Web Lock показує помилку storage | low | Загальний catch помилково класифікував DOMException очікування як локальне збереження. Пряма поправка: окреме повідомлення з ручним retry; два браузерні випадки перевіряють обидва імені винятку. |

Три незалежні шари завершені до зведення. Обов’язкової кількості проблем
немає. Нових бізнес-рішень або причин змінювати погоджений scope немає;
поправки застосовують уже наявні контракти.

## Completion Evidence

Усі findings виправлено й перевірено; відкладених немає. Root прочитав
поправки та виконав фінальний `CI=true npm run check`: exit 0,
295 Vitest (119 unit + 176 Worker), 48 Playwright (24 Chromium + 24 решта),
типи/build. Окремі регресії перевіряють обидві точки зміни UserID,
deny/throw двох limiter bindings і повідомлення Web Lock timeout/abort.
Матрицю вище покривають Worker/D1, draft unit та браузерні тести,
описані в [перевірках](../../m2-http-ui.md). Переглянуто desktop/mobile
email/result скриншоти; локальний HTTPS context відповів 200/missing.
Без коміту, push, cloud deploy або реальних партнерських переходів.
