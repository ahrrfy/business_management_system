import test from 'node:test';
import assert from 'node:assert/strict';
import {cashCloudClient} from './cloud-client.mjs';
const context={source:'https://cash.test',restore:'https://restore.test',secret:'synthetic-test-only'};

for(const failure of ['lost-response','edge-html','writer-restart']) test('saved command survives '+failure+' with exact replay and reconciliation',async()=>{
 const sent=[];let count=0;
 const input={clientRequestId:'original-request-1',payment:{amount:'100.00',method:'CASH'}};
 const call=cashCloudClient(context,()=>count++,{pause:()=>{},fetch:async(url,request)=>{
  sent.push({url,request});
  if(sent.length===1){if(failure==='lost-response')throw TypeError('connection lost after commit');if(failure==='writer-restart')return Response.json({code:'CASH_WRITER_UNAVAILABLE'},{status:503});return new Response('<html>edge unavailable</html>',{status:503});}
  if(url.includes('/operation/'))return Response.json({state:'CONFIRMED'});
  return Response.json({invoiceId:7,idempotentReplay:true});
 }});
 const result=await call(context.source,'/sale',input,'retained-fault');
 assert.equal(result.body.invoiceId,7);assert.equal(count,3);
 assert.equal(sent[0].request.body,JSON.stringify(input));assert.equal(sent[2].request.body,sent[0].request.body);
 assert.equal(sent[2].request.headers['x-cash-fault'],'retained-fault');
 assert.equal(result.transportAttempts[0].reconciliation.state,'CONFIRMED');
});

test('business rejection and invalid target never become financial retries',async()=>{
 let count=0;const call=cashCloudClient(context,()=>count++,{pause:()=>{},fetch:async()=>Response.json({code:'INSUFFICIENT_STOCK'},{status:503})});
 assert.equal((await call(context.source,'/sale',{clientRequestId:'saved-key'})).status,503);assert.equal(count,1);
 await assert.rejects(call('https://unapproved.test','/sale',{}),/UNAPPROVED/);assert.equal(count,1);
});

test('queue overflow is explicit and never becomes a tight financial retry loop',async()=>{
 let count=0;const call=cashCloudClient(context,()=>count++,{pause:()=>{},fetch:async()=>Response.json({code:'CASH_WRITER_QUEUE_FULL'},{status:503})});
 assert.equal((await call(context.source,'/sale',{clientRequestId:'saved-key'})).status,503);assert.equal(count,1);
});

test('persistent transport failure stops at the bounded budget',async()=>{
 let count=0;const call=cashCloudClient(context,()=>count++,{pause:()=>{},fetch:async()=>{throw TypeError('offline');}});
 await assert.rejects(call(context.source,'/sale',{clientRequestId:'saved-key'}),error=>error.transportAttempts.length===5);
 assert.equal(count,10);
});

test('Worker1102 resource exhaustion is surfaced without repeated financial attempts',async()=>{
 let count=0;const call=cashCloudClient(context,()=>count++,{pause:()=>{},fetch:async()=>new Response('<title>Worker exceeded resource limits</title><span class="cf-error-code">1102</span>',{status:503})});
 const result=await call(context.source,'/sale',{clientRequestId:'saved-key'});
 assert.equal(result.body.code,'WORKER_RESOURCE_LIMIT');assert.equal(count,1);
});
