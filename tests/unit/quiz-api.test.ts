import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiFailure } from '../../src/client/api';
afterEach(() => vi.unstubAllGlobals());
for (const value of [null, [], {}, {error:null}, {error:{code:'identity_lost'}}, {error:{code:'identity_lost',message:'lost',retryable:'false'}}, {error:{code:3,message:'lost',retryable:false}}]) {
  it(`malformed error retains recoverable classification: ${JSON.stringify(value)}`, async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(value, {status:503})));
    await expect(api('/email-confirmations','user',{})).rejects.toMatchObject({code:'network'});
  });
}
it('HTML response remains recoverable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>unavailable</html>', {status:502})));
  await expect(api('/context')).rejects.toBeInstanceOf(ApiFailure);
  await expect(api('/context')).rejects.toMatchObject({code:'network'});
});
for (const code of ['identity_lost','rate_limited','operation_not_found']) {
  it(`valid error keeps ${code} and Retry-After`, async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({error:{code,message:'Повідомлення',retryable:false}}, {status:429,headers:{'Retry-After':'60'}})));
    await expect(api('/context')).rejects.toMatchObject({code,message:'Повідомлення',retryAfter:60});
  });
}
