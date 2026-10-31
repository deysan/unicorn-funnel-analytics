---
title: 'M1: атомарний протокол команд і місткості'
type: 'feature'
created: '2026-10-31'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Продовжити M1 за погодженими D-064–068/D-160–166: внутрішній протокол
атомарного запису команди, revision/retry, чотири бюджети й capacity_epoch.
Повтор не змінює стан; відмова не лишає часткових ефектів. Без коміту,
HTTP-контрактів, deploy або застосування міграцій до dev. Не реалізувати
весь MVP чи нові продуктові правила. Попередні дозволені зміни зберегти.

</frozen-after-approval>

## Implementation Notes

- Обмежений внутрішній шар без зовнішніх ефектів; усі продуктові правила вже
  погоджено. Міграції лише в ізольованих D1. Один результат підкроку —
  безпечний batch; handlers/вибір офера/постбеки/Cron належать наступним блокам.
- `src/server/storage/transaction-guards.ts`: типізовані власні CHECK,
  SQL-предикати лише від серверного коду, changes() відразу після ефекту;
  невідомий текст SQL не є доказом rollback/revision/capacity.
- `capacity.ts`: ліміти 1000/10000/1000/20000, resume <80%; snapshot epoch,
  перевірка контрольних рядків, всіх epoch перед capacity, атомарні прирости.
  Окремий awaited pause після доведеної відмови; зменшення — prepared
  statements у batch caller з фактичним ACK/delete, без власного Cron.
- `command-executor.ts`: auth/TTL → replay → snapshot/profile → builder
  → guard access/revision/references/integrity/epoch/capacity → effects +
  result + counters. Builder визначає SQL бізнес-ефектів і прирости,
  executor не підміняє конкретні команди M2. Кожен ефект перевіряє changes().
- Лише guard_revision допускає до трьох записів із незмінною командою;
  після помилки читаємо відомий результат під чинним доступом. Невідомий
  результат не запускає повтор запису. Каталог майбутнього builder
  фіксується обробником на запит. Поточний доступ перевіряється і в batch.
- `0003_admission_assertions.sql`: окремі іменовані guards для control,
  integrity, epoch і чотирьох бюджетів. Попередню незастосовану до dev
  `0002` виправити: expired stub зберігає revision (D-161), не вимагає нуля.
- Given старий revision, when batch, then rollback; до трьох повторних
  обчислень. Given unknown/epoch/access failure, then жодного autoretry.
- Given однаковий ключ, when конкурентний запис, then один набір ефектів;
  відомий переможець повертається без нового резерву чи паузи.
- Given рівно limit, when приймання, then успіх і pause разом. Given
  переповнення, then rollback усіх бюджетів та умовний окремий pause.
- Given старий epoch, when відмова/пізній pause, then не зупиняємо новий цикл.
  Given спад нижче 80%, then count/pause/epoch оновлюються разом.
- Given integrity pause/відсутній control, then новий запис відхилено;
  авторизований replay доступний. Given no_offer, then лише command_keys.
- Given revoked/expired profile, when запис або replay, then відмова доступу.
  Given помилка пізнього ефекту/нуль змінених рядків, then повний rollback.
- D1-тести на бізнес-таблицях, керовані гонки/збої, повний локальний check;
  незалежне BMAD Build рев’ю без квоти findings перед завершенням.

- Фактичний формат workerd містить extended SQLITE_CONSTRAINT_CHECK;
  вузький classifier доповнено за тестом, а не довільним substring.
  Перший прогін також виявив помилкову назву singleton замість singleton_id;
  виправлено, повторний набір 42/42 пройшов.
- Службові guard-рядки видаляються одним scoped DELETE наприкінці batch.
  References — callback від свіжого часу перед batch, не застарілий now builder.
- Повний check: exit 0, 92 Vitest, типи/build і 21 Playwright.

## Completion Notes

- Незалежний BMAD Build рев’юер звірив поточний протокол із рішеннями,
  прочитав тести; підтверджених дефектів не знайшов. Сам тести не запускав.
  Відкладених findings немає; повний архітектурний аудит не повторювали.
- Завершено цей підкрок; підсумкова звірка пакета M1 лишається наступним
  кроком перед M2. Без коміту/push і dev/cloud міграцій.

## Підсумкове рев’ю M1

Пізніше власник доручив аудит і один коміт M1 перед M2.

- [x] [Review][Patch] M1-R1: готовий replay після revoke/hash/TTL — додано
  три D1-перевірки відмови доступу без нових ефектів.
- [x] [Review][Patch] M1-R2: entry після revision-конфлікту — додано
  перевірку рівно однієї спроби й повного rollback.

Обидва findings — medium, закриті; невирішених або відкладених немає.
Незалежний verification-reviewer підтвердив покриття читанням. Підсумковий
check: 96 Vitest, типи/build та 21 Playwright пройшли. Повний висновок —
[аудит M1](../reviews/2026-10-31-m1/report.md).
