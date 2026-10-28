import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {loadAuditTarget,assertAuditConnection} from './audit-local-target.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const allowed=['erp_audit_fixes_20261028_test','erp_audit_fix_assets_1028_test','erp_audit_fix_hr_1028_test','erp_audit_fix_outbox_1028_test'];
const targets=process.argv.slice(2);
if(!targets.length||targets.some(name=>!allowed.includes(name)))throw new Error('Exact owned schema required');
const state=JSON.parse(execFileSync('docker',['inspect','erp-audit-procedures-20261028'],{encoding:'utf8'}))[0];
if(state.Config.Labels?.['codex.audit']!=='procedures-20261028'||state.HostConfig.PortBindings['3306/tcp'][0].HostPort!=='33318')throw new Error('Wrong isolated container');
const sql=fs.readFileSync(path.join(root,'drizzle/migrations/0408_audit_crossmodule_contracts.sql'),'utf8');
const target=loadAuditTarget('procedures');
await Promise.all(targets.map(async database=>{
 const conn=await mysql.createConnection({...target.connectionOptions,database,multipleStatements:true});
 try{
  await assertAuditConnection(conn,target,database);
  const [[identity]]=await conn.query('SELECT DATABASE() AS db, @@event_scheduler AS events');
  if(identity.db!==database||identity.events!=='OFF')throw new Error('Wrong target or scheduler');
  for(const statement of sql.split(/-->\s*statement-breakpoint/).map(s=>s.trim()).filter(Boolean))await conn.query(statement);
  console.log(database+': 0408 applied; no business data rewrite');
 }finally{await conn.end();}
}));
