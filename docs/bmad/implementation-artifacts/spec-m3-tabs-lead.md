---
title: 'M3 — дві вкладки й Lead під час квізу'
type: 'chore'
created: '2026-11-01'
status: 'done'
route: 'oneshot'
---

<frozen-after-approval>

## Intent

Перевірити SC08/D015 та D159 у браузері: незалежний запис по питаннях,
останній commit перемагає, повтор не застосовує стару дію знову,
перша пізня доставка є новим записом. Lead робить stale крок недоступним;
явне оновлення контексту дає bypass зі збереженим профілем без email.
Без синхронізації наживо, нових бізнес-правил або коміту.

</frozen-after-approval>

## Implementation Notes

Наявні dirty M3 зміни накопичуються за дорученням власника.
Investigation підтвердив D1 guards/revision/replay, дефекту не знайдено.
Малий oneshot лише browser regression: concurrency.spec.ts, окрема група
run-smoke для незмінного IP rate budget; синтетичні профілі90–93.
Новий Lead надходить справжнім HTTP endpoint; дві вкладки ділять cookie.


## Verification

Цільові 4/4 browser-тести пройшли. Незалежний BMAD Build reviewer
повернув []. Повний `CI=true npm run check`: exit 0, 431 Vitest,
79 Playwright, typecheck/build. Production-код у цьому підкроці не
змінювався; попередні dirty M3 зміни збережено. Без коміту.
