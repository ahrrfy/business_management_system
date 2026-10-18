import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,open}from'node:fs/promises';
import {randomUUID}from'node:crypto';import path from'node:path';
import{Miniflare,Log,LogLevel}from'miniflare';
import{buildActualCashWorker,cashRoot}from'./build.mjs';import{sqlStatements}from'./sql-statements.mjs';
import{readPagedSnapshot,exportPagedJournal,journalFileRecords,validateJournalFile}from'./paged-client.mjs';

assert.deepEqual(process.argv.slice(2),['--confirm-isolated-local-cash']);
const prefix='sc-'+randomUUID(),dir=path.join(cashRoot,'results/scoped-state-20261018',prefix),buildDir=path.join(cashRoot,'build/scoped-scale');await mkdir(dir,{recursive:true});
// workerd on Windows needs a short persistence path for its namespace/hash files.
const persistDir=path.resolve(cashRoot,'../../../.superpowers/sdd/sc-'+randomUUID().slice(0,8));await mkdir(persistDir);await writeFile(path.join(dir,'persistence.json'),JSON.stringify({path:persistDir},null,2));
const secret='cash-scale-local-synthetic-key-only',outbound=[];
const entry=String.raw`import coordinated,{CashWriter}from'./coordinated-worker';import core from'./worker';import{createWithRecovery}from'./journal';import{cashProfiler}from'./profile';
export class ScaleCashWriter extends CashWriter{
 async execute(request){const input=await request.json();if(input.shiftId<1||input.shiftId>8)throw Error('INVALID_SYNTHETIC_CASHIER');const p=cashProfiler(this.env);try{const result=await createWithRecovery(p.env,input,{userId:input.shiftId,branchId:1,role:'cashier'},request.headers.get('x-cash-fault')??'');return Response.json(result,{headers:{'x-cash-profile':JSON.stringify(p.result())}});}catch(e){return Response.json({code:e.code??e.message,message:e.message},{status:e.status??503,headers:{'x-cash-profile':JSON.stringify(p.result())}});}}
 async fetch(request){if(new URL(request.url).pathname==='/test-reset')this.ctx.abort('SCALE_WRITER_RESET');return super.fetch(request);}
}export default coordinated;`;
await buildActualCashWorker({stdin:entry,outfile:path.join(buildDir,'worker.mjs')});
const modules=[{type:'ESModule',path:path.join(buildDir,'worker.mjs')},{type:'CompiledWasm',path:path.join(buildDir,'sql-wasm.wasm')}];
const options={modules,compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],bindings:{LAB_TOKEN:secret},outboundService:async r=>{outbound.push(r.url);return new Response('HOSTINGER_UNAVAILABLE',{status:503});}};
const source=new Miniflare({cf:false,log:new Log(LogLevel.NONE),d1Persist:path.join(persistDir,'src'),durableObjectsPersist:path.join(persistDir,'do'),workers:[{...options,name:'primary',d1Databases:{DB:'scale-primary',RECOVERY_LOG:'scale-journal'},durableObjects:{CASH_WRITER:{className:'ScaleCashWriter',useSQLite:true}}},{...options,name:'second-front',durableObjects:{CASH_WRITER:{className:'ScaleCashWriter',scriptName:'primary'}}}]});
const restore=new Miniflare({cf:false,log:new Log(LogLevel.NONE),...options,d1Persist:path.join(persistDir,'restore'),d1Databases:{DB:'scale-restore'}});
let sourceDisposed=false,requests=0;const pending=[];const phases=[];
const makeInput=(i)=>({branchId:1,shiftId:i%8+1,sourceType:'POS',clientRequestId:prefix+'-'+i,lines:[{variantId:1,productUnitId:1,quantity:'1'}],payment:{method:'CASH',amount:'100'}});
const inputs=Array.from({length:5001},(_,i)=>makeInput(i));
async function save(name,value){const h=await open(path.join(dir,name),'wx');try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}}
const call=async(target,route,input,fault='')=>{requests++;assert.ok(requests<30000);const init={method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json','x-cash-profile':'1',...(fault?{'x-cash-fault':fault}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})};const start=performance.now();const response=target===source||target===restore?await target.dispatchFetch('http://cash.test'+route,init):await target.fetch('http://cash.test'+route,init);return{status:response.status,body:await response.json(),ms:performance.now()-start,profile:JSON.parse(response.headers.get('x-cash-profile')??'null'),writer:JSON.parse(response.headers.get('x-cash-writer')??'null')};};
try{
 const db=await source.getD1Database('DB','primary'),journal=await source.getD1Database('RECOVERY_LOG','primary'),rd=await restore.getD1Database('DB');const init=async(b,sql)=>b.batch(sqlStatements(sql).map(s=>b.prepare(s)));
 const schema=await readFile(path.join(buildDir,'schema.sql'),'utf8'),fixture=await readFile(path.join(buildDir,'fixture.sql'),'utf8'),metadata=JSON.parse(await readFile(path.join(buildDir,'tables.json'),'utf8'));
 for(const[b,role]of[[db,'primary'],[rd,'restore']]){
  await init(b,schema);await init(b,fixture);await init(b,`CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL);INSERT INTO cashSandboxIdentity VALUES('actual-cash-20261017','${role}');UPDATE branchStock SET quantity=20000 WHERE id=1;`);
  for(let i=2;i<=8;i++)await init(b,`INSERT INTO users(id,openId,name,role,loginMethod,branchId) VALUES(${i},'scale-user-${i}','Synthetic Cashier ${i}','cashier','local',1);INSERT INTO shifts(id,userId,branchId,shiftStatus,shiftType,openingBalance,openGuard) VALUES(${i},${i},1,'OPEN','RETAIL','0.00','${i}:1:RETAIL');`);
  await b.prepare("WITH RECURSIVE n(id) AS(SELECT 3 UNION ALL SELECT id+1 FROM n WHERE id<1103) INSERT INTO productVariants(id,productId,sku,costPrice) SELECT id,1,'UNRELATED-'||id,'40.00' FROM n").run();
  for(const t of metadata){const cols=t.columns.filter(c=>c.defaultSql==='CURRENT_TIMESTAMP').map(c=>'`'+c.name+"`='2026-10-17 00:00:00'");if(cols.length)await b.prepare('UPDATE `'+t.name+'` SET '+cols.join(',')).run();}
 }
 await init(journal,await readFile(path.join(cashRoot,'journal-schema.sql'),'utf8'));await save('inputs.json',{prefix,at:new Date().toISOString(),inputs,openingStock:20000,originalSourceSha256:JSON.parse(await readFile(path.join(buildDir,'source-evidence.json'),'utf8')).originalSourceSha256});
 const secondary=await source.getWorker('second-front');let offset=0;
 for(const[commands,concurrency]of[[1000,1],[2000,4],[2000,8]]){
  const jobs=inputs.slice(offset,offset+commands),results=[];let index=0,stop=false;const start=performance.now();
  const workers=await Promise.allSettled(Array.from({length:concurrency},async()=>{while(index<jobs.length&&!stop){const input=jobs[index++];pending.push(input.clientRequestId);try{const r=await call(index%2?source:secondary,'/sale',input);results.push({requestId:input.clientRequestId,status:r.status,invoiceId:r.body.invoiceId,ms:r.ms,writer:r.writer,stateRead:r.profile?.stateRead,sqlCount:r.profile?.sqlCount,code:r.body.code});if(r.status!==200||r.body.recoveryAcknowledged!==true){stop=true;throw Error(JSON.stringify(r));}}catch(e){stop=true;throw e;}}}));
  const seconds=(performance.now()-start)/1000;await save('phase-'+concurrency+'-measurements.json',{commands,concurrency,seconds,results,workerErrors:workers.filter(r=>r.status==='rejected').map(r=>r.reason.message)});
  assert.ok(workers.every(r=>r.status==='fulfilled'));assert.equal(results.length,commands);const times=results.map(r=>r.ms).sort((a,b)=>a-b);const writers=results.map(r=>r.writer);
  assert.equal(new Set(writers.map(w=>w.instance)).size,1);assert.equal(new Set(writers.map(w=>w.admissionSequence)).size,commands);assert.ok(writers.every(w=>w.maxActive===1));
  const ordered=[...results].sort((a,b)=>a.writer.admissionSequence-b.writer.admissionSequence);assert.ok(ordered.every((r,i)=>!i||r.invoiceId>ordered[i-1].invoiceId));
  for(const r of results){assert.equal(r.stateRead.mode,'CASH_SCOPED');assert.ok(r.stateRead.totalRows<=16);for(const name of['invoices','receipts','accountingEntries','inventoryMovements','invoiceAttributions'])assert.equal(r.stateRead.rows[name],0);assert.ok(r.stateRead.bytes<16000);assert.equal(r.sqlCount,r.invoiceId===1?28:29,'First invoice creates its counter; later invoices update its preimage');}
  const phase={commands,concurrency,seconds,rps:commands/seconds,p50:times[Math.ceil(commands*.5)-1],p95:times[Math.ceil(commands*.95)-1],max:times.at(-1),maxHydratedRows:Math.max(...results.map(r=>r.stateRead.totalRows)),maxHydratedBytes:Math.max(...results.map(r=>r.stateRead.bytes)),conflictRetries:0,transportRetries:0,distinctSyntheticCashiers:8,frontends:2};phases.push(phase);offset+=commands;console.log(JSON.stringify({phase}));
 }
 const faultInput=inputs.at(-1),uncertain=await call(source,'/sale',faultInput,'after-primary');assert.equal(uncertain.status,503);assert.equal(uncertain.body.code,'PRIMARY_COMMITTED_RECOVERY_PENDING');
 const lookup=await call(source,'/operation/'+faultInput.clientRequestId);assert.equal(lookup.body.state,'PRIMARY_COMMITTED_RECOVERY_PENDING');
 const ns=await source.getDurableObjectNamespace('CASH_WRITER','primary');try{await ns.get(ns.idFromName('actual-cash-20261017:primary:writer-v1')).fetch('http://cash.test/test-reset');}catch{}
 const repaired=await call(source,'/sale',faultInput);assert.equal(repaired.status,200);assert.equal(repaired.body.invoiceId,5001);assert.notEqual(repaired.writer.instance,uncertain.writer.instance);
 for(const input of[inputs[0],inputs[2500],faultInput]){const r=await call(source,'/sale',input);assert.equal(r.status,200);assert.equal(r.body.idempotentReplay,true);}
 const altered=structuredClone(inputs[0]);altered.payment.amount='101';assert.equal((await call(source,'/sale',altered)).status,409);
 let revenue=0n,cost=0n,profit=0n,cash=0n,stock=null;const cents=s=>{assert.match(s,/^-?\d+\.\d{2}$/);return BigInt(s.replace('.',''));};
 const original=await readPagedSnapshot(call,source,{onRow(name,row){if(name==='accountingEntries'&&row.entryType==='SALE'){revenue+=cents(row.revenue);cost+=cents(row.cost);profit+=cents(row.profit);}if(name==='receipts'){assert.equal(row.direction,'IN');assert.equal(row.cashBucket,'DRAWER');assert.equal(row.createdBy,row.shiftId);cash+=cents(row.amount);}if(name==='branchStock'&&row.id===1)stock=row.quantity;}});
 assert.deepEqual([revenue,cost,profit,cash],[50010000n,25005000n,25005000n,50010000n]);assert.equal(stock,14999);for(const name of['invoices','invoiceItems','receipts','inventoryMovements','invoiceAttributions','cashCommands','cashOutbox','idempotencyKeys'])assert.equal(original.counts[name],5001,name);assert.equal(original.counts.accountingEntries,10002);
 await save('source-snapshot.json',original);const file=path.join(dir,'signed-recovery.ndjson');await assert.rejects(()=>exportPagedJournal(call,source,file,secret,{snapshotSha256:original.sha256,snapshotEpoch:original.epoch,interruptAfterPages:1}),/SIMULATED_EXPORT_INTERRUPTION_AFTER_FSYNC/);
 const exported=await exportPagedJournal(call,source,file,secret,{snapshotSha256:original.sha256,snapshotEpoch:original.epoch,resume:true});assert.equal(exported.count,5001);await save('export.json',exported);
 await source.dispose();sourceDisposed=true;let restored=0,firstRecord,lastRecord;
 for await(const record of journalFileRecords(file,secret)){firstRecord??=record;lastRecord=record;const r=await call(restore,'/restore',{records:[record]});assert.equal(r.status,200);assert.equal(r.body.journalBindingPresent,false);assert.equal(r.body.applied,1);restored++;if(restored===17){const repeat=await call(restore,'/restore',{records:[record]});assert.equal(repeat.body.replayed,1);}}
 for(const record of[firstRecord,lastRecord])assert.equal((await call(restore,'/restore',{records:[record]})).body.replayed,1);
 const recovered=await readPagedSnapshot(call,restore);assert.equal(recovered.sha256,original.sha256);assert.deepEqual(recovered.counts,original.counts);assert.equal((await validateJournalFile(file,secret)).sha256,exported.sha256);assert.equal(outbound.length,0);
 const result={passed:true,at:new Date().toISOString(),prefix,phases,measuredSales:5000,totalSales:5001,recoveryRecords:restored,sourceDisposedBeforeRestore:true,realWriterRestart:true,exportResumedAfterFsync:true,restoreReplays:3,changedPayloadRejected:true,source:original,restore:recovered,checkpoint:exported,checkpointFile:file,requests,outboundAttempts:outbound.length,money:{revenue:'500100.00',cost:'250050.00',profit:'250050.00',cashIn:'500100.00'},stock:{before:20000,after:stock}};await save('result.json',result);await writeFile(path.join(cashRoot,'results/scoped-state-20261018/scale-latest.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:true,dir,phases,sales:5001,restored,requests,checkpointSha256:exported.sha256}));
}catch(e){await save('failure.json',{at:new Date().toISOString(),error:e.message,stack:e.stack,phases,pending});throw e;}
finally{if(!sourceDisposed)await source.dispose();await restore.dispose();}
