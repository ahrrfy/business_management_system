import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(root, 'package.json'));
const mysql = require('mysql2/promise');
const exec = promisify(execFile);
const record = resolve(root, '.superpowers/sdd/cash-mysql-runtime.json');
const port = 13318;
const database = 'erp_d1_actual_cash_20261017_test';
export const oracleDatabase = 'erp_d1_actual_cash_20261017_oracle_test';
const norm = value => resolve(value).toLowerCase();
export const url = `mysql://root@127.0.0.1:${port}/${database}`;

export function labEnv(scope='suite') {
  assert.ok(scope==='suite'||scope==='oracle','Fixed laboratory scope required');
  const targetUrl=scope==='oracle'?`mysql://root@127.0.0.1:${port}/${oracleDatabase}`:url;
  return { ...process.env, DATABASE_URL:targetUrl, TEST_DATABASE_URL:targetUrl,
    CONTROL_DATABASE_URL:'', TEST_CONTROL_DATABASE_URL:'', NODE_ENV:'test', TZ:'UTC',
    WRANGLER_WRITE_LOGS:'false', WRANGLER_SEND_METRICS:'false' };
}

async function listenerInfo() {
  const script = `$items=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess); [pscustomobject]@{pid=$_.OwningProcess;address=$_.LocalAddress;executable=$owner.ExecutablePath;parent=$owner.ParentProcessId} }); ConvertTo-Json -InputObject $items -Compress`;
  const { stdout } = await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000});
  return JSON.parse(stdout.replace(/^\uFEFF/,''));
}

async function runtimeRecord() {
  const r = JSON.parse((await readFile(record,'utf8')).replace(/^\uFEFF/,''));
  assert.equal(r.port,port); assert.equal(r.database,database);
  assert.ok(Number.isSafeInteger(r.pid) && r.pid>0);
  const actualRoot = await realpath(r.root);
  assert.equal(norm(dirname(actualRoot)),norm(await realpath(tmpdir())));
  assert.match(basename(actualRoot),/^erp-d1-actual-cash-mysql-20261017-[a-f0-9]{8}$/);
  const data = await realpath(resolve(actualRoot,'data'));
  assert.equal(norm(data),norm(resolve(r.root,'data')));
  const exe = await realpath(resolve(r.binaryRoot,'bin/mysqld.exe'));
  // Reuse only the previously downloaded official binary, never an arbitrary path.
  const old = JSON.parse((await readFile(resolve(root,'.superpowers/sdd/mysql-runtime.json'),'utf8')).replace(/^\uFEFF/,''));
  assert.equal(norm(r.binaryRoot),norm(old.binaryRoot));
  const priorRoot = await realpath(old.root);
  assert.equal(norm(dirname(priorRoot)),norm(await realpath(tmpdir())));
  assert.match(basename(priorRoot),/^erp-d1-poc-mysql-20261017-[a-f0-9]{8}$/);
  assert.equal(norm(r.binaryRoot),norm(resolve(priorRoot,'mysql-8.4.9-winx64')));
  const listeners = await listenerInfo();
  assert.ok(listeners.length,'No laboratory listener');
  for (const item of listeners) {
    assert.equal(item.address,'127.0.0.1');
    assert.equal(norm(item.executable??''),norm(exe));
    assert.ok(item.pid===r.pid || item.parent===r.pid,'Listener is not owned by recorded child');
  }
  return {r,data};
}

export async function connectCashLab(options={}) {
  const {r,data} = await runtimeRecord();
  const connection = await mysql.createConnection({host:'127.0.0.1',port,user:'root',password:'',timezone:'Z',decimalNumbers:false,connectTimeout:5000,multipleStatements:options.multipleStatements===true});
  try {
    const [[server]] = await connection.query('SELECT @@port AS port, @@datadir AS dataDir, @@version AS version');
    assert.equal(server.port,port);
    assert.equal(norm(await realpath(server.dataDir)),norm(data),'Same-connection datadir mismatch');
    assert.match(server.version,/^8\.4\.9/);
    return {connection,r,server};
  } catch(error) { await connection.end(); throw error; }
}

async function start() {
  assert.equal(process.platform,'win32');
  assert.equal((await listenerInfo()).length,0,'Port in use; refusing to share');
  const old = JSON.parse((await readFile(resolve(root,'.superpowers/sdd/mysql-runtime.json'),'utf8')).replace(/^\uFEFF/,''));
  const bin = await realpath(resolve(old.binaryRoot,'bin/mysqld.exe'));
  assert.equal(norm(dirname(await realpath(old.root))),norm(await realpath(tmpdir())));
  assert.match(basename(old.root),/^erp-d1-poc-mysql-20261017-[a-f0-9]{8}$/);
  assert.equal(norm(bin),norm(resolve(old.root,'mysql-8.4.9-winx64/bin/mysqld.exe')));
  const dir = resolve(tmpdir(),`erp-d1-actual-cash-mysql-20261017-${crypto.randomUUID().replaceAll('-','').slice(0,8)}`);
  await mkdir(dir);
  const data = resolve(dir,'data');
  await exec(bin,['--no-defaults','--initialize-insecure',`--basedir=${old.binaryRoot}`,`--datadir=${data}`,'--console'],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});
  assert.equal((await listenerInfo()).length,0,'Port taken during initialization');
  const child = spawn(bin,['--no-defaults',`--basedir=${old.binaryRoot}`,`--datadir=${data}`,'--bind-address=127.0.0.1',`--port=${port}`,'--default-time-zone=+00:00','--mysqlx=OFF','--skip-log-bin','--innodb-buffer-pool-size=128M',`--log-error=${resolve(dir,'server-error.log')}`],{detached:true,stdio:'ignore',windowsHide:true});
  await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});
  child.unref();
  await writeFile(record,JSON.stringify({root:dir,binaryRoot:old.binaryRoot,pid:child.pid,port,database},null,2));
  for(let i=0;i<30;i++) {
    if((await listenerInfo()).length) {
      const {connection,server} = await connectCashLab();
      await connection.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await connection.end();
      console.log(JSON.stringify({ready:true,port,database,version:server.version})); return;
    }
    await delay(500);
  }
  throw new Error('Recorded child not ready');
}

async function runCommand(kind,scope='suite') {
  const {connection} = await connectCashLab(); await connection.end();
  const results = resolve(root,'experiments/d1-continuity/cash/results'); await mkdir(results,{recursive:true});
  const log = resolve(results,`mysql-${scope==='oracle'?'oracle-':''}${kind}.log`);
  const script = kind==='init' ? ['scripts/init-test-db.mjs'] : [resolve(root,'node_modules/vitest/vitest.mjs'),'run'];
  const child = spawn(process.execPath,script,{cwd:root,env:labEnv(scope),stdio:['ignore','pipe','pipe'],windowsHide:true});
  const chunks=[]; child.stdout.on('data',v=>chunks.push(v)); child.stderr.on('data',v=>chunks.push(v));
  const code = await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes);});
  const output=Buffer.concat(chunks).toString('utf8'); await writeFile(log,output);
  console.log(JSON.stringify({kind,exitCode:code,log,tail:output.slice(-5000)}));
  process.exitCode=code??1;
}

async function completeWindowsInit(scope='suite') {
  assert.ok(scope==='suite'||scope==='oracle','Fixed laboratory scope required');
  const {connection}=await connectCashLab({multipleStatements:true});
  try {
    await connection.query(`USE ${scope==='oracle'?oracleDatabase:database}`);
    // Windows MySQL metadata uses utf8mb3_tolower_ci for TABLE_SCHEMA while
    // DATABASE() user variables use utf8mb3_general_ci. This lab-only, explicit
    // comparison collation avoids ER_CANT_AGGREGATE_2COLLATIONS in migration0363.
    // Original migration sources and application behavior remain unchanged.
    const file='drizzle/migrations/0363_work_order_base_inventory_snapshot.sql';
    const original=await readFile(resolve(root,file),'utf8');
    const compatible=original.replace(/\b(CONSTRAINT_SCHEMA|TABLE_SCHEMA) = @db\b/g,'$1 = @db COLLATE utf8mb3_tolower_ci');
    assert.notEqual(compatible,original);
    const apply=async sql=>{for(const chunk of sql.split(/-->\s*statement-breakpoint/g).map(x=>x.trim()).filter(Boolean)) await connection.query(chunk);};
    await apply(compatible);
    for(const file of ['drizzle/migrations/0380_delivery_shortfall_settlement.sql','drizzle/migrations/extras/0361_fix_triggers_and_guards.sql']) await apply(await readFile(resolve(root,file),'utf8'));
    console.log('Completed remaining test-only DDL with explicit Windows metadata collation; production sources unchanged');
  } finally {await connection.end();}
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const action=process.argv[2];
  if(action==='--start') await start();
  else if(action==='--init') await runCommand('init');
  else if(action==='--init-oracle') await runCommand('init','oracle');
  else if(action==='--suite') await runCommand('suite');
  else if(action==='--complete-windows-init') await completeWindowsInit();
  else if(action==='--complete-windows-oracle-init') await completeWindowsInit('oracle');
  else if(action==='--stop') { const {connection}=await connectCashLab(); await connection.query('SHUTDOWN'); await connection.end(); console.log('Stopped only the verified cash laboratory MySQL'); }
  else throw new Error('Explicit --start/--init/--suite/--stop required');
}
