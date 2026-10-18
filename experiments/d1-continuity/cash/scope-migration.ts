import {tables} from './schema';
import {cashReadIndexes} from './cash-indexes';
import {primary,assertIdentity,failure} from './journal';
import {sqlStatements} from './sql-statements.mjs';
import journalDDL from './journal-schema.sql';

// Authenticated laboratory maintenance only. No financial table is rebuilt.
// Every DROP below is guarded inside its native atomic batch by BOTH empty
// read-only online tables. Existing invoices/stock/receipts/commands stay intact.
export async function migrateCashScope(env:any) {
 const db=primary(env.DB),role=(await db.prepare("SELECT role FROM cashSandboxIdentity WHERE id='actual-cash-20261017'").first())?.role;
 if(!['primary','restore'].includes(role))throw failure('SANDBOX_IDENTITY_MISMATCH');
 await assertIdentity(db,role);
 const schema=await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN('customers','onlineOrders')").all();
 const found=new Map(schema.results.map((r:any)=>[r.name,r.sql]));const statements:string[]=[];
 if(!found.has('customers'))statements.push(tables.find(t=>t.name==='customers')!.ddl);
 const online=found.get('onlineOrders') as string;
 if(!online)throw failure('SCOPED_UPGRADE_UNSUPPORTED_SCHEMA');
 const rebuild=!online.includes('REFERENCES `customers`');
 if(rebuild){
  if(!online.includes('`customerId` IS NULL'))throw failure('SCOPED_UPGRADE_UNSUPPORTED_SCHEMA');
  statements.push('INSERT INTO cashAssert(ok) SELECT CASE WHEN (SELECT COUNT(*) FROM onlineOrders)=0 AND (SELECT COUNT(*) FROM onlineOrderItems)=0 THEN 1 ELSE 0 END');
  statements.push('CREATE TABLE cashScopeOnlineOrdersSequence(id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL CHECK(seq>=0))','INSERT INTO cashScopeOnlineOrdersSequence SELECT 1,seq FROM sqlite_sequence WHERE name=\'onlineOrders\'');
  statements.push(tables.find(t=>t.name==='onlineOrders')!.ddl.replace('CREATE TABLE `onlineOrders`','CREATE TABLE `cashScopeOnlineOrdersUpgrade`'));
  statements.push('DROP TABLE onlineOrders','ALTER TABLE cashScopeOnlineOrdersUpgrade RENAME TO onlineOrders',"UPDATE sqlite_sequence SET seq=(SELECT seq FROM cashScopeOnlineOrdersSequence WHERE id=1) WHERE name='onlineOrders' AND EXISTS(SELECT 1 FROM cashScopeOnlineOrdersSequence)","INSERT INTO sqlite_sequence(name,seq) SELECT 'onlineOrders',seq FROM cashScopeOnlineOrdersSequence WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='onlineOrders')",'DROP TABLE cashScopeOnlineOrdersSequence','DELETE FROM cashAssert');
 }
 statements.push(...cashReadIndexes);
 statements.push('INSERT INTO cashAssert(ok) SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END','DELETE FROM cashAssert');
 await db.batch(statements.map(s=>db.prepare(s)));
 const foreignKeys=await db.prepare('PRAGMA foreign_key_check').all();if(foreignKeys.results.length)throw failure('SCOPED_UPGRADE_FOREIGN_KEY_MISMATCH');
 let journalInstalled=false;
 if(role==='primary'){
  const log=primary(env.RECOVERY_LOG);await assertIdentity(log,'journal');
  const existing=await log.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cashJournalHead'").first();
  if(!existing){
   const marker='-- Constant-size prefix proof';const start=journalDDL.indexOf(marker);if(start<0)throw failure('SCOPED_UPGRADE_MISSING_DDL');
   await log.batch(sqlStatements(journalDDL.slice(start)).map(s=>log.prepare(s)));journalInstalled=true;
  }
  const audit=await log.prepare('SELECT epoch,committedCount,(SELECT COUNT(*) FROM cashJournalCommitted) actualCount,COALESCE((SELECT MAX(epoch) FROM cashJournalCommitted),1) lastEpoch,(SELECT COUNT(*) FROM sqlite_master WHERE type=\'trigger\' AND name IN(\'cashJournalCommitted_no_update\',\'cashJournalCommitted_no_delete\',\'cashJournalCommitted_contiguous\',\'cashJournalCommitted_advance_head\',\'cashJournalHead_guard\',\'cashJournalHead_no_delete\')) guards FROM cashJournalHead WHERE id=1').first();
  if(!audit||audit.guards!==6||audit.epoch!==audit.lastEpoch||audit.committedCount!==audit.actualCount||audit.actualCount!==audit.epoch-1)throw failure('SCOPED_UPGRADE_PREFIX_MISMATCH');
 }
 return {role,sourceStatements:statements.length,emptyOnlineOrdersRebuilt:rebuild,journalHeadInstalled:journalInstalled,foreignKeyViolations:0,journalBindingPresent:!!env.RECOVERY_LOG};
}
