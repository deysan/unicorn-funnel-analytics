---
title: 'M3 — негативні сценарії SC13'
type: 'chore'
created: '2026-11-01'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>

## Intent

Перевірити SC13 за погодженими межами: cookie дає доступ лише до власного
профілю/результату; UserID не є авторизацією; повтор також вимагає чинного
доступу; Origin/некоректні тіла не змінюють дані. Звіт і постбеки мають
окрему авторизацію. Нових бізнес-рішень і коміту немає.

</frozen-after-approval>

## Implementation Notes

BMAD investigation не підтвердив дефекту. Основна прогалина доказів:
попередній foreign-ID тест використовував неіснуючий профіль. Додаємо
два реальні профілі, чужий збережений результат/email; відмови replay
після втрати доступу; негативні Origin/UTF8/byte-limit із повним snapshot.
Поточні partner/report тести вже покривають незалежну auth, чужий ClickID,
повтори, строгі DTO й недоступність limiter. Наявні dirty M3 зміни збережено.


## Verification

Додано 9 HTTP/D1-регресій. Перша expired-фікстура порушувала CHECK
created_at <= last_active_at; виправлено фікстуру, не схему.
Незалежний BMAD Build reviewer: []. Root повний `CI=true npm run check`:
exit0, 440 Vitest (193 unit + 247 Worker), 79 Playwright, типи/build.
Попередні зміни M3 збережено; коміт/push/deploy не виконано.
