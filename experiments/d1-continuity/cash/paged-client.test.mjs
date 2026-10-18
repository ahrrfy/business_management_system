import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,mkdir}from'node:fs/promises';import path from'node:path';import{createHmac}from'node:crypto';import{canonical,sha256,exportPagedJournal}from'./paged-client.mjs';import{cashRoot}from'./build.mjs';
test('checkpoint resume rejects another snapshot and fresh export pins the requested epoch',async()=>{
 const parent=path.join(cashRoot,'results/scoped-state-20261018');await mkdir(parent,{recursive:true});const dir=await mkdtemp(path.join(parent,'client-contract-')),secret='synthetic-paged-checkpoint-test';
 const empty=async()=>({status:200,body:{labId:'actual-cash-20261017',schemaVersion:'actual-cash-v1',afterEpoch:1,throughEpoch:1,nextEpoch:1,complete:true,records:[]}});
 const good=path.join(dir,'empty.ndjson');await exportPagedJournal(empty,'local',good,secret,{snapshotSha256:'a'.repeat(64),snapshotEpoch:1});
 await assert.rejects(()=>exportPagedJournal(empty,'local',good,secret,{snapshotSha256:'b'.repeat(64),snapshotEpoch:1,resume:true}),/snapshot|SNAPSHOT/);
 await assert.rejects(()=>exportPagedJournal(empty,'local',good,secret,{snapshotSha256:'a'.repeat(64),snapshotEpoch:2,resume:true}),/epoch|Epoch|EPOCH/);
 const plan={expectedEpoch:1,requestId:'checkpoint-concurrent',request:{input:{clientRequestId:'checkpoint-concurrent'},actor:{userId:1}}};const unsigned={version:1,labId:'actual-cash-20261017',schemaVersion:'actual-cash-v1',requestId:plan.requestId,envelopeHash:sha256(canonical(plan.request)),planHash:sha256(canonical(plan)),epoch:2,plan};const record={...unsigned,signature:createHmac('sha256',secret).update(canonical(unsigned)).digest('hex')};
 const newer=async()=>({status:200,body:{labId:'actual-cash-20261017',schemaVersion:'actual-cash-v1',afterEpoch:1,throughEpoch:2,nextEpoch:2,complete:true,records:[record]}});
 await assert.rejects(()=>exportPagedJournal(newer,'local',path.join(dir,'newer.ndjson'),secret,{snapshotSha256:'a'.repeat(64),snapshotEpoch:1}),/SNAPSHOT_EPOCH/);
});
