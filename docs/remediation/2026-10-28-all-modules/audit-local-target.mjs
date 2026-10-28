import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const definitions={
 procedures:{container:'erp-audit-procedures-20261028',label:'procedures-20261028',port:33318,
  schemas:['erp_audit_fixes_20261028_test','erp_audit_fix_purchase_1028_test','erp_audit_fix_assets_1028_test','erp_audit_fix_hr_1028_test','erp_audit_fix_digital_1028_test','erp_audit_fix_commerce_1028_test','erp_audit_fix_outbox_1028_test','erp_audit_fix_platform_1028_test']},
 allModules:{container:'erp-all-modules-test-1028-ram',label:'all-modules-fixes-20261028',port:33320,
  schemas:['erp_audit_all_modules_1028_test','erp_audit_all_control_1028_test']},
};

export function loadAuditTarget(kind,{verifyContainer=true}={}){
 const definition=definitions[kind];
 const file=process.env.AUDIT_LOCAL_DB_ACCESS_FILE;
 if(!definition||!file)throw new Error('Set AUDIT_LOCAL_DB_ACCESS_FILE to the protected local audit credential file');
 const document=JSON.parse(fs.readFileSync(file,'utf8'));
 const target=document.targets?.[kind];
 if(document.version!==2||target?.status!=='READY'||target.container!==definition.container||target.label!==definition.label||target.host!=='127.0.0.1'||target.port!==definition.port||target.user!=='root'||typeof target.password!=='string'||target.password.length<32||!/^[a-f0-9-]{36}$/.test(target.expectedServerUuid??''))throw new Error('Invalid or unready isolated audit target');
 if(verifyContainer){
  const state=JSON.parse(execFileSync('docker',['inspect',definition.container],{encoding:'utf8'}))[0];
  const bindings=state.HostConfig.PortBindings?.['3306/tcp'];
  if(state.Id!==target.containerId||state.Config.Labels?.['codex.audit']!==definition.label||state.State.Status!=='running'||bindings?.length!==1||bindings[0].HostIp!=='127.0.0.1'||bindings[0].HostPort!==String(definition.port))throw new Error('Isolated audit container identity changed');
 }
 return {...definition,expectedServerUuid:target.expectedServerUuid,
  connectionOptions:{host:target.host,port:target.port,user:target.user,password:target.password,connectTimeout:5000},
  databaseUrl(database){
   if(!definition.schemas.includes(database))throw new Error('Unknown owned synthetic audit schema');
   const url=new URL('mysql://127.0.0.1');
   url.port=String(target.port);url.username=target.user;url.password=target.password;url.pathname='/'+database;
   return url.toString();
  },
 };
}

export async function assertAuditConnection(connection,target,database){
 const [[identity]]=await connection.query('SELECT @@server_uuid AS uuid, @@event_scheduler AS events, DATABASE() AS db');
 if(identity.uuid!==target.expectedServerUuid||identity.events!=='OFF'||(database!=null&&identity.db!==database))throw new Error('Wrong audit server, schema or event scheduler');
}
