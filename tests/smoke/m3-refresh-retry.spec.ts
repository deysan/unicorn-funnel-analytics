import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';
for(const failure of ['entry','B']) test(`explicit refresh retains entry/B keys after ${failure} failure @audit`,async({page,context})=>{
  const profiles=JSON.parse(await readFile('.wrangler/e2e-profiles.json','utf8')) as {token:string}[];
  await context.addCookies([{name:'__Host-unicorn',value:profiles[19].token,domain:'localhost',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
  const entries:string[]=[],selections:string[]=[];
  await page.route('**/entries',async route=>{entries.push(route.request().postData()!);if(failure==='entry'&&entries.length===1){await route.fetch();await route.abort();}else await route.continue();});
  await page.route('**/offer-selections',async route=>{selections.push(route.request().postData()!);if(failure==='B'&&selections.length===1)await route.abort();else await route.continue();});
  await page.goto('/?result='+crypto.randomUUID());
  await page.getByRole('button',{name:'Оновити контекст'}).click();
  await expect(page.getByRole('button',{name:'Повторити дію'})).toBeEnabled();
  await page.getByRole('button',{name:'Повторити дію'}).click();
  await expect(page.getByText('ClickID',{exact:true})).toBeVisible();
  if(failure==='entry'){expect(entries).toHaveLength(2);expect(entries[1]).toBe(entries[0]);expect(selections).toHaveLength(1);}
  else{expect(entries).toHaveLength(1);expect(selections).toHaveLength(2);expect(selections[1]).toBe(selections[0]);}
});
