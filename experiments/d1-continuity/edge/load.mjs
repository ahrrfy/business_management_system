import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,open} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cloudContext} from './cloud-run.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
export async function runCloud({confirmSyntheticSandbox=false}={}){
  if(!confirmSyntheticSandbox)throw new Error('EXPLICIT_SYNTHETIC_CONFIRMATION_REQUIRED');
  const {runtime,token,root}=await cloudContext();
  const base=`https://erp-edge-poc-20261017-${runtime.suffix}.${runtime.subdomain}.workers.dev`;
  const restore=`https://erp-edge-poc-20261017-${runtime.suffix}-restore.${runtime.subdomain}.workers.dev`;
  const records=[],cases=[],prefix='edge_'+randomUUID().replaceAll('-','');
  const call=async(route,{input,id,fault,target=base,unauth=false}={})=>{
    if(records.length>=220)throw new Error('REQUEST_BUDGET_EXHAUSTED');
    const start=performance.now();
    const response=await fetch(target+route,{method:input?'POST':'GET',headers:{'content-type':'application/json',...(!unauth?{authorization:`Bearer ${token}`}:{ }),...(id?{'idempotency-key':id}:{}),...(fault?{'x-lab-fault':fault}:{})},...(input?{body:JSON.stringify(input)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
    let body;try{body=await response.json();}catch{throw new Error(`NON_JSON_HTTP_${response.status}`);}
    records.push({route,status:response.status,ms:performance.now()-start,workerWallMs:response.headers.get('x-lab-wall-ms'),target:target===base?'primary':'restore'});
    return{status:response.status,body};
  };
  const scenario=async(name,fn)=>{const start=performance.now();await fn();cases.push({name,passed:true,ms:performance.now()-start});console.log('PASS '+name);};
  const cart={lines:[{productId:1,productUnitId:1,quantity:1},{productId:1,productUnitId:1,quantity:2}]};
  let snapshot,externalFile,load;
  try{
    await scenario('authenticated isolated Worker; unported financial routes explicitly disabled',async()=>{
      assert.equal((await call('/snapshot',{unauth:true})).status,401);
      const status=await call('/status');assert.equal(status.status,200);assert.equal(status.body.financialWritesEnabled,false);
      for(const route of ['/sale','/checkout','/credit','/return','/digital','/dispatch'])assert.equal((await call(route,{input:{}})).status,501);
    });
    await scenario('original pricing and billing execute on cloud D1 with exact totals and missing-tier rejection',async()=>{
      const quoted=await call('/quote',{input:{productUnitId:1,tier:'RETAIL',quantity:1,discount:'0.01',taxRate:'5',fee:'2'}});
      assert.equal(quoted.status,200,JSON.stringify(quoted.body));assert.equal(quoted.body.totals.total,'131.61');
      const wholesale=await call('/quote',{input:{productUnitId:1,tier:'WHOLESALE',quantity:3}});
      assert.equal(wholesale.status,200);assert.equal(wholesale.body.totals.total,'300.03');
      assert.equal((await call('/quote',{input:{productUnitId:1,tier:'GOVERNMENT',quantity:1}})).status,412);
      assert.equal((await call('/quote',{input:{productUnitId:1,tier:'RETAIL',quantity:1,discount:'1e3'}})).status,400);
    });
    await scenario('original cart share recovers dropped response and rejects changed payload',async()=>{
      const id=prefix+'_drop';assert.equal((await call('/cart-share',{input:cart,id,fault:'drop-response'})).status,503);
      const result=await call('/cart-share',{input:cart,id});assert.equal(result.status,200);assert.equal(result.body.lineCount,1);
      assert.deepEqual(await call('/cart-share',{input:cart,id}),result);
      assert.equal((await call('/cart-share',{input:{lines:[{productId:2,productUnitId:2,quantity:1}]},id})).status,409);
    });
    await scenario('independent log outage refuses new write; prepared and primary-committed faults replay safely',async()=>{
      const before=await call('/snapshot');
      assert.equal((await call('/cart-share',{input:cart,id:prefix+'_logdown',fault:'log-unavailable'})).status,503);
      assert.equal((await call('/cart-share',{input:cart,id:prefix+'_prepared',fault:'after-prepare'})).status,503);
      const after=await call('/snapshot');assert.deepEqual(after.body.tables,before.body.tables);
      const id=prefix+'_primary';assert.equal((await call('/cart-share',{input:cart,id,fault:'after-primary'})).status,503);
      assert.equal((await call('/cart-share',{input:cart,id})).status,200);
    });
    await scenario('eight same-key contenders share one original-service token and one database effect',async()=>{
      const results=await Promise.all(Array.from({length:8},()=>call('/cart-share',{input:cart,id:prefix+'_duplicate'})));
      assert.ok(results.every(result=>result.status===200),JSON.stringify(results));
      assert.equal(new Set(results.map(result=>result.body.token)).size,1);
    });
    await scenario('bounded cloud load of original quotes and cart sharing while Hostinger is unused',async()=>{
      const index=records.length,started=performance.now();let next=0;
      await Promise.all(Array.from({length:6},async()=>{while(next<72){const n=next++;let response;
        if(n<60)response=await call('/quote',{input:{productUnitId:2,tier:'RETAIL',quantity:3}});
        else response=await call('/cart-share',{input:cart,id:prefix+'_load_'+n});
        assert.equal(response.status,200,JSON.stringify(response.body));
        if(n<60)assert.equal(response.body.totals.total,'0.03');
      }}));
      const times=records.slice(index).map(row=>row.ms).sort((a,b)=>a-b),elapsed=performance.now()-started;
      load={requests:times.length,concurrency:6,elapsedMs:elapsed,p50Ms:times[Math.ceil(times.length*.5)-1],p95Ms:times[Math.ceil(times.length*.95)-1],maxMs:times.at(-1),requestsPerSecond:times.length/(elapsed/1000),errors:0,quoteRequests:60,cartShareRequests:12,hostinger:'not referenced by bundled actual functions; local outbound-denial separately tested',cpuMeasurement:'not available from this token; wall latency only'};
    });
    await scenario('signed journal fsynced outside Cloudflare; fresh Worker restores with no journal binding',async()=>{
      snapshot=(await call('/snapshot')).body;
      const committed=snapshot.journal.filter(record=>record.state==='COMMITTED');
      assert.ok(committed.length>=15);assert.ok(committed.every(record=>record.snapshot&&record.signature));
      const before=await call('/snapshot',{target:restore});assert.equal(before.body.journal,null);assert.equal(before.body.tables.storefrontCartShares.length,0);
      const dir=await mkdtemp(path.join(os.tmpdir(),'erp-edge-external-journal-'));externalFile=path.join(dir,'signed-journal.json');
      const serialized=JSON.stringify({scope:'actual-cart-share-only',records:committed});
      const handle=await open(externalFile,'wx');try{await handle.writeFile(serialized);await handle.sync();}finally{await handle.close();}
      const fromDisk=await readFile(externalFile,'utf8');assert.equal(sha(fromDisk),sha(serialized));
      const local=JSON.parse(fromDisk);
      const altered=structuredClone(local.records[0]);altered.result='{}';
      assert.equal((await call('/restore-from-log',{input:{records:[altered]},target:restore})).status,400);
      for(let i=0;i<local.records.length;i+=4){const response=await call('/restore-from-log',{input:{records:local.records.slice(i,i+4)},target:restore});assert.equal(response.status,200,JSON.stringify(response.body));}
      const recovered=(await call('/snapshot',{target:restore})).body;
      assert.deepEqual(recovered.tables.storefrontCartShares,snapshot.tables.storefrontCartShares);
      assert.deepEqual(recovered.tables.edge_operations,snapshot.tables.edge_operations);
      for(let i=0;i<local.records.length;i+=4)assert.equal((await call('/restore-from-log',{input:{records:local.records.slice(i,i+4)},target:restore})).status,200);
      const twice=(await call('/snapshot',{target:restore})).body;assert.deepEqual(twice,recovered);
      snapshot.restore={committed:local.records.length,sha256:sha(fromDisk),sourceHash:sha(JSON.stringify(snapshot.tables.storefrontCartShares)),restoredHash:sha(JSON.stringify(recovered.tables.storefrontCartShares)),journalBinding:null,externalFile};
    });
    return{passed:true,cases,load,snapshot,records};
  }finally{
    await mkdir(path.join(root,'results'),{recursive:true});
    const evidence={at:new Date().toISOString(),completedCases:cases.length,expectedCases:7,passed:cases.length===7,cases,load,snapshot,records,externalFile,
      scope:'Original pricing/billing and cart-share creation only; no actual sale/checkout/credit/refund/digital/fulfillment migration.',
      sourceEvidence:JSON.parse(await readFile(path.join(root,'build/source-evidence.json'),'utf8')),deployment:JSON.parse(await readFile(path.join(root,'results/deploy.json'),'utf8'))};
    await writeFile(path.join(root,'results/cloud-latest.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({passed:evidence.passed,cases:cases.length,requests:records.length,load,externalFile}));
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3||process.argv[2]!=='--confirm-synthetic-sandbox')throw new Error('EXPLICIT_SYNTHETIC_CONFIRMATION_REQUIRED');
  await runCloud({confirmSyntheticSandbox:true});
}
