// Bounded real HTTPS smoke. No SQLite, seeded identities, tracing, screenshots or reset.
import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { funnelSchema, reportStatusSchema } from '../src/shared/report.ts';
const execute = promisify(execFile);
let browser;
let stage = 'configuration';
const timeout = setTimeout(() => { console.error('demo_smoke_timeout'); process.exit(1); }, 180_000);
const require = (ok) => { if (!ok) throw new Error('smoke_failed'); };
try {
  const origin = process.env.DEMO_ORIGIN;
  const target = new URL(origin);
  require(target.protocol === 'https:' && target.origin === origin && !target.username && !target.password && !target.port && target.hostname.endsWith('.workers.dev'));
  require(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');
  const username = process.env.REPORT_USERNAME, password = process.env.REPORT_PASSWORD, token = process.env.PARTNER_TOKEN;
  require(/^[A-Za-z0-9_-]{1,64}$/.test(username ?? '') && /^[\x21-\x7e]{8,128}(?![\s\S])/.test(password ?? '') && /^[A-Za-z0-9_-]{43}$/.test(token ?? ''));
  const day = new Date().toISOString().slice(0, 10);
  require(Date.now() % 86400000 < 86400000 - 180000);
  const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  const read = async (path) => {
    const response = await fetch(new URL(path, target), { headers: {Authorization:auth}, redirect:'error', signal:AbortSignal.timeout(10000) });
    require(response.ok); return response.json();
  };
  const counts = async () => {
    const report = funnelSchema.parse(await read(`/api/v1/report/funnel?from=${day}&to=${day}&preland_id=demo`));
    require(report.report_status === 'ready');
    return { entered:report.metrics.quiz.activity.entered, completed:report.metrics.quiz.activity.completed, ...report.metrics.offers.activity };
  };
  stage='baseline'; const baseline = await counts();
  const statusBefore = reportStatusSchema.parse(await read('/api/v1/report/status'));
  require(statusBefore.receiver_mode === 'normal' && !statusBefore.integrity_paused && !statusBefore.history_unverified);
  const assertDelta = async (expected) => {
    require(new Date().toISOString().slice(0,10)===day);
    const actual=await counts(); for (const [key, delta] of Object.entries(expected)) require(actual[key]-baseline[key]===delta);
  };
  const expected={entered:1,completed:1,transitioned:1,bypass:0,leads:0,buyers:0,purchases:0};
  stage='quiz'; browser=await chromium.launch();
  const context=await browser.newContext(); const page=await context.newPage(); page.setDefaultTimeout(15000);
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin ? route.continue() : route.abort());
  await page.goto(origin); await page.getByLabel('Жінки',{exact:true}).check(); await page.getByRole('button',{name:'Продовжити'}).click();
  await page.getByLabel('Азія',{exact:true}).check(); await page.getByRole('button',{name:'Продовжити'}).click();
  await page.getByLabel('Email',{exact:true}).fill('Synthetic@example.test'); await page.getByRole('button',{name:'Підтвердити та підібрати'}).click();
  await page.getByText('ВАША ПРОПОЗИЦІЯ · 003').waitFor();
  const click=await page.locator('dd code').innerText(); require(/^[0-9a-f-]{36}$/.test(click));
  require(await page.locator('a[href^="https://"]').count()===0); await assertDelta(expected);
  const prefix=randomUUID();
  const cli=async(args)=>{const result=await execute(process.execPath,['scripts/partner-cli.ts',...args],{env:{...process.env,PARTNER_TOKEN:token},timeout:20000,maxBuffer:4096});require(['prepared\n','accepted\n'].includes(result.stdout));};
  const prepare=async(suffix,type)=>{const file=prefix+'-'+suffix+'.json';await cli(['prepare','--file',file,'--type',type,'--click',click,...(type==='Purchase'?['--amount-minor','2500','--currency','USD']:[])]);return file;};
  const send=async(file)=>cli(['send','--file',file,'--target',origin]);
  stage='lead'; await send(await prepare('lead','Lead')); expected.leads=1;await assertDelta(expected);
  stage='bypass'; await page.goto(origin);await page.getByText('ВАША ПРОПОЗИЦІЯ · 003').waitFor();require(await page.locator('dd code').innerText()!==click);
  expected.bypass=1;await assertDelta(expected);
  stage='purchase';const purchase=await prepare('purchase','Purchase');await send(purchase);expected.buyers=1;expected.purchases=1;await assertDelta(expected);
  stage='replay';await send(purchase);await assertDelta(expected);
  stage='second_purchase';await send(await prepare('purchase-2','Purchase'));expected.purchases=2;await assertDelta(expected);
  console.log('demo_smoke_passed deltas=1/1/1/1/1/1/2 cron_requires_separate_observation');
} catch {
  // Never expose raw HTTP, browser, child-process errors, credentials or payloads.
  console.error(`demo_smoke_failed stage=${stage}`); process.exitCode=1;
} finally {
  try { await browser?.close(); } finally { clearTimeout(timeout); }
}
