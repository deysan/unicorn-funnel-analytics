import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Report } from './Report';
import { Diagnostics } from './Diagnostics';
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
  const question = state.question === 'preferred_gender' ? 'Кого ви хочете зустріти?'
    : state.question === 'preferred_ethnicity' ? `З якого регіону ${gender === 'women' ? 'жінки' : 'чоловіки'} вас цікавлять?` : 'Підтвердьте email';
  const choices = state.question === 'preferred_gender' ? [['women', 'Жінки'], ['men', 'Чоловіки']]
    : [['asia', 'Азія'], ['europe', 'Європа'], ['latam', 'Латинська Америка']];
  return <main className="quiz">
    <header className="brand"><span className="mark" aria-hidden="true">u.</span><span>UNICORN<span className="brand-note">Знайомства починаються з вибору</span></span></header>
    <section className="card" aria-busy={state.busy}>
      {state.kind === 'question' && <>
        <p className="eyebrow">ВАШІ ВПОДОБАННЯ · КРОК {state.question === 'preferred_gender' ? '1' : state.question === 'preferred_ethnicity' ? '2' : '3'} З 3</p>
        <div className="progress" aria-hidden="true"><i style={{width: state.question === 'preferred_gender' ? '33%' : state.question === 'preferred_ethnicity' ? '66%' : '100%'}} /></div>
        <h1 ref={heading} tabIndex={-1}>{question}</h1>
        <p className="intro">{state.question === 'email' ? 'Підтвердьте адресу, щоб отримати вашу пропозицію. У демо листи не надсилаються.' : 'Оберіть один варіант — ми підберемо пропозицію за вашими вподобаннями.'}</p>
        <form onSubmit={(event) => { event.preventDefault(); if (state.question === 'email') controller.confirm(value); else controller.answer(value); }}>
          {state.question === 'email' ? <label className="email-label">Email<input name="email" type="email" autoComplete="email" required value={value} onChange={(e) => setValue(e.target.value)} disabled={state.busy || !state.ready}/></label>
            : <fieldset disabled={state.busy || !state.ready}><legend className="sr-only">{question}</legend>{choices.map(([id, label]) => <label className={'choice' + (value === id ? ' selected' : '')} key={id}><input type="radio" name="answer" value={id} checked={value === id} onChange={() => setValue(id)}/><span>{label}</span><span className="choice-dot" aria-hidden="true"/></label>)}</fieldset>}
          <div className="actions">{state.question !== 'preferred_gender' && <button type="button" className="secondary" disabled={state.busy || !state.ready} onClick={controller.back}>Назад</button>}
            <button type="submit" disabled={!value || !state.ready || state.busy}>{state.busy ? 'Зберігаємо…' : state.question === 'email' ? 'Підтвердити та підібрати' : 'Продовжити'} <span aria-hidden="true">→</span></button></div>
        </form>
      </>}
      {state.kind === 'loading' && <><p className="eyebrow">ВАШ ПЕРСОНАЛЬНИЙ ВИБІР</p><h1>Готуємо наступний крок…</h1></>}
      {state.kind === 'stopped' && <><p className="eyebrow">ПОТРІБНА ВАША ДІЯ</p><h1>Продовжимо після відновлення</h1></>}
      {state.kind === 'result' && state.result?.code === 'offer_selected' && <>
        <p className="eyebrow">ВАША ПРОПОЗИЦІЯ · {state.result.offer_id}</p><h1>{state.result.offer_name}</h1>
        <p className="intro">Пропозицію підібрано. Адреса показана для перегляду; зовнішній сайт не відкривається.</p>
        <dl><dt>URL пропозиції</dt><dd className="url">{state.result.target_url}</dd><dt>ClickID</dt><dd><code>{state.result.click_id}</code></dd></dl>
      </>}
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
    <footer>Демо зі збереженням вподобань у цьому браузері. Без розсилок і зовнішніх переходів.</footer>
  </main>;
}
export function App() { return /^\/report(?:\/|$)/.test(location.pathname) ? <Report/> : location.pathname === '/diagnostics' ? <Diagnostics/> : <Quiz/>; }
