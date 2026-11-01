import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { prepare, send, retryDelay } from '../../scripts/partner-cli';
const files:string[]=[];
const input={event_type:'Purchase',partner_event_id:'stable-id',click_id:'00000000-0000-4000-8000-000000000001',occurred_at:'2026-10-31T12:00:00Z',amount_minor:100,currency:'USD'};
const token=Buffer.alloc(32,7).toString('base64url');
async function file(){const name=randomUUID()+'.json';files.push(name);await prepare(name,input);return name;}
afterEach(async()=>{await Promise.all(files.splice(0).map(name=>rm('.wrangler/partner-events/'+name,{force:true})));});
it('prepare exclusively creates normalized files without secret; send/retry uses identical original bytes',async()=>{
  const name=await file();const path='.wrangler/partner-events/'+name;const original=await readFile(path,'utf8');expect(original).not.toContain(token);
  expect(JSON.parse(original)).toEqual({...input,occurred_at:'2026-10-31T12:00:00.000Z'});await expect(prepare(name,{...input,partner_event_id:'new'})).rejects.toThrow();
  const requests:RequestInit[]=[];const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{requests.push(init!);return new Response(JSON.stringify(requests.length===1?{error:{code:'rate_limited'}}:{status:'accepted'}),{status:requests.length===1?429:200,headers:{'Retry-After':'2'}});});
  const wait=vi.fn(async()=>{});await send(name,'https://localhost:5173',token,{fetch:fetch as typeof globalThis.fetch,sleep:wait,random:()=>0.5,now:()=>0});
  expect(wait).toHaveBeenCalledWith(2100);expect(requests).toHaveLength(2);
  for(const request of requests){expect(Buffer.from(request.body as Uint8Array).toString()).toBe(original);expect(request.redirect).toBe('error');expect(request.signal).toBeInstanceOf(AbortSignal);}
  expect(await readFile(path,'utf8')).toBe(original);
});
it('only known limiter errors retry, with a maximum of three automatic retries',async()=>{
  const name=await file();const wait=vi.fn(async()=>{});
  const fetch=vi.fn(async()=>new Response(JSON.stringify({error:{code:'rate_limit_unavailable'}}),{status:503}));
  await expect(send(name,'https://localhost:5173',token,{fetch,sleep:wait,random:()=>0,now:()=>0})).rejects.toThrow('rate_limit_unavailable');
  expect(fetch).toHaveBeenCalledTimes(4);expect(wait).toHaveBeenCalledTimes(3);expect(wait).toHaveBeenCalledWith(30000);
  for(const [status,code] of [[409,'postback_conflict'],[503,'temporarily_unavailable'],[503,'capacity_exceeded'],[401,'unauthorized'],[429,'unknown']] as const){
    const once=vi.fn(async()=>new Response(JSON.stringify({error:{code}}),{status}));await expect(send(name,'https://localhost:5173',token,{fetch:once,sleep:wait,random:()=>0,now:()=>0})).rejects.toThrow();expect(once).toHaveBeenCalledOnce();
  }
});
it('network/redirect/timeout failures require explicit resend; no raw secret or cause',async()=>{
  const name=await file();const fetch=vi.fn(async()=>{throw new Error(token);});await expect(send(name,'https://localhost:5173',token,{fetch,sleep:async()=>{},random:()=>0,now:()=>0})).rejects.toThrow('network_or_response_failure_repeat_same_file');expect(fetch).toHaveBeenCalledOnce();
});
it('refuses HTTP, URL credentials/query and absent token before sending',async()=>{
  const name=await file();
  for(const target of ['http://localhost:5173','https://user:pass@example.test','https://example.test/?secret=x','https://example.test/#x','https://example.test/api'])await expect(send(name,target,token)).rejects.toThrow('invalid_target');
  await expect(send(name,'https://localhost:5173',undefined)).rejects.toThrow('partner_token_required');
  await expect(prepare('../escape.json',input)).rejects.toThrow('invalid_file_name');
});
it('retry delay respects valid Retry-After/date and fallback with jitter',()=>{
  expect(retryDelay(null,60,0,0)).toBe(60000);expect(retryDelay('bad',30,0,1)).toBe(33000);expect(retryDelay('2',60,0,1)).toBe(2200);expect(retryDelay('Thu, 01 Jan 1970 00:00:02 GMT',60,0,0)).toBe(2000);
});
