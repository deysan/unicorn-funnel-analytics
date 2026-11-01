---
title: 'M2 — підтвердження email і вибір офера A/B'
type: 'feature'
created: '2026-10-31'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: ['docs/requirements.md', 'docs/decisions.md', 'docs/m2-quiz-commands.md']
---

<frozen-after-approval reason="Явне доручення реалізувати A/B у погодженому M2, без коміту">

## Intent

Завершити внутрішній серверний шлях квізу двома окремими командами:
A зберігає нормалізований email, час підтвердження та подію без адреси;
B обирає офер за поточним профілем/Lead, створює ClickID зі знімком
назви/URL/версії каталогу та зберігає результат. Застосувати наявний
executor M1, без зміни погоджених правил і без коміту.

A використовує прийнятий показ email і його вхід, перевірки кроку,
revision, TTL та атомарність попередніх команд. Нормалізація D-072/073:
обрізати тільки крайні U+0020, lowercase домену, зберегти local-part;
ASCII dot-atom, 254/64/63 символи, мінімум дві DNS-мітки. Без листів/MX.
Email не потрапляє в результати команд, події, URL або журнали.

B з переданим OperationID A перевіряє саме цю A: користувач/преленд,
тип команди, непрострочений 7-денний результат і подія підтвердження
email. Вхід B перевіряється окремо. A не мусить бути останньою;
новий Lead може змінити офер, але не режим quiz. Без A потрібне право
bypass за D-023/136. Непридатна A не підмінюється новішою або bypass.
Режим визначає сервер. ClickID і offer_transition мають однакові
entry_event_id та, для quiz, completion_event_id із результату A.

Given A прийнята, when B не записалась, then A та email залишаються.
Given виконана B, when повтор після зміни каталогу/профілю, then старий
ClickID/URL або no_offer без нової події. Given чинні підстави без офера,
when B, then збережений no_offer без ClickID і з приростом лише ключів.
Given новий ключ після no_offer, when каталог змінився, then новий вибір.
Given A прострочилась перед commit, when нова B, then selection_not_ready
без ефектів. Given конфлікт revision, when B, then переобчислення до
трьох спроб з незмінними ключем, payload і snapshot каталогу.

Це внутрішній підкрок: HTTP, cookie/UI, CLI, постбеки та звіт — далі.
Без зовнішніх переходів, хмарних дій, застосування міграцій до dev-бази.

</frozen-after-approval>

## Implementation Notes

- Intent gaps: немає; правила підтверджені D-038–040/064/072–073/
  152–161. Irreversibles: немає, SQL-файл застосовується лише до тестів.
  Footprint: shared email, розширення quiz commands, builder B,
  додатковий selection guard у executor/міграції, unit/D1-тести й docs.
- Reuse: executeCommand, stepReady, returningUserAction, selectOffer,
  buildOfferUrl, CommandResult. Зберегти попередні незакомічені підкроки.
- Технічний DTO: A — email та view_event_id; B — entry_event_id та
  необов’язковий completion_operation_id. Сервер отримує completion_event_id
  сам. ID канонічні як у попередньому внутрішньому сервісі.
- Для семиденної межі A додати окремий SQL CHECK guard selection:
  це дозволяє відрізнити selection_not_ready від reference_unavailable
  та захистити перевірку/запис без покладання тільки на revision.
- Перевірка: локальні unit та Worker/D1 з керованим часом/гонками,
  повний check і незалежне BMAD Build рев’ю. UI smoke не є доказом A/B.
- Реалізовано A в quiz/commands, B в quiz/offer-command; спільні
  entry/view SQL-перевірки винесено в event-references без зміни правил.
  Нова 0004 додає selection CHECK; чинність конкретної A перевіряється
  і при побудові, і всередині commit, включно з no_offer.
- Незалежне дослідження звірило чинність A: результат 7 днів та власна
  подія email/преленд; вимоги «тільки остання A» немає. Такого обмеження
  не додавали; перевірено старішу A після зміни email та різні входи.
- Фактична перевірка: 34 нові unit та 40 Worker-випадків; фінальний
  `CI=true npm run check` — exit 0, 278 Vitest (115 unit + 163 Worker),
  типи/build і 21 Playwright. Міграції — лише в тестових D1.
- Незалежний BMAD Build reviewer не виявив доказових дефектів,
  сам запустив 34 unit-тести. Його Worker-запуск не дійшов до тестів
  через EPERM локального порту/журналу; повний check виконав root.
  Без коміту, хмарного deploy, робочих міграцій або зовнішніх переходів.
