import test from 'node:test';
import assert from 'node:assert/strict';
import {CashWriterQueue} from './writer-queue.ts';
const gate=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
const tick=()=>new Promise(r=>setImmediate(r));

test('admitted waiter precedes continuing new sales, with only one active writer',async()=>{
 const queue=new CashWriterQueue(),hold=gate(),order=[];
 const first=queue.run(async()=>{order.push('first');await hold.promise;return 1;});
 await tick();
 const waiting=queue.run(async()=>{order.push('waiting');return 2;});
 const later=Array.from({length:5},(_,i)=>queue.run(async()=>{order.push('later-'+i);return i+3;}));
 try{await tick();assert.equal(queue.stats().active,1);assert.deepEqual(order,['first']);}
 finally{hold.release();}
 const results=await Promise.all([first,waiting,...later]);
 assert.deepEqual(order,['first','waiting',...Array.from({length:5},(_,i)=>'later-'+i)]);
 assert.deepEqual(results.map(r=>r.admissionSequence),[1,2,3,4,5,6,7]);
 assert.deepEqual(queue.stats(),{pending:0,active:0,maxActive:1});
});

test('a rejected operation drains the queue; overflow never executes work',async()=>{
 const queue=new CashWriterQueue(2),hold=gate();let overflowRan=false;
 const first=queue.run(async()=>{await hold.promise;throw Error('SIMULATED_FAILURE');});
 const rejected=assert.rejects(first,/SIMULATED_FAILURE/);
 const next=queue.run(async()=>99);
 await assert.rejects(queue.run(async()=>{overflowRan=true;}),/CASH_WRITER_QUEUE_FULL/);
 assert.equal(overflowRan,false);hold.release();await rejected;
 assert.equal((await next).value,99);assert.deepEqual(queue.stats(),{pending:0,active:0,maxActive:1});
 assert.equal((await queue.run(async()=>100)).value,100);
});
