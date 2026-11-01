import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { partner, type PartnerBindings } from '../../src/server/http/partner';
import { encodeSecret } from '../../src/server/http/security';
import { db, freshBusinessDb, userStatement, eventStatement, clickStatement, id } from './helpers/business-db';
const token=encodeSecret(new Uint8Array(32).fill(7));const otherToken=encodeSecret(new Uint8Array(32).fill(8));
const allow={limit:async()=>({success:true})} as RateLimit;
const bindings:PartnerBindings={...env,PARTNER_TOKENS:JSON.stringify({'demo-partner':token,'retired-partner':otherToken}),IP_HMAC_SECRET:token,PARTNER_IP_LIMITER:allow,PARTNER_ID_LIMITER:allow};
const input={event_type:'Lead',partner_event_id:'lead',click_id:id(3),occurred_at:new Date().toISOString()};
const request=(options:{input?:unknown;body?:BodyInit;headers?:Record<string,string>;env?:PartnerBindings;url?:string}={})=>partner.request(options.url??'https://localhost:5173/events',{
  method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...options.headers},body:options.body??JSON.stringify(options.input??input),
},options.env??bindings);
async function state(){return Promise.all(['partner_events','events','event_delivery','users','user_offer_leads','capacity_control'].map(async t=>(await db.prepare(`SELECT * FROM ${t}`).all()).results));}
beforeEach(async()=>{await freshBusinessDb();await db.batch([userStatement(),eventStatement(id(2)),clickStatement(id(3),id(2))]);await db.prepare('UPDATE clicks SET created_at=?').bind(Date.now()).run();});
it('HTTP ACK is identical for new/replay, no Origin or cookie required, no cookie/activity renewal',async()=>{
  const first=await request();expect(first.status).toBe(200);expect(await first.json()).toEqual({status:'accepted'});expect(first.headers.get('cache-control')).toBe('no-store');expect(first.headers.has('set-cookie')).toBe(false);
  const before=await state();const repeated=await request();expect(repeated.status).toBe(200);expect(await repeated.json()).toEqual({status:'accepted'});expect(await state()).toEqual(before);
});
it('current auth is required even for replay; body/cookie/Basic are never substitutes',async()=>{
  await request();const before=await state();
  for(const authorization of ['',`Basic ${token}`,`Bearer ${otherToken}`,`Bearer ${'a'.repeat(43)}`]){
    const response=await request({headers:{Authorization:authorization,Cookie:`__Host-unicorn=${token}`}});expect(response.status).toBe(authorization===`Bearer ${otherToken}`?422:401);
  }
  expect((await request({env:{...bindings,PARTNER_TOKENS:JSON.stringify({'retired-partner':otherToken})}})).status).toBe(401);
  expect((await request({url:'http://localhost:5173/events'})).status).toBe(401);expect(await state()).toEqual(before);
});
it('malformed or ambiguous partner config fails closed before writes',async()=>{
  const before=await state();
  for(const value of [undefined,'{','null','[]','{}',JSON.stringify({'bad\n':token}),JSON.stringify({'demo-partner':3}),JSON.stringify({'demo-partner':'bad'}),JSON.stringify({'demo-partner':token,other:token})]){
    const response=await request({env:{...bindings,PARTNER_TOKENS:value}});expect(response.status).toBe(503);expect(await response.text()).not.toContain(token);
  }expect(await state()).toEqual(before);
});
it('strict DTO/body bytes/media/UTF8 failures preserve all business rows',async()=>{
  const before=await state();
  for(const [body,headers,status] of [
    ['{',{},400],['null',{},400],['[]',{},400],[JSON.stringify({...input,email:'Synthetic@example.test'}),{},400],
    [JSON.stringify({...input,received_at:0}),{},400],[JSON.stringify({...input,partner_id:'demo-partner'}),{},400],
    [JSON.stringify({...input,padding:'я'.repeat(4100)}),{'Content-Length':'1'},413],
    [JSON.stringify(input),{'Content-Encoding':'gzip'},415],[JSON.stringify(input),{'Content-Type':'text/plain'},415],
    [new Uint8Array([0xff,0x7b,0x7d]),{},400],
  ] as [BodyInit,Record<string,string>,number][]){const response=await request({body,headers});expect(response.status).toBe(status);expect(response.headers.get('cache-control')).toBe('no-store');}
  expect(await state()).toEqual(before);
  const bytes=new TextEncoder().encode(JSON.stringify(input)+' '.repeat(8192-new TextEncoder().encode(JSON.stringify(input)).length));
  expect((await request({body:bytes})).status).toBe(200);
  expect((await state())[4]).not.toEqual(before[4]);
});
it('conflict is 409 before click lookup; foreign/missing new click 422; SQL errors are safe 503',async()=>{
  await request();const before=await state();const conflict=await request({input:{...input,click_id:id(999)}});expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({error:{code:'postback_conflict',retryable:false}});
  const missing=await request({input:{...input,partner_event_id:'missing',click_id:id(999)}});expect(missing.status).toBe(422);expect(await missing.json()).toMatchObject({error:{code:'click_unavailable',retryable:false}});
  const broken=new Proxy(db,{get(){return()=>{throw new Error('private SQL secret');};}});const failed=await request({env:{...bindings,DB:broken}});expect(failed.status).toBe(503);expect(await failed.text()).not.toMatch(/SQL|secret/);expect(await state()).toEqual(before);
});
for(const stage of ['ip','partner'] as const)for(const refusal of ['deny','throw'] as const)it(`separate ${stage} limiter ${refusal} leaves no business records`,async()=>{
  const before=await state();const ip={limit:vi.fn(async()=>({success:true}))};const account={limit:vi.fn(async()=>({success:true}))};
  const failing={limit:vi.fn(async()=>{if(refusal==='throw')throw new Error('private');return{success:false};})};
  const response=await request({env:{...bindings,PARTNER_IP_LIMITER:stage==='ip'?failing:ip,PARTNER_ID_LIMITER:stage==='partner'?failing:account}});
  expect(response.status).toBe(refusal==='deny'?429:503);expect(response.headers.get('retry-after')).toBe(refusal==='deny'?'60':'30');
  if(stage==='ip')expect(account.limit).not.toHaveBeenCalled();else expect(failing.limit).toHaveBeenCalledWith({key:'demo-partner'});
  expect(await state()).toEqual(before);
});
it('IP limiter runs before auth, partner limiter after auth and never keyed by token; nonlocal fails closed',async()=>{
  const ip={limit:vi.fn(async()=>({success:true}))};const account={limit:vi.fn(async()=>({success:true}))};
  const custom={...bindings,PARTNER_IP_LIMITER:ip,PARTNER_ID_LIMITER:account};
  expect((await request({headers:{Authorization:''},env:custom})).status).toBe(401);expect(ip.limit).toHaveBeenCalledOnce();expect(account.limit).not.toHaveBeenCalled();
  expect((await request({env:custom})).status).toBe(200);expect(account.limit).toHaveBeenCalledWith({key:'demo-partner'});expect(ip.limit.mock.calls).not.toContainEqual([{key:token}]);
  expect((await request({url:'https://demo.example.test/events'})).status).toBe(503);
});
it('total IP+partner limiter wait is bounded; late success cannot write',async()=>{
  vi.useFakeTimers();try{
    const slow={limit:()=>new Promise(resolve=>setTimeout(()=>resolve({success:true}),600))} as RateLimit;
    const pending=request({env:{...bindings,PARTNER_IP_LIMITER:slow,PARTNER_ID_LIMITER:slow}});
    await vi.advanceTimersByTimeAsync(1200);const response=await pending;expect(response.status).toBe(503);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM partner_events').first('n')).toBe(0);
  }finally{vi.useRealTimers();}
});
