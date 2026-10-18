import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {buildActualCashWorker,cashRoot} from './build.mjs';
import {sqlStatements} from './sql-statements.mjs';

test('cash staging reads the invoice scope beyond1,000 unrelated rows and preserves global sequence gaps',async()=>{
 const dir=path.join(cashRoot,'build/scoped-test');
 await buildActualCashWorker({stdin:`import{prepareCashSale,applyCashPlan,fixtureActor}from'./actual';import{cashProjectionSql,cashReadBoundary}from'./cash-state';export default{async fetch(req,env){try{const d=await req.json();if(d.readCost){const bound=JSON.stringify({input:d.input,actor:fixtureActor,...cashReadBoundary()});const result=await env.DB.prepare(cashProjectionSql).bind(bound).all();const plan=await env.DB.prepare('EXPLAIN QUERY PLAN '+cashProjectionSql).bind(bound).all();return Response.json({meta:result.meta,plan:plan.results});}const p=await prepareCashSale(env.DB,d.input,fixtureActor);if(d.apply)await applyCashPlan(env.DB,p.plan);return Response.json(p);}catch(e){return Response.json({error:e.message,code:e.code,cause:e.cause?.message},{status:500});}}};`,outfile:path.join(dir,'worker.mjs')});
 const mf=new Miniflare({modules:[{type:'ESModule',path:path.join(dir,'worker.mjs')},{type:'CompiledWasm',path:path.join(dir,'sql-wasm.wasm')}],compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],cf:false,log:new Log(LogLevel.NONE),outboundService:()=>new Response('HOSTINGER_UNAVAILABLE',{status:503})});
 try{
  const db=await mf.getD1Database('DB');
  for(const name of ['schema.sql','fixture.sql'])await db.batch(sqlStatements(await readFile(path.join(dir,name),'utf8')).map(s=>db.prepare(s)));
  await db.prepare("WITH RECURSIVE n(id) AS(SELECT3 UNION ALL SELECT id+1 FROM n WHERE id<1103) INSERT INTO productVariants(id,productId,sku,costPrice) SELECT id,1,'UNRELATED-'||id,'40.00' FROM n".replace('SELECT3','SELECT 3')).run();
  const input={branchId:1,shiftId:1,sourceType:'POS',clientRequestId:'cash-scoped-first',lines:[{variantId:1,productUnitId:1,quantity:'2'}],payment:{amount:'200',method:'CASH'}};
  const call=async(input,apply=false)=>{const r=await mf.dispatchFetch('http://cash.test/',{method:'POST',body:JSON.stringify({input,apply})});const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
  const first=await call(input);
  assert.equal(first.result.total,'200.00');
  assert.equal(first.snapshot.mode,'CASH_SCOPED');
  assert.equal(first.snapshot.rows.productVariants,1);
  assert.equal(first.snapshot.rows.accountingEntries,0);
  assert.ok(first.snapshot.totalRows<30);
  const metadata=JSON.parse(await readFile(path.join(dir,'tables.json'),'utf8'));
  const writable=['invoices','invoiceItems','inventoryMovements','receipts','accountingEntries','idempotencyKeys','invoiceAttributions'];
  for(const name of writable){await db.prepare('INSERT INTO sqlite_sequence(name,seq) SELECT ?,600000 WHERE NOT EXISTS(SELECT1 FROM sqlite_sequence WHERE name=?)'.replace('SELECT1','SELECT 1')).bind(name,name).run();await db.prepare('UPDATE sqlite_sequence SET seq=600000 WHERE name=?').bind(name).run();}
  await db.prepare('UPDATE cashEpoch SET epoch=epoch+1 WHERE id=1').run();
  const high=await call({...input,clientRequestId:'cash-scoped-high-water'},true);
  assert.equal(high.result.invoiceId,600001);
  for(const name of writable){const changes=high.plan.changes.filter(c=>c.table===name);assert.ok(changes.length);assert.ok(changes.every(c=>c.after.id>600000),name);}
  assert.equal(high.snapshot.rows.invoices,0);
  const response=await mf.dispatchFetch('http://cash.test/',{method:'POST',body:JSON.stringify({input:{...input,clientRequestId:'cash-read-cost-probe'},readCost:true})}),cost=await response.json();assert.equal(response.status,200);assert.ok(cost.meta.rows_read<250,'Unrelated catalog/history must not be scanned');assert.ok(!cost.plan.some(p=>/SCAN (?:invoiceItems|couponRedemptions)\b/.test(p.detail)),'History access requires indexed invoiceId probes');
  assert.equal(metadata.filter(t=>t.columns.some(c=>c.auto)).length>0,true);
  await mkdir(path.join(cashRoot,'results/scoped-state-20261018'),{recursive:true});
  await writeFile(path.join(cashRoot,'results/scoped-state-20261018/projection-proof.json'),JSON.stringify({passed:true,catalogRows:1103,initial:first.snapshot,highWater:high.snapshot,invoiceId:high.result.invoiceId,physicalRead:cost},null,2));
 }finally{await mf.dispose();}
});
