---
title: 'M0: браузерна матриця й CI без deploy'
type: 'chore'
created: '2026-10-31'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Завершити основу перевірок M0 за D-110/D-177: повний набір у Chromium,
критичні сценарії в Firefox/WebKit і мобільній емуляції Chromium/WebKit.
Підготувати GitHub Actions для тих самих перевірок без deploy і хмарної D1.
Перед хмарним запуском перевірити Free-передумови. Нові бізнес-сценарії
не реалізовувати. Коміт — після завершення M0, push лише за дорученням.

</frozen-after-approval>

## Implementation Notes

- BMAD oneshot: невеликий блок налаштування вже погоджених перевірок.
- Файли: `playwright.config.ts`, `tests/smoke/scaffold.spec.ts`,
  `.github/workflows/ci.yml`, README, план, середовище та AI-worklog.
- Given каркас, when загальний check, then типи, 13 Vitest і всі п’ять
  браузерних конфігурацій успішні без пропусків та автоматичних повторів.
- Given вузький viewport, when відкриття сторінки, then кнопка доступна
  й немає горизонтального прокручування.
- Given зміна коду/залежностей/workflow, when PR/push у master або ручний
  запуск, then стандартний Linux runner перевіряє lockfile-версії,
  типи, Vitest, build і браузери, не виконує deploy/хмарні міграції.
- Given акаунт, when перевірка передумов D-177, then план, доступна квота
  та блокування доплат підтверджені; невідомі умови не є дозволом на витрати.
- 2026-10-31: read-only перевірка GitHub UI підтвердила Free, доступний
  включений ресурс і нульовий бюджет Actions із зупинкою використання.
  Actions дозволені для приватного репозиторію. Налаштування не змінювали.
  Персональні billing-подробиці й знімки до репозиторію не переносимо.
- Chromium запускає всі тести; інші проєкти — `@critical`. Зараз це тільки
  поведінка технічної сторінки; бізнес-покриття додається в M1–M5.
- Один worker, retries 0, заборона test.only у CI, браузерний дедлайн
  5 хвилин; job 15 хвилин. Actions за перевіреними SHA; credentials не
  зберігаємо. Кеш і upload артефактів вимкнено; результат — у журналі run.
- Додано окремі DOM-типи для браузерних тестів. Firefox 157 на macOS 27
  потребував ізольованих `MOZ_APP_DATA`/`MOZ_LOCAL_APP_DATA`; fixture очищає
  їх після закриття браузера. Попередній варіант через системний home мав
  помилку teardown, прибраний. Фінальний check: типи, 13 Vitest, build,
  21 Playwright успішні; actionlint 1.7.12 — exit 0. GitHub run не виконували.
- Незалежний BMAD Build Blind Hunter переглянув конфігурації, fixture,
  тести, CI та документацію: доказових дефектів немає. Рев’юер перевірив
  diff і не запускав тести; їх виконав основний агент. Квоту findings
  за AGENTS.md не застосовували. Відкладених findings немає.
- Завершено локальну основу M0; коміт охоплює накопичені Vitest та
  браузерні/CI-зміни. Попередній коміт каркаса збережено; push не виконано.
