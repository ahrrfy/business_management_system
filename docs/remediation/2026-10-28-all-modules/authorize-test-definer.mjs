import mysql from 'mysql2/promise';
import {loadAuditTarget,assertAuditConnection} from './audit-local-target.mjs';
const target=loadAuditTarget('procedures');
const db=await mysql.createConnection(target.connectionOptions);
const names=['erp_audit_fixes_20261028_test','erp_audit_fix_purchase_1028_test','erp_audit_fix_assets_1028_test','erp_audit_fix_hr_1028_test','erp_audit_fix_digital_1028_test','erp_audit_fix_commerce_1028_test','erp_audit_fix_outbox_1028_test','erp_audit_fix_platform_1028_test'];
try{
 await assertAuditConnection(db,target);
 const [[state]]=await db.query('SELECT @@event_scheduler AS state');if(state.state!=='OFF')throw new Error('Unexpected scheduler');
 const [[found]]=await db.query("SELECT COUNT(*) AS n FROM mysql.user WHERE User='erp_app' AND Host='%'");
 if(Number(found.n)===0)await db.query("CREATE USER 'erp_app'@'%' ACCOUNT LOCK");
 for(const name of names)await db.query('GRANT SELECT, INSERT, UPDATE, DELETE, TRIGGER, EXECUTE ON '+name+".* TO 'erp_app'@'%'");
 console.log(JSON.stringify({lockedDefinerCreated:Number(found.n)===0,syntheticSchemaGrants:names.length,snapshotGrantsAdded:0,productionAccess:false}));
}finally{await db.end();}
