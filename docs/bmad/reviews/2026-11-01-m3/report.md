# Підсумковий аудит M3

Дата: 2026-11-01. База M2: `6a677951cab893acc83fbeccc12bec44873b478b`.
Обсяг: усі накопичені зміни M3 та успадковані механізми M2, потрібні
для gate SC-03–09/13. Доручення: аудит за ТЗ/рішеннями з BMAD,
один локальний коміт за успішного результату. Push/deploy не входять.

Статус: **M3 пройшов підсумкову перевірку**. Відкритих findings у межах
етапу немає; дозволений один локальний коміт накопиченого M3.

## Джерела та метод

[ТЗ](https://docs.google.com/document/d/1gitcbjFaNR_rz8BGErQgLVJqi2njv494-tsCNPPIbRY/edit)
звіряємо через [вимоги](../../../requirements.md); оригінал повторно
прочитано цього ж дня під час [аудиту M2](../2026-11-01-m2/report.md).
[Рішення](../../../decisions.md), [сценарії](../../../scenarios.md) та
[план реалізації](../../../implementation-plan.md) визначають погоджені межі.

BMAD 6.12.4, skill bmad-review, customization resolved із
[project override](../../../../_bmad/custom/bmad-review.toml). Вміст —
code diff плюс поведінкові контракти. Три незалежні контексти запущено
до обробки результатів: adversarial, edge-case-hunter, verification-gap.
Кожен читав повний diff tracked/untracked і джерела; чужих findings
не отримував. Квоти проблем немає; старе design-only формулювання
override не скасовує актуального доручення власника на реалізацію.
Редакторські lenses не застосовувалися: це поведінковий аудит коду.
[Manifest](manifest.json).

## Покриття M3 за ТЗ та рішеннями

| Сценарій / вимога | Реалізація й докази |
|---|---|
| SC-03, FR-03/04, D-004–006 | [quiz browser](../../../../tests/smoke/quiz.spec.ts): step обмежений відповідями, URL нормалізується, reload/new entry, збережений профіль, без автоматичного нового UserID |
| SC-04, FR-01/02/06, D-005/007/042/043 | quiz browser: Back лише новий view, women → men змінює Q2; [quiz D1](../../../../tests/worker/quiz-commands.test.ts): збереження допустимих Q2/email, підтвердження після валідного view |
| SC-05/06, FR-05–08, D-008/023/039/040 | [offer unit](../../../../tests/unit/offer-selection.test.ts): latest Lead/minID, inactive/removed, matching/fallback/no_offer; [A/B D1](../../../../tests/worker/final-commands.test.ts): snapshot повтору, нова B після no_offer, Lead/revision до commit |
| SC-07, FR-09/10, D-009–012 | [partner HTTP](../../../../tests/worker/partner-http.test.ts), [partner D1](../../../../tests/worker/partner-events.test.ts), [CLI browser](../../../../tests/smoke/partner-cli.spec.ts): два Purchase, повтор/конфлікт, пізня подія, немає автоматичного Lead |
| SC-08, D-015/064/160/161 | [дві вкладки](../../../../tests/smoke/concurrency.spec.ts): різні питання, replay після нового запису, перша пізня доставка, server choice; quiz/A/B D1: revision гонки й rollback |
| SC-09, NFR-05, D-036–038/047–050/124/127–130 | quiz browser і [draft unit](../../../../tests/unit/quiz-draft.test.ts): A/B recovery, TTL, storage failures, незмінні ключі; A/B D1: невідомий commit, ключі/конфлікти/TTL; [API unit](../../../../tests/unit/quiz-api.test.ts): malformed response без втрати доступу |
| SC-13, NFR-06, D-020/051–053/070/081–083/134/138–142 | [SC13 matrix](../../../m3-sc13.md), [quiz HTTP](../../../../tests/worker/quiz-http.test.ts): два реальні профілі, cookie/expectedID, current access перед replay, strict Origin/body, auth scopes, snapshots без записів |
| D-101–107/125/126 | HTTP/D1: limiter fail-closed, порядок IP/subject, deadline; browser: пауза/ключі/лічильник retry, Web Lock та bootstrap; без хмарного твердження про trusted IP |
| D-124/127, пізні відповіді | quiz browser: visibility success/error після B, новіша відповідь перемагає, чинний TTL очищає payload, busy/paused без зайвого GET |

Тести D1 контролюють порядок транзакцій і revision. Браузерні тести
перевіряють UI й HTTP, а не доводять одночасний commit двох SQL batch.
Погоджено останній успішний запис, не порядок кліків на пристроях;
синхронізації вкладок наживо немає. Зміна контексту після Lead потребує
явного refresh після step_not_ready; це погоджений D-159, не дефект.

## Findings і виправлення

Усі сім висновків прийнято після перевірки коду й контрактів; нових
бізнес-рішень не потрібно. [Машиночитаний перелік і triage](findings.json).

| ID / lens | Проблема | Результат |
|---|---|---|
| M3-01, adversarial | Нова B після no_offer успадковувала витрачений бюджет повторів | Нова дія скидає бюджет; retry зберігає його. Окремий тест двох B |
| M3-02, edge-case-hunter | Retry явного refresh міг змінити entry/B після невідомого результату | Ключі створюються один раз на жест; retry відновлює поточну B. Два тести втрати entry/B |
| M3-03, edge-case-hunter | Старий context після deadline міг повернути email у чернетку | Час не відступає, expired незворотний; recovery враховує очищення під час await. Тест із реальною затриманою відповіддю |
| M3-04, verification-gap | Не доведено reschedule таймера після visibility | Свіжий час перед deadline → очищення через 1001 мс, ті самі ключі |
| M3-05, verification-gap | Старий identity_lost перевіряли лише після готової B | Тепер звільняємо його під час незавершеного retry, до зміни generation |
| M3-06, verification-gap | Refresh не мав окремих доказів found B та помилки читання | Реальний commit B, втрачена відповідь; found/503 не створюють нового переходу |
| M3-07, verification-gap | Не перевірено збій локального запису після успішної B | Результат і попередження видимі; reload повертає той самий ClickID |

Тести: [бюджет повторів](../../../../tests/smoke/m3-retry-budget.spec.ts),
[refresh](../../../../tests/smoke/m3-refresh-retry.spec.ts),
[гонка TTL](../../../../tests/smoke/m3-expiry-race.spec.ts),
[прогалини перевірок](../../../../tests/smoke/m3-audit-gaps.spec.ts).
Цільовий Chromium `@audit`: **9/9, exit 0**. Рев’юери adversarial та
edge-case-hunter повторно прочитали виправлення: причини закрито,
нових конкретних регресій не виявили. Тести запускав основний агент;
повторна перевірка рев’юерів була лише читанням коду.

Smoke розділено на окремі групи M3/аудиту з чистою тестовою persistence.
Це ізолює накопичення запитів у тестах; реальні IP/subject ліміти не
змінювалися. Dev-історія збережена.

## Фактичні перевірки

- Вихідний check до виправлень аудиту: 440 Vitest, 79 Playwright, exit 0.
  Зелений набір не заперечував знайдених прогалин покриття.
- Після виправлень: `npm run test:smoke -- --project=chromium --grep=@audit`
  — 9/9, exit 0.
- Фінальний `CI=true npm run check` — **exit 0**: TypeScript, **440 Vitest**
  (193 unit + 247 Worker), build та **88 Playwright** без test retries:
  26 базових Chromium + 24 матриця + 6 M3 + 9 аудит + 4 concurrency +
  2 CLI + 13 report + 4 report matrix.
- Пошук фактичних секретів `.dev.vars` у tracked/untracked файлах та
  `dist/client`: 4 значення, збігів немає; значення не виводилися.
- Документацію перечитано; 203 локальні посилання у 14 змінених Markdown
  файлах ведуть на наявні файли. JSON артефакти валідні, `git diff --check`
  не виявив помилок пробілів.

Після check змінювалася лише документація. Vite попереджає про майбутній
native config loader; поточна збірка проходить. Це не failure тесту.

## Межі висновку

M3 — локальне відновлення й захист, не весь MVP. Cron/ACK/lease,
фізичний cleanup і звірка лічильників — M4. Експлуатаційне підтвердження
історії/restore та пакет здачі — M5; хмарне демо — M6.
Наявна dev-історія не очищується, метадані повноти не вигадуються.

Нових сервісів/платних ресурсів немає. BigQuery, реальний партнер,
листи й зовнішні переходи не використовуються. Rate-limit adapter
поки локальний; production-навантаження/p95 залишаються цілями дизайну.
Локальні перевірки не є результатом GitHub CI поточного SHA.
