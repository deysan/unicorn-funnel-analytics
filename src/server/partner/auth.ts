import { decodeSecret, HttpFailure } from '../http/security';

export function partnerIdentity(request: Request, configuration: string | undefined): string {
  let entries: [string, Uint8Array<ArrayBuffer>][];
  try {
    const parsed: unknown = JSON.parse(configuration ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) throw new Error();
    entries = Object.entries(parsed).map(([id, token]) => {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/.test(id) || typeof token !== 'string') throw new Error();
      return [id, decodeSecret(token)];
    });
    // An ambiguous token must never authorize whichever entry happens to be first.
    if (new Set(Object.values(parsed)).size !== entries.length) throw new Error();
  } catch { throw new HttpFailure('temporarily_unavailable', 503, true); }
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{43})(?![\s\S])/i.exec(header);
  let supplied: Uint8Array<ArrayBuffer>;
  try { supplied = decodeSecret(match?.[1]); } catch { throw new HttpFailure('unauthorized', 401); }
  let identity: string | undefined;
  for (const [id, token] of entries) if (crypto.subtle.timingSafeEqual(supplied, token)) identity = id;
  if (!identity) throw new HttpFailure('unauthorized', 401);
  return identity;
}
