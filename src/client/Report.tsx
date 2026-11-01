import { useEffect, useState, useSyncExternalStore } from 'react';
import { formatConversion, parseReportQuery, queryString, reportQuestionLabels, reportQuestions, utcDay, type Conversion } from '../shared/report';
import { ReportController } from './report-controller';
const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
function ConversionValue({ value }: { value: Conversion }) { return <><strong>{formatConversion(value)}</strong><small>{value.numerator} / {value.denominator} користувачів</small></>; }
export function Report() {
  const [controller] = useState(() => new ReportController());
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [draft, setDraft] = useState({ from: '', to: '', preland_id: '', offer_id: '' });
  const [formError, setFormError] = useState<string>();
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
  return <main className="report">
    <header className="report-header"><div><p className="eyebrow">UNICORN · ЗАКРИТИЙ ЗВІТ</p><h1>Воронка та результати</h1><p>Активність за UTC-дні й результати груп користувачів станом на зріз.</p></div><button disabled={state.busy || Boolean(state.pausedUntil && state.pausedUntil > Date.now())} onClick={controller.refresh}>Оновити</button></header>
    <section className="card report-filters" aria-label="Фільтри звіту">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label>Від (UTC)<input type="date" required value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })}/></label>
        <label>До (UTC)<input type="date" required value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })}/></label>
        <label>Преленд<select value={draft.preland_id} onChange={(e) => setDraft({ ...draft, preland_id: e.target.value })}><option value="">Усі преленди</option>{[...prelands].sort().map((id) => <option key={id} value={id}>{id}{!state.filters?.prelands.includes(id) ? ' · вибраний ID' : ''}</option>)}</select></label>
        <label>Офер<select value={draft.offer_id} onChange={(e) => setDraft({ ...draft, offer_id: e.target.value })}><option value="">Усі офери</option>{offers.sort((a, b) => a.id.localeCompare(b.id)).map((o) => <option key={o.id} value={o.id}>{o.id}{o.name ? ' · ' + o.name : ''}{o.status === 'inactive' ? ' · неактивний' : o.status === 'historical' ? ' · історичний / вибраний ID' : ''}</option>)}</select></label>
        <button type="submit">Застосувати</button><button className="secondary" type="button" onClick={controller.reset}>Скинути фільтри</button>
      </form>
      {dirty && <p>Є незастосовані зміни. Числа відповідають фільтрам в URL.</p>}
      {formError && <p role="alert" className="error">{formError}</p>}{state.filtersError && <p role="status">{state.filtersError}</p>}
    </section>
    <div className="report-status" role="status" aria-live="polite">
      {state.busy && <p>Оновлюємо звіт…</p>}
      {state.error && <p className="error">{state.error}</p>}
      {state.lastSuccess !== undefined && <p>Останній успішний зріз: {time(state.lastSuccess)}</p>}
      {state.applied && <p>Застосовано: {state.applied.from} — {state.applied.to} UTC · {state.applied.preland_id ?? 'усі преленди'} · {state.applied.offer_id ?? 'усі офери'}</p>}
      {value?.report_status === 'ready' && value.filters.to === utcDay(value.updated_at) && <p>Поточний день UTC ще не завершено.</p>}
      {state.pausedUntil && <p>Пауза доступу до {time(state.pausedUntil)}. Повтор після завершення паузи.</p>}
      {state.stopped && <p>Автооновлення зупинено. Виправте доступ або фільтри та натисніть «Оновити».</p>}
      {value?.report_status === 'unavailable' && <p className="error">{value.reason === 'history_unverified' ? 'Повноту історії не підтверджено. Бізнес-числа недоступні.' : `Період недоступний. Підтверджена історія починається ${value.available_from}. Змініть період явно.`}</p>}
    </div>
    {metrics && <div data-testid="report-metrics">
      <section className="card report-section"><h2>Квіз</h2><p>Унікальні користувачі з подією в періоді. Фільтр офера не змінює цей блок.</p>
        <dl className="report-metrics"><div><dt>Входи</dt><dd data-testid="entered">{metrics.quiz.activity.entered}</dd></div><div><dt>Початки квізу</dt><dd>{metrics.quiz.activity.started}</dd></div><div><dt>Завершення квізу</dt><dd data-testid="completed">{metrics.quiz.activity.completed}</dd></div></dl>
        <p className="report-scroll-hint">Прокрутіть таблицю вправо, щоб побачити конверсії.</p><div className="report-table"><table><caption>Питання: активність і конверсії груп показу</caption><thead><tr><th>Питання</th><th>Побачили</th><th>Підтвердили в періоді</th><th>Показ → підтвердження</th><th>Ще не підтвердили</th></tr></thead><tbody>{reportQuestions.map((q) => <tr key={q}><th scope="row">{reportQuestionLabels[q]}</th><td>{metrics.quiz.activity.questions[q].viewed}</td><td>{metrics.quiz.activity.questions[q].confirmed}</td><td><ConversionValue value={metrics.quiz.conversions.questions[q]}/></td><td><ConversionValue value={{ numerator: metrics.quiz.conversions.questions[q].denominator - metrics.quiz.conversions.questions[q].numerator, denominator: metrics.quiz.conversions.questions[q].denominator }}/></td></tr>)}</tbody></table></div>
        <dl className="report-conversions"><div><dt>Початок → завершення</dt><dd><ConversionValue value={metrics.quiz.conversions.started_completed}/></dd></div><div><dt>Початок → будь-який офер</dt><dd><ConversionValue value={metrics.quiz.conversions.started_offer}/></dd></div></dl>
      </section>
      <section className="card report-section"><h2>Офери</h2><p>Користувачі рахуються один раз у вибраній групі; покупки — окремі події.</p>
        <dl className="report-metrics">{([['transitioned', 'Переходи'], ['bypass', 'Без повторного квізу'], ['leads', 'Lead'], ['buyers', 'Покупці'], ['purchases', 'Покупки']] as const).map(([key, title]) => <div key={key}><dt>{title}</dt><dd data-testid={key}>{metrics.offers.activity[key]}</dd></div>)}</dl>
        <dl className="report-conversions"><div><dt>Перехід → Lead</dt><dd><ConversionValue value={metrics.offers.conversions.transition_lead}/></dd></div><div><dt>Перехід → Purchase</dt><dd><ConversionValue value={metrics.offers.conversions.transition_purchase}/></dd></div></dl>
      </section><p>Конверсії включають подальші результати групи, також після кінця періоду. Унікальних користувачів між оферами чи прелендами не підсумовуємо.</p>
    </div>}
    <section className="card report-section"><h2>Технічний стан</h2>{state.statusError && <p className="error">{state.statusError}</p>}{state.status && <>
      <p>Оновлено: {time(state.status.updated_at)}</p><p>Доставка: очікують {state.status.delivery.pending} · у роботі {state.status.delivery.in_flight} · доставлено {state.status.delivery.delivered}</p>
      <ul>{state.status.budgets.map((b) => <li key={b.key}>{b.key}: {b.used} / {b.limit}{b.paused ? ' · призупинено' : ''}</li>)}</ul>
      <p>Цілісність: {state.status.integrity_paused ? 'пауза' : 'без паузи'} · Історія: {state.status.history_unverified ? 'не перевірена' : state.status.history_metadata === 'confirmed' ? 'межа підтверджена' : 'метадані відсутні або некоректні'}</p>
      <p>Cron та експорт ще не реалізовані. Звіт нічого не надсилає й не поновлює профіль.</p>
    </>}</section>
    <footer>Автооновлення кожні 60 секунд після завершення попередньої спроби, лише у видимій вкладці.</footer>
  </main>;
}
