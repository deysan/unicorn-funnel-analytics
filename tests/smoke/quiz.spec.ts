import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';
const projectOffsets: Record<string, number> = {chromium:0,firefox:20,webkit:40,'mobile-chromium':60,'mobile-webkit':80};
let profileIndex = 0;
async function seed(context: import('@playwright/test').BrowserContext, project: string) {
  const profiles = JSON.parse(await readFile('.wrangler/e2e-profiles.json','utf8')) as {id:string;token:string}[];
  const profile = profiles[projectOffsets[project]+profileIndex++];
  await context.addCookies([{ name: '__Host-unicorn', value: profile.token, domain: 'localhost', path:'/', httpOnly:true,secure:true,sameSite:'Lax' }]);
  return profile;
}
async function answer(page: import('@playwright/test').Page, label: string) {
  await page.getByLabel(label, { exact:true }).check(); await page.getByRole('button',{name:'Продовжити'}).click();
}
async function reachEmail(page: import('@playwright/test').Page) {
  await page.goto('/'); await answer(page,'Жінки'); await answer(page,'Азія'); await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
}
async function finish(page: import('@playwright/test').Page) {
  await page.getByLabel('Email',{exact:true}).fill('Synthetic@example.test'); await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByText('ClickID',{exact:true})).toBeVisible();
}
test('квіз women+asia → 003; reload відновлює ClickID; новий вхід повертає Q1', {tag:'@critical'}, async ({page,context},info) => {
  await seed(context,info.project.name); await reachEmail(page);
  await page.screenshot({path:`test-results/quiz-email-${info.project.name}.png`,fullPage:true}); await finish(page);
  await expect(page.getByText('ВАША ПРОПОЗИЦІЯ · 003')).toBeVisible();
  const click = await page.locator('dd code').innerText(); await page.reload(); await expect(page.locator('dd code')).toHaveText(click);
  expect(await page.locator('a[href^="https://"]').count()).toBe(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/quiz-${info.project.name}.png`,fullPage:true});
  await page.goto('/'); await expect(page.getByRole('heading',{name:'Кого ви хочете зустріти?'})).toBeVisible();
  await expect(page.getByLabel('Жінки',{exact:true})).toBeChecked();
});
test('втрачена відповідь B відновлюється GET без нового ClickID', async ({page,context},info) => {
  await seed(context,info.project.name); await reachEmail(page);
  let bPosts=0; let click='';
  await page.route('**/offer-selections',async route=>{ bPosts++; const response=await route.fetch(); const json=await response.json(); click=json.click_id; await route.abort(); });
  await page.getByLabel('Email',{exact:true}).fill('Retry@example.test'); await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeVisible(); await page.unroute('**/offer-selections');
  await page.reload(); await expect(page.locator('dd code')).toHaveText(click); expect(bPosts).toBe(1);
});
test('step обмежується передумовами; Back створює показ без нового entry', async ({page,context},info) => {
  await seed(context,info.project.name); let entries=0;let views=0;page.on('request',r=>{if(r.url().endsWith('/entries'))entries++;if(r.url().endsWith('/question-views'))views++;});
  await page.goto('/?step=email'); await expect(page).toHaveURL(/step=preferred_gender/); await answer(page,'Жінки');
  await expect(page.getByLabel('Азія',{exact:true})).toBeVisible(); await expect(page.getByRole('button',{name:'Назад'})).toBeEnabled();
  await page.getByRole('button',{name:'Назад'}).click(); await expect(page.getByLabel('Жінки',{exact:true})).toBeChecked();
  await expect.poll(()=>views).toBe(3); expect(entries).toBe(1);
  await page.reload();await expect(page.getByLabel('Жінки',{exact:true})).toBeChecked();await expect.poll(()=>views).toBe(4);expect(entries).toBe(2);
});
test('збій sessionStorage до A не надсилає email', async ({page,context},info) => {
  await seed(context,info.project.name); await reachEmail(page); let aPosts=0;page.on('request',r=>{if(r.url().endsWith('/email-confirmations'))aPosts++;});
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException('blocked','QuotaExceededError');};});
  await page.getByLabel('Email',{exact:true}).fill('Storage@example.test'); await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByRole('status')).toContainText('Локальне збереження'); expect(aPosts).toBe(0);
  await expect(page.getByRole('button',{name:'Підтвердити та підібрати'})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeEnabled();
});
test('дві вкладки bootstrap створюють один профіль під Web Lock', {tag:'@critical'}, async ({context,page}) => {
  const second=await context.newPage();let creations=0;context.on('response',r=>{if(r.url().endsWith('/identity')&&r.status()===201)creations++;});
  await Promise.all([page.goto('/'),second.goto('/')]);
  await expect(page.getByLabel('Жінки',{exact:true})).toBeVisible();await expect(second.getByLabel('Жінки',{exact:true})).toBeVisible();
  expect(creations).toBe(1);
  const response=await page.request.get('/api/v1/quiz/context?preland_id=demo');expect((await response.json()).identity_status).toBe('ready');
});
test('no_offer: явна нова B зберігає ключ під час повтору', async ({page,context},info) => {
  await seed(context,info.project.name); await reachEmail(page);
  const keys:string[]=[];const results=new Map<string,object>();
  await page.route('**/operations/*',async route=>{const key=route.request().url().split('/').at(-1)!;if(results.has(key))await route.fulfill({json:results.get(key)});else await route.continue();});
  await page.route('**/offer-selections',async route=>{const key=route.request().postDataJSON().operation_id as string;keys.push(key);
    if(keys.length===2){await route.abort();return;}
    const result={code:'no_offer',catalog_version:'a'.repeat(64)};results.set(key,result);await route.fulfill({json:result});});
  await page.getByLabel('Email',{exact:true}).fill('NoOffer@example.test');await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByRole('heading',{name:'Зараз немає пропозиції'})).toBeVisible();
  await page.getByRole('button',{name:'Спробувати ще раз'}).click();await page.getByRole('button',{name:'Повторити дію'}).click();
  await expect(page.getByRole('heading',{name:'Зараз немає пропозиції'})).toBeVisible();
  expect(keys).toHaveLength(3);expect(keys[1]).not.toBe(keys[0]);expect(keys[2]).toBe(keys[1]);
});
test('storage failure після A блокує B, стирає email і дозволяє відновити старі ключі', async ({page,context},info) => {
  await seed(context,info.project.name);await reachEmail(page);let aPosts=0;let bPosts=0;
  page.on('request',r=>{if(r.url().endsWith('/offer-selections'))bPosts++;});
  await page.route('**/email-confirmations',async route=>{aPosts++;const response=await route.fetch();
    await page.evaluate(()=>{const original=Storage.prototype.setItem;(window as unknown as {restoreStorage:()=>void}).restoreStorage=()=>{Storage.prototype.setItem=original;};Storage.prototype.setItem=()=>{throw new DOMException('blocked');};});await route.fulfill({response});});
  await page.getByLabel('Email',{exact:true}).fill('AfterA@example.test');await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByRole('status')).toContainText('Локальне збереження');expect(bPosts).toBe(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('unicorn.final.v1'))).toBeNull();
  await page.evaluate(()=>(window as unknown as {restoreStorage:()=>void}).restoreStorage());
  await page.getByRole('button',{name:'Повторити дію'}).click();await expect(page.getByText('ClickID',{exact:true})).toBeVisible();expect(aPosts).toBe(1);expect(bPosts).toBe(1);
});
test('заблокована cookie зупиняє bootstrap також після reload', async ({page,context}) => {
  let creations=0;await page.route('**/identity',async route=>{const response=await route.fetch();creations++;const headers=response.headers();delete headers['set-cookie'];await context.clearCookies();await route.fulfill({response,headers});});
  await page.goto('/');await expect(page.getByRole('status')).toContainText('Браузер не повернув cookie');expect(creations).toBe(1);
  await page.reload();await expect(page.getByRole('button',{name:'Відновити доступ'})).toBeVisible();expect(creations).toBe(1);
});
test('TTL чернетки: GET без повтору A, email вилучено; явний refresh дає новий entry', async ({page,context},info) => {
  await seed(context,info.project.name);await reachEmail(page);let aPosts=0;let entries=0;
  page.on('request',r=>{if(r.url().endsWith('/entries'))entries++;});
  await page.route('**/email-confirmations',async route=>{aPosts++;await route.abort();});
  await page.getByLabel('Email',{exact:true}).fill('Expired@example.test');await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeVisible();
  await page.evaluate(()=>{const draft=JSON.parse(sessionStorage.getItem('unicorn.final.v1')!);draft.deadline=1;sessionStorage.setItem('unicorn.final.v1',JSON.stringify(draft));});
  await page.reload();await expect(page.getByRole('status')).toContainText('Строк надсилання минув');expect(aPosts).toBe(1);
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('unicorn.final.v1')!).email)).toBeUndefined();
  await page.getByRole('button',{name:'Оновити контекст'}).click();await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
  await expect.poll(()=>entries).toBe(1);expect(await page.evaluate(()=>sessionStorage.getItem('unicorn.final.v1'))).toBeNull();
});
test('активна чернетка очищає email на TTL без reload', async ({page,context},info) => {
  await seed(context,info.project.name);await page.clock.install();await reachEmail(page);
  await page.route('**/email-confirmations',route=>route.abort());
  await page.getByLabel('Email',{exact:true}).fill('ActiveTTL@example.test');await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('unicorn.final.v1')!).email)).toBe('ActiveTTL@example.test');
  await page.clock.fastForward(86_400_001);
  await expect(page.getByRole('status')).toContainText('Строк надсилання минув');
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('unicorn.final.v1')!).email)).toBeUndefined();
});
test('limiter Retry-After: пауза не скорочується; максимум три автоматичні повтори старого ключа', async ({page,context},info) => {
  await seed(context,info.project.name);await page.clock.install();await page.addInitScript(()=>{Math.random=()=>0;});
  const payloads:string[]=[];await page.route('**/entries',async route=>{payloads.push(route.request().postData()!);await route.fulfill({status:429,headers:{'Retry-After':'75'},json:{error:{code:'rate_limited',message:'Пауза',retryable:true}}});});
  await page.goto('/');await expect(page.getByRole('button',{name:'Повторити дію'})).toBeDisabled();
  await page.clock.fastForward(74_000);expect(payloads).toHaveLength(1);
  await page.clock.fastForward(1_000);await expect.poll(()=>payloads.length).toBe(2);
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeDisabled();
  await page.clock.fastForward(75_000);await expect.poll(()=>payloads.length).toBe(3);
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeDisabled();
  await page.clock.fastForward(75_000);await expect.poll(()=>payloads.length).toBe(4);
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeDisabled();
  await page.clock.fastForward(150_000);expect(payloads).toHaveLength(4);expect(new Set(payloads).size).toBe(1);
});
test('без Web Locks готовий профіль працює, новий не створюється', async ({page,context},info) => {
  await seed(context,info.project.name);await page.addInitScript(()=>{Object.defineProperty(navigator,'locks',{value:undefined});});let creations=0;
  page.on('request',r=>{if(r.url().endsWith('/identity'))creations++;});
  await page.goto('/');await page.getByLabel('Жінки',{exact:true}).check();
  await expect(page.getByRole('button',{name:'Продовжити'})).toBeEnabled();
  await context.clearCookies();await page.reload();await expect(page.getByRole('status')).toContainText('Web Locks');expect(creations).toBe(0);
});
test('втрачена відповідь A: reload читає A і не підтверджує email повторно', async ({page,context},info) => {
  await seed(context,info.project.name);await reachEmail(page);let aPosts=0;let bPosts=0;
  page.on('request',r=>{if(r.url().endsWith('/offer-selections'))bPosts++;});
  await page.route('**/email-confirmations',async route=>{aPosts++;await route.fetch();await route.abort();});
  await page.getByLabel('Email',{exact:true}).fill('LostA@example.test');await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeVisible();await page.reload();
  await expect(page.getByText('ClickID',{exact:true})).toBeVisible();expect(aPosts).toBe(1);expect(bPosts).toBe(1);
});
test('приватна Lead fixture: bypass створює лише entry/B без email і показів', async ({page,context}) => {
  const profiles=JSON.parse(await readFile('.wrangler/e2e-profiles.json','utf8')) as {token:string}[];
  await context.addCookies([{name:'__Host-unicorn',value:profiles[19].token,domain:'localhost',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
  const posts:string[]=[];page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname.split('/').at(-1)!);});
  await page.goto('/?step=email');await expect(page.getByText('ClickID',{exact:true})).toBeVisible();
  await expect(page.getByText('ВАША ПРОПОЗИЦІЯ · 003')).toBeVisible();expect(posts).toEqual(['entries','offer-selections']);
  expect(await page.getByLabel('Email',{exact:true}).count()).toBe(0);
});
test('втрата cookie посеред квізу переживає reload без автоматичного нового профілю', async ({page,context},info) => {
  await seed(context,info.project.name);let creations=0;page.on('request',r=>{if(r.url().endsWith('/identity'))creations++;});
  await page.goto('/');await page.getByLabel('Жінки',{exact:true}).check();await expect(page.getByRole('button',{name:'Продовжити'})).toBeEnabled();
  await context.clearCookies();await page.reload();await expect(page.getByRole('button',{name:'Відновити доступ'})).toBeVisible();
  expect(creations).toBe(0);expect(await page.getByLabel('Жінки',{exact:true}).count()).toBe(0);
});
test('cookie swap: Back з результату приховує дані й не запускає bypass чужого профілю', async ({page,context},info) => {
  await seed(context,info.project.name);await reachEmail(page);await finish(page);
  const profiles=JSON.parse(await readFile('.wrangler/e2e-profiles.json','utf8')) as {id:string;token:string}[];
  const replacement=profiles[19];const newOwnerPosts:string[]=[];
  page.on('request',r=>{if(r.method()==='POST'&&r.headers()['x-expected-user-id']===replacement.id)newOwnerPosts.push(r.url());});
  await context.addCookies([{name:'__Host-unicorn',value:replacement.token,domain:'localhost',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
  await page.goBack();
  await expect(page.getByRole('button',{name:'Відновити доступ'})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Профіль змінився');
  expect(newOwnerPosts).toEqual([]);expect(await page.getByText('ClickID',{exact:true}).count()).toBe(0);
  expect(await page.getByRole('radio').count()).toBe(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('unicorn.final.v1'))).toBeNull();
});
test('cookie swap: answer → context не приймає нового власника й не надсилає його view', async ({page,context},info) => {
  await seed(context,info.project.name);await page.goto('/');
  const profiles=JSON.parse(await readFile('.wrangler/e2e-profiles.json','utf8')) as {id:string;token:string}[];
  const replacement=profiles[18];const newOwnerPosts:string[]=[];
  page.on('request',r=>{if(r.method()==='POST'&&r.headers()['x-expected-user-id']===replacement.id)newOwnerPosts.push(r.url());});
  await page.route('**/answers',async route=>{
    const response=await route.fetch();const headers=response.headers();delete headers['set-cookie'];
    await context.addCookies([{name:'__Host-unicorn',value:replacement.token,domain:'localhost',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
    await route.fulfill({response,headers});
  });
  await answer(page,'Жінки');
  await expect(page.getByRole('button',{name:'Відновити доступ'})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Профіль змінився');
  expect(newOwnerPosts).toEqual([]);expect(await page.getByRole('radio').count()).toBe(0);
  expect(await page.getByLabel('Email',{exact:true}).count()).toBe(0);
});
for(const errorName of ['TimeoutError','AbortError']) test(`bootstrap lock ${errorName}: явна причина і ручний retry без нового профілю`,async({page})=>{
  await page.addInitScript((name)=>{Object.defineProperty(navigator.locks,'request',{value:()=>Promise.reject(new DOMException('lock wait',name))});},errorName);
  let creations=0;page.on('request',r=>{if(r.url().endsWith('/identity'))creations++;});
  await page.goto('/');await expect(page.getByRole('status')).toContainText('Не вдалося дочекатися доступу');
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeEnabled();
  await expect(page.getByRole('status')).not.toContainText('Локальне збереження');expect(creations).toBe(0);
});


test('друге питання змінює формулювання після women → Back → men', async ({page,context},info) => {
  await seed(context,info.project.name); await page.goto('/'); await answer(page,'Жінки');
  await expect(page.getByRole('heading',{name:'З якого регіону жінки вас цікавлять?'})).toBeVisible();
  await page.getByRole('button',{name:'Назад'}).click(); await answer(page,'Чоловіки');
  await expect(page.getByRole('heading',{name:'З якого регіону чоловіки вас цікавлять?'})).toBeVisible();
});

test('restart з втраченою cookie та limiter на підтвердженні не повторює видачу профілю', async ({page,context}) => {
  await page.clock.install(); await page.addInitScript(()=>{Math.random=()=>0;});
  let creations=0; let throttleConfirmation=false;
  await page.route('**/api/v1/quiz/context?*', async route=>{
    if (throttleConfirmation) {
      throttleConfirmation=false;
      await route.fulfill({status:429,headers:{'Retry-After':'60'},json:{error:{code:'rate_limited',message:'Пауза підтвердження',retryable:true}}});
    } else await route.continue();
  });
  const loseCookie = async (route: import('@playwright/test').Route) => {
    const response=await route.fetch(); expect(response.status()).toBe(201); creations++;
    const headers=response.headers(); delete headers['set-cookie']; await context.clearCookies();
    if(creations===2) throttleConfirmation=true;
    await route.fulfill({response,headers});
  };
  await page.route('**/api/v1/quiz/identity',loseCookie);
  await page.route('**/api/v1/quiz/identity/restart',loseCookie);
  await page.goto('/'); await expect(page.getByRole('button',{name:'Відновити доступ'})).toBeVisible(); expect(creations).toBe(1);
  await page.getByRole('button',{name:'Відновити доступ'}).click();
  await expect(page.getByRole('status')).toContainText('Пауза підтвердження'); expect(creations).toBe(2);
  await page.clock.runFor(60_001);
  await expect(page.getByRole('status')).toContainText('Потрібне явне відновлення'); expect(creations).toBe(2);
  await page.clock.runFor(180_000); expect(creations).toBe(2);
  expect(await page.evaluate(()=>sessionStorage.getItem('unicorn.identity.attempt.v1'))).toBe('pending');
});
