import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import * as reference from './mysql-reference.mjs';

async function creationCount(connection) {
  const [[row]]=await connection.query("SHOW GLOBAL STATUS LIKE 'Com_create_db'");
  return BigInt(row.Value);
}

test('real MySQL mismatched expected data directory refuses provisioning without CREATE',async(t)=>{
  const {connection,server}=await reference.connectReference();
  try {
    const before=await creationCount(connection);
    assert.equal(typeof reference.provisionDatabaseOnVerifiedConnection,'function','same-connection provisioning identity gate must exist');
    await assert.rejects(reference.provisionDatabaseOnVerifiedConnection(connection,resolve(server.dataDir,'wrong-expected-datadir')),/data directory identity mismatch/);
    const after=await creationCount(connection);
    assert.equal(after,before,'identity mismatch must issue no CREATE DATABASE');
    t.diagnostic(`Com_create_db before=${before}, after=${after}; rejected data-directory mismatch before CREATE`);
    assert.equal((await connection.query('SELECT 1 AS alive'))[0][0].alive,1);
  }finally{await connection.end();}
});

test('recorded local PID and loopback listener belong to the expected fresh executable',async()=>{
  const text=await readFile(resolve(reference.repoRoot,'.superpowers/sdd/mysql-runtime.json'),'utf8');
  const runtime=JSON.parse(text.replace(/^\uFEFF/,''));
  assert.equal(typeof reference.assertRuntimeProcessIdentity,'function','process and listener gate must exist');
  await reference.assertRuntimeProcessIdentity(runtime);
  await assert.rejects(reference.assertRuntimeProcessIdentity({...runtime,pid:process.pid}),/process executable identity mismatch|listener process identity mismatch/);
});
