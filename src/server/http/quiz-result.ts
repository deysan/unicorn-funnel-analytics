import type { Context } from 'hono';
import type { CommandResult } from '../storage/command-results';

// The public demo uses JSON. The redirect representation is exercised in-process
// against an actual committed B, without registering a route that leaves the demo.
export function quizResultResponse(c: Context, result: CommandResult, representation: 'demo' | 'redirect' = 'demo'): Response {
  c.header('Cache-Control', 'no-store');
  if (representation === 'redirect' && result.code === 'offer_selected') {
    return c.redirect(result.target_url, 303);
  }
  return c.json(result);
}
