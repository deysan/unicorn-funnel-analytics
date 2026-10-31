---
title: 'M0: Vitest для правил і Worker/D1'
type: 'chore'
created: '2026-10-31'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Налаштувати Vitest для чистих правил і Worker/D1 у погодженому локальному
каркасі. Надати окремі команди й типові перевірки наявного контракту/API,
реального тестового D1 та ізоляції даних. Зберегти Chromium smoke.
Нові бізнес-правила/схему M1 не реалізовувати. Коміти робимо після
завершення блоків M0, M1 тощо; цей крок — без коміту й push.

</frozen-after-approval>

## Implementation Notes

- Малий локальний блок без невідомих продуктових рішень/незворотних дій.
  Наявний каркас і smoke не змінюють бізнес-поведінки; src лишається
  джерелом тестованого коду. BMAD oneshot; заборона коміту користувача
  має пріоритет над завершальним кроком workflow.
- Файли: три `vitest*.config.ts`, `tests/unit`, `tests/worker`, окремий
  tsconfig тестів Worker, npm scripts/lockfile та документація.
- Given вибір unit, when запуск тестів, then виконуються тільки чисті
  перевірки в Node без запуску браузера або хмарних ресурсів.
- Given Worker-тести, when перевірка HTTP і SQL, then використовується
  локальний workerd/D1 з ізольованими даними файлів і явним очищенням
  тестових фікстур усередині файлу; dev-база не змінюється.
- Given загальний check, when всі рівні завершені, then типи, unit,
  Worker/D1, build і Chromium smoke успішні; порожні набори не є успіхом.

- Встановлено Vitest 5.0.5 і @cloudflare/vitest-plugin 1.4.11 після
  перевірки registry й документації. Два проєкти, окремий Worker tsconfig,
  scripts для кожного рівня/всіх рівнів/watch; retries = 0.
- Фактично виконано typecheck; unit 6/6; Worker 7/7; після npm ci —
  загальний check: Vitest 13/13, build, Chromium 4/4. Lockfile незмінний
  після npm ci. У 7 dev SQLite-файлах немає тестових таблиць.
- Окремий BMAD Build рев’юер переглянув код/config/scripts/tests/lockfile
  без запуску тестів: дефектів коду немає. За AGENTS.md квоту findings
  не застосовували. Фактичні запуски виконав основний агент.
- Коміт/push не виконано; історія попереднього каркаса збережена.

## Review Triage Log

- low, виправлено: рев’юер помітив статус «Vitest ще не встановлено» та
  застарілий наступний крок у документації. Оновлено `docs/m0-environment.md`,
  `docs/plan.md`, README й план реалізації за фактичними результатами.
