import { Miniflare, Log, LogLevel } from 'miniflare';
import { build } from 'esbuild';
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function createLab({persistPath}={}) {
  const temporary=!persistPath;
  const state=persistPath ?? await mkdtemp(path.join(os.tmpdir(),'d1-isolated-lab-'));
  await mkdir(state,{recursive:true});
  const resolved=await realpath(state), temp=await realpath(os.tmpdir());
  if(!resolved.startsWith(temp+path.sep) && !resolved.startsWith(path.join(root,'state')+path.sep)) throw new Error('LAB_STATE_PATH_UNSAFE');
  await mkdir(path.join(root,'build'),{recursive:true});
  const outfile=path.join(root,'build','worker.mjs');
  const bundle=await build({write:false,entryPoints:[path.join(root,'worker.mjs')],outfile,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const attempts=[];
  const trap=(kind)=>async()=>{attempts.push(kind); return new Response('LAB_NETWORK_UNAVAILABLE',{status:503});};
  const runtime=new Miniflare({modules:true,script:bundle.outputFiles[0].text,cf:false,compatibilityDate:'2026-07-30',d1Databases:{DB:'lab-d1-only'},d1Persist:state,host:'127.0.0.1',port:0,log:new Log(LogLevel.NONE),outboundService:trap('internet'),serviceBindings:{HOSTINGER:trap('hostinger')},bindings:{LAB_ONLY:'synthetic-isolated-v1'}});
  const db=await runtime.getD1Database('DB');
  await db.exec(await readFile(path.join(root,'schema.sql'),'utf8'));
  return {
    db, runtime, persistPath:state, networkAttempts:attempts,
    async command(input,headers={}) {
      const response=await runtime.dispatchFetch('http://lab.invalid/command',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input)});
      return {status:response.status,body:await response.json()};
    },
    async reset() {
      const {results}=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lab_%'").all();
      await db.exec('PRAGMA defer_foreign_keys = ON;'+results.reverse().map(({name})=>`DELETE FROM ${name};`).join(''));
      for(const company of ['c1','c2']) {
        await db.batch([
          db.prepare('INSERT INTO lab_companies VALUES (?)').bind(company),
          ...['b1','b2'].flatMap(branch=>[
            db.prepare('INSERT INTO lab_branches VALUES (?,?,1)').bind(company,branch),
            db.prepare('INSERT INTO lab_actors VALUES (?,?,?,1,0)').bind(company,`a-${branch}`,branch),
            db.prepare('INSERT INTO lab_control VALUES (?,?,1,1,0)').bind(company,branch),
            db.prepare("INSERT INTO lab_stock VALUES (?,?,'sku',100,0,0)").bind(company,branch),
            db.prepare("INSERT INTO lab_customers VALUES (?,?,'customer','0.00','100.00',0)").bind(company,branch),
            db.prepare("INSERT INTO lab_approvals VALUES (?,?,'approval','customer','100.00',1,0)").bind(company,branch),
            db.prepare("INSERT INTO lab_coupons VALUES (?,?,'coupon',1,'1.00',0)").bind(company,branch),
            db.prepare('INSERT INTO lab_counters VALUES (?,?,1,0)').bind(company,branch),
            db.prepare("INSERT INTO lab_cash VALUES (?,?,'1000.00',0)").bind(company,branch),
            db.prepare("INSERT INTO lab_wallets VALUES (?,?,'wallet','100.00',0)").bind(company,branch)
          ])
        ]);
      }
    },
    async close({remove=temporary}={}) {await runtime.dispose(); if(remove) await rm(state,{recursive:true,force:true});}
  };
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url) && process.argv.includes('--test')) {
  process.env.TZ='UTC';
  const start=new Date(),cases=[];
  for await(const event of run({files:[path.join(root,'d1.test.mjs')],concurrency:1})) {
    if(event.type==='test:pass'||event.type==='test:fail') {
      const data=event.data;
      cases.push({name:data.name,status:event.type==='test:pass'?'pass':'fail',durationMs:data.details.duration_ms,error:data.details.error?.message});
      process.stdout.write(`${event.type==='test:pass'?'PASS':'FAIL'} ${data.name} (${data.details.duration_ms.toFixed(1)}ms)\n`);
      if(data.details.error) process.stdout.write(String(data.details.error.stack ?? data.details.error)+'\n');
    }
  }
  const evidence={date:start.toISOString(),node:process.version,miniflare:'4.20260730.0',esbuild:'0.28.2',decimal:'10.6.0',runtime:'real local workerd D1 binding',cases,counts:{pass:cases.filter(x=>x.status==='pass').length,fail:cases.filter(x=>x.status==='fail').length}};
  await mkdir(path.join(root,'results'),{recursive:true});
  await writeFile(path.join(root,'results','d1-latest.json'),JSON.stringify(evidence,null,2)+'\n');
  process.stdout.write(JSON.stringify(evidence.counts)+'\n');
  process.exitCode=evidence.counts.fail?1:0;
}
