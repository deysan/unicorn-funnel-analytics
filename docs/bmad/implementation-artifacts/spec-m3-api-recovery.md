---
title: 'M3 — відновлення після некоректної HTTP-відповіді'
type: 'bugfix'
created: '2026-11-01'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>

## Intent

За D-069/D-124 і SC-09 невідома відповідь API не доводить втрату доступу.
Перевіряти структуру помилки перед використанням її code. Некоректні
null/HTML/неповні помилки мають дозволяти ручний повтор зі збереженими
OperationID та чернеткою; валідні помилки зберігають погоджену поведінку.
Перший підкрок M3, без коміту, deploy чи змін бізнес-правил.

</frozen-after-approval>

## Implementation Notes

Малий oneshot: немає невідомих бізнес-рішень або незворотних дій.
Code map: shared/quiz.ts — контракт; client/api.ts — перевірка envelope;
controller.fail — споживач code, не змінюємо. Unit і browser регресії
доводять ручне відновлення після фактично записаної A без повторного POST A.


Перевірено повним `CI=true npm run check`: exit 0, 431 Vitest,
71 Playwright, typecheck/build. Незалежний BMAD Build reviewer
переглянув поточні зміни та повернув порожній перелік findings.
Коміт пропущено за прямим дорученням власника. Завершено лише цей підкрок.
