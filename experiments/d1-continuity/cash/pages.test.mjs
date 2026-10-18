import test from 'node:test';import assert from 'node:assert/strict';import {readFile}from'node:fs/promises';import path from'node:path';import{Miniflare,Log,LogLevel}from'miniflare';import{buildActualCashWorker,cashRoot}from'./build.mjs';import{sqlStatements}from'./sql-statements.mjs';
test('bounded journal and state pages pin epochs and reject changed snapshots',async()=>{
 const dir=path.join(cashRoot,'build/pages-test');await buildActualCashWorker({entry:path.join(cashRoot,'worker.ts'),outfile:path.join(dir,'worker.mjs')});
 const token='cash-pages-synthetic-key-only';const mf=new Miniflare({modules:[{type:'ESModule',path:path.join(dir,'worker.mjs')},{type:'CompiledWasm',path:path.join(dir,'sql-wasm.wasm')}],compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'page-primary',RECOVERY_LOG:'page-journal'},bindings:{LAB_TOKEN:token},cf:false,log:new Log(LogLevel.NONE),outboundService:()=>new Response('DENIED',{status:503})});
 const call=async(route,data)=>{const r=await mf.dispatchFetch('http://cash.test'+route,{method:data?'POST':'GET',headers:{authorization:'Bearer '+token},...(data?{body:JSON.stringify(data)}:{})});return {status:r.status,body:await r.json()};};
 try{const db=await mf.getD1Database('DB'),journal=await mf.getD1Database('RECOVERY_LOG');const init=async(db,sql)=>db.batch(sqlStatements(sql).map(s=>db.prepare(s)));
 await init(db,await readFile(path.join(dir,'schema.sql'),'utf8'));await init(db,await readFile(path.join(dir,'fixture.sql'),'utf8'));await init(db,"CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL);INSERT INTO cashSandboxIdentity VALUES('actual-cash-20261017','primary');");await init(journal,await readFile(path.join(cashRoot,'journal-schema.sql'),'utf8'));
 for(let i=0;i<3;i++)assert.equal((await call('/sale',{branchId:1,shiftId:1,sourceType:'POS',clientRequestId:'cash-page-sale-'+i,lines:[{variantId:1,productUnitId:1,quantity:'1'}],payment:{method:'CASH',amount:'100'}})).status,200);
 const first=await call('/recovery-log?afterEpoch=1&limit=2');assert.equal(first.status,200);assert.equal(first.body.records.length,2);assert.equal(first.body.throughEpoch,4);assert.equal(first.body.nextEpoch,3);assert.equal(first.body.complete,false);
 const second=await call('/recovery-log?afterEpoch=3&throughEpoch=4&limit=2');assert.equal(second.status,200);assert.equal(second.body.records.length,1);assert.equal(second.body.complete,true);assert.equal(second.body.nextEpoch,4);
 const manifest=await call('/snapshot?manifest=1');assert.equal(manifest.status,200);assert.equal(manifest.body.epoch,4);assert.equal(manifest.body.tables.find(t=>t.name==='invoices').count,3);
 const page=await call('/snapshot?table=invoices&epoch=4&limit=2');assert.equal(page.status,200);assert.deepEqual(page.body.rows.map(r=>r.id),[1,2]);assert.deepEqual(page.body.nextCursor,[2]);
 const last=await call('/snapshot?table=invoices&epoch=4&limit=2&after='+encodeURIComponent(JSON.stringify(page.body.nextCursor)));assert.deepEqual(last.body.rows.map(r=>r.id),[3]);assert.equal(last.body.complete,true);
 assert.equal((await call('/snapshot?table=sqlite_master&epoch=4')).status,400);
 assert.equal((await call('/snapshot?table=invoices&epoch=4&after='+encodeURIComponent('["wrong"]'))).status,400);
 assert.equal((await call('/recovery-log?afterEpoch=1&throughEpoch=999')).status,409);
 await db.prepare('UPDATE cashEpoch SET epoch=epoch+1 WHERE id=1').run();assert.equal((await call('/snapshot?table=invoices&epoch=4&limit=2')).status,409);
 await journal.batch([
  journal.prepare('INSERT INTO cashJournalRequests VALUES(?,?,?)').bind('cash-gap-fixture','a'.repeat(64),'{}'),
  journal.prepare('INSERT INTO cashJournalAttempts VALUES(?,?,?,?)').bind('b'.repeat(64),'cash-gap-fixture',99,'{}'),
 ]);
 await assert.rejects(()=>journal.prepare('INSERT INTO cashJournalCommitted VALUES(?,?,?,?,?)').bind('cash-gap-fixture','b'.repeat(64),99,'{}','x').run(),/RECOVERY_SEQUENCE_GAP/);
 assert.equal((await call('/recovery-log?afterEpoch=1&limit=2')).status,200,'Rejected journal gap leaves its valid prefix intact');
 }finally{await mf.dispose();}
});
