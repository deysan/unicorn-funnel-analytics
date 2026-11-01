# M2 — базовий закритий звіт

Історичний запис підкроку. Актуальний підсумок усього M2 на 2026-11-01 —
[фінальний аудит](bmad/reviews/2026-11-01-m2/report.md).

2026-10-31. Локальна реалізація [контракту](m2-report-contract.md).
Увесь незакомічений M2 і dev persistence збережено. Нових бізнес-рішень,
міграцій, commit/push/deploy немає.

## Читання й числа

`/report`, `/report/` та report API проходять серверний Basic Auth до
ASSETS. Credentials відокремлені від cookie квізу й partner Bearer;
setup генерує лише відсутні `REPORT_USERNAME`/`REPORT_PASSWORD` у
ignored `.dev.vars`. IP300/min до auth та спільний report30/min після
auth мають сукупний deadline 1s; відмова 429/60s, збій 503/30s.
Усі відповіді `no-store`; бізнес-таблиці й cookies не змінюються.
Це локальний fail-closed IP adapter, не хмарна реалізація.

Один параметризований SELECT обчислює metadata/updated_at та всі
бізнес-числа на одному D1-зрізі. Activity рахує незалежні унікальні
UserID в UTC-періоді; Purchase — кількість подій. Quiz не фільтрується
офером. Конверсії беруть групи показів/початків/переходів у періоді та
всі прийняті пов’язані результати зрізу: валідні view/completion refs,
повернення через інший entry, рівні timestamps, точні cohort ClickID.
Допустимий ранній/майбутній час партнерської події не губить конверсію;
пізня покупка не змінює activity старого дня. Bypass не завершує квіз.

DTO суворий і містить тільки дозволені поля. Конверсії — точні
numerator/denominator; UI округлює відсоток до одного знака, 0/0 показує
«немає даних», 0/N — 0,0%. «Ще не підтвердили» має число та частку.
Неприпустима пара відхиляється, а не виправляється clamp.
`/status` окремо читає реальні delivery counts, бюджети/паузи та flags;
Cron/export явно `not_implemented`. `/filters` поєднує один snapshot
збережених ID із однією версією каталогу, включно з historical IDs,
без EPU/URL/профілів. Кожен endpoint має власний updated_at.

## Повнота історії й запуск

`report_status=ready` містить metrics, available_from, updated_at,
filters. `unavailable` не містить metrics; history_unverified має
пріоритет і не видає available_from. period_unavailable повертає
доступну межу, не обрізаючи запит. Відсутні/суперечливі metadata дають
безпечну технічну 503 без чисел. Доступна межа — максимум підтвердженого
UTC-дня та строго наступної доби після now−90days+5min.

Застосовану міграцію 0002 не переписано. Її старий коментар про першу
подію не виконується: `setup-local` до міграцій фіксує відсутність D1
storage, а після міграцій перед сервером атомарно ініціалізує UTC-день.
Guard відмовляє за бізнес-даних, попередніх metadata або пауз/лічильників.
Звичайний setup старої persistence нічого не backfill-ить і не знімає
unverified. Збій після створення D1 до initializer залишається fail-closed
до окремої перевірки; порожні таблиці не є доказом для повторного запуску.
E2E reset стосується тільки `.wrangler/e2e-state` й виконується до setup.

## Інтерфейс

Окрема українська сторінка не запускає квіз. Початкові from/to беруться
з UTC-дня status.updated_at; явні дати можуть працювати при помилці status
або filters. Застосовані фільтри живуть в URL через replaceState;
форма має локальну чернетку й позначку незастосованих змін. Invalid URL
не скидається мовчки, збережений невідомий ID лишається видимим.

Ручне оновлення читає всі три endpoints; auto — funnel/status через 60s
після завершення попередньої спроби. Hidden зупиняє polling, повернення
оновлює без overlap; abort/generation не дають старій відповіді підмінити
новий вибір. Timeout 10s та Retry-After не створюють tight loop; auth/query
помилки зупиняють auto до ручного виправлення. Error/unavailable ховають
числа, зберігаючи фільтри й останній успішний timestamp. Старший за 15min зріз
також ховається. Auth не зберігається в JavaScript.

## Перевірка

Цільові 20 unit та 22 Worker/D1, typecheck/build пройшли. D1 включає повну
числову SC-14, cross-day/cohort return, повторний view, wrong references,
equal time, bypass, exact ClickID, ранню/майбутню Purchase без Lead,
missing/invalid/unverified metadata, snapshot UTC, auth/ліміти й no-store.
Guarded initializer перевірено на новій історії та на відмовах із даними,
unverified, integrity pause та ненульовими budget counts. Окрема тимчасова копія реального setup
довела нову UTC-межу, byte-identical повтор credentials та збереження
старого unverified/null metadata. Основна dev-база не змінювалася.

Початковий Worker запуск без доступу до loopback не стартував (EPERM);
дозволений повтор пройшов. Перший Chromium smoke знайшов неправильний
тестовий getByLabel для вкладеного select; locator замінено на доступний
combobox role. Повтор7/7 пройшов; ретраїв тестів немає.
Після двох додаткових browser-регресій (60s після повільного completion,
period_unavailable/corrupt DTO) і critical report matrix виконано
`CI=true npm run check` — **exit 0: 416 Vitest** (182 unit + 234 Worker),
типи/build та **63 Playwright** (24 Chromium + 24 решта матриці + 2 CLI +
9 Chromium report + 4 critical report matrix). Кожна smoke-група має
свіжий test runtime; IP/report limits не підвищено. Реальний CLI smoke
перевіряє квіз→Lead→bypass→2 Purchase + replay→report: 1 покупець, 2 покупки,
незмінність усіх бізнес-таблиць/cookie після читання. Desktop/mobile
знімки збережено в ignored test-results; root переглянув їх, додано
мобільну підказку scroll і назву «Без повторного квізу».

`git diff --check`, локальні посилання та пошук значень credentials
у source/docs/tests/client bundle пройшли.

## Незалежне рев’ю та фінальна перевірка

Три контексти BMAD завершили review; чотири findings зафіксовано у
[triage](bmad/implementation-artifacts/spec-m2-report.md#review-triage-log).
Виправлено залежний початковий запит під час паузи й джерело часу
позначки незавершеного дня. Додано негативні Basic credentials та
числові UI-регресії з різними конверсіями й залишком 2/3.
Після цільових тестів root повторив увесь `CI=true npm run check`:
**420 Vitest** (182 unit + 238 Worker), **67 Playwright**
(24 + 24 + 2 CLI + 13 report + 4 report matrix), типи/build, exit 0.
Відкладених findings немає. Попередній прогін вище — до review.

Чинний localhost:5173 перевірено: HTML401 без Basic, HTML/status200
із Basic, funnel503 через відсутні metadata старої dev-історії,
усюди no-store. Історію не очищено й дату не вигадано.

## Межі

Це локальний наскрізний звіт M2. Cron, pending delivery/ACK, cleanup,
реальна перевірка restore/консервативної межі, cloud adapter/deploy та
повна матриця M3–M5 ще попереду. SC-14 використовує синтетичні D1 fixtures;
частина аварій UI моделюється Playwright routes. Загальне завершення M2
й готовність усього MVP цим підкроком не оголошуються.
