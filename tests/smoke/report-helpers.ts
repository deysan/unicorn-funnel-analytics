import { readFile } from 'node:fs/promises';
export async function reportCredentials() {
  const source=await readFile('.dev.vars','utf8');
  const get=(key:string)=>source.split('\n').find(line=>line.startsWith(key+'='))!.slice(key.length+1);
  return {username:get('REPORT_USERNAME'),password:get('REPORT_PASSWORD')};
}
