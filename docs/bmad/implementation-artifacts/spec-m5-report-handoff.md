---
title: M5 — підтвердження історії та пакет перевірки звіту
type: feature
created: 2026-11-01
status: done
route: dispatch
baseline_commit: 366ae4fcbde19bbb7cfe045d00579979a2b30983
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/m2-report-contract.md'
  - '{project-root}/docs/implementation-plan.md'
---

<frozen-after-approval reason="погоджені D-098/D-116 і доручення реалізувати M5 без коміту">

## Intent

Звіт уже реалізує SC-14. Бракує перевіреної операційної процедури явного
підтвердження історії та інтеграційних доказів після retention. Завершити
локальний пакет перевірки звіту, щоб перевіряючий міг відтворити результати
й зрозуміти межі довіри до чисел.

## Boundaries & Constraints

Зберегти формули, API v1, Basic Auth read-only, консервативну UTC-межу.
Повноту доводить оператор після діагностики, а не SQL за наявністю рядків.
Без доказу безпечної межі — history_unverified. Поновлення історії не
знімає integrity/capacity пауз, не виправляє лічильники, не змінює TTL.
Не виконувати restore, SQL проти dev/cloud, очищення persistence,
commit/push/deploy. Немає нового admin API/UI, генератора історії або
реальних партнерських переходів. M6 і хмарна перевірка лишаються окремо.

## I/O & Edge-Case Matrix

| Сценарій | Вхід | Очікування |
|---|---|---|
| Явне підтвердження | Доведена UTC-межа, очікувані поточні metadata, цілісність перевірена | Змінюються лише history metadata; старий період unavailable, допустимий ready |
| Невалідна межа | Майбутній/нецілий UTC-день | Відмова без запису |
| Застаріла перевірка | Metadata змінилися після діагностики | Відмова, перечитати й перевірити; не перезаписувати нову межу |
| Integrity pause | Цілісність не підтверджена | Історія не поновлюється; пауза збережена |
| Сумнів у повноті | Нові події й успішний Cron | Бізнес-числа лишаються прихованими |
| Звичайний retention | Реальний cleanup прострочених подій | Допустимий період має незмінні числа; старий період unavailable |

</frozen-after-approval>

## Code Map

- `scripts/report-history.ts`: лише newHistorySql; зберегти initializer, додати генератори явного mark-unverified/confirmation SQL. Не додавати автоматичне виконання.
- `src/server/report/read.ts`, `src/shared/report.ts`: наявні формули/DTO/availableFrom; повторно використати контракти.
- `src/server/maintenance/cleanup.ts`, `coordinator.ts`: реальні retention/Cron для інтеграційних тестів.
- `tests/worker/report.test.ts`: числова SC-14, фільтри, причинні посилання вже є.
- `tests/worker/helpers/business-db.ts`: ізольована D1 та production producers у тестах M4.
- `README.md`: запуск/CLI вже є; посилання на операційний і демонстраційний пакети.
- `docs/decisions.md`: D-098/116; відновлення не є доказом повноти.

## Tasks & Acceptance

- [x] `scripts/report-history.ts`: безпечні SQL helpers із валідацією UTC-дня й очікуваних metadata. Підтвердження одним guarded UPDATE з RETURNING; нуль рядків означає відмову. Не розширювати доступність назад від уже встановленої межі. Явне mark-unverified не очищує integrity pause.
- [x] `tests/worker/report-history.test.ts`: виконати helper SQL у D1, перевірити матрицю та незмінність інших controls/business rows. Реальний cleanup/Cron, а не копія SQL алгоритму.
- [x] `docs/report-operations.md`: порядок діагностики, зовнішня зупинка трафіку/Cron перед restore, повторне встановлення недовіри після restore, докази/межа, guarded SQL і перевірка результату. Існуюча dev-історія не визнається повною без доказів. Конкурентні операційні зміни заборонені процедурою; CAS не замінює maintenance fence.
- [x] `docs/demo-walkthrough.md`: точні локальні кроки квіз→Lead→bypass→Purchase→repeat→report; очікувані зміни й фільтри, посилання на тести SC-14, захист секретів, реалізоване/імітоване/design-only. Дані синтетичні, без переходу до партнера.
- [x] `README.md`: посилання на пакет; актуальні міграції 0001–0005 і стан M5, без заяви хмарної готовності.

Acceptance: Given недовіру до історії, when Cron або нові факти, then звіт не відновлюється автоматично.
Given перевірену межу й чинні metadata, when явне підтвердження, then ready лише для доступного періоду без зміни лічильників/пауз.
Given виконаний cleanup, when читання допустимого періоду, then бізнес-числа збережено.
Given README та walkthrough, when локальне демо, then кроки відповідають чинному CLI/квізу, секрети й реальні переходи відсутні.

## Implementation Notes

Погоджений обсяг M5 уже авторизований користувачем; нового погодження бізнес-рішень не потрібно. Фактичні тести записати після виконання. Увесь M5 не позначати завершеним до підсумкової звірки.

## Spec Change Log

## Review Triage Log

- Blind: findings відсутні. Verification: прогалин не знайдено.
- Edge: medium/patch — baseline після відкриття квізу пропускав entry/view у приростах. Walkthrough виправлено на report→baseline→quiz; reviewer підтвердив закриття читанням.

## Verification

Node 24.22.2/npm 11.19.1 через PATH. Цільові Worker/D1 report-history/report/maintenance тести та typecheck. Координатор читає diff, запускає повний check і незалежні reviews. Жодних комітів.

Фактично: 82/82 цільових, повний дозволений check 534 Vitest + 89 Playwright, типізація/build exit 0. Первісний fullcheck заблокований sandbox EPERM; нові retention-фікстури виправлені до фінального запуску. Відкритих findings немає. Без коміту за прямим дорученням користувача (має пріоритет над build step05).

## Фінальний аудит M5

Наступне доручення власника дозволило підсумкову звірку й один локальний
коміт. [Аудит](../reviews/2026-11-01-m5/report.md): три незалежні lenses,
одне зауваження про чисту приватну сесію виправлено. Код і тести не змінено
після успішного 534/89 check. Умови локального M5 виконано; M6 попереду.
