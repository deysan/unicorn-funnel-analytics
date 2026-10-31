import { Hono } from 'hono';
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

app.notFound((c) => c.json({
  code: 'not_found', message: 'Маршрут не знайдено.', retryable: false,
}, 404));

export default app;
