import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(root,'../../..'),exec=promisify(execFile);
const approved={accountId:'d4a91e89f1fe496f6a3d7f18dee6938c',subdomain:'alarabiya2017',suffix:'c6fa3d',databases:{
 primary:['2eb97799-be52-4edd-8e3c-f578455a0358','2026-10-17T19:52:44.755Z'],
 journal:['b57e0c5d-7a20-4141-9162-d8ac6a75c787','2026-10-17T19:52:48.861Z'],
 restore:['96f1b186-807d-40e5-be58-7c716269b024','2026-10-17T19:52:53.195Z']}};
const hash=value=>createHash('sha256').update(value).digest('hex');
function cliJson(output){
 try{return JSON.parse(output);}catch{}
 // Wrangler's SQL-file importer prints progress before its JSON result even
 // with --json. Parse only a complete trailing JSON value, never partial text.
 for(const match of output.matchAll(/^[\[{]/gm)){try{return JSON.parse(output.slice(match.index));}catch{}}
 throw Error('NO_COMPLETE_CLI_JSON_RESULT');
}

export async function cashCloudContext(){
 const runtime=JSON.parse(await readFile(path.join(repo,'.superpowers/sdd/cash-runtime.json'),'utf8'));
 for(const field of ['accountId','subdomain','suffix'])if(runtime[field]!==approved[field])throw Error('UNAPPROVED_CASH_ACCOUNT');
 for(const [role,[id,date]]of Object.entries(approved.databases))if(runtime.databases[role]?.databaseId!==id||runtime.databases[role]?.createdAt!==date||runtime.databases[role]?.name!==`erp-cash-poc-20261017-c6fa3d-${role}`)throw Error('UNAPPROVED_CASH_DATABASE');
 const cliPackage=JSON.parse(await readFile(path.join(path.dirname(runtime.cli),'../package.json'),'utf8'));if(cliPackage.version!=='4.151.1')throw Error('UNAPPROVED_CLI_VERSION');
 const env={};for(const field of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'])if(process.env[field])env[field]=process.env[field];
 Object.assign(env,{CLOUDFLARE_ACCOUNT_ID:approved.accountId,WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false'});
 const invoke=async(args,json=false)=>{
  let result;try{result=await exec(process.execPath,[runtime.cli,...args],{cwd:runtime.cwd,env,windowsHide:true,timeout:120000,maxBuffer:4194304});return json?cliJson(result.stdout):result.stdout;}
  catch(error){throw Error(`CASH_CLI_${args[0]}_${args[1]}_FAILED_PRIVATE_OUTPUT`,{cause:{code:error.code??'PARSE_OR_CLI'}});}finally{result=undefined;}
 };
 const secret=JSON.parse(await readFile(path.join(repo,'.superpowers/sdd/cash-test-secret.json'),'utf8')).token;
 if(typeof secret!=='string'||secret.length<40)throw Error('MISSING_TEST_SECRET');
 return {root,repo,runtime,invoke,secret,source:`https://erp-cash-poc-20261017-c6fa3d.alarabiya2017.workers.dev`,restore:`https://erp-cash-poc-20261017-c6fa3d-restore.alarabiya2017.workers.dev`};
}
export async function verifyResources(context){
 for(const [role,resource]of Object.entries(context.runtime.databases)){
  const info=await context.invoke(['d1','info',resource.name,'--json'],true);
  if(info.uuid!==resource.databaseId||info.name!==resource.name||info.created_at!==resource.createdAt)throw Error('REMOTE_CASH_IDENTITY_MISMATCH_'+role);
 }
}
async function initialize(context,resume=false){
 const {runtime,invoke}=context;
 if(runtime.initialized)throw Error('CASH_ALREADY_INITIALIZED_REFUSING_RESET');
 const schema=await readFile(path.join(root,'build/schema.sql'),'utf8'),fixture=await readFile(path.join(root,'build/fixture.sql'),'utf8'),journal=await readFile(path.join(root,'journal-schema.sql'),'utf8');
 for(const [role,resource]of Object.entries(runtime.databases)){
  const inspected=await invoke(['d1','execute',resource.name,'--remote','--command',"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",'--json'],true);
  if(inspected.some(v=>v.results?.length)){
   if(!resume||role!=='primary')throw Error('NONEMPTY_CASH_DATABASE_REFUSED_'+role);
   // Recover the known first import's unknown CLI result without replaying DDL.
   // Adoption is allowed only for an exact, untouched local fixture snapshot.
   const baseline=JSON.parse(await readFile(path.join(root,'results/baseline.json'),'utf8'));
   const names=[...Object.keys(baseline),'cashAssert','cashSandboxIdentity'];
   if(inspected[0].results.map(r=>r.name).sort().join('|')!==names.sort().join('|'))throw Error('RESUME_SCHEMA_TABLES_MISMATCH');
   const rows=await invoke(['d1','execute',resource.name,'--remote','--command',Object.keys(baseline).map(name=>'SELECT * FROM `'+name+'`;').join('\n'),'--json'],true);
   if(rows.length!==Object.keys(baseline).length)throw Error('RESUME_TABLE_COUNT_MISMATCH');
   const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
   for(let i=0;i<rows.length;i++)if(canonical(rows[i].results)!==canonical(baseline[Object.keys(baseline)[i]]))throw Error('RESUME_FIXTURE_ROW_MISMATCH_'+Object.keys(baseline)[i]);
   const marker=await invoke(['d1','execute',resource.name,'--remote','--command',"SELECT * FROM cashSandboxIdentity; SELECT * FROM cashAssert;",'--json'],true);
   if(marker[0]?.results?.[0]?.id!=='actual-cash-20261017'||marker[0].results[0].role!==role||marker[1]?.results?.length)throw Error('RESUME_MARKER_MISMATCH');
   console.log(JSON.stringify({adoptedVerifiedInitialImport:role,id:resource.databaseId}));continue;
  }
  const marker=`CREATE TABLE cashSandboxIdentity(id TEXT PRIMARY KEY,role TEXT NOT NULL); INSERT INTO cashSandboxIdentity VALUES('actual-cash-20261017','${role}');`;
  const sql=role==='journal'?journal:schema+'\n'+fixture+'\n'+marker;
  const file=path.join(runtime.cwd,`cash-init-${role}.sql`);await writeFile(file,sql);
  await invoke(['d1','execute',resource.name,'--remote','--file',file,'--yes','--json'],true);
  console.log(JSON.stringify({initialized:role,id:resource.databaseId,sqlSha256:hash(sql)}));
 }
 runtime.initialized=new Date().toISOString();runtime.schemaSha256=hash(schema);runtime.fixtureSha256=hash(fixture);
 await writeFile(path.join(repo,'.superpowers/sdd/cash-runtime.json'),JSON.stringify(runtime,null,2));
}
async function deploy(context){
 const {runtime,invoke,secret}=context;if(!runtime.initialized)throw Error('INITIALIZE_FIRST');
 const worker=await readFile(path.join(root,'build/worker.mjs')),wasm=await readFile(path.join(root,'build/sql-wasm.wasm'));
 const evidence={at:new Date().toISOString(),bundleSha256:hash(worker),wasmSha256:hash(wasm),bytes:{worker:worker.length,wasm:wasm.length},schemaSha256:runtime.schemaSha256,fixtureSha256:runtime.fixtureSha256,workers:{}};
 const secrets=path.join(runtime.cwd,'cash-lab-secret.json');await writeFile(secrets,JSON.stringify({LAB_TOKEN:secret}));
 try { for(const role of ['primary','restore']){
  const name=role==='primary'?'erp-cash-poc-20261017-c6fa3d':'erp-cash-poc-20261017-c6fa3d-restore';
  const db=runtime.databases[role],log=runtime.databases.journal;
  const config={name,account_id:runtime.accountId,main:path.join(root,'build/worker.mjs'),compatibility_date:'2026-08-01',compatibility_flags:['nodejs_compat'],workers_dev:true,preview_urls:false,observability:{enabled:false},find_additional_modules:true,rules:[{type:'CompiledWasm',globs:['**/*.wasm'],fallthrough:true}],d1_databases:[{binding:'DB',database_name:db.name,database_id:db.databaseId},...(role==='primary'?[{binding:'RECOVERY_LOG',database_name:log.name,database_id:log.databaseId}]:[])]};
  const file=path.join(runtime.cwd,`cash-${role}.json`);await writeFile(file,JSON.stringify(config,null,2));
  const output=await invoke(['deploy','--config',file,'--no-bundle']);
  await invoke(['secret','bulk',secrets,'--config',file]);
  evidence.workers[role]={name,url:context[role==='primary'?'source':'restore'],deploymentVersion:output.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1]??null,journalBinding:role==='primary'};
  console.log(JSON.stringify({deployed:role,...evidence.workers[role]}));
 } } finally {await unlink(secrets);}
 await mkdir(path.join(root,'results'),{recursive:true});await writeFile(path.join(root,'results/deploy.json'),JSON.stringify(evidence,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==4||process.argv[3]!=='--confirm-isolated-cash-lab'||!['--initialize','--resume-initialization','--deploy'].includes(process.argv[2]))throw Error('EXPLICIT_CASH_SANDBOX_ACTION_REQUIRED');
 const context=await cashCloudContext();await verifyResources(context);
 if(process.argv[2]==='--deploy')await deploy(context);else await initialize(context,process.argv[2]==='--resume-initialization');
}
