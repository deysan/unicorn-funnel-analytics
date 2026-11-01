import { readFile } from 'node:fs/promises';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
async function seed(context:BrowserContext,index:number) {
  const profiles=JSON.parse(await readFile('.wrangler/e2e-profiles.json','utf8')) as {id:string;token:string}[];
  const profile=profiles[index];
  await context.addCookies([{name:'__Host-unicorn',value:profile.token,domain:'localhost',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
  return profile;
}
async function answer(page:Page,label:string) {await page.getByLabel(label,{exact:true}).check();await page.getByRole('button',{name:'Продовжити'}).click();}
async function prepare(page:Page) {await page.goto('/');await answer(page,'Жінки');await answer(page,'Азія');await expect(page.getByLabel('Email',{exact:true})).toBeEnabled();}
async function question(page:Page,step:string) {await page.goto('/?step='+step);await expect(page.getByRole('button',{name:'Продовжити'})).toBeEnabled();}
async function state(context:BrowserContext) {const r=await context.request.get('/api/v1/quiz/context?preland_id=demo');expect(r.status()).toBe(200);return r.json();}

test('SC08 різні питання у двох вкладках зберігаються незалежно, офер за серверним станом @concurrency',async({page,context})=>{
  const profile=await seed(context,90);await prepare(page);const other=await context.newPage();
  await question(page,'preferred_gender');await question(other,'preferred_ethnicity');
  await answer(page,'Чоловіки');await expect(page.getByRole('heading',{name:'З якого регіону чоловіки вас цікавлять?'})).toBeVisible();
  await expect(other.getByRole('heading',{name:'З якого регіону жінки вас цікавлять?'})).toBeVisible();
  await answer(other,'Європа');await expect(other.getByLabel('Email',{exact:true})).toBeEnabled();
  expect(await state(context)).toMatchObject({user_id:profile.id,answers:{preferred_gender:'men',preferred_ethnicity:'europe'}});
  await other.getByLabel('Email',{exact:true}).fill('Tabs@example.test');await other.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(other.getByText('ВАША ПРОПОЗИЦІЯ · 005')).toBeVisible();
});

for(const delivery of ['replay','late_first'] as const) test(`SC08 same question ${delivery} uses last committed write @concurrency`,async({page,context})=>{
  await seed(context,delivery==='replay'?91:92);await prepare(page);const other=await context.newPage();
  await question(page,'preferred_ethnicity');await question(other,'preferred_ethnicity');
  let held:Route|undefined;const payloads:string[]=[];
  await page.route('**/answers',async route=>{payloads.push(route.request().postData()!);if(payloads.length>1){await route.continue();return;}
    if(delivery==='replay'){await route.fetch();await route.abort();}else held=route;
  });
  await answer(page,'Європа');
  if(delivery==='replay')await expect(page.getByRole('button',{name:'Повторити дію'})).toBeEnabled();else await expect.poll(()=>Boolean(held)).toBe(true);
  await answer(other,'Латинська Америка');await expect(other.getByLabel('Email',{exact:true})).toBeEnabled();
  expect((await state(context)).answers.preferred_ethnicity).toBe('latam');
  if(delivery==='replay')await page.getByRole('button',{name:'Повторити дію'}).click();else await held!.continue();
  await expect(page.getByLabel('Email',{exact:true})).toBeEnabled();
  expect((await state(context)).answers.preferred_ethnicity).toBe(delivery==='replay'?'latam':'europe');
  if(delivery==='replay'){expect(payloads).toHaveLength(2);expect(payloads[1]).toBe(payloads[0]);}
  await other.reload();await other.getByRole('button',{name:'Назад'}).click();
  await expect(other.getByLabel(delivery==='replay'?'Латинська Америка':'Європа',{exact:true})).toBeChecked();
});

test('Lead через HTTP під час stale Q2: явний refresh дає bypass без нового email @concurrency',async({page,context})=>{
  const profile=await seed(context,93);await prepare(page);
  await page.getByLabel('Email',{exact:true}).fill('LeadTabs@example.test');await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByText('ClickID',{exact:true})).toBeVisible();const click=await page.locator('dd code').innerText();
  const other=await context.newPage();await question(other,'preferred_ethnicity');
  const vars=await readFile('.dev.vars','utf8');const raw=vars.split('\n').find(x=>x.startsWith('PARTNER_TOKENS='))!.slice('PARTNER_TOKENS='.length);
  const token=JSON.parse(raw.startsWith("'")?raw.slice(1,-1):raw)['demo-partner'];
  const lead=await context.request.post('/api/v1/partner/events',{headers:{Authorization:'Bearer '+token},data:{event_type:'Lead',partner_event_id:crypto.randomUUID(),click_id:click,occurred_at:new Date().toISOString()}});
  expect(lead.status()).toBe(200);
  await expect(other.getByLabel('Азія',{exact:true})).toBeChecked();
  let emails=0;other.on('request',r=>{if(r.url().endsWith('/email-confirmations'))emails++;});
  const rejected=other.waitForResponse(r=>r.url().endsWith('/answers'));
  await answer(other,'Європа');expect(await (await rejected).json()).toMatchObject({error:{code:'step_not_ready'}});
  expect(await state(context)).toMatchObject({user_id:profile.id,next_action:'select_offer',answers:{preferred_ethnicity:'asia'}});
  await other.getByRole('button',{name:'Оновити контекст'}).click();
  await expect(other.getByText('ВАША ПРОПОЗИЦІЯ · 003')).toBeVisible();expect(await other.locator('dd code').innerText()).not.toBe(click);expect(emails).toBe(0);
});
