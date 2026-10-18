import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,open} from 'node:fs/promises';
import path from 'node:path';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {buildActualCashWorker,cashRoot} from './build.mjs';
import {sqlStatements} from './sql-statements.mjs';

test('native cash writer: cross-frontend FIFO, overflow, restart after commit and independent restore',async()=>{
 const buildRoot=path.resolve(cashRoot,'../../../.superpowers/sdd/cash-writer-test-build');
 const entry=String.raw`import coordinated,{CashWriter} from './coordinated-worker';
 import core from './worker';import {cashTestBindings} from './test-bindings';
 export class TestCashWriter extends CashWriter {
  state={released:false,waiting:false,restartWaiting:false,restartReleased:false,abort:()=>this.ctx.abort('SIMULATED_WRITER_RESTART_AFTER_PRIMARY')};
  execute(request){if(request.headers.get('x-cash-fault')==='test-throw')throw Error('SIMULATED_EXECUTION_THROW');const test=cashTestBindings(this.env,request,this.state);return core.fetch(request,test.env);}
  async fetch(request){const p=new URL(request.url).pathname;
   if(p==='/test-state')return Response.json({...this.queue.stats(),instance:this.instance,waiting:this.state.waiting,restartWaiting:this.state.restartWaiting});
   if(p==='/test-release'){this.state.released=true;return Response.json({released:true});}
   if(p==='/test-release-restart'){this.state.restartReleased=true;return Response.json({released:true});}
   return super.fetch(request);
  }
 } export default coordinated;`;
 await buildActualCashWorker({stdin:entry,outfile:path.join(buildRoot,'worker.mjs')});
 const modules=[{type:'ESModule',path:path.join(buildRoot,'worker.mjs')},{type:'CompiledWasm',path:path.join(buildRoot,'sql-wasm.wasm')}];
 const outbound=[],secret='local-synthetic-cash-writer-key-20261018';
 const options={modules,compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],bindings:{LAB_TOKEN:secret},outboundService:async r=>{outbound.push(r.url);return new Response('HOSTINGER_UNAVAILABLE',{status:503});}};
 const global={cf:false,log:new Log(LogLevel.NONE)};
 const source=new Miniflare({...global,workers:[
  {...options,name:'primary',d1Databases:{DB:'writer-primary',RECOVERY_LOG:'writer-journal'},durableObjects:{CASH_WRITER:{className:'TestCashWriter',useSQLite:true}}},
  {...options,name:'second-front',durableObjects:{CASH_WRITER:{className:'TestCashWriter',scriptName:'primary'}}},
 ]});
 const restore=new Miniflare({...global,...options,d1Databases:{DB:'writer-restore'}});
 let disposed=false;
 const input=id=>({branchId:1,shiftId:1,sourceType:'POS',clientRequestId:id,lines:[{variantId:1,productUnitId:1,quantity:'2'}],payment:{amount:'200',method:'CASH'}});
 const call=async(runtime,route,data,fault='',extra={})=>{
  const init={method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json','x-cash-profile':'1',...(fault?{'x-cash-fault':fault}:{}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})};
  const r=(runtime===source||runtime===restore)?await runtime.dispatchFetch('http://cash.test'+route,init):await runtime.fetch('http://cash.test'+route,init);
  return {status:r.status,body:await r.json(),writer:JSON.parse(r.headers.get('x-cash-writer')??'null'),profile:JSON.parse(r.headers.get('x-cash-profile')??'null')};
 };
 try{
  const db=await source.getD1Database('DB','primary'),journal=await source.getD1Database('RECOVERY_LOG','primary'),rd=await restore.getD1Database('DB');
  const init=async(binding,sql)=>binding.batch(sqlStatements(sql).map(s=>binding.prepare(s)));
  const schema=await readFile(path.join(buildRoot,'schema.sql'),'utf8'),fixture=await readFile(path.join(buildRoot,'fixture.sql'),'utf8'),metadata=JSON.parse(await readFile(path.join(buildRoot,'tables.json'),'utf8'));
  for(const[binding,role]of[[db,'primary'],[rd,'restore']]){
   await init(binding,schema);await init(binding,fixture);
   await init(binding,`CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL); INSERT INTO cashSandboxIdentity VALUES('actual-cash-20261017','${role}');`);
   for(const table of metadata){const names=table.columns.filter(c=>c.defaultSql==='CURRENT_TIMESTAMP').map(c=>'`'+c.name+"`='2026-10-17 00:00:00'");if(names.length)await binding.prepare('UPDATE `'+table.name+'` SET '+names.join(',')).run();}
  }
  await init(journal,await readFile(path.join(cashRoot,'journal-schema.sql'),'utf8'));
  const secondary=await source.getWorker('second-front');
  const ns=await source.getDurableObjectNamespace('CASH_WRITER','primary');
  const stub=()=>ns.get(ns.idFromName('actual-cash-20261017:primary:writer-v1'));
  const control=async route=>(await (await stub().fetch('http://cash.test'+route)).json());
  const until=async predicate=>{for(let i=0;i<500;i++){const s=await control('/test-state');if(predicate(s))return s;await new Promise(r=>setTimeout(r,10));}throw Error('WRITER_TEST_BARRIER_TIMEOUT');};
  const initial=(await call(source,'/snapshot')).body.tables;
  const absent=await call(restore,'/sale',input('cash-writer-no-binding'),' ',{'x-cash-writer-bypass':'1'});
  assert.equal(absent.status,503);assert.equal(absent.body.code,'CASH_WRITER_UNAVAILABLE');
  assert.deepEqual((await call(restore,'/snapshot')).body.tables,initial);
  assert.equal((await call(source,'/sale',input('cash-writer-unauthorized'),'',{authorization:'Bearer wrong'})).status,401);
  assert.equal((await call(source,'/sale',{...input('cash-writer-invalid'),payment:{method:'CASH',amount:'wrong'}})).status,400);
  assert.equal((await call(source,'/sale',input('x'.repeat(51)))).status,400,
    'The HTTP key limit must match original invoices.sourceId varchar(50) before queue admission');

  const first=call(source,'/sale',input('cash-writer-held'),'hold-journal');
  await until(s=>s.waiting);
  const waiting=call(secondary,'/sale',input('cash-writer-waiting'));
  await until(s=>s.pending===2);
  const later=Array.from({length:6},(_,i)=>call(i%2?secondary:source,'/sale',input('cash-writer-later-'+i)));
  await until(s=>s.pending===8);
  const beforeOverflow=(await call(source,'/snapshot')).body.tables;
  const overflowInput=input('cash-writer-overflow');
  const overflow=await call(secondary,'/sale',overflowInput);
  assert.equal(overflow.status,503);assert.equal(overflow.body.code,'CASH_WRITER_QUEUE_FULL');
  assert.deepEqual((await call(source,'/snapshot')).body.tables,beforeOverflow);
  await control('/test-release');
  const admitted=await Promise.all([first,waiting,...later]);
  assert.ok(admitted.every(r=>r.status===200&&r.body.recoveryAcknowledged));
  assert.equal(admitted[0].writer.admissionSequence,1);
  assert.equal(admitted[1].writer.admissionSequence,2);
  assert.equal(admitted[1].body.invoiceId,2,'Admitted waiter must precede all later submissions');
  assert.deepEqual(admitted.map(r=>r.writer.admissionSequence).sort((a,b)=>a-b),[1,2,3,4,5,6,7,8]);
  assert.equal(new Set(admitted.map(r=>r.writer.instance)).size,1,'Different frontends must share the same object');
  assert.ok(admitted.every(r=>r.writer.maxActive===1));
  assert.ok(admitted.every(r=>r.profile.rpcCount===7),'Outer Worker must preserve actual D1 profile');
  assert.equal((await call(source,'/sale',overflowInput)).body.invoiceId,9);

  const same=input('cash-writer-same-key');
  const sameResults=await Promise.all([call(source,'/sale',same),call(secondary,'/sale',same),call(source,'/sale',same)]);
  assert.ok(sameResults.every(r=>r.status===200));assert.equal(new Set(sameResults.map(r=>r.body.invoiceId)).size,1);
  assert.equal((await call(source,'/sale',{...same,payment:{amount:'100',method:'CASH'},lines:[{variantId:1,productUnitId:1,quantity:'1'}]})).status,409);
  assert.equal((await call(source,'/sale',input('cash-writer-statement-failure'),'last-statement')).status,503);
  assert.equal((await call(source,'/sale',input('cash-writer-execution-throw'),'test-throw')).status,503);
  assert.equal((await call(source,'/sale',input('cash-writer-after-failure'))).body.invoiceId,11);

  const lost=input('cash-writer-lost-response');
  assert.equal((await call(source,'/sale',lost,'drop-response')).status,503);
  const replay=await call(secondary,'/sale',lost);assert.equal(replay.status,200);assert.equal(replay.body.invoiceId,12);
  assert.equal((await call(source,'/sale',lost)).body.invoiceId,12);

  const oldInstance=(await control('/test-state')).instance;
  const resetInput=input('cash-writer-reset-primary'),queuedInput=input('cash-writer-reset-queued');
  const resetting=call(source,'/sale',resetInput,'writer-reset-after-primary');
  await until(s=>s.restartWaiting);
  const queued=call(secondary,'/sale',queuedInput);await until(s=>s.pending===2);
  const releaseReset=control('/test-release-restart');
  const interrupted=await Promise.all([resetting,queued]);await releaseReset;
  assert.equal(interrupted[0].status,503);
  assert.equal((await call(source,'/operation/'+resetInput.clientRequestId)).body.state,'PRIMARY_COMMITTED_RECOVERY_PENDING');
  assert.notEqual((await control('/test-state')).instance,oldInstance,'Native abort must construct a new object');
  const resetReplay=await call(source,'/sale',resetInput);assert.equal(resetReplay.status,200);assert.equal(resetReplay.body.invoiceId,13);
  const queuedReplay=await call(secondary,'/sale',queuedInput);assert.equal(queuedReplay.status,200);assert.equal(queuedReplay.body.invoiceId,14);
  assert.equal((await call(source,'/sale',resetInput)).body.invoiceId,13);
  assert.equal((await call(source,'/sale',queuedInput)).body.invoiceId,14);
  const final=(await call(source,'/snapshot')).body.tables;
  assert.equal(final.invoices.length,14);assert.equal(final.receipts.length,14);assert.equal(final.inventoryMovements.length,14);assert.equal(final.accountingEntries.length,28);
  assert.equal(final.branchStock.find(r=>r.variantId===1).quantity,72);
  const log=(await call(source,'/recovery-log')).body;
  const resultDir=path.join(cashRoot,'results/fair-writer-20261018');await mkdir(resultDir,{recursive:true});
  const file=path.join(resultDir,'signed-writer-recovery.json'),handle=await open(file,'w');try{await handle.writeFile(JSON.stringify(log));await handle.sync();}finally{await handle.close();}
  await source.dispose();disposed=true;
  const saved=JSON.parse(await readFile(file,'utf8'));
  for(const record of saved.records){const r=await call(restore,'/restore',{records:[record]});assert.equal(r.status,200);assert.equal(r.body.journalBindingPresent,false);}
  assert.deepEqual((await call(restore,'/snapshot')).body.tables,final);
  for(const record of [saved.records[0],saved.records.at(-1)])assert.equal((await call(restore,'/restore',{records:[record]})).status,200);
  assert.deepEqual((await call(restore,'/snapshot')).body.tables,final);
  assert.equal(outbound.length,0);
  console.log(JSON.stringify({committedSales:14,restoredSales:14,frontends:2,singleActiveWriter:true,realObjectRestart:true,noDirectFallback:true,outboundAttempts:0}));
 }finally{if(!disposed)await source.dispose();await restore.dispose();}
});
