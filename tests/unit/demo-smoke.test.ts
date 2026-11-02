import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const effects=vi.hoisted(()=>({
  launch:vi.fn(()=>{throw new Error('offline_browser_blocked');}),
  execFile:vi.fn(()=>{throw new Error('offline_cli_blocked');}),
}));
vi.mock('@playwright/test',()=>({chromium:{launch:effects.launch}}));
vi.mock('node:child_process',()=>({execFile:effects.execFile}));
const legacy=Buffer.alloc(32,3).toString('base64url');
let previousExitCode:typeof process.exitCode;
beforeEach(()=>{
  previousExitCode=process.exitCode;
  vi.resetModules();vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
  vi.stubEnv('DEMO_ORIGIN','https://unicorn-demo.synthetic.workers.dev');
  vi.stubEnv('REPORT_USERNAME','demo');vi.stubEnv('PARTNER_TOKEN',legacy);vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED','1');
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('offline_baseline_stop');}));
  vi.spyOn(process,'exit').mockImplementation(()=>{throw new Error('offline_exit_blocked');});
  vi.spyOn(console,'error').mockImplementation(()=>{});vi.spyOn(console,'log').mockImplementation(()=>{});
});
afterEach(()=>{
  process.exitCode=previousExitCode;
  vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();
});
async function configuration(password:string|undefined,accepted:boolean) {
  vi.stubEnv('REPORT_PASSWORD',password);
  // Import the real script, but stop at the first mocked read; no cloud smoke can run.
  const script='../../scripts/demo-smoke.mjs';await import(script);
  expect(console.error).toHaveBeenCalledExactlyOnceWith('demo_smoke_failed stage='+(accepted?'baseline':'configuration'));
  expect(fetch).toHaveBeenCalledTimes(accepted?1:0);
  expect(effects.launch).not.toHaveBeenCalled();expect(effects.execFile).not.toHaveBeenCalled();
  expect(process.exit).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
}
it.each([
  ['approved','unicorn-demo'],['legacy',legacy],['minimum','!A:0_a~?'],['maximum','a'.repeat(128)],
])('accepts %s report password before the intercepted baseline',async(_label,password)=>configuration(password,true));
it.each([
  ['missing',undefined],['empty',''],['short','a'.repeat(7)],['long','a'.repeat(129)],
  ['space','demo password'],['newline','unicorn-demo\n'],['tab','unicorn\tdemo'],
  ['null','unicorn\0demo'],['delete','unicorn\x7fdemo'],['non-ASCII','unicorn-démo'],
])('rejects %s report password before any external activity',async(_label,password)=>configuration(password,false));
it.each(['unicorn-demo','a'.repeat(42),'!'.repeat(43)])('keeps partner token validation strict (%s)',async token=>{
  vi.stubEnv('PARTNER_TOKEN',token);await configuration('unicorn-demo',false);
});
