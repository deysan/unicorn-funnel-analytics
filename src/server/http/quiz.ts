import { Hono, type Context } from 'hono';
import { quizResultResponse } from './quiz-result';
import { uuidSchema } from '../../shared/quiz';
import { executeQuizCommand } from '../quiz/commands';
import { readQuizContext } from '../quiz/context';
import { readCommandResult } from '../storage/command-results';
import { body, cookie, createIdentity, HttpFailure, identity, ipKey, keyring, limit, type QuizBindings } from './security';
type Identity = Extract<Awaited<ReturnType<typeof identity>>, {status: 'ready'}>;
type QuizEnv = { Bindings: QuizBindings; Variables: { identity: Awaited<ReturnType<typeof identity>>; limiterBudget: { remaining: number } } };
export const quiz = new Hono<QuizEnv>();
quiz.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  try {
    const budget = { remaining: 1000 }; c.set('limiterBudget', budget);
    await limit(c.env.QUIZ_IP_LIMITER, await ipKey(c.req.raw, c.env), budget);
    const auth = await identity(c.req.raw, c.env.DB); c.set('identity', auth);
    if (auth.status === 'ready') await limit(c.env.QUIZ_USER_LIMITER, auth.userId, budget);
    await next();
  } catch (e) { return failure(c, e); }
});
function failure(c: Context<QuizEnv>, error: unknown) {
  const e = error instanceof HttpFailure ? error : new HttpFailure('temporarily_unavailable', 503, true);
  if (e.retryAfter) c.header('Retry-After', String(e.retryAfter));
  return c.json({ error: { code: e.code, message: messages[e.code] ?? 'Запит не виконано. Оновіть контекст або повторіть спробу.', retryable: e.retryable } }, e.status);
}
const messages: Record<string, string> = {
  identity_lost: 'Доступ до профілю втрачено. Потрібне явне відновлення.',
  rate_limited: 'Забагато запитів. Зачекайте перед повтором.',
  rate_limit_unavailable: 'Перевірка частоти тимчасово недоступна.',
  temporarily_unavailable: 'Сервіс тимчасово недоступний. Повторіть цю саму дію.',
};
function authorized(c: Context<QuizEnv>): Identity {
  const auth = c.get('identity'); const expected = uuidSchema.safeParse(c.req.header('X-Expected-User-ID'));
  if (!expected.success) throw new HttpFailure('validation_failed', 400);
  if (auth.status !== 'ready' || expected.data !== auth.userId) throw new HttpFailure('identity_lost', 401);
  return auth;
}
quiz.get('/context', async (c) => {
  if (c.req.query('preland_id') !== 'demo') throw new HttpFailure('validation_failed', 400);
  const auth = c.get('identity');
  if (auth.status !== 'ready') return c.json({ identity_status: auth.status, server_time: Date.now() });
  const context = await readQuizContext({ db: c.env.DB, userId: auth.userId, secretHash: auth.hash, now: Date.now() });
  const { status, ...rest } = context;
  return c.json({ ...rest, identity_status: status, server_time: Date.now() });
});
for (const restart of [false, true]) quiz.post(restart ? '/identity/restart' : '/identity', async (c) => {
  const input = await body(c.req.raw, c.env); if (Object.keys(input).length) throw new HttpFailure('validation_failed', 400);
  const auth = c.get('identity');
  if (auth.status === 'ready') {
    if (restart) throw new HttpFailure('identity_already_ready', 409);
    return c.json({ user_id: auth.userId }, 200);
  }
  if (!restart && auth.status === 'invalid') throw new HttpFailure('identity_lost', 401);
  await limit(c.env.BOOTSTRAP_LIMITER, await ipKey(c.req.raw, c.env), c.get('limiterBudget'));
  const created = await createIdentity(c.env.DB);
  c.header('Set-Cookie', cookie(created.token, created.now));
  return c.json({ user_id: created.userId }, 201);
});
quiz.get('/operations/:operation_id', async (c) => {
  const auth = authorized(c); const op = uuidSchema.safeParse(c.req.param('operation_id'));
  if (!op.success) throw new HttpFailure('validation_failed', 400);
  const outcome = await readCommandResult(c.env.DB, { userId: auth.userId, operationId: op.data }, Date.now());
  if (outcome.status === 'not_found') throw new HttpFailure('operation_not_found', 404);
  if (outcome.status === 'expired') throw new HttpFailure('operation_expired', 410);
  return c.json(outcome.result);
});
const routes = { entries: 'entry', 'question-views': 'question_view', answers: 'answer', 'email-confirmations': 'email_confirmation', 'offer-selections': 'offer_selection' } as const;
for (const [route, type] of Object.entries(routes)) quiz.post('/' + route, async (c) => {
  const auth = authorized(c); const input = await body(c.req.raw, c.env);
  if ('type' in input || input.preland_id !== 'demo') throw new HttpFailure('validation_failed', 400);
  for (const field of ['operation_id', 'event_id', 'entry_event_id', 'view_event_id', 'completion_operation_id']) {
    if (field in input) { const id = uuidSchema.safeParse(input[field]); if (!id.success) throw new HttpFailure('validation_failed', 400); input[field] = id.data; }
  }
  let committedActivity: number | undefined;
  const outcome = await executeQuizCommand({ db: c.env.DB, userId: auth.userId, secretHash: auth.hash, keys: await keyring(c.env),
    input: { ...input, type }, now: Date.now, onCommit: (activity) => { committedActivity = activity; } });
  if (outcome.status === 'found') {
    if (committedActivity !== undefined) c.header('Set-Cookie', cookie(auth.token, committedActivity));
    return quizResultResponse(c, outcome.result);
  }
  if (outcome.status === 'expired') throw new HttpFailure('operation_expired', 410);
  if (outcome.status === 'conflict') throw new HttpFailure('operation_conflict', 409);
  const reasons = { access: ['identity_lost', 401], reference: ['reference_unavailable', 409], integrity: ['integrity_paused', 503], capacity: ['capacity_exceeded', 503], temporary: ['temporarily_unavailable', 503], step_not_ready: ['step_not_ready', 409], selection_not_ready: ['selection_not_ready', 409], validation: ['validation_failed', 400] } as const;
  const [code, status] = reasons[outcome.reason]; throw new HttpFailure(code, status, status === 503);
});
quiz.all('*', (c) => failure(c, new HttpFailure('not_found', 404)));
quiz.onError((e, c) => failure(c, e));
