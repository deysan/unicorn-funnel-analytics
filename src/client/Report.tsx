import { useEffect, useState, useSyncExternalStore } from 'react';
import { formatConversion, parseReportQuery, queryString, reportQuestionLabels, reportQuestions, utcDay, type Conversion } from '../shared/report';
import { ReportController } from './report-controller';
import { Brand } from './Brand';
const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
function ConversionValue({ value }: { value: Conversion }) { return <><strong>{formatConversion(value)}</strong><small>{value.numerator} / {value.denominator} користувачів</small></>; }
export function Report() {
  const [controller] = useState(() => new ReportController());
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [draft, setDraft] = useState({ from: '', to: '', preland_id: '', offer_id: '' });
  const [formError, setFormError] = useState<string>();
  const [section, setSection] = useState<'overview' | 'technical'>('overview');
  useEffect(() => controller.start(), [controller]);
  const appliedKey = state.applied ? queryString(state.applied) : '';
  useEffect(() => { if (state.applied) { setDraft({ preland_id: '', offer_id: '', ...state.applied }); setFormError(undefined); } }, [appliedKey]); // Updates never erase unsubmitted form edits.
  const draftQuery = { from: draft.from, to: draft.to, ...(draft.preland_id ? { preland_id: draft.preland_id } : {}), ...(draft.offer_id ? { offer_id: draft.offer_id } : {}) };
  const dirty = queryString(draftQuery) !== appliedKey;
  const submit = () => {
    try { const query = parseReportQuery(new URLSearchParams(queryString(draftQuery))); controller.apply(query); setFormError(undefined); }
    catch { setFormError('Укажіть правильні дати UTC, від початку до кінця періоду, не пізніше сьогодні.'); }
  };
  const value = state.funnel;
  const metrics = value?.report_status === 'ready' ? value.metrics : undefined;
  const prelands = new Set(state.filters?.prelands ?? []); if (draft.preland_id) prelands.add(draft.preland_id);
  const offers = [...state.filters?.offers ?? []]; if (draft.offer_id && !offers.some((o) => o.id === draft.offer_id)) offers.push({ id: draft.offer_id, status: 'historical' });
  const status = state.status;
  const needsAttention = status && (status.receiver_mode === 'unavailable' || status.integrity_paused || status.history_unverified
    || status.history_metadata !== 'confirmed' || status.pause_reason !== null
    || status.budgets.some(b => b.alert !== 'normal' || b.paused)
    || status.cron.stale || status.cron.status === 'partial_failure' || status.cron.errors.length > 0
    || status.delivery.delayed || status.delivery.errors.length > 0
    || status.reconciliation.status === 'mismatch' || status.reconciliation.status === 'read_failed'
    || Object.values(status.cleanup.phases ?? {}).some(p => p.error));
  return <><Brand report/><main className="report report-shell">
    <header className="report-heading"><div><h1>Воронка та результати</h1><p>Активність за UTC-дні й результати груп користувачів станом на зріз.</p></div><button type="button" className="secondary" disabled={state.busy || Boolean(state.pausedUntil && state.pausedUntil > Date.now())} onClick={controller.refresh}>Оновити</button></header>
    <nav className="report-tabs" aria-label="Розділи звіту">
      <button type="button" aria-pressed={section === 'overview'} aria-controls="report-overview" onClick={() => setSection('overview')}>Огляд воронки</button>
      <button type="button" aria-pressed={section === 'technical'} aria-controls="report-technical" onClick={() => setSection('technical')}>Технічний стан</button>
    </nav>
    <section className="report-filters" aria-label="Фільтри звіту" hidden={section !== 'overview'}>
      <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label>Від (UTC)<input type="date" required value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })}/></label>
        <label>До (UTC)<input type="date" required value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })}/></label>
        <label>Преленд<select value={draft.preland_id} onChange={(e) => setDraft({ ...draft, preland_id: e.target.value })}><option value="">Усі преленди</option>{[...prelands].sort().map((id) => <option key={id} value={id}>{id}{!state.filters?.prelands.includes(id) ? ' · вибраний ID' : ''}</option>)}</select></label>
        <label>Офер<select value={draft.offer_id} onChange={(e) => setDraft({ ...draft, offer_id: e.target.value })}><option value="">Усі офери</option>{offers.sort((a, b) => a.id.localeCompare(b.id)).map((o) => <option key={o.id} value={o.id}>{o.id}{o.name ? ' · ' + o.name : ''}{o.status === 'inactive' ? ' · неактивний' : o.status === 'historical' ? ' · історичний / вибраний ID' : ''}</option>)}</select></label>
        <button type="submit">Застосувати</button><button className="text-button" type="button" onClick={controller.reset}>Скинути фільтри</button>
      </form>
      {dirty && <p>Є незастосовані зміни. Числа відповідають фільтрам в URL.</p>}
      {formError && <p role="alert" className="error">{formError}</p>}{state.filtersError && <p role="status">{state.filtersError}</p>}
    </section>
    <div className="report-status" role="status" aria-live="polite">
      {state.busy && <p>Оновлюємо звіт…</p>}
      {state.statusError && <p className="error">{state.statusError}</p>}
      {needsAttention && <p className="warning">Технічний стан потребує уваги. Подробиці в розділі «Технічний стан».</p>}
      {state.error && <p className="error">{state.error}</p>}
      {state.lastSuccess !== undefined && <p>Останній успішний зріз: {time(state.lastSuccess)}</p>}
      {state.applied && <p>Застосовано: {state.applied.from} — {state.applied.to} UTC · {state.applied.preland_id ?? 'усі преленди'} · {state.applied.offer_id ?? 'усі офери'}</p>}
      {value?.report_status === 'ready' && value.filters.to === utcDay(value.updated_at) && <p>Поточний день UTC ще не завершено.</p>}
      {state.pausedUntil && <p>Пауза доступу до {time(state.pausedUntil)}. Повтор після завершення паузи.</p>}
      {state.stopped && <p>Автооновлення зупинено. Виправте доступ або фільтри та натисніть «Оновити».</p>}
      {value?.report_status === 'unavailable' && <p className="error">{value.reason === 'history_unverified' ? 'Повноту історії не підтверджено. Бізнес-числа недоступні.' : `Період недоступний. Підтверджена історія починається ${value.available_from}. Змініть період явно.`}</p>}
    </div>
    <section id="report-overview" aria-label="Огляд воронки" hidden={section !== 'overview'}>
    {metrics && <div data-testid="report-metrics">
      <section className="report-section"><div className="section-heading"><h2>Квіз</h2><span>Унікальні користувачі</span></div>
        <dl className="stats quiz-stats report-conversions"><div><dt>Входи</dt><dd data-testid="entered">{metrics.quiz.activity.entered}</dd></div><div><dt>Початки квізу</dt><dd>{metrics.quiz.activity.started}</dd></div><div><dt>Завершення квізу</dt><dd data-testid="completed">{metrics.quiz.activity.completed}</dd></div><div className="emphasis"><dt>Початок → завершення</dt><dd><ConversionValue value={metrics.quiz.conversions.started_completed}/></dd></div></dl>
        <p className="report-scroll-hint table-hint">Прокрутіть таблицю вправо, щоб побачити конверсії.</p><div className="report-table table-wrap"><table><caption>Питання: активність і конверсії груп показу</caption><thead><tr><th>Питання</th><th>Побачили</th><th>Підтвердили в періоді</th><th>Показ → підтвердження</th><th>Ще не підтвердили</th></tr></thead><tbody>{reportQuestions.map((q) => <tr key={q}><th scope="row">{reportQuestionLabels[q]}</th><td>{metrics.quiz.activity.questions[q].viewed}</td><td>{metrics.quiz.activity.questions[q].confirmed}</td><td><div className="conversion-cell"><ConversionValue value={metrics.quiz.conversions.questions[q]}/>{metrics.quiz.conversions.questions[q].denominator > 0 && <meter min={0} max={metrics.quiz.conversions.questions[q].denominator} value={metrics.quiz.conversions.questions[q].numerator} aria-label={'Конверсія: ' + reportQuestionLabels[q]}/>}</div></td><td><ConversionValue value={{ numerator: metrics.quiz.conversions.questions[q].denominator - metrics.quiz.conversions.questions[q].numerator, denominator: metrics.quiz.conversions.questions[q].denominator }}/></td></tr>)}</tbody></table></div>
        <p className="section-note">Унікальні користувачі з подією в періоді. Фільтр офера не змінює цей блок.</p><dl className="report-conversions offer-conversions"><div><dt>Початок → будь-який офер</dt><dd><ConversionValue value={metrics.quiz.conversions.started_offer}/></dd></div></dl>
      </section>
      <section className="report-section"><div className="section-heading"><h2>Офери</h2><span>Користувачі та окремі покупки</span></div>
        <dl className="stats offer-stats">{([['transitioned', 'Переходи'], ['bypass', 'Без повторного квізу'], ['leads', 'Lead'], ['buyers', 'Покупці'], ['purchases', 'Покупки']] as const).map(([key, title]) => <div key={key}><dt>{title}</dt><dd data-testid={key}>{metrics.offers.activity[key]}</dd></div>)}</dl>
        <dl className="report-conversions offer-conversions"><div><dt>Перехід → Lead</dt><dd><ConversionValue value={metrics.offers.conversions.transition_lead}/></dd></div><div><dt>Перехід → Purchase</dt><dd><ConversionValue value={metrics.offers.conversions.transition_purchase}/></dd></div></dl>
      </section><details className="methodology"><summary>Як читати ці показники</summary><p>Користувачі рахуються один раз у вибраній групі; покупки — окремі події. Конверсії включають подальші результати групи, також після кінця періоду. Унікальних користувачів між оферами чи прелендами не підсумовуємо.</p></details>
    </div>}
    </section>
    <section id="report-technical" className="technical" aria-label="Технічний стан" hidden={section !== 'technical'}><h2>Технічний стан</h2>{state.status && <>
      <p>Режим імітатора поточного обробника: {state.status.receiver_mode}. Попередні спроби можуть ще завершуватися в іншому режимі.</p>
      <p className="technical-note">Оновлено: {time(state.status.updated_at)}</p>
      <h3 className="technical-heading">Доставка подій</h3>
      <dl className="stats"><div><dt>Очікують</dt><dd>{state.status.delivery.pending}</dd></div><div><dt>У роботі</dt><dd>{state.status.delivery.in_flight}</dd></div><div><dt>Доставлено</dt><dd>{state.status.delivery.delivered}</dd></div></dl>
      <div className="technical-grid"><section><h3>Місткість та цілісність</h3>
      <ul>{state.status.budgets.map((b) => <li key={b.key}>{b.key}: {b.used} / {b.limit}{b.alert === 'critical' ? ' · критично ≥95%' : b.alert === 'warning' ? ' · увага ≥80%' : ''}{b.paused ? ' · призупинено' : ''}</li>)}</ul>
      <p>Цілісність: {state.status.integrity_paused ? 'пауза' : 'без паузи'} · Історія: {state.status.history_unverified ? 'не перевірена' : state.status.history_metadata === 'confirmed' ? 'межа підтверджена' : 'метадані відсутні або некоректні'}</p>
      <p>Причина паузи: {state.status.pause_reason === 'integrity' ? 'порушення цілісності' : state.status.pause_reason === 'capacity' ? 'місткість' : 'немає'}</p>
      </section><section><h3>Фонові процеси</h3>
      <p>Cron: {state.status.cron.status === 'unknown' ? 'ще немає даних' : state.status.cron.status === 'complete' ? 'успішний запуск' : state.status.cron.status === 'running' ? 'у роботі' : 'часткова невдача'}{state.status.cron.stale ? ' · понад 5 хв без свіжого успіху або спроби' : ''}</p>
      <p>Остання спроба Cron: {state.status.cron.last_attempt_at === null ? 'невідомо' : time(state.status.cron.last_attempt_at)} · Успіх: {state.status.cron.last_success_at === null ? 'невідомо' : time(state.status.cron.last_success_at)}</p>
      <p>Останній ACK: {state.status.delivery.last_ack_at === null ? 'ще немає' : time(state.status.delivery.last_ack_at)} · Найстаріша недоставлена: {state.status.delivery.oldest_age_ms === null ? 'немає' : `${Math.floor(state.status.delivery.oldest_age_ms / 60_000)} хв`}{state.status.delivery.delayed ? ' · затримка понад 15 хв' : ''}</p>
      {!!state.status.cron.errors.length && <p className="error">Помилки запуску: {state.status.cron.errors.join(', ')}</p>}
      {!!state.status.delivery.errors.length && <ul>{state.status.delivery.errors.map((e) => <li key={e.code}>{e.code}: {e.count}</li>)}</ul>}
      <p>Очищення: {state.status.cleanup.at === null ? 'ще немає даних' : time(state.status.cleanup.at)}</p>
      {state.status.cleanup.phases && <ul>{Object.entries(state.status.cleanup.phases).map(([name, p]) => <li key={name}>{name}: змінено {p.changed}, пропущено {p.skipped}{p.has_more ? ' · є наступна порція' : ''}{p.error ? ' · помилка очищення' : ''}</li>)}</ul>}
      <p>Щогодинна звірка: {state.status.reconciliation.status} · Спроба: {state.status.reconciliation.attempt_at === null ? 'невідомо' : time(state.status.reconciliation.attempt_at)} · Зріз: {state.status.reconciliation.read_at === null ? 'невідомо' : time(state.status.reconciliation.read_at)}</p>
      {state.status.reconciliation.summary && <ul>{Object.entries(state.status.reconciliation.summary).map(([name, count]) => <li key={name}>{name}: {count === null ? 'невідомо' : count}</li>)}</ul>}
      </section></div><p className="technical-note">Технічний стан охоплює всю базу, незалежно від фільтрів. Звіт нічого не надсилає й не поновлює профіль.</p>
    </>}</section>
  </main><footer className="page-footer">Автооновлення кожні 60 секунд після завершення попередньої спроби, лише у видимій вкладці.</footer>
  </>;
}
