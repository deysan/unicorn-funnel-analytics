---
title: 'M2 — партнерські постбеки та демонстраційний CLI'
type: 'feature'
created: '2026-10-31'
status: 'done'
route: 'dispatch'
baseline_commit: '2c6798642ff5740f742246d2de8fdc6f16542e9c'
review_loop_iteration: 0
context: ['AGENTS.md', 'docs/m2-partner-contract.md', 'docs/m1-command-protocol.md', 'docs/m2-http-ui.md']
---

<frozen-after-approval reason="Власник явно доручив реалізувати погоджений підкрок M2, без коміту">

## Intent

Приймати авторизовані партнерські Lead/Purchase та демонструвати їх
локальним CLI через той самий API. Повтор не зараховується вдруге;
Lead впливає на наступне повернення, Purchase обліковується незалежно.

## Boundaries & Constraints

**Always:** [контракт](../../m2-partner-contract.md) конкретизує наявні
requirements/decisions. Зберегти весь незакомічений M2. Атомарні ключ,
історія, доставка, Lead/revision та бюджети. Синтетичні дані, secrets
поза Git. Новий POST endpoint і CLI — один демонстраційний шлях.

**Never:** коміт/push/deploy, партнерський redirect/листи, reset dev,
нові бізнес-рішення, обхід auth/лімітів CLI, припущення про завершення
всього M2. Звіт, Cron/cleanup та cloud adapter поза підкроком.

## I/O & Edge-Case Matrix

| Сценарій | Очікувана поведінка |
|---|---|
| Lead → повернення | Максимум Lead, revision +1; bypass активного офера |
| Purchase до Lead / дві покупки | Окремі події, без штучного Lead/revision |
| Replay/concurrent same key | Один EventID/набір ефектів, однаковий ACK |
| Conflicting key | 409 без змін, навіть якщо змінений click недоступний |
| Старий/чужий/очищений click | Старий retained прийняти, чужий/очищений новий —422; відомий replay без click —200 |
| TTL профілю / пізній Lead | Історія зберігається; прострочений compact Lead не оживає |
| Поганий DTO/time/auth/ліміт | Сувора відмова без бізнес-записів і витоку |
| Rollback/lost commit/revision/cleanup | Без часткового запису, доказовий replay, обмежені повтори |
| CLI prepare/send/retry/redirect | Незмінний файл та ID/час, секрет тільки env, до3 limiter retries, жодного redirect |

</frozen-after-approval>

## Code Map

- `src/server/storage/{capacity,transaction-guards}.ts` — reuse; executor
  квізу не підходить через cookie/activity/request_results.
- `migrations/0002_business_schema.sql` — готові таблиці й унікальність;
  нова міграція наразі не потрібна.
- `src/server/http/security.ts` — виділити bounded JSON без Origin,
  зберегти quiz guard; reuse limiter/HttpFailure, додати422.
- `src/server/quiz`, `offers` — чинний вибір і Lead-bypass, не переписувати.
- `tests/worker/helpers/business-db.ts`, `command-protocol.test.ts` —
  D1 fixtures та interceptBatch для конкуренції/rollback/unknown commit.
- `scripts/setup-local.mjs`, `wrangler.jsonc` — стабільний partner secret,
  окремі IP/partner bindings; generated Env, без нових dependencies.

## Tasks & Acceptance

- [x] `src/shared/partner.ts` — strict DTO/time/нормалізація, спільні типи.
- [x] `src/server/partner/*` — атомарне приймання, replay/conflict,
  історична атрибуція, Lead/revision, TTL та budgets.
- [x] `src/server/http/partner.ts`, `index.ts`, security/config/setup —
  Bearer, bounded body, окремі limiter, безпечні ACK/errors.
- [x] `scripts` — CLI prepare/send через HTTP, env-secret, стабільні
  файли, без overwrite/redirect, контрольовані повтори й README сценарій.
- [x] `tests/unit`, `tests/worker`, `tests/smoke` — матриця, реальний
  наскрізний CLI→HTTP→D1 та повернення bypass; ізольована persistence.
- [x] `docs/m2-partner-postbacks.md`, README, plan/implementation-plan,
  ai-worklog — фактична поведінка, результати й межі.

Given прийнятий постбек, when повторено той самий файл, then counts,
received_at, revision й activity незмінні. Given невідомий результат,
when ключ не доводить commit, then API не повертає accepted.
Given квіз створив ClickID, when CLI надсилає Lead і користувач повертається,
then новий перехід має bypass без повторного квізу/email.

## Implementation Notes

Два незалежні дослідження не знайшли бізнес-прогалин. Footprint:
shared/service/HTTP/CLI/config/tests/docs; route dispatch. Працюємо
послідовно одним implementation agent; не запускати власні subagents.
Дозвіл реалізувати вже є, dirty tree навмисний. Якщо виявиться справжня
прогалина, повідомити root; не вигадувати правило. Завершення — handoff
для root review, не commit. Перед широкими прогінами — цільові тести.

## Verification

`CI=true npm run check`: типи, всі Vitest, build, браузерна матриця
та справжня локальна демонстрація CLI. Ліміти не підвищувати для тестів;
за потреби окрема smoke-група. Перевірити кожний рядок матриці,
diff whitespace, посилання, відсутність секретів у Git/client bundle.
Root проводить незалежні BMAD review перед фінальним підсумком.


## Implementation Handoff — 2026-10-31

На момент передачі реалізацію завершено локально, root review ще не проведено.
Додано shared DTO/time, partner auth/service/HTTP, окремі limiter bindings,
стабільний local secret, Node CLI prepare/send і README-сценарій.
77 нових Vitest (43 unit + 34 Worker) та 2 реальні CLI smoke.
Прогін перед рев’ю `CI=true npm run check`: exit 0, 372 Vitest, 50 Playwright,
типи/build. Git whitespace/посилання/secret scan пройшли.
Деталі й фактичні межі — [постбеки/CLI](../../m2-partner-postbacks.md).
Незалежне рев’ю не підмінено самоперевіркою; root запускає його після handoff.
Коміт/push/deploy, звіт/Cron/cleanup не виконувалися; dev persistence не очищена.

## Review Triage Log

Три незалежні шари завершені перед triage. Blind та edge-case не знайшли
доказових дефектів; тести самостійно не запускали. Мінімальної квоти
зауважень немає за AGENTS.md/project override.

| Finding | Verdict | Доказ / маршрут |
|---|---|---|
| Verification: грошові поля Purchase у payload_json не перевірені | medium | Тести перевіряють partner_events/ACK/counts, але payload assert стосується Lead. Вилучення amount/currency зі snapshot лишилося б непоміченим. Patch: перевірити серіалізовану Purchase з точною парою та без обох полів; це чинний контракт, нових бізнес-рішень немає. |

## Completion Evidence

Finding закрито двома Worker-регресіями, root перевірив diff. Після
поправки root виконав `CI=true npm run check`: exit 0, **374 Vitest**
(162 unit + 212 Worker), типи/build і **50 Playwright** (24+24+2).
Матрицю покривають partner DTO/CLI unit, partner-events/partner-http
Worker та справжні CLI smoke; усі вони виконані без skip/retry тестів.
Чинний dev сервер запущено на HTTPS localhost:5173 без нових міграцій
або reset; новий endpoint повернув 401/no-store без Bearer.
Документацію й AI-021 оновлено. Відкладених findings немає.
Без коміту, push, deploy чи партнерських переходів.
