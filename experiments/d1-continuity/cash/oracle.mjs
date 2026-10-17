import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCashLab,labEnv,root,oracleDatabase } from './mysql-lab.mjs';
const cash=path.dirname(fileURLToPath(import.meta.url));
if(process.argv[2]!=='--verify-isolated-mysql')throw Error('EXPLICIT_ORACLE_MODE_REQUIRED');
Object.assign(process.env,labEnv('oracle'));
const {connection:c,server}=await connectCashLab();
await c.query('USE '+oracleDatabase);
const {createConfirmedPosSale}=await import('../../../server/services/posExternalPayment.ts');
const {getDb}=await import('../../../server/db.ts');
const {sql}=await import('drizzle-orm');
const fixture=await readFile(path.join(cash,'build/fixture.sql'),'utf8');
const statements=fixture.split(';').map(s=>s.trim()).filter(Boolean).filter(s=>!/^UPDATE cashEpoch/i.test(s));
const actor={userId:1,branchId:1,role:'cashier'};
const input=id=>({branchId:1,shiftId:1,sourceType:'POS',clientRequestId:id,lines:[{variantId:1,productUnitId:1,quantity:'2'}],payment:{amount:'200',method:'CASH'}});
const tables=['invoices','invoiceItems','inventoryMovements','branchStock','receipts','accountingEntries','idempotencyKeys','documentCounters','invoiceAttributions'];
async function reset(){
 const [rows]=await c.query("SHOW FULL TABLES WHERE Table_type='BASE TABLE'");
 await c.query('SET FOREIGN_KEY_CHECKS=0');
 try{for(const row of rows){const name=Object.values(row)[0];assert.match(name,/^\w+$/);await c.query('TRUNCATE TABLE `'+name+'`');}}
 finally{await c.query('SET FOREIGN_KEY_CHECKS=1');}
 for(const statement of statements)await c.query(statement);
}
async function state(){const result={};for(const table of tables){const [rows]=await c.query('SELECT * FROM `'+table+'`');result[table]=rows;}return result;}
try{
 const db=getDb();assert.ok(db);const raw=await db.execute(sql`SELECT @@port AS port, DATABASE() AS db`);assert.equal(Number(raw[0][0].port),13318);assert.equal(raw[0][0].db,oracleDatabase);
 const scenarios=[];
 for(const [name,adjust]of [
  ['standard',i=>i],
  ['cash-rounding',i=>({...i,cashRoundIQD:true,payment:{amount:'300',method:'CASH'}})],
  ['multiple-lines',i=>({...i,lines:[...i.lines,{variantId:2,productUnitId:2,quantity:'1'}],payment:{amount:'280',method:'CASH'}})],
  ['discount',i=>({...i,invoiceDiscount:'10',payment:{amount:'190',method:'CASH'}})],
  ['decimal-quantity',i=>({...i,lines:[{variantId:1,productUnitId:1,quantity:'0.1'}],payment:{amount:'10',method:'CASH'}})],
 ]){
  await reset();const request=adjust(input('oracle-cash-'+name));let result,error;
  try{result=await createConfirmedPosSale(request,actor);}catch(e){error={code:e.code??'ERROR',message:e.message};}
  const after=await state();
  if(result){const replay=await createConfirmedPosSale(request,actor);assert.equal(replay.invoiceId,result.invoiceId);assert.deepEqual(await state(),after);}
  scenarios.push({name,input:request,actor,result:result??null,error:error??null,tables:after});
 }
 await mkdir(path.join(cash,'results'),{recursive:true});
 await writeFile(path.join(cash,'results/mysql-oracle.json'),JSON.stringify({verifiedServer:{port:server.port,version:server.version},scenarios},null,2));
 console.log(JSON.stringify({mysqlPort:server.port,scenarios:scenarios.map(s=>({name:s.name,result:s.result,error:s.error}))}));
}finally{await c.end();}
// The original application deliberately retains its pool; this standalone
// verified reference process has completed all awaited writes and file flushes.
process.exit(0);
