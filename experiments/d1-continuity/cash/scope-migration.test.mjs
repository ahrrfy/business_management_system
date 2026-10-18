import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {buildActualCashWorker,cashRoot} from './build.mjs';
import {sqlStatements} from './sql-statements.mjs';
import {canonical,sha256} from './paged-client.mjs';

test('legacy upgrade preserves actual financial rows, journal bytes and deleted order sequence; DDL rollback and repeated upgrade are safe',async()=>{
 const dir=path.join(cashRoot,'build/scope-upgrade');await mkdir(dir,{recursive:true});
 const legacy=execFileSync('git',['show','5b47adec54e7008ced01b72ac9007dfb83520d81:experiments/d1-continuity/cash/schema.ts'],{cwd:cashRoot,encoding:'utf8'});
 await build({stdin:{contents:legacy,resolveDir:cashRoot,loader:'ts'},bundle:true,format:'esm',platform:'node',minifyWhitespace:true,legalComments:'none',outfile:path.join(dir,'legacy.mjs'),logLevel:'silent'});
 const old=await import(pathToFileURL(path.join(dir,'legacy.mjs')).href);
 assert.equal(sha256(old.initializationSql),'2d23312bc828b9ff0a52abc7d7415a649c5accf7261ed973fc5c2d29b4e1f1e8');
 await buildActualCashWorker({stdin:`import worker from './worker';import{prepareCashSale,applyCashPlan,fixtureActor,fixtureInput}from'./actual';export default{async fetch(req,env){const p=new URL(req.url).pathname;if(p==='/test-prepare'){const v=await prepareCashSale(env.AUX,{...fixtureInput,clientRequestId:'legacy-upgrade-proof'},fixtureActor);await applyCashPlan(env.DB,v.plan,{historicalRestore:true});return Response.json(v);}return worker.fetch(req,env);}};`,outfile:path.join(dir,'worker.mjs')});
 const current=await import(pathToFileURL(path.join(dir,'schema-metadata.mjs')).href);
 for(const table of old.tables)if(table.name!=='onlineOrders')assert.equal(current.tables.find(t=>t.name===table.name).ddl,table.ddl,'Financial schema changed '+table.name);
 const secret='synthetic-legacy-upgrade-test-only',outbound=[];
 const mf=new Miniflare({modules:[{type:'ESModule',path:path.join(dir,'worker.mjs')},{type:'CompiledWasm',path:path.join(dir,'sql-wasm.wasm')}],compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],bindings:{LAB_TOKEN:secret},d1Databases:['DB','AUX','RECOVERY_LOG'],cf:false,log:new Log(LogLevel.NONE),outboundService:r=>{outbound.push(r.url);return new Response('HOSTINGER_UNAVAILABLE',{status:503});}});
 try{
  const db=await mf.getD1Database('DB'),aux=await mf.getD1Database('AUX'),log=await mf.getD1Database('RECOVERY_LOG');
  const run=(db,sql)=>db.batch(sqlStatements(sql).map(s=>db.prepare(s)));
  await run(db,old.initializationSql);await run(db,sqlStatements(current.fixtureSql).filter(s=>!/^UPDATE `customers`/.test(s.trim())).join(';'));await run(aux,current.initializationSql);await run(aux,current.fixtureSql);
  await run(db,"CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL); INSERT INTO cashSandboxIdentity VALUES('actual-cash-20261017','primary'); INSERT INTO sqlite_sequence(name,seq) VALUES('onlineOrders',600000);");
  for(const binding of [db,aux])for(const table of old.tables){const columns=table.columns.filter(c=>c.defaultSql==='CURRENT_TIMESTAMP').map(c=>'`'+c.name+"`='2026-10-17 00:00:00'");if(columns.length)await binding.prepare('UPDATE `'+table.name+'` SET '+columns.join(',')).run();}
  const journal=execFileSync('git',['show','5b47adec54e7008ced01b72ac9007dfb83520d81:experiments/d1-continuity/cash/journal-schema.sql'],{cwd:cashRoot,encoding:'utf8'});await run(log,journal);
  const call=async(route,body)=>{const r=await mf.dispatchFetch('http://cash.test'+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};};
  const sale=await call('/test-prepare',{});assert.equal(sale.status,200,JSON.stringify(sale.body));const plan=sale.body.plan;
  const record={version:1,labId:'actual-cash-20261017',schemaVersion:'actual-cash-v1',requestId:plan.requestId,envelopeHash:sha256(canonical(plan.request)),planHash:sha256(canonical(plan)),epoch:plan.expectedEpoch+1,plan};const recordJson=canonical(record),signature=createHmac('sha256',secret).update(recordJson).digest('hex');
  await log.batch([log.prepare('INSERT INTO cashJournalRequests VALUES(?,?,?)').bind(plan.requestId,record.envelopeHash,canonical(plan.request)),log.prepare('INSERT INTO cashJournalAttempts VALUES(?,?,?,?)').bind(record.planHash,plan.requestId,record.epoch,canonical(plan)),log.prepare('INSERT INTO cashJournalCommitted VALUES(?,?,?,?,?)').bind(plan.requestId,record.planHash,record.epoch,recordJson,signature)]);
  const names=[...old.tables.map(t=>t.name),'cashEpoch','cashCommands','cashOutbox','sqlite_sequence'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(names.map(async n=>[n,(await db.prepare('SELECT * FROM `'+n+'`').all()).results.sort((a,b)=>canonical(a).localeCompare(canonical(b)))])));
  const before=await snapshot(),savedLog=(await log.prepare('SELECT * FROM cashJournalCommitted').all()).results;
  await db.prepare('CREATE TABLE cashScopeOnlineOrdersUpgrade(blocked INTEGER)').run();
  const failed=await call('/migrate-scope',{confirm:'ISOLATED_CASH_SCOPE_UPGRADE'});assert.equal(failed.status,503);assert.deepEqual(await snapshot(),before);assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name='customers'").first(),null,'Native DDL batch did not roll back');await db.prepare('DROP TABLE cashScopeOnlineOrdersUpgrade').run();
  const migrated=await call('/migrate-scope',{confirm:'ISOLATED_CASH_SCOPE_UPGRADE'});assert.equal(migrated.status,200,JSON.stringify(migrated.body));assert.equal(migrated.body.journalHeadInstalled,true);assert.equal(migrated.body.emptyOnlineOrdersRebuilt,true);assert.deepEqual(await snapshot(),before);assert.deepEqual((await log.prepare('SELECT * FROM cashJournalCommitted').all()).results,savedLog);
  assert.deepEqual(await log.prepare('SELECT * FROM cashJournalHead').first(),{id:1,epoch:2,committedCount:1});assert.equal((await db.prepare("SELECT seq FROM sqlite_sequence WHERE name='onlineOrders'").first()).seq,600000);
  const repeat=await call('/migrate-scope',{confirm:'ISOLATED_CASH_SCOPE_UPGRADE'});assert.equal(repeat.status,200);assert.equal(repeat.body.journalHeadInstalled,false);assert.equal(repeat.body.emptyOnlineOrdersRebuilt,false);assert.deepEqual(await snapshot(),before);
  const next=await call('/sale',{...plan.request.input,clientRequestId:'legacy-upgrade-next'});assert.equal(next.status,200,JSON.stringify(next.body));assert.equal((await db.prepare('SELECT COUNT(*) n FROM invoices').first()).n,2);assert.equal((await log.prepare('SELECT * FROM cashJournalHead').first()).committedCount,2);
  assert.equal(outbound.length,0);await writeFile(path.join(cashRoot,'results/scoped-state-20261018/legacy-upgrade.json'),JSON.stringify({passed:true,legacySchemaSha256:sha256(old.initializationSql),oldFinancialTablesUnchanged:true,oldRowsAndSequencePreserved:true,oldJournalBytePreserved:true,nativeDdlRollback:true,idempotent:true,deletedOrderHighWater:600000,newActualCashAfterUpgrade:true,outboundAttempts:0},null,2));
 }finally{await mf.dispose();}
});
