import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare,Log,LogLevel} from 'miniflare';
import {buildActualWorker} from './build.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
test('actual Worker paths, independent journal acknowledgements and external-log recovery',async()=>{
  const bundle=await buildActualWorker({entry:path.join(root,'worker.ts'),write:false});
  const script=bundle.outputFiles[0].text, attempts=[];
  const runtime=new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],cf:false,
    d1Databases:{DB:'edge-primary',RECOVERY_LOG:'edge-journal',RESTORE:'edge-restore'},
    log:new Log(LogLevel.NONE),outboundService:async()=>{attempts.push('outbound-denied');return new Response('HOSTINGER_UNAVAILABLE',{status:503});},
    bindings:{LAB_TOKEN:'synthetic-only-local-key',LAB_ID:'edge-actual-test'}});
  const restoreRuntime=new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],cf:false,
    d1Databases:{DB:'edge-restore'},log:new Log(LogLevel.NONE),bindings:{LAB_TOKEN:'synthetic-only-local-key',LAB_ID:'edge-restore-test'}});
  const db=await runtime.getD1Database('DB'), log=await runtime.getD1Database('RECOVERY_LOG'), restored=await restoreRuntime.getD1Database('DB');
  const schema=await readFile(path.join(root,'schema.sql'),'utf8');
  try{
    await db.exec(schema);await db.prepare("INSERT INTO edge_marker VALUES ('edge-actual-20261017','primary')").run();
    await restored.exec(schema);await restored.prepare("INSERT INTO edge_marker VALUES ('edge-actual-20261017','restore')").run();
    await log.exec(await readFile(path.join(root,'journal-schema.sql'),'utf8'));
    const call=async(target,route,input,id='case-request-0001',fault='')=>{
      const response=await target.dispatchFetch('http://lab.invalid'+route,{method:input?'POST':'GET',headers:{authorization:'Bearer synthetic-only-local-key','content-type':'application/json','idempotency-key':id,...(fault?{'x-lab-fault':fault}:{})},...(input?{body:JSON.stringify(input)}:{})});
      return{status:response.status,body:await response.json()};
    };
    assert.equal((await runtime.dispatchFetch('http://lab.invalid/snapshot')).status,401);
    assert.equal((await call(runtime,'/sale',{})).status,501);
    const quoted=await call(runtime,'/quote',{productUnitId:1,tier:'RETAIL',quantity:1,discount:'0.01',taxRate:'5',fee:'2'});
    assert.equal(quoted.status,200);assert.equal(quoted.body.totals.total,'131.61');
    const input={lines:[{productId:1,productUnitId:1,quantity:1},{productId:1,productUnitId:1,quantity:2}]};
    const state=async()=>({main:(await db.prepare('SELECT * FROM storefrontCartShares ORDER BY id').all()).results,ops:(await db.prepare('SELECT * FROM edge_operations ORDER BY id').all()).results});
    assert.equal((await call(runtime,'/cart-share',input,'case-log-down-01','log-unavailable')).status,503);
    assert.deepEqual((await state()).main,[]);
    assert.equal((await call(runtime,'/cart-share',input,'case-prepared-01','after-prepare')).status,503);
    assert.deepEqual((await state()).main,[]);
    assert.equal((await call(runtime,'/cart-share',input,'case-primary-01','after-primary')).status,503);
    assert.equal((await state()).main.length,1);
    const first=await call(runtime,'/cart-share',input,'case-primary-01');assert.equal(first.status,200);
    assert.deepEqual(await call(runtime,'/cart-share',input,'case-primary-01'),first);
    const changed=await call(runtime,'/cart-share',{lines:[{productId:2,productUnitId:2,quantity:1}]},'case-primary-01');assert.equal(changed.status,409);
    const same=await Promise.all(Array.from({length:4},()=>call(runtime,'/cart-share',input,'case-concurrent-01')));
    assert.ok(same.every(value=>value.status===200),JSON.stringify(same));
    assert.equal(new Set(same.map(value=>value.body.token)).size,1);
    assert.equal((await call(runtime,'/cart-share',input,'case-drop-01','drop-response')).status,503);
    assert.equal((await call(runtime,'/cart-share',input,'case-drop-01')).status,200);
    // Exercise the maximum supported recovery chunk with original signed records.
    for(let i=0;i<5;i++)assert.equal((await call(runtime,'/cart-share',input,'case-chunk-max-'+i)).status,200);
    const committed=(await log.prepare("SELECT * FROM edge_journal WHERE state='COMMITTED' ORDER BY seq").all()).results;
    assert.equal(committed.length,8);
    assert.equal((await call(restoreRuntime,'/restore',{})).status,404);
    assert.equal((await call(restoreRuntime,'/restore-from-log',{records:[...committed,committed[0]]})).status,400);
    const tampered=structuredClone(committed[1]);tampered.result='{}';
    assert.equal((await call(restoreRuntime,'/restore-from-log',{records:[committed[0],tampered]})).status,400);
    assert.equal((await restored.prepare('SELECT COUNT(*) AS n FROM storefrontCartShares').first()).n,0);
    const restoredState=async()=>({main:(await restored.prepare('SELECT * FROM storefrontCartShares ORDER BY id').all()).results,ops:(await restored.prepare('SELECT * FROM edge_operations ORDER BY id').all()).results});
    // Replay the original valid signature against conflicting local row identity.
    const signedRow=JSON.parse(committed[0].snapshot);
    for(const conflict of [{...signedRow,id:signedRow.id+1000},{...signedRow,createdAt:'2000-01-01 00:00:00'}]){
      await restored.prepare('INSERT INTO storefrontCartShares(id,token,lines,expiresAt,createdAt) VALUES (?,?,?,?,?)').bind(conflict.id,conflict.token,conflict.lines,conflict.expiresAt,conflict.createdAt).run();
      assert.equal((await call(restoreRuntime,'/restore-from-log',{records:[committed[0]]})).status,503);
      assert.deepEqual(await restoredState(),{main:[conflict],ops:[]});
      await restored.prepare('DELETE FROM storefrontCartShares WHERE id=? AND token=? AND createdAt=?').bind(conflict.id,conflict.token,conflict.createdAt).run();
    }
    // A later PK failure must roll back earlier records within this input chunk.
    const secondRow=JSON.parse(committed[1].snapshot), conflict={...secondRow,token:'X'.repeat(24),lines:'[]'};
    await restored.prepare('INSERT INTO storefrontCartShares(id,token,lines,expiresAt,createdAt) VALUES (?,?,?,?,?)').bind(conflict.id,conflict.token,conflict.lines,conflict.expiresAt,conflict.createdAt).run();
    assert.equal((await call(restoreRuntime,'/restore-from-log',{records:committed.slice(0,2)})).status,503);
    assert.deepEqual(await restoredState(),{main:[conflict],ops:[]});
    await restored.prepare('DELETE FROM storefrontCartShares WHERE id=? AND token=?').bind(conflict.id,conflict.token).run();
    const before=await state();
    const recovery=await call(restoreRuntime,'/restore-from-log',{records:committed});
    assert.equal(recovery.status,200);assert.equal(recovery.body.atomicScope,'input-chunk');
    const after=async()=>({main:(await restored.prepare('SELECT * FROM storefrontCartShares ORDER BY id').all()).results,ops:(await restored.prepare('SELECT * FROM edge_operations ORDER BY id').all()).results});
    assert.deepEqual(await after(),before);
    assert.equal((await call(restoreRuntime,'/restore-from-log',{records:committed})).status,200);
    assert.deepEqual(await after(),before);
    assert.deepEqual(attempts,[]);
    await mkdir(path.join(root,'results'),{recursive:true});
    await writeFile(path.join(root,'results/local-integration.json'),JSON.stringify({passed:true,committed:committed.length,externalLogRestore:true,hostingerRequests:0,sourceRows:before.main.length}));
  }finally{await runtime.dispose();await restoreRuntime.dispose();}
});
