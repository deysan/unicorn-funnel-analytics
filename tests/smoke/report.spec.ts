import { test, expect } from './fixtures';
import { reportCredentials } from './report-helpers';
import type { Page } from '@playwright/test';
const day='2026-10-31';const now=Date.parse(day+'T12:00:00Z');
function funnel(offer?:string) {return {report_status:'ready',updated_at:now,available_from:day,filters:{from:day,to:day,...(offer?{offer_id:offer}:{})},metrics:{
  quiz:{activity:{entered:5,started:5,completed:4,questions:{preferred_gender:{viewed:3,confirmed:1},preferred_ethnicity:{viewed:4,confirmed:3},email:{viewed:5,confirmed:4}}},conversions:{questions:{preferred_gender:{numerator:1,denominator:3},preferred_ethnicity:{numerator:3,denominator:4},email:{numerator:4,denominator:5}},started_completed:{numerator:4,denominator:5},started_offer:{numerator:2,denominator:5}}},
  offers:{activity:{transitioned:5,bypass:0,leads:3,buyers:1,purchases:offer==='999'?9:2},conversions:{transition_lead:{numerator:3,denominator:5},transition_purchase:{numerator:1,denominator:5}}},
}};}
const status={updated_at:now,receiver_mode:'normal',delivery:{pending:0,in_flight:0,delivered:0,oldest_age_ms:null,delayed:false,last_ack_at:null,errors:[]},budgets:[],integrity_paused:false,history_unverified:false,history_metadata:'confirmed',pause_reason:null,cron:{status:'unknown',last_attempt_at:null,last_success_at:null,stale:null,errors:[]},cleanup:{at:null,phases:null},reconciliation:{status:'unknown',attempt_at:null,read_at:null,summary:null}};
const filters={updated_at:now,catalog_version:'a'.repeat(64),prelands:['demo'],offers:[{id:'003',name:'Synthetic',status:'active'}]};
async function authenticate(page:Page){const creds=await reportCredentials();await page.context().setExtraHTTPHeaders({Authorization:'Basic '+Buffer.from(creds.username+':'+creds.password).toString('base64')});}
async function mock(page:Page) {
  await authenticate(page);
  await page.route('**/api/v1/report/status',route=>route.fulfill({json:status}));
  await page.route('**/api/v1/report/filters',route=>route.fulfill({json:filters}));
  await page.route('**/api/v1/report/funnel?*',route=>route.fulfill({json:funnel(new URL(route.request().url()).searchParams.get('offer_id')??undefined)}));
}
test('захист HTML/API та справжній порожній report на desktop/mobile @critical @report',async({page,request,browserName})=>{
  for(const path of ['/report','/report/','/api/v1/report/status']) {const response=await request.get(path);expect(response.status()).toBe(401);expect(response.headers()['cache-control']).toBe('no-store');expect(response.headers()['www-authenticate']).toContain('Basic');}
  await authenticate(page);let quizRequests=0;page.on('request',r=>{if(r.url().includes('/api/v1/quiz/'))quizRequests++;});
  await page.goto('/report/');await expect(page.getByTestId('report-metrics')).toBeVisible();expect(quizRequests).toBe(0);
  await expect(page.getByTestId('purchases')).toHaveText('0');expect(new URL(page.url()).searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  if(browserName==='chromium'){await page.reload();await expect(page.getByTestId('report-metrics')).toBeVisible();}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('URL source, draft marker, apply/replace, missing selected ID and reload @report',async({page})=>{
  await mock(page);await page.goto('/report/?from='+day+'&to='+day+'&offer_id=999');await expect(page.getByTestId('purchases')).toHaveText('9');
  await expect(page.getByRole('combobox',{name:'Офер',exact:true})).toHaveValue('999');const length=await page.evaluate(()=>history.length);
  await page.getByRole('combobox',{name:'Офер',exact:true}).selectOption('003');await expect(page.getByText('Є незастосовані зміни.',{exact:false})).toBeVisible();await expect(page.getByTestId('purchases')).toHaveText('9');
  await page.getByRole('button',{name:'Застосувати',exact:true}).click();await expect(page.getByTestId('purchases')).toHaveText('2');expect(page.url()).toContain('offer_id=003');expect(await page.evaluate(()=>history.length)).toBe(length);
  await page.reload();await expect(page.getByRole('combobox',{name:'Офер',exact:true})).toHaveValue('003');await expect(page.getByTestId('purchases')).toHaveText('2');
});
test('invalid URL stays visible until explicit reset; filters failure does not block explicit funnel @report',async({page})=>{
  await mock(page);await page.goto('/report/?from=bad&to='+day+'&extra=1');await expect(page.getByText('Некоректні фільтри в URL.',{exact:false})).toBeVisible();expect(page.url()).toContain('from=bad');await expect(page.getByTestId('report-metrics')).toHaveCount(0);
  await page.getByRole('button',{name:'Скинути фільтри'}).click();await expect(page.getByTestId('report-metrics')).toBeVisible();
  await page.route('**/api/v1/report/filters',route=>route.abort());await page.getByRole('button',{name:'Оновити',exact:true}).click();
  await expect(page.getByText('Список фільтрів не оновлено.',{exact:false})).toBeVisible();await expect(page.getByTestId('report-metrics')).toBeVisible();await expect(page.getByRole('combobox',{name:'Офер',exact:true}).locator('option[value="003"]')).toHaveCount(1);
});
test('unavailable and errors remove old numbers, retain last successful time; status independent @report',async({page})=>{
  await mock(page);await page.goto('/report/');await expect(page.getByTestId('report-metrics')).toBeVisible();
  await page.route('**/api/v1/report/status',route=>route.abort());await page.getByRole('button',{name:'Оновити',exact:true}).click();await expect(page.getByText('Технічний стан недоступний.')).toBeVisible();await expect(page.getByTestId('report-metrics')).toBeVisible();
  await page.route('**/api/v1/report/funnel?*',route=>route.fulfill({json:{report_status:'unavailable',reason:'history_unverified',updated_at:now,filters:{from:day,to:day}}}));
  await page.getByRole('button',{name:'Оновити',exact:true}).click();await expect(page.getByText('Повноту історії не підтверджено.',{exact:false})).toBeVisible();await expect(page.getByTestId('report-metrics')).toHaveCount(0);
  await page.route('**/api/v1/report/funnel?*',route=>route.fulfill({status:503,json:{error:{code:'temporarily_unavailable'}}}));await page.getByRole('button',{name:'Оновити',exact:true}).click();await expect(page.getByText('Не вдалося прочитати звіт.',{exact:false})).toBeVisible();await expect(page.getByText('Останній успішний зріз:',{exact:false})).toBeVisible();await expect(page.getByTestId('report-metrics')).toHaveCount(0);
});
test('late old response cannot replace applied filters and manual refresh reads all three @report',async({page})=>{
  await mock(page);await page.goto('/report/');await expect(page.getByTestId('report-metrics')).toBeVisible();
  let release!:()=>void;let started!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});const seen=new Promise<void>(resolve=>{started=resolve;});
  await page.route('**/api/v1/report/funnel?*',async route=>{if(!new URL(route.request().url()).searchParams.has('offer_id')){started();await waiting;} await route.fulfill({json:funnel(new URL(route.request().url()).searchParams.get('offer_id')??undefined)}).catch(()=>{});});
  await page.getByRole('button',{name:'Оновити',exact:true}).click();await seen;
  await page.getByRole('combobox',{name:'Офер',exact:true}).selectOption('003');await page.getByRole('button',{name:'Застосувати',exact:true}).click();await expect(page.getByTestId('report-metrics')).toBeVisible();release();await expect(page.getByText('Застосовано:',{exact:false})).toContainText('003');await expect(page.getByTestId('purchases')).toHaveText('2');
  const calls:string[]=[];page.on('request',r=>{if(r.url().includes('/api/v1/report/'))calls.push(new URL(r.url()).pathname.split('/').pop()!);});await page.getByRole('button',{name:'Оновити',exact:true}).click();await expect.poll(()=>calls.length).toBe(3);expect(calls.sort()).toEqual(['filters','funnel','status']);
});
test('60s after completion, no overlapping polling, hidden pauses, visibility resumes, auth stops @report',async({page})=>{
  await page.clock.install({time:now});await mock(page);const calls:string[]=[];page.on('request',r=>{if(r.url().includes('/api/v1/report/'))calls.push(new URL(r.url()).pathname.split('/').pop()!);});
  await page.goto('/report/');await expect(page.getByTestId('report-metrics')).toBeVisible();await expect(page.getByRole('button',{name:'Оновити',exact:true})).toBeEnabled();calls.length=0;
  await page.clock.runFor(59_000);expect(calls).toHaveLength(0);await page.clock.runFor(1000);await expect.poll(()=>calls.length).toBe(2);expect(calls.sort()).toEqual(['funnel','status']);await expect(page.getByRole('button',{name:'Оновити',exact:true})).toBeEnabled();
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});calls.length=0;await page.clock.runFor(120_000);expect(calls).toHaveLength(0);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await expect.poll(()=>calls.length).toBe(2);await expect(page.getByRole('button',{name:'Оновити',exact:true})).toBeEnabled();
  await page.route('**/api/v1/report/funnel?*',route=>route.fulfill({status:401,json:{error:{code:'unauthorized'}}}));await page.getByRole('button',{name:'Оновити',exact:true}).click();await expect(page.getByText('Автооновлення зупинено.',{exact:false})).toBeVisible();calls.length=0;await page.clock.runFor(180_000);expect(calls).toHaveLength(0);
});
test('limiter Retry-After pause and stale hidden snapshot never masquerade as fresh @report',async({page})=>{
  await page.clock.install({time:now});await mock(page);await page.goto('/report/');await expect(page.getByTestId('report-metrics')).toBeVisible();let requests=0;
  await page.route('**/api/v1/report/funnel?*',route=>{requests++;return route.fulfill({status:429,headers:{'Retry-After':'120'},json:{error:{code:'rate_limited'}}});});
  await page.getByRole('button',{name:'Оновити',exact:true}).click();await expect(page.getByText('Пауза доступу до ',{exact:false})).toBeVisible();await page.clock.runFor(119_000);expect(requests).toBe(1);await page.clock.runFor(1000);await expect.poll(()=>requests).toBe(2);
  await page.route('**/api/v1/report/funnel?*',route=>route.fulfill({json:funnel()}));await page.clock.runFor(120_000);await expect(page.getByTestId('report-metrics')).toBeVisible();
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await page.clock.runFor(900_001);await expect(page.getByTestId('report-metrics')).toHaveCount(0);
});
test('polling interval begins after slow completion and never overlaps visibility refresh @report',async({page})=>{
  await page.clock.install({time:now});await mock(page);let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  await page.route('**/api/v1/report/funnel?*',async route=>{calls++;if(calls===1)await waiting;await route.fulfill({json:funnel()});});
  await page.goto('/report/');await expect.poll(()=>calls).toBe(1);
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));expect(calls).toBe(1);
  await page.clock.runFor(9000);release();await expect(page.getByTestId('report-metrics')).toBeVisible();await expect(page.getByRole('button',{name:'Оновити',exact:true})).toBeEnabled();
  await page.clock.runFor(51_000);expect(calls).toBe(1);await page.clock.runFor(9000);await expect.poll(()=>calls).toBe(2);
});
test('period unavailable never clips URL; corrupt conversion response hides metrics @report',async({page})=>{
  await mock(page);await page.goto('/report/');await expect(page.getByTestId('report-metrics')).toBeVisible();const url=page.url();
  await page.route('**/api/v1/report/funnel?*',route=>route.fulfill({json:{report_status:'unavailable',reason:'period_unavailable',updated_at:now,available_from:'2026-11-01',filters:{from:day,to:day}}}));
  await page.getByRole('button',{name:'Оновити',exact:true}).click();await expect(page.getByText('Період недоступний.',{exact:false})).toBeVisible();expect(page.url()).toBe(url);await expect(page.getByTestId('report-metrics')).toHaveCount(0);
  const corrupt=funnel();corrupt.metrics.quiz.conversions.started_completed={numerator:3,denominator:2};
  await page.route('**/api/v1/report/funnel?*',route=>route.fulfill({json:corrupt}));await page.getByRole('button',{name:'Оновити',exact:true}).click();await expect(page.getByText('Не вдалося прочитати звіт.',{exact:false})).toBeVisible();await expect(page.getByTestId('report-metrics')).toHaveCount(0);
});
for (const failure of [429, 401]) test(`initial filters ${failure} blocks dependent funnel after delayed status @report`, async ({page}) => {
  await page.clock.install({time:now}); await mock(page);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  await page.route('**/api/v1/report/status', async route => { await waiting; await route.fulfill({json:status}); });
  await page.route('**/api/v1/report/filters', route => route.fulfill({status:failure, headers:{'Retry-After':'120'}, json:{error:{code:failure === 429 ? 'rate_limited' : 'unauthorized'}}}));
  await page.route('**/api/v1/report/funnel?*', route => { calls++; return route.fulfill({json:funnel()}); });
  await page.goto('/report/');
  await expect(page.getByText(failure === 429 ? 'Пауза доступу до ' : 'Автооновлення зупинено.', {exact:false})).toBeVisible();
  release(); await expect(page.getByLabel('Від (UTC)')).toHaveValue(day); expect(calls).toBe(0);
  await expect(page.getByTestId('report-metrics')).toHaveCount(0);
  if (failure === 429) {
    await page.clock.runFor(119_000); expect(calls).toBe(0);
    await page.clock.runFor(1000); await expect.poll(() => calls).toBe(1);
  } else {
    await page.clock.runFor(180_000); expect(calls).toBe(0);
    await page.route('**/api/v1/report/filters', route => route.fulfill({json:filters}));
    await page.getByRole('button', {name:'Оновити', exact:true}).click(); await expect.poll(() => calls).toBe(1);
  }
  await expect(page.getByTestId('report-metrics')).toBeVisible();
});
test('incomplete UTC-day label follows business snapshot when status fails or crosses midnight @report', async ({page}) => {
  await mock(page); await page.route('**/api/v1/report/status', route => route.abort());
  await page.goto('/report/?from=' + day + '&to=' + day);
  await expect(page.getByTestId('report-metrics')).toBeVisible(); await expect(page.getByText('Технічний стан недоступний.')).toBeVisible();
  const label = page.getByText('Поточний день UTC ще не завершено.', {exact:true}); await expect(label).toBeVisible();
  const midnight = Date.parse('2026-11-01T00:00:00Z');
  await page.route('**/api/v1/report/status', route => route.fulfill({json:status}));
  await page.route('**/api/v1/report/funnel?*', route => route.fulfill({json:{...funnel(), updated_at:midnight}}));
  await page.getByRole('button', {name:'Оновити', exact:true}).click();
  await expect(page.getByText('Останній успішний зріз:', {exact:false})).toContainText('2026-11-01 00:00:00 UTC');
  await expect(page.getByTestId('report-metrics')).toBeVisible(); await expect(label).toHaveCount(0);
  await page.route('**/api/v1/report/status', route => route.fulfill({json:{...status, updated_at:midnight}}));
  await page.route('**/api/v1/report/funnel?*', route => route.fulfill({json:funnel()}));
  await page.getByRole('button', {name:'Оновити', exact:true}).click(); await expect(label).toBeVisible();
});
test('labeled conversions show distinct pairs, rounded thirds and remaining shares @report', async ({page}) => {
  await mock(page); await page.goto('/report/'); await expect(page.getByTestId('report-metrics')).toBeVisible();
  const rows = [
    ['Вподобання', '33,3%', '1 / 3 користувачів', '66,7%', '2 / 3 користувачів'],
    ['Регіон', '75,0%', '3 / 4 користувачів', '25,0%', '1 / 4 користувачів'],
    ['Email', '80,0%', '4 / 5 користувачів', '20,0%', '1 / 5 користувачів'],
  ];
  for (const [question, converted, pair, remaining, remainingPair] of rows) {
    const row = page.getByRole('row').filter({has:page.getByRole('rowheader', {name:question, exact:true})});
    await expect(row.getByRole('cell').nth(2).locator('strong')).toHaveText(converted);
    await expect(row.getByRole('cell').nth(2).locator('small')).toHaveText(pair);
    await expect(row.getByRole('cell').nth(3).locator('strong')).toHaveText(remaining);
    await expect(row.getByRole('cell').nth(3).locator('small')).toHaveText(remainingPair);
  }
  for (const [label, percent, pair] of [
    ['Початок → завершення', '80,0%', '4 / 5 користувачів'],
    ['Початок → будь-який офер', '40,0%', '2 / 5 користувачів'],
    ['Перехід → Lead', '60,0%', '3 / 5 користувачів'],
    ['Перехід → Purchase', '20,0%', '1 / 5 користувачів'],
  ]) {
    const item = page.locator('.report-conversions > div').filter({has:page.getByText(label, {exact:true})});
    await expect(item.locator('dd strong')).toHaveText(percent); await expect(item.locator('dd small')).toHaveText(pair);
  }
});
test('technical state truthfully shows unknown, thresholds, stale Cron, delayed delivery and phase failures @report',async({page})=>{
 await mock(page);await page.goto('/report/?from='+day+'&to='+day);
 await page.getByRole('button',{name:'Технічний стан',exact:true}).click();
 await expect(page.getByText('Режим імітатора поточного обробника: normal.',{exact:false})).toBeVisible();
 await expect(page.getByText('Cron: ще немає даних',{exact:false})).toBeVisible();
 const failed={...status,receiver_mode:'unavailable',delivery:{...status.delivery,pending:1,oldest_age_ms:900_001,delayed:true,errors:[{code:'timeout',count:1}]},
  budgets:[{key:'events',used:9500,limit:10000,paused:false,alert:'critical'},{key:'profiles',used:800,limit:1000,paused:false,alert:'warning'}],
  cron:{status:'partial_failure',last_attempt_at:now-600_000,last_success_at:now-900_000,stale:true,errors:['cleanup_failed']},
  cleanup:{at:now,phases:{events:{changed:0,skipped:0,has_more:true,error:'cleanup_failed'}}}};
 await page.route('**/api/v1/report/status',route=>route.fulfill({json:failed}));await page.getByRole('button',{name:'Оновити',exact:true}).click();
 await expect(page.getByText('Режим імітатора поточного обробника: unavailable.',{exact:false})).toBeVisible();
 await expect(page.getByText('Cron: часткова невдача',{exact:false})).toBeVisible();await expect(page.getByText('· критично ≥95%',{exact:false})).toBeVisible();await expect(page.getByText('· увага ≥80%',{exact:false})).toBeVisible();
 await expect(page.getByText('· затримка понад 15 хв',{exact:false})).toBeVisible();await expect(page.getByText('· помилка очищення',{exact:false})).toBeVisible();
 await page.route('**/api/v1/report/status',route=>route.fulfill({status:503,json:{code:'temporarily_unavailable',retryable:true}}));await page.getByRole('button',{name:'Оновити',exact:true}).click();
 await expect(page.getByText('Cron: часткова невдача',{exact:false})).toHaveCount(0);await expect(page.getByText('Технічний стан недоступний.',{exact:true})).toBeVisible();
});

test('report sections preserve draft and URL without extra requests @report @critical', async ({page}, info) => {
  await mock(page); await page.goto('/report/');
  await expect(page.getByTestId('purchases')).toHaveText('2');
  await expect(page.getByRole('button', {name:'Оновити', exact:true})).toBeEnabled();
  await page.getByRole('combobox', {name:'Офер', exact:true}).selectOption('003');
  const url = page.url();
  const calls: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/v1/report/')) calls.push(r.url()); });
  await page.getByRole('button', {name:'Технічний стан', exact:true}).click();
  await expect(page.getByRole('button', {name:'Технічний стан', exact:true})).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', {name:'Доставка подій'})).toBeVisible();
  await expect(page.getByTestId('report-metrics')).toBeHidden();
  await page.getByRole('button', {name:'Огляд воронки', exact:true}).click();
  await expect(page.getByRole('combobox', {name:'Офер', exact:true})).toHaveValue('003');
  await expect(page.getByText('Є незастосовані зміни.', {exact:false})).toBeVisible();
  await expect(page.getByTestId('purchases')).toHaveText('2');
  expect(page.url()).toBe(url); expect(calls).toHaveLength(0);
  if ((page.viewportSize()?.width ?? 0) <= 640) {
    await expect(page.getByText('Прокрутіть таблицю вправо, щоб побачити конверсії.')).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/redesign-report-${info.project.name}.png`,fullPage:true});
});

test('report failures and technical warnings remain visible across sections @report', async ({page}) => {
  await mock(page); await page.goto('/report/');
  await expect(page.getByTestId('purchases')).toHaveText('2');
  await page.route('**/api/v1/report/status', route => route.fulfill({json:{...status,integrity_paused:true,pause_reason:'integrity'}}));
  await page.getByRole('button', {name:'Оновити', exact:true}).click();
  await expect(page.getByText('Технічний стан потребує уваги.', {exact:false})).toBeVisible();
  await page.route('**/api/v1/report/status', route => route.abort());
  await page.getByRole('button', {name:'Оновити', exact:true}).click();
  await expect(page.getByText('Технічний стан недоступний.', {exact:true})).toBeVisible();
  await expect(page.getByText('Технічний стан потребує уваги.', {exact:false})).toHaveCount(0);
  await page.getByRole('button', {name:'Технічний стан', exact:true}).click();
  await page.route('**/api/v1/report/funnel?*', route => route.abort());
  await page.getByRole('button', {name:'Оновити', exact:true}).click();
  await expect(page.getByText('Не вдалося прочитати звіт.', {exact:false})).toBeVisible();
  await expect(page.getByText('Технічний стан недоступний.', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:'Огляд воронки', exact:true}).click();
  await expect(page.getByTestId('report-metrics')).toHaveCount(0);
});

test('zero-denominator conversions show no data without a misleading meter @report', async ({page}) => {
  await mock(page);
  const empty = funnel();
  empty.metrics.quiz.conversions.questions.preferred_gender = {numerator:0, denominator:0};
  await page.route('**/api/v1/report/funnel?*', route => route.fulfill({json:empty}));
  await page.goto('/report/');
  const row = page.getByRole('row').filter({has:page.getByRole('rowheader', {name:'Вподобання', exact:true})});
  await expect(row.getByRole('cell').nth(2).locator('strong')).toHaveText('немає даних');
  await expect(row.locator('meter')).toHaveCount(0);
  await expect(page.locator('meter')).toHaveCount(2);
});
