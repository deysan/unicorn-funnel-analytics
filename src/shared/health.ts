import { z } from 'zod';

export const healthSchema = z.strictObject({
  status: z.literal('ok'),
  database: z.literal('ok'),
  value: z.literal(1),
});

export type Health = z.infer<typeof healthSchema>;
