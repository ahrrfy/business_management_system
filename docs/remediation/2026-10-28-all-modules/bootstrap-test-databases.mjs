import mysql from 'mysql2/promise';
import {execFileSync} from 'node:child_process';
import {loadAuditTarget,assertAuditConnection} from './audit-local-target.mjs';
const container='erp-audit-procedures-20261028';
const expected=['erp_audit_fixes_20261028_test','erp_audit_fix_purchase_1028_test','erp_audit_fix_assets_1028_test','erp_audit_fix_hr_1028_test','erp_audit_fix_digital_1028_test','erp_audit_fix_commerce_1028_test','erp_audit_fix_outbox_1028_test','erp_audit_fix_platform_1028_test'];
const requested=process.argv.slice(2);
if(requested.some(name=>!expected.includes(name)))throw new Error('Unknown owned synthetic database');
const targets=requested.length?requested:expected;
const state=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
if(state.Config.Labels?.['codex.audit']!=='procedures-20261028'||state.State.Status!=='running')throw new Error('Wrong local container');
if(state.HostConfig.PortBindings?.['3306/tcp']?.[0]?.HostPort!=='33318'||state.HostConfig.PortBindings['3306/tcp'][0].HostIp!=='127.0.0.1')throw new Error('Wrong local bind');
const target=loadAuditTarget('procedures');
const env={...process.env,MYSQL_PWD:target.connectionOptions.password};
const connection=await mysql.createConnection({...target.connectionOptions,multipleStatements:false});
try {
 await assertAuditConnection(connection,target);
 const [[scheduler]]=await connection.query('SELECT @@event_scheduler AS state');if(scheduler.state!=='OFF')throw new Error('Scheduler must remain OFF');
 const schema=execFileSync('docker',['exec','-e','MYSQL_PWD',container,'mysqldump','-uroot','--no-data','--routines','--triggers','--set-gtid-purged=OFF','--no-tablespaces','erp_procedures_snapshot_test'],{env,maxBuffer:32*1024*1024});
 for(const database of targets){
  const [[found]]=await connection.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[database]);
  if(Number(found.n)!==0){
    const [[tableCount]]=await connection.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[database]);
    if(Number(tableCount.n)!==0){console.log(database+': existing schema preserved, tables='+tableCount.n);continue;}
  }else await connection.query('CREATE DATABASE '+database+' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  execFileSync('docker',['exec','-i','-e','MYSQL_PWD',container,'mysql','-uroot',database],{env,input:schema,maxBuffer:1024*1024});
  const [[count]]=await connection.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[database]);
  console.log(database+': schema-only tables='+count.n);
 }
} finally {await connection.end();}
