import test from 'node:test';
import assert from 'node:assert/strict';
import * as commands from './commands.mjs';
import {createLab} from './run.mjs';
let lab;
test.before(async()=>{lab=await createLab();});
test.after(async()=>{if(lab) await lab.close();});
test.beforeEach(async(t)=>{if(!t.name.startsWith('money:')) await lab.reset();});
test('money: decimal ties, signed values, repeated cents and full DECIMAL(20,2)', () => {
  assert.equal(typeof commands.money, 'function', 'money contract must exist');
  const { money, total } = commands;
  assert.equal(money('1.005'), '1.01');
  assert.equal(money('-1.005'), '-1.01');
  assert.equal(money('999999999999999999.99'), '999999999999999999.99');
  assert.equal(total(Array.from({length:1000},()=>({quantity:1, unitPrice:'0.01'}))), '10.00');
  assert.equal(total([{quantity:3,unitPrice:'0.335'}]), '1.01');
  assert.throws(()=>money('1000000000000000000.00'), /range/);
  assert.throws(()=>money(0.1), /string/);
  assert.notEqual((0.1 + 0.2).toString(), '0.3');
  assert.notEqual(Number('999999999999999999.99').toFixed(2), '999999999999999999.99');
});

const base=(extra={})=>({companyId:'c1',actorId:'a-b1',branchId:'b1',epoch:1,clientRequestId:crypto.randomUUID(),kind:'SALE',mode:'CASH',sku:'sku',quantity:1,unitPrice:'10.00',...extra});
const row=(table,where="companyId='c1' AND branchId='b1'")=>lab.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).first();
const count=async(table,where="companyId='c1'")=>(await lab.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first()).n;
const ok=async(input,headers)=>{const r=await lab.command(input,headers);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
test('cash sale commits invoice, receipt, cash, balanced journal, stock, audit and outbox',async()=>{
  const result=await ok(base({quantity:3,unitPrice:'0.335'})); assert.equal(result.total,'1.01');
  assert.equal((await row('lab_stock')).qty,97); assert.equal((await row('lab_cash')).balance,'1001.01');
  assert.equal(await count('lab_invoices'),1); assert.equal(await count('lab_receipts'),1);
  const {results}=await lab.db.prepare("SELECT amount FROM lab_journal WHERE companyId='c1'").all();
  assert.equal(commands.money(results.reduce((a,r)=>new commands.Money(a).plus(r.amount).toString(),'0')),'0.00');
  assert.equal(await count('lab_audit'),1);assert.equal(await count('lab_outbox'),1);assert.equal(await count('lab_assert','1=1'),0);
});
test('credit sale raises AR without cash receipt and credit return reverses once',async()=>{
  const sale=await ok(base({mode:'CREDIT',customerId:'customer',quantity:2,unitPrice:'2.505'}));
  assert.equal(sale.total,'5.01');assert.equal((await row('lab_customers')).balance,'5.01');assert.equal(await count('lab_receipts'),0);assert.equal((await row('lab_cash')).balance,'1000.00');
  await ok(base({kind:'RETURN',invoiceId:sale.id,quantity:1}));assert.equal((await row('lab_customers')).balance,'2.50');assert.equal((await row('lab_stock')).qty,99);assert.equal(await count('lab_receipts'),0);
  await ok(base({kind:'RETURN',invoiceId:sale.id,quantity:1}));assert.equal((await row('lab_customers')).balance,'0.00');
  assert.equal((await lab.command(base({kind:'RETURN',invoiceId:sale.id,quantity:1}))).status,409);
});
test('reserve and COD dispatch create no premature invoice or receipt and release reserved stock',async()=>{
  const order=await ok(base({kind:'RESERVE',quantity:3}));assert.equal(await count('lab_invoices'),0);assert.equal(await count('lab_receipts'),0);assert.equal((await row('lab_stock')).reserved,3);assert.equal((await row('lab_stock')).qty,100);
  const dispatched=await ok(base({kind:'DISPATCH',orderId:order.id}));assert.equal(dispatched.total,'30.00');assert.equal((await row('lab_stock')).reserved,0);assert.equal((await row('lab_stock')).qty,97);assert.equal((await row('lab_orders')).status,'DISPATCHED');assert.equal(await count('lab_receipts'),0);assert.equal((await row('lab_cash')).balance,'1000.00');
  const returned=await ok(base({kind:'RETURN',invoiceId:dispatched.id,quantity:1}));assert.equal(returned.total,'10.00');assert.equal(await count('lab_receipts'),0);assert.equal((await row('lab_stock')).qty,98);
});
test('POS versus storefront last unit accepts one source and no negative stock',async()=>{
  await lab.db.prepare("UPDATE lab_stock SET qty=1 WHERE companyId='c1' AND branchId='b1'").run();
  const r=await Promise.all([lab.command(base()),lab.command(base({kind:'RESERVE'}))]);assert.equal(r.filter(x=>x.status===200).length,1);const stock=await row('lab_stock');assert.equal(stock.qty-stock.reserved,0);assert.equal(await count('lab_invoices')+await count('lab_orders'),1);assert.equal(await count('lab_moves'),1);
});
test('many POS contenders cannot oversell',async()=>{
  await lab.db.prepare("UPDATE lab_stock SET qty=4 WHERE companyId='c1' AND branchId='b1'").run();
  const r=await Promise.all(Array.from({length:20},()=>lab.command(base())));assert.equal(r.filter(x=>x.status===200).length,4);assert.equal((await row('lab_stock')).qty,0);assert.equal(await count('lab_receipts'),4);assert.equal(await count('lab_outbox'),4);
});
test('two credit sales compete for one allowance',async()=>{
  const r=await Promise.all([lab.command(base({mode:'CREDIT',customerId:'customer',unitPrice:'75.00'})),lab.command(base({mode:'CREDIT',customerId:'customer',unitPrice:'75.00'}))]);assert.equal(r.filter(x=>x.status===200).length,1);assert.equal((await row('lab_customers')).balance,'75.00');assert.equal(await count('lab_receipts'),0);
});
test('credit approval and last coupon are consumed once under contention',async()=>{
  await lab.db.prepare("UPDATE lab_customers SET creditLimit='0.00' WHERE companyId='c1' AND branchId='b1'").run();
  const r=await Promise.all(Array.from({length:5},()=>lab.command(base({mode:'CREDIT',customerId:'customer',approvalId:'approval',couponId:'coupon'}))));assert.equal(r.filter(x=>x.status===200).length,1);assert.equal((await row('lab_approvals')).unused,0);assert.equal((await row('lab_coupons')).remaining,0);assert.equal((await row('lab_customers')).balance,'9.00');
});
test('duplicate concurrent request has one financial result; changed payload or branch is rejected',async()=>{
  const input=base(); const r=await Promise.all(Array.from({length:12},()=>lab.command(input)));assert.ok(r.every(x=>x.status===200),JSON.stringify(r));assert.equal(new Set(r.map(x=>x.body.id)).size,1);for(const table of ['lab_operations','lab_invoices','lab_receipts','lab_outbox'])assert.equal(await count(table),1);assert.equal(await count('lab_journal'),2);
  assert.equal((await lab.command({...input,unitPrice:'11.00'})).status,409);assert.equal((await lab.command({...input,branchId:'b2',actorId:'a-b2'})).status,409);
  const other=await ok({...input,companyId:'c2'});assert.equal(await count('lab_invoices',"companyId='c2'"),1);assert.equal(other.total,'10.00');
});
test('period close race yields a valid serial outcome and stale epoch cannot write',async()=>{
  const r=await Promise.all([lab.command(base()),lab.command(base({kind:'CLOSE_PERIOD'}))]);assert.equal(r[1].status,200);assert.equal((await row('lab_control')).periodOpen,0);assert.equal(await count('lab_invoices'),r[0].status===200?1:0);assert.equal((await lab.command(base())).status,409);
  await lab.reset();await ok(base({kind:'ROTATE_EPOCH'}));assert.equal((await row('lab_control')).epoch,2);assert.equal((await lab.command(base())).status,409);assert.equal(await count('lab_invoices'),0);await ok(base({epoch:2}));
});
test('late failure and zero-row guard roll back idempotency, counters and all effects',async()=>{
  for(const header of ['x-lab-final-failure','x-lab-zero-guard']) {
    const input=base();assert.equal((await lab.command(input,{[header]:'1'})).status,409);for(const table of ['lab_operations','lab_invoices','lab_receipts','lab_journal','lab_moves','lab_audit','lab_outbox'])assert.equal(await count(table),0);assert.equal((await row('lab_counters')).next,1);assert.equal((await row('lab_stock')).qty,100);assert.equal((await row('lab_cash')).balance,'1000.00');assert.equal(await count('lab_assert','1=1'),0);await ok(input);await lab.reset();
  }
});
test('dropped postcommit response replays original after close and epoch rotation',async()=>{
  const input=base();assert.equal((await lab.command(input,{'x-lab-drop-response':'1'})).status,503);assert.equal(await count('lab_invoices'),1);await ok(base({kind:'ROTATE_EPOCH'}));await ok(base({kind:'CLOSE_PERIOD',epoch:2}));const replay=await ok(input);assert.equal(replay.total,'10.00');assert.equal(await count('lab_invoices'),1);assert.equal(await count('lab_receipts'),1);
});
test('cash refunds use original cumulative allocation and actual OUT receipt only',async()=>{
  const sale=await ok(base({quantity:3,unitPrice:'0.335'}));
  for(let i=0;i<3;i++)await ok(base({kind:'RETURN',invoiceId:sale.id,quantity:1}));assert.equal((await row('lab_cash')).balance,'1000.00');assert.equal((await row('lab_stock')).qty,100);assert.equal((await row('lab_invoices')).returnedTotal,'1.01');assert.equal(await count('lab_receipts'),4);
  assert.equal((await lab.command(base({kind:'RETURN',invoiceId:sale.id,quantity:1}))).status,409);assert.equal((await lab.command(base({kind:'RETURN',invoiceId:sale.id,branchId:'b2',actorId:'a-b2',quantity:1}))).status,409);
});
test('Hostinger unavailable and internet trap receive only explicit probes; full flow stays local',async()=>{
  const probe=await lab.command(base(),{'x-lab-network-probe':'1'});assert.equal(probe.body.hostinger,503);assert.equal(probe.body.internet,503);const n=lab.networkAttempts.length;
  const sale=base();const s=await ok(sale);await ok(base({kind:'RETURN',invoiceId:s.id}));const o=await ok(base({kind:'RESERVE'}));await ok(base({kind:'DISPATCH',orderId:o.id}));await ok(sale);assert.equal(lab.networkAttempts.length,n);
});
test('unknown, inactive and wrong branch actors are rejected with no writes',async()=>{
  for(const input of [base({actorId:'missing'}),base({actorId:'a-b2'})])assert.equal((await lab.command(input)).status,409);
  await lab.db.prepare("UPDATE lab_actors SET active=0 WHERE companyId='c1' AND id='a-b1'").run();assert.equal((await lab.command(base())).status,409);assert.equal(await count('lab_operations'),0);
});
test('D1 FK UNIQUE CHECK NULL and cross-tenant constraints reject invalid rows',async()=>{
  await assert.rejects(lab.db.prepare("INSERT INTO lab_branches VALUES ('missing','bad',1)").run(),/FOREIGN KEY/);
  await assert.rejects(lab.db.prepare("INSERT INTO lab_companies VALUES ('c1')").run(),/UNIQUE/);
  await assert.rejects(lab.db.prepare("INSERT INTO lab_branches VALUES ('c1','bad',2)").run(),/CHECK/);
  await assert.rejects(lab.db.prepare("INSERT INTO lab_branches VALUES ('c1','bad',NULL)").run(),/NOT NULL/);
  await lab.db.prepare("INSERT INTO lab_actors VALUES ('c2','only-other','b1',1,0)").run();
  await assert.rejects(lab.db.prepare("INSERT INTO lab_operations VALUES ('c1','cross','b1','only-other','h','{}','{}','SALE')").run(),/FOREIGN KEY/);
  await lab.db.prepare('INSERT INTO lab_money_probe VALUES (?,?)').bind('max','999999999999999999.99').run();assert.equal((await row('lab_money_probe',"id='max'")).amount,'999999999999999999.99');
  await lab.db.prepare('INSERT INTO lab_money_probe VALUES (?,?)').bind('negative','-999999999999999999.99').run();assert.equal((await row('lab_money_probe',"id='negative'")).amount,'-999999999999999999.99');
  const sum=await lab.db.prepare('SELECT SUM(amount) AS unsafe FROM lab_money_probe WHERE id=?').bind('max').first();assert.notEqual(String(sum.unsafe),'999999999999999999.99');
});
test('SQLite binary and NOCASE do not silently provide MySQL Unicode collation',async()=>{
  for(const value of ['Cafe','cafe','café','CAFÉ','cafe '])await lab.db.prepare('INSERT INTO lab_collation_binary VALUES (?)').bind(value).run();assert.equal(await count('lab_collation_binary','1=1'),5);
  await lab.db.prepare("INSERT INTO lab_collation_nocase VALUES ('Cafe')").run();await assert.rejects(lab.db.prepare("INSERT INTO lab_collation_nocase VALUES ('cafe')").run(),/UNIQUE/);for(const value of ['café','CAFÉ','cafe '])await lab.db.prepare('INSERT INTO lab_collation_nocase VALUES (?)').bind(value).run();assert.equal(await count('lab_collation_nocase','1=1'),4);
});
test('synthetic digital UNKNOWN requires explicit reconciliation and internal wallet posts once',async()=>{
  const claim=base({kind:'DIGITAL_CLAIM',intentId:'intent',walletId:'wallet',amount:'12.34'});await ok(claim);await ok(claim);await ok(base({kind:'DIGITAL_UNKNOWN',intentId:'intent'}));assert.equal((await lab.command(base({kind:'DIGITAL_POST',intentId:'intent'}))).status,409);assert.equal((await row('lab_wallets')).balance,'100.00');assert.equal((await lab.command(base({kind:'DIGITAL_CLAIM',intentId:'intent',walletId:'wallet',amount:'12.34'}))).status,409);
  await ok(base({kind:'DIGITAL_RECONCILE',intentId:'intent',confirmedAmount:'12.34'}));const post=base({kind:'DIGITAL_POST',intentId:'intent'});const r=await Promise.all([ok(post),ok(post)]);assert.equal(r[0].id,r[1].id);assert.equal((await row('lab_wallets')).balance,'87.66');assert.equal((await row('lab_digital')).providerCalls,1);assert.equal((await row('lab_digital')).state,'POSTED');assert.equal(await count('lab_journal'),2);assert.equal((await lab.command(base({kind:'DIGITAL_POST',intentId:'intent'}))).status,409);
});
test('local persisted workerd restart retains committed result and exact state',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const persistPath=await mkdtemp(path.join(os.tmpdir(),'d1-isolated-lab-restart-'));let persistent;
  try {persistent=await createLab({persistPath});await persistent.reset();const input=base();const result=await persistent.command(input);assert.equal(result.status,200);await persistent.close({remove:false});persistent=await createLab({persistPath});assert.deepEqual(await persistent.command(input),result);assert.equal((await persistent.db.prepare("SELECT balance FROM lab_cash WHERE companyId='c1' AND branchId='b1'").first()).balance,'1010.00');}finally{await persistent?.close({remove:false});await rm(persistPath,{recursive:true,force:true});}
});

test('money: existing billing clamps excess discount and bounds tax, with delivery fee after tax',()=>{
  assert.equal(commands.total([{quantity:2,unitPrice:'1'}],'9999','0','0'),'0.00');
  assert.throws(()=>commands.total([{quantity:1,unitPrice:'1'}],'0','100.01'),/tax/);
  assert.equal(commands.total([{quantity:2,unitPrice:'9.99'}],'0.005','7.5','3.005'),'24.48');
});
test('money: 100 large repeated values aggregate exactly beyond int64 cents',()=>{
  const value='9007199254740999.91';
  const sum=Array.from({length:100},()=>value).reduce((a,v)=>a.plus(v),new commands.Money('0'));
  assert.equal(commands.money(sum.toString()),'900719925474099991.00');
  assert.equal(commands.money('-999999999999999999.99'),'-999999999999999999.99');
});
test('same last-unit request concurrent duplicates all recover one durable result',async()=>{
  await lab.db.prepare("UPDATE lab_stock SET qty=1 WHERE companyId='c1' AND branchId='b1'").run();
  const input=base();const r=await Promise.all(Array.from({length:20},()=>lab.command(input)));
  assert.ok(r.every(x=>x.status===200),JSON.stringify(r));assert.equal(new Set(r.map(x=>x.body.id)).size,1);assert.equal(await count('lab_receipts'),1);assert.equal((await row('lab_stock')).qty,0);
});
test('competing partial returns cannot exceed original quantity or cash',async()=>{
  const sale=await ok(base({unitPrice:'0.01'}));
  const r=await Promise.all(Array.from({length:5},()=>lab.command(base({kind:'RETURN',invoiceId:sale.id,quantity:1}))));
  assert.equal(r.filter(x=>x.status===200).length,1);assert.equal(await count('lab_returns'),1);assert.equal((await row('lab_stock')).qty,100);assert.equal((await row('lab_cash')).balance,'1000.00');assert.equal(await count('lab_receipts'),2);
});
test('one approval cannot authorize different requests even without a coupon',async()=>{
  await lab.db.prepare("UPDATE lab_customers SET creditLimit='0.00' WHERE companyId='c1' AND branchId='b1'").run();
  const r=await Promise.all(Array.from({length:5},()=>lab.command(base({mode:'CREDIT',customerId:'customer',approvalId:'approval'}))));
  assert.equal(r.filter(x=>x.status===200).length,1);assert.equal((await row('lab_customers')).balance,'10.00');assert.equal((await row('lab_approvals')).unused,0);
});
test('last coupon cannot be redeemed by different cash requests',async()=>{
  const r=await Promise.all(Array.from({length:5},()=>lab.command(base({couponId:'coupon'}))));
  assert.equal(r.filter(x=>x.status===200).length,1);assert.equal((await row('lab_cash')).balance,'1009.00');assert.equal((await row('lab_coupons')).remaining,0);assert.equal(await count('lab_receipts'),1);
});
test('monetary columns reject malformed and out-of-range noncanonical TEXT',async()=>{
  const sale=await ok(base({quantity:2}));
  await ok(base({kind:'RETURN',invoiceId:sale.id,quantity:1}));
  await ok(base({kind:'RESERVE'}));
  await ok(base({kind:'DIGITAL_CLAIM',intentId:'shape-probe',walletId:'wallet',amount:'1.00'}));
  await lab.db.prepare("INSERT INTO lab_money_probe VALUES ('shape','1.00')").run();
  const monetaryNames=new Set(['balance','creditLimit','allowance','discount','total','returnedTotal','amount']);
  const {results:tables}=await lab.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lab_%'").all();
  let checkedColumns=0;
  for(const {name:table} of tables) {
    const {results:columns}=await lab.db.prepare(`PRAGMA table_info(${table})`).all();
    for(const {name:column} of columns.filter(({name})=>monetaryNames.has(name))) {
      assert.ok(await count(table,'1=1')>0,`${table}.${column} must have real rows`);
      for(const value of ['1..0','1.0.','1.0','01.00','1.2.3','--1.00','-0.00','1000000000000000000.00','abc']) {
        await assert.rejects(lab.db.prepare(`UPDATE ${table} SET ${column}=?`).bind(value).run(),/CHECK/,`${table}.${column}: ${value}`);
      }
      checkedColumns++;
    }
  }
  assert.equal(checkedColumns,14,'every monetary column in the isolated schema must be covered');
});
test('duplicate committed while another invocation is awaiting admission returns stored result',async()=>{
  await lab.db.prepare("UPDATE lab_stock SET qty=1 WHERE companyId='c1' AND branchId='b1'").run();
  const input=base();const delayed=lab.command(input,{'x-lab-admission-delay':'1'});
  await new Promise(resolve=>setTimeout(resolve,10));const first=await ok(input);const second=await delayed;
  assert.equal(second.status,200,JSON.stringify(second.body));assert.equal(second.body.id,first.id);assert.equal(await count('lab_receipts'),1);
});

test('rounded-zero cash return portions create no fictitious OUT receipts',async()=>{
  const sale=await ok(base({quantity:3,unitPrice:'0.004'}));assert.equal(sale.total,'0.01');
  const first=await ok(base({kind:'RETURN',invoiceId:sale.id,quantity:1}));assert.equal(first.total,'0.00');assert.equal(await count('lab_receipts'),1);
  await ok(base({kind:'RETURN',invoiceId:sale.id,quantity:1}));await ok(base({kind:'RETURN',invoiceId:sale.id,quantity:1}));
  assert.equal(await count('lab_receipts'),2);assert.equal((await row('lab_cash')).balance,'1000.00');
});
