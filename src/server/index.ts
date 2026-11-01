import { Hono } from 'hono';
import { runMaintenance } from './maintenance/coordinator';
import { report } from './http/report';
import { partner } from './http/partner';
import { quiz } from './http/quiz';
import { healthSchema } from '../shared/health';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

// Технічний маршрут каркаса M0; не читає бізнес-дані.
app.get('/api/v1/health', async (c) => {
  try {
    const row = await c.env.DB.prepare('SELECT 1 AS value').first<{ value: number }>();
    const result = healthSchema.parse({ status: 'ok', database: 'ok', value: row?.value });
    return c.json(result);
  } catch {
    return c.json({
      code: 'database_unavailable',
      message: 'Локальна база даних недоступна. Спробуйте ще раз.',
      retryable: true,
    }, 503);
  }
});

app.route('/api/v1/quiz', quiz);
app.route('/api/v1/partner', partner);

app.use('/api/v1/report/*', async (c) => report.fetch(c.req.raw, c.env));
app.use('/report', async (c) => report.fetch(c.req.raw, c.env));
app.use('/report/*', async (c) => report.fetch(c.req.raw, c.env));

app.notFound((c) => c.json({
  code: 'not_found', message: 'Маршрут не знайдено.', retryable: false,
}, 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const result = await runMaintenance({ db: env.DB, mode: env.MOCK_RECEIVER_MODE });
    const summary = JSON.stringify({ code: 'maintenance_run', delivery: result.delivery, hourly: result.hourly, cleanup: result.cleanup, errors: result.errors });
    if (result.errors.length) console.warn(summary); else console.info(summary);
  },
};
