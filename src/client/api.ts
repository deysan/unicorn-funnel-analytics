import { contextSchema, identityResponseSchema, quizResultSchema, type ApiError } from '../shared/quiz';
export class ApiFailure extends Error {
  constructor(public code: string, message: string, public retryAfter = 0) { super(message); }
}
export async function api<T>(path: string, user?: string, payload?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/v1/quiz' + path, { method: payload === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10_000),
      headers: { ...(user ? { 'X-Expected-User-ID': user } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  } catch { throw new ApiFailure('network', 'Немає відповіді. Повторіть дію вручну — її ключі збережено.'); }
  let value: unknown; try { value = await response.json(); } catch { throw new ApiFailure('network', 'Не вдалося прочитати відповідь. Повторіть дію.'); }
  if (!response.ok) { const error = (value as ApiError).error;
    throw new ApiFailure(error?.code ?? 'unknown', error?.message ?? 'Запит не виконано.', Number(response.headers.get('Retry-After') ?? 0)); }
  const schema = path.startsWith('/context') ? contextSchema : path.startsWith('/identity') ? identityResponseSchema : quizResultSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiFailure('network', 'Відповідь не відповідає контракту. Повторіть дію.');
  if ('code' in parsed.data && parsed.data.code === 'offer_selected') {
    const result = parsed.data;
    try { const url = new URL(result.target_url); if (url.protocol !== 'https:' || url.username || url.password || url.searchParams.getAll('click_id').length !== 1 || url.searchParams.get('click_id') !== result.click_id) throw new Error(); }
    catch { throw new ApiFailure('network', 'Некоректна адреса результату. Повторіть читання.'); }
  }
  return parsed.data as T;
}
