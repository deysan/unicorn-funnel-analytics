import { useState } from 'react';
import { healthSchema, type Health } from '../shared/health';

type CheckState =
  | { status: 'idle' | 'loading' | 'error' }
  | { status: 'success'; result: Health };

export function App() {
  const [state, setState] = useState<CheckState>({ status: 'idle' });

  async function checkConnection() {
    setState({ status: 'loading' });
    try {
      const response = await fetch('/api/v1/health', {
        cache: 'no-store', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Перевірка неуспішна.');
      const result = healthSchema.parse(await response.json());
      setState({ status: 'success', result });
    } catch {
      setState({ status: 'error' });
    }
  }

  return (
    <main>
      <p className="eyebrow">UNICORN / M0</p>
      <h1>Локальне середовище</h1>
      <p>Перевірка зв’язку між інтерфейсом, Worker та локальною D1.</p>
      <div className="flow" aria-label="Шлях запиту">UI <span>→</span> Worker <span>→</span> D1</div>
      <button disabled={state.status === 'loading'} onClick={() => void checkConnection()}>
        {state.status === 'loading' ? 'Перевіряємо…' : 'Перевірити з’єднання'}
      </button>
      <div className="result" role="status" aria-live="polite">
        {state.status === 'idle' && <p>Натисніть кнопку, щоб виконати запит.</p>}
        {state.status === 'loading' && <p>Очікуємо відповідь Worker і D1…</p>}
        {state.status === 'success' && <p className="success">З’єднання працює. D1 повернула: {state.result.value}.</p>}
        {state.status === 'error' && <p className="error">Не вдалося перевірити з’єднання. Спробуйте ще раз.</p>}
      </div>
      <footer>Технічний каркас · локальна база · бізнес-сценарії ще не реалізовані</footer>
    </main>
  );
}
