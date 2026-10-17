import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)), repo=path.resolve(root,'../../..'),exec=promisify(execFile);
const approved={accountId:'d4a91e89f1fe496f6a3d7f18dee6938c',suffix:'e19867',subdomain:'alarabiya2017',databases:{
  primary:['33ddee65-d239-4bd7-905b-8dd1d006f7ba','2026-10-17T19:05:46.945Z'],
  journal:['e4df50d4-88fd-404a-a16f-22ade4624900','2026-10-17T19:05:51.265Z'],
  restore:['bee5c00f-1291-456b-a2bd-c57927fce77b','2026-10-17T19:05:55.310Z']}};
export async function cloudContext(){
  const runtime=JSON.parse(await readFile(path.join(repo,'.superpowers/sdd/edge-runtime.json'),'utf8'));
  if(runtime.accountId!==approved.accountId||runtime.suffix!==approved.suffix||runtime.subdomain!==approved.subdomain)throw new Error('UNAPPROVED_ACCOUNT');
  for(const [role,[id,date]]of Object.entries(approved.databases)){
    const resource=runtime.databases[role];
    if(resource?.databaseId!==id||resource.createdAt!==date||resource.name!==`erp-edge-poc-20261017-e19867-${role}`)throw new Error('UNAPPROVED_DATABASE');
  }
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false',CLOUDFLARE_ACCOUNT_ID:approved.accountId});
  const invoke=async(args,parse=false)=>{
    let captured;
    try{captured=await exec(process.execPath,[runtime.cli,...args],{cwd:runtime.cwd,env,windowsHide:true,timeout:90000,maxBuffer:4194304});return parse?JSON.parse(captured.stdout):captured.stdout;}
    catch{throw new Error(`CLI_${args[0]}_${args[1]}_FAILED_OUTPUT_PRIVATE`);}
    finally{captured=undefined;}
  };
  const token=JSON.parse(await readFile(path.join(repo,'.superpowers/sdd/edge-test-secret.json'),'utf8')).token;
  if(typeof token!=='string'||token.length<40)throw new Error('MISSING_PRIVATE_TEST_TOKEN');
  return{runtime,invoke,token,root,repo};
}
async function main(){
  if(process.argv.length!==4||process.argv[3]!=='--confirm-synthetic-sandbox'||!['--initialize','--deploy'].includes(process.argv[2]))throw new Error('EXPLICIT_MODE_AND_SYNTHETIC_CONFIRMATION_REQUIRED');
  const {runtime,invoke,token}=await cloudContext(), mode=process.argv[2];
  if(mode==='--initialize'){
    if(runtime.initialized)throw new Error('ALREADY_INITIALIZED_NO_RESET');
    for(const [role,resource]of Object.entries(runtime.databases)){
      const info=await invoke(['d1','info',resource.name,'--json'],true);
      if(info.uuid!==resource.databaseId||info.name!==resource.name||info.created_at!==resource.createdAt)throw new Error('REMOTE_IDENTITY_MISMATCH');
      const inspected=await invoke(['d1','execute',resource.name,'--remote','--command',"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",'--json'],true);
      if(inspected.some(result=>result.results?.length))throw new Error('NONEMPTY_RESOURCE_REFUSED');
      const schema=await readFile(path.join(root,role==='journal'?'journal-schema.sql':'schema.sql'),'utf8');
      const sql=role==='journal'?schema:schema+`\nINSERT INTO edge_marker VALUES ('edge-actual-20261017','${role}');`;
      const file=path.join(runtime.cwd,`${role}-bootstrap.sql`);await writeFile(file,sql);
      await invoke(['d1','execute',resource.name,'--remote','--file',file,'-y']);
      console.log(JSON.stringify({initialized:role,name:resource.name}));
    }
    runtime.initialized=new Date().toISOString();
    await writeFile(path.join(repo,'.superpowers/sdd/edge-runtime.json'),JSON.stringify(runtime,null,2));
  }else{
    if(!runtime.initialized)throw new Error('INITIALIZE_FIRST');
    const bundle=await readFile(path.join(root,'build/worker.mjs'));
    const hash=createHash('sha256').update(bundle).digest('hex'),results=[];
    for(const role of ['primary','restore']){
      const name=`erp-edge-poc-20261017-e19867${role==='restore'?'-restore':''}`;
      const config={name,account_id:runtime.accountId,main:path.join(root,'build/worker.mjs'),compatibility_date:'2026-10-17',compatibility_flags:['nodejs_compat'],
        workers_dev:true,preview_urls:false,send_metrics:false,observability:{enabled:false},vars:{LAB_ID:name},
        d1_databases:[{binding:'DB',database_name:runtime.databases[role].name,database_id:runtime.databases[role].databaseId},
          ...(role==='primary'?[{binding:'RECOVERY_LOG',database_name:runtime.databases.journal.name,database_id:runtime.databases.journal.databaseId}]:[])]};
      const configFile=path.join(runtime.cwd,`${role}-wrangler.json`);await writeFile(configFile,JSON.stringify(config,null,2));
      const output=await invoke(['deploy','--no-bundle','--config',configFile]);
      const secret=path.join(runtime.cwd,'lab-secret.json');await writeFile(secret,JSON.stringify({LAB_TOKEN:token}));
      await invoke(['secret','bulk',secret,'--config',configFile]);
      const url=`https://${name}.${runtime.subdomain}.workers.dev`;
      results.push({role,name,url,bundleSha256:hash,version:output.match(/Current Version ID:\s*([0-9a-f-]+)/)?.[1]});
      console.log(JSON.stringify(results.at(-1)));
    }
    await mkdir(path.join(root,'results'),{recursive:true});await writeFile(path.join(root,'results/deploy.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
