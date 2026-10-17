import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('cloud access requires explicit synthetic sandbox confirmation before auth', async () => {
  const { createCloudLab } = await import('./lab.mjs');
  await assert.rejects(createCloudLab(), /CONFIRM_SYNTHETIC_SANDBOX_REQUIRED/);
});

test('a different database identity is rejected before auth or network', async () => {
  const { createCloudLab } = await import('./lab.mjs');
  await assert.rejects(createCloudLab({ confirmSyntheticSandbox: true, manifest: {
    accountId: 'd4a91e89f1fe496f6a3d7f18dee6938c', name: 'erp-d1-poc-20261017-887100',
    databaseId: '00000000-0000-0000-0000-000000000000'
  }}), /CLOUD_RESOURCE_NOT_APPROVED/);
});

test('recovery admission cannot be enabled for the source database', async () => {
  const { createCloudLab } = await import('./lab.mjs');
  await assert.rejects(createCloudLab({ confirmSyntheticSandbox:true, recoverImportedSource:true,
    manifest:{accountId:'d4a91e89f1fe496f6a3d7f18dee6938c',name:'erp-d1-poc-20261017-887100',databaseId:'90a4dd83-614f-42ad-b9f7-43ec8c411843'} }), /CLOUD_RECOVERY_TARGET_NOT_APPROVED/);
});

for (const [field, value] of [['databaseId','00000000-0000-0000-0000-000000000000'],['name','erp-d1-poc-20261017-unapproved'],['createdAt','2026-10-17T00:00:00.000Z']]) {
  test(`pure manifest validation refuses changed restore ${field} before CLI access`, async () => {
    const { validateCloudManifest } = await import('./lab.mjs');
    const manifest = {accountId:'d4a91e89f1fe496f6a3d7f18dee6938c',name:'erp-d1-poc-20261017-c60ca2',databaseId:'9594cf92-a2aa-49ea-8f75-e15d5cb88d3b',createdAt:'2026-10-17T18:43:20.619Z',sourceDatabaseId:'90a4dd83-614f-42ad-b9f7-43ec8c411843',[field]:value};
    assert.throws(()=>validateCloudManifest(manifest,{recoverImportedSource:true,initialize:false}),/CLOUD_RESOURCE_NOT_APPROVED/);
  });
}

test('pure manifest validation refuses source recovery mode before CLI access', async () => {
  const { validateCloudManifest } = await import('./lab.mjs');
  assert.throws(()=>validateCloudManifest({accountId:'d4a91e89f1fe496f6a3d7f18dee6938c',name:'erp-d1-poc-20261017-887100',databaseId:'90a4dd83-614f-42ad-b9f7-43ec8c411843'},{recoverImportedSource:true,initialize:false}),/CLOUD_RECOVERY_TARGET_NOT_APPROVED/);
});

test('private CLI auth disables disk logging while retaining captured JSON stdout', async () => {
  const { createCloudLab } = await import('./lab.mjs');
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'erp-d1-auth-env-test-'));
  const bin = path.join(fixture, 'bin');
  await mkdir(bin);
  const cli = path.join(bin, 'wrangler.js');
  await writeFile(cli, "if(process.env.WRANGLER_WRITE_LOGS!=='false')process.exit(23);process.stdout.write(JSON.stringify({token:'SYNTHETIC_TEST_TOKEN_NOT_A_CREDENTIAL'}));");
  const previousFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new Error('TEST_NETWORK_BLOCKED'); };
  try {
    await assert.rejects(createCloudLab({ confirmSyntheticSandbox: true, manifest: {
      accountId:'d4a91e89f1fe496f6a3d7f18dee6938c', name:'erp-d1-poc-20261017-887100',
      databaseId:'90a4dd83-614f-42ad-b9f7-43ec8c411843', wranglerModule:path.join(fixture,'package.json')
    }}), error => error.code === 'CLOUD_TRANSPORT_ERROR');
    assert.equal(attempts, 1); // JSON parsing succeeded; real network remained blocked.
  } finally {
    globalThis.fetch = previousFetch;
    await unlink(cli); await rmdir(bin); await rmdir(fixture);
  }
});
