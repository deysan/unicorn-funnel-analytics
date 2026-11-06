import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Report } from './Report';
import { Diagnostics } from './Diagnostics';
import { Brand } from './Brand';
import { quizController as controller } from './controller';

function Quiz() {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [value, setValue] = useState(''); const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => controller.start(), []);
  useEffect(() => {
    if (state.kind === 'question') {
      setValue(state.question === 'email' ? state.context?.email ?? '' : state.context?.answers[state.question!] ?? '');
      heading.current?.focus(); controller.rendered(state.token);
    }
  }, [state.token, state.kind, state.question, state.context]);
  const gender = state.context?.answers.preferred_gender;
  const step = state.question === 'preferred_gender' ? 1 : state.question === 'preferred_ethnicity' ? 2 : 3;
  const question = state.question === 'preferred_gender' ? 'Кого ви хочете зустріти?'
    : state.question === 'preferred_ethnicity' ? `З якого регіону ${gender === 'women' ? 'жінки' : 'чоловіки'} вас цікавлять?` : 'Підтвердьте email';
  const choices = state.question === 'preferred_gender' ? [['women', 'Жінки'], ['men', 'Чоловіки']]
    : [['asia', 'Азія'], ['europe', 'Європа'], ['latam', 'Латинська Америка']];
  return <><Brand/><main className="quiz-shell">
    <aside className="quiz-aside">
      <p className="aside-title">Ваші вподобання.<br/>Ваша пропозиція.</p>
      <p className="aside-copy">Оберіть, кого хочете зустріти. Ми підберемо пропозицію за вашими відповідями.</p>
      {state.kind === 'question' && <ol className="steps">{['Вподобання', 'Регіон', 'Email'].map((name, i) =>
        <li key={name} className={step === i + 1 ? 'current' : i + 1 < step ? 'done' : ''} aria-current={step === i + 1 ? 'step' : undefined}>
          <span aria-hidden="true">{i + 1 < step ? '✓' : i + 1}</span>{name}
        </li>)}</ol>}
      <p className="aside-foot">Без розсилок і зовнішніх переходів</p>
    </aside>
    <section className="card quiz-content" aria-busy={state.busy}>
      {state.kind === 'question' && <>
        <div className="step-meta"><span>Крок {step} із 3</span><span>{step === 3 ? 'Останній крок' : 'Ваш вибір'}</span></div>
        <div className="step-track" aria-hidden="true">{[1, 2, 3].map(i => <i className={i <= step ? 'filled' : ''} key={i}/>)}</div>
        <h1 ref={heading} tabIndex={-1}>{question}</h1>
        <p className="question-help">{state.question === 'email' ? 'Підтвердьте адресу, щоб отримати вашу пропозицію. У демо листи не надсилаються.' : 'Оберіть один варіант, щоб продовжити.'}</p>
        <form onSubmit={(event) => { event.preventDefault(); if (state.question === 'email') controller.confirm(value); else controller.answer(value); }}>
          {state.question === 'email' ? <label className="field-label">Email<input name="email" type="email" autoComplete="email" required value={value} onChange={(e) => setValue(e.target.value)} disabled={state.busy || !state.ready}/></label>
            : <fieldset disabled={state.busy || !state.ready}><legend className="sr-only">{question}</legend>{choices.map(([id, label]) => <label className={'option' + (value === id ? ' selected' : '')} key={id}><input type="radio" name="answer" value={id} checked={value === id} onChange={() => setValue(id)}/><span>{label}</span><span className="option-check" aria-hidden="true"/></label>)}</fieldset>}
          <div className="quiz-actions">{state.question !== 'preferred_gender' && <button type="button" className="secondary" disabled={state.busy || !state.ready} onClick={controller.back}>Назад</button>}
            <button type="submit" disabled={!value || !state.ready || state.busy}>{state.busy ? 'Зберігаємо…' : state.question === 'email' ? 'Підтвердити та підібрати' : 'Продовжити'}</button></div>
        </form>
        <p className="privacy-note">Без розсилок і зовнішніх переходів.</p>
      </>}
      {state.kind === 'loading' && <h1>Готуємо наступний крок…</h1>}
      {state.kind === 'stopped' && <h1>Продовжимо після відновлення</h1>}
      {state.kind === 'result' && state.result?.code === 'offer_selected' && <div className="offer-result">
        <p className="result-label">ВАША ПРОПОЗИЦІЯ · {state.result.offer_id}</p><h1>{state.result.offer_name}</h1>
        <p>Пропозицію підібрано. Адреса показана для перегляду; зовнішній сайт не відкривається.</p>
        <dl><dt>URL пропозиції</dt><dd className="url">{state.result.target_url}</dd><dt>ClickID</dt><dd><code>{state.result.click_id}</code></dd></dl>
      </div>}
      {state.kind === 'result' && state.result?.code === 'no_offer' && <><h1>Зараз немає пропозиції</h1><p>Результат збережено. Ви можете явно розпочати нову спробу підбору.</p><button disabled={state.busy || !state.ready} onClick={controller.tryAgain}>Спробувати ще раз</button></>}
      <div className="status" role="status" aria-live="polite">
        {state.kind === 'question' && !state.ready && !state.error && <p>Підтверджуємо показ кроку…</p>}
        {state.error && <p className="error">{state.error}</p>}{state.warning && <p>{state.warning}</p>}
        {state.pausedUntil && <p>Пауза до {new Date(state.pausedUntil).toLocaleTimeString('uk-UA')}. Ключі дії збережено.</p>}
      </div>
      <div className="recovery">
        {state.retry && <button disabled={state.busy || Boolean(state.pausedUntil)} onClick={controller.retry}>Повторити дію</button>}
        {state.refresh && <button disabled={state.busy} onClick={controller.refresh}>Оновити контекст</button>}
        {state.restart && <button disabled={state.busy} onClick={controller.restart}>Відновити доступ</button>}
      </div>
    </section>
  </main><footer className="page-footer">Демо зі збереженням вподобань у цьому браузері. Без розсилок і зовнішніх переходів.</footer></>;
}
export function App() { return /^\/report(?:\/|$)/.test(location.pathname) ? <Report/> : location.pathname === '/diagnostics' ? <Diagnostics/> : <Quiz/>; }
