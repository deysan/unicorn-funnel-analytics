# Підсумковий аудит M2

Дата: 2026-11-01. Обсяг: увесь локальний M2 після M1
`2c6798642ff5740f742246d2de8fdc6f16542e9c`, включно з tracked/untracked
кодом, SQL, тестами, скриптами й документацією. Доручення власника:
звірити ТЗ й погоджені рішення з BMAD та зробити один коміт, якщо блок готовий.

**Результат:** M2 готовий до одного локального коміту. Три конкретні
прогалини закрито; нових бізнес-рішень не потрібно. Повний check пройшов,
відкладених зауважень у межах M2 немає.

## Джерела та метод

- [Оригінальне ТЗ](../../../task.md)
  повторно прочитано через Google Drive 2026-11-01; modified time джерела
  `2026-10-26T17:41:23.823Z`. Розбіжності з каталогом і FR у requirements не виявлено.
- [Вимоги](../../../requirements.md), [рішення D-001–D-181](../../../decisions.md),
  [сценарії](../../../scenarios.md), [умова завершення M2](../../../implementation-plan.md)
  та контракти окремих підкроків залишаються джерелом істини.
- BMAD 6.12.4, skill `bmad-review`; customization успішно resolved із
  [project override](../../../../_bmad/custom/bmad-review.toml).
  Три окремі контексти запущено до обробки результатів: adversarial,
  edge-case-hunter, verification-gap. Рев’юери читали один повний diff
  і відповідні джерела; не отримували findings інших рев’юерів.
- Застарілу design-only підказку override застосовано в межах актуального
  доручення власника на реалізацію й аудит. Квоти проблем немає.
  Редакторські prose/structure lenses не застосовувалися до коду.
  [Manifest](manifest.json), [усі findings за lenses](findings.json).
- Root зіставив висновки з кодом і ТЗ, виправив підтверджені прогалини та
  виконав перевірки. Висновки BMAD не змінювали погоджених правил.

## Findings і triage

### Adversarial

**HTTP-редирект не був доведений (FR-13, D-024).** До аудиту перевірялася
побудова URL, а browser-тест 307 перевіряв лише відмову CLI слідувати
чужому редиректу. Це інший контракт. Без виправлення gate M2 був неповним.

Закрито: [HTTP-адаптер](../../../../src/server/http/quiz-result.ts) приймає
збережений результат B; demo-представлення лишається JSON, redirect —
303/Location без зовнішнього fetch. [HTTP/D1-тест](../../../../tests/worker/quiz-http.test.ts)
проходить справжню A/B, читає записаний результат і через in-process Hono
перевіряє 303, точний Location/ClickID, no-store, порожнє тіло, відсутність
fetch і змін бізнес-таблиць. Для no_offer/accepted немає Location.
Публічний маршрут на партнера не додано. Після виправлення цей рев’юер
перечитав правку й повернув `[]`.

### Edge-case-hunter

**Повторна видача профілю після restart + втраченої cookie + 429.**
У [controller](../../../../src/client/controller.ts) автоматична повторна
спроба із restart=true обходила pending guard після успішного POST і
обмеженого контрольного GET. Це могло створити зайві профілі.

Закрито: pending скидає лише явний restart; bootstrap перевіряє його і
для повтору restart. Готовий контекст повторно використовує чинний
профіль без POST. [Браузерна регресія](../../../../tests/smoke/quiz.spec.ts)
губить cookie після реальної видачі, виконує явний restart, повертає 429
на підтвердженні й переводить час уперед: третьої видачі немає, потрібне
явне відновлення. Повторний перегляд цього рев’юера повернув `[]`.

### Verification-gap

**Відсутній доказ HTTP-редиректу.** Незалежно знайдено ту саму прогалину,
що й adversarial. Обидва висновки збережено в JSON; спільне виправлення
й доказ наведені вище. Це одна прогалина, а не два окремих дефекти.

**Немає assertion залежного тексту Q2 (FR-01).** Код уже змінював
формулювання, але тести не доводили цього. Додано browser-сценарій
women → Q2 → Back → men → Q2 з точними заголовками для обох відповідей.
Він перевіряє також зміну формулювання після повернення.

Відкладених findings у межах M2 немає. Окремо root виправив застарілі
статуси реалізації у README, plan, requirements і system-design.
Документи підкроків позначено історичними з посиланням на цей підсумок.

## Звірка з ТЗ та погодженими рішеннями

Посилання на тести — докази поведінки, а не заміна вимог. Рядки нижче
стосуються реалізованої частини M2; повний MVP потребує M3–M6.

| Вимога / рішення | Доказ у M2 |
|---|---|
| FR-01: три питання, залежний текст Q2 | [quiz.spec.ts](../../../../tests/smoke/quiz.spec.ts): повне проходження, email, women → Back → men |
| FR-02: email не є правилом вибору чи Lead | [selection](../../../../src/server/offers/selection.ts), [A/B tests](../../../../tests/worker/final-commands.test.ts), [email tests](../../../../tests/unit/email.test.ts); окреме створення партнерського Lead |
| FR-03/04, D-003–007, D-031/041–044 | [quiz commands](../../../../tests/worker/quiz-commands.test.ts), [HTTP](../../../../tests/worker/quiz-http.test.ts), browser reload/Back; серверний профіль, UserID/EventID, збережені відповіді |
| FR-05/08, D-008/023 | [offer selection tests](../../../../tests/unit/offer-selection.test.ts): активний найновіший Lead, minID за рівності, неактивний Lead, bypass; [CLI E2E](../../../../tests/smoke/partner-cli.spec.ts) |
| FR-06/07, D-028/094/176 | [catalog tests](../../../../tests/unit/offer-catalog.test.ts), selection tests: усі контрольні приклади, maxEPU/minID, fallback007, no_offer; перевірка всього конфігу до build |
| FR-09, D-009/032/033/082/093/132 | [partner HTTP](../../../../tests/worker/partner-http.test.ts), [partner events](../../../../tests/worker/partner-events.test.ts): Bearer, ClickID, історичний owner, компактний Lead, атрибуція |
| FR-10, D-010–012/036–040/071/122/123 | partner tests і [CLI E2E](../../../../tests/smoke/partner-cli.spec.ts): той самий ID без ефектів, payload conflict без запису, інша Purchase окремо, Purchase без Lead, часові межі й запізнілі події |
| FR-11/12, D-013/014/021/022/045/046/086/114–116/143–151 | [report D1](../../../../tests/worker/report.test.ts), [history](../../../../tests/worker/report-history.test.ts), [report browser](../../../../tests/smoke/report.spec.ts): SC-14, UTC, когорти, фільтри, знаменники, unavailable, числові UI assertions |
| FR-13, D-024/173 | UI показує назву/URL/ClickID; окремий 303/Location тест адаптера з фактичним результатом B, без зовнішнього запиту |
| D-017/034/038/039/064/065/162–164/167/168 | [final commands](../../../../tests/worker/final-commands.test.ts), quiz/partner tests: спільний atomic batch, snapshot, ключ, результат, ClickID, events/outbox, rollback, revision і бюджети |
| NFR-05/06, D-019/020/047–053/070/075/077/081/083/085/101–107 | HTTP/D1 і browser-тести повторів, cookie/expectedUserID/Origin, Web Locks, sessionStorage, лімітів і негативних постбеків; повна аварійна матриця — M3 |
| DEL-01/02/03 | [Дизайн](../../../system-design.md), [Excalidraw](../../../diagrams/system-context.excalidraw), [план](../../../implementation-plan.md); Purchase-виключення/фактичний EPU залишаються майбутнім дизайном |

**Критерій M2 SC-01/02/07:** справжній browser → HTTPS → Worker/D1 →
CLI Lead → reload/bypass → дві Purchase, точний повтор і конфлікт →
report. У [наскрізному тесті](../../../../tests/smoke/partner-cli.spec.ts)
очікуються офер 003, 1 користувач, 1 завершення, 1 унікальний перехідник,
1 bypass-користувач, 1 Lead, 1 покупець і 2 покупки. Повтор/конфлікт і
читання звіту не змінюють бізнес-таблиць; звіт не поновлює cookie.

## Фактична перевірка

Перед правками root виконав `CI=true npm run check`: exit 0,
420 Vitest і 67 Playwright. Після правок цільові перевірки пройшли:
13 HTTP/D1 та 2 нові browser-тести, build. Перший запуск нового адаптера
виявив втрату Set-Cookie при поверненні native Response; це виправлено
через Hono Context. Повтор 13/13 підтвердив і cookie renewal, і redirect.

Після всіх виправлень root повторно виконав `CI=true npm run check`,
**exit 0**:

- TypeScript для client/server/shared та всіх test/config файлів — успіх.
- Vitest — **420/420** у 25 файлах: 182 unit + 238 Worker/D1.
- Vite client/Worker build — успіх.
- Playwright — **69/69**: 26 Chromium + 24 решта матриці + 2 CLI +
  13 Chromium report + 4 report у решті матриці.

Дві нові browser-перевірки збільшили загальне число з 67 до 69; HTTP
redirect перевіряється всередині наявного повного HTTP A/B-тесту.
Автоматичного повтору тестів не було.
Локальні посилання 22 змінених Markdown-файлів цілі; значення чинних
локальних credentials відсутні в 198 перевірених файлах репозиторію
та client bundle. Whitespace перевірено перед фіксацією.

Довкілля: Node 24.22.2, npm 11.19.1, локальний workerd/D1, macOS.
Браузерна матриця: Chromium, Firefox, WebKit, mobile-chromium і
mobile-webkit; мобільні конфігурації — емуляція. Retries вимкнено.
Перевірки використовують ізольовані test/E2E дані, не dev persistence.

## Межі висновку

- Завершено **M2**, не весь MVP. M3 — повна матриця відновлення й захисту;
  M4 — Cron/ACK/lease/cleanup/reconciliation; M5 — інтеграція retention,
  restore-повноти та пакет здачі; M6 — хмарний реліз.
- Стани outbox і budgets уже реальні; доставки поки немає. `/status`
  явно повертає `not_implemented` для Cron/export. Накопичення обмежене,
  після заповнення приймання зупиниться за погодженим контрактом.
- Реальний партнер, листи, BigQuery та benchmark не використовувалися.
  HTTP-редирект перевірено in-process, демо-UI не відкриває партнера.
- Наявна dev-база з 10 подіями без `history_available_from` не була
  очищена чи backfill-нута; бізнес-звіт для неї fail-closed без чисел.
  Новий підтверджений облік працює, що доведено E2E. Окреме підтвердження
  повноти старої історії належить подальшому експлуатаційному блоку.
- NFR-01/04: production-навантаження й p95 залишаються цілями дизайну
  за D-026. NFR-02: локальний звіт читає актуальний SQL snapshot;
  цільова свіжість експорту ще не перевірена. NFR-03/07: проєктні
  гарантії й ресурсні оцінки не є результатами випробування Cloudflare Free.
- Хмарного deploy/push і GitHub CI для M2 не виконано. Попередній CI
  M0 не подається як перевірка поточного коду. Репозиторій приватний;
  локальний коміт не змінює віддалену історію чи доступ.
