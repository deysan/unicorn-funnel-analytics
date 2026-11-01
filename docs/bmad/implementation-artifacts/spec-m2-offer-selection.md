---
title: 'M2: каталог оферів і правила вибору'
type: 'feature'
created: '2026-10-31'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Почати M2 з серверного каталогу семи оферів і чистих правил вибору за
FR-02/05–08, D-008/D-023/D-028/D-093–094/D-173–176. Вибір детермінований:
активний найновіший Lead → відповідність/EPU/minID → 007 → no_offer.
Неповні вподобання без активного Lead не дають fallback; email/Purchase
не впливають на вибір. Зміни без коміту до завершення M2, без реальних
переходів, записів у D1, HTTP-команд, deploy чи нових бізнес-рішень.

</frozen-after-approval>

## Implementation Notes

- Невідомих продуктових рішень немає. Незворотних дій немає. Обмежений
  зріз: три серверні файли offers/config/catalog/selection, Vite config,
  unit/Worker тести й документація. M1 не змінюємо.
- `config.ts`: сім початкових записів точно за requirements; партнер
  demo-partner синтетичний, наявний у M1 fixtures. Секретів немає.
- `catalog.ts`: суворий Zod-валідатор всього каталогу, відомі партнери,
  унікальні 001–007 (підмножина/порожній каталог дозволені), параметри
  підбору, finite nonnegative epu_usd без округлення чи обмеження центами.
  Універсальним є тільки 007; поля та невідомі ID не приймаємо мовчки.
- HTTPS URL без credentials/сирих пробілів/control/backslash; click_id
  у query, включно з декодованим регістровим варіантом, заборонено.
  Формуємо URL через URL API; query/fragment зберігаються семантично.
  Готовий URL із UUID ≤2048 UTF-8 байтів; назва ≤256 байтів.
- Нормалізація: offers/partners за ID, genders як впорядкована множина,
  URL.href; фіксований JSON-масив формату unicorn.catalog/1 з усіма полями.
  SHA-256 через Web Crypto; копія глибоко заморожена, snapshot/version
  створюються разом. getOfferCatalog ліниво кешує пару, а не кожну B.
- Vite config викликає той самий валідатор до dev/build; CI вже запускає
  unit/build. Нова B пізніше викличе getOfferCatalog всередині builder
  після replay. Не робимо непідключений HTTP endpoint лише для перевірки.
- `selection.ts`: чистий selectOffer із результатами selected/no_offer/
  needs_quiz і nextAction для повернення. Час Lead — вже перевірений
  latest_lead_at, не received_at. Відсутній офер не активний, але факт Lead
  враховується для D-023. Передачу лише чинного профілю/Lead забезпечить caller.
- Given початковий каталог, when усі шість комбінацій вподобань, then
  контрольні результати ТЗ; EPU tie → minID, 007 не конкурує за EPU.
- Given активні Lead, when вибір, then найновіший/мінімальний ID незалежно
  від EPU й вподобань; inactive/removed не стають кандидатом.
- Given немає активного Lead та неповні вподобання, then needs_quiz.
  Given лише inactive/removed Lead і повні вподобання, then select_offer
  без email; given повні відповіді без Lead, nextAction лишається quiz.
- Given одна помилка в конфігу, then весь каталог відхилено, не no_offer.
  Given перестановка полів/записів, then version незмінна; given зміна
  семантичного поля, then version інша; вихідний config не мутує snapshot.
- Unit перевіряє правила/URL/валідацію/вектор SHA; Worker звіряє той самий
  version і вибір у workerd. Повний check і незалежне BMAD Build рев’ю.

## Completion Notes

- Каталог, валідатор/version/URL, чистий selector та правило повернення
  реалізовано. Vite до dev/build перевіряє той самий конфіг. Пакетів не додано.
- `CI=true npm run check`: exit 0; типи, 162 Vitest (81 unit + 81 Worker),
  build та 21 Playwright пройшли. SHA-вектор незалежно обчислено через
  node:crypto з явного початкового каталогу; workerd дає те саме значення.
- Незалежне BMAD Build рев’ю не знайшло підтверджених дефектів; рев’юер
  читав код/тести, але сам їх не запускав. Відкладених findings немає.
- Завершено лише цей зріз M2. HTTP/B/D1, повний сценарій і коміт цілого
  M2 ще попереду. Міграцій/deploy/реальних переходів не виконували.
