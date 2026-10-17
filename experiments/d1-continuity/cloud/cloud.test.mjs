import assert from 'node:assert/strict';
import { Money, money } from '../commands.mjs';
import { createCloudLab } from './lab.mjs';

// Importing this module does not connect to Cloudflare. Only the explicit runner calls it.
export async function runCloudCases(lab, record) {
  let serial = 0;
  const base = (extra = {}) => ({ companyId:'c1', actorId:'a-b1', branchId:'b1', epoch:1,
    clientRequestId:`cloud-case-${++serial}`, kind:'SALE', mode:'CASH', sku:'sku', quantity:1, unitPrice:'10.00', ...extra });
  const ok = async (input, controls) => {
    const response = await lab.command(input, controls);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  };
  const rejected = async (input, error, controls) => {
    const response = await lab.command(input, controls);
    assert.equal(response.status, 409); assert.equal(response.body.error, error);
  };
  const one = sql => lab.db.prepare(sql).first();
  const snapshot = () => one(`SELECT
    (SELECT qty FROM lab_stock WHERE companyId='c1' AND branchId='b1') AS qty,
    (SELECT reserved FROM lab_stock WHERE companyId='c1' AND branchId='b1') AS reserved,
    (SELECT balance FROM lab_cash WHERE companyId='c1' AND branchId='b1') AS cash,
    (SELECT balance FROM lab_customers WHERE companyId='c1' AND branchId='b1') AS ar,
    (SELECT next FROM lab_counters WHERE companyId='c1' AND branchId='b1') AS counter,
    (SELECT COUNT(*) FROM lab_invoices WHERE companyId='c1') AS invoices,
    (SELECT COUNT(*) FROM lab_orders WHERE companyId='c1') AS orders,
    (SELECT COUNT(*) FROM lab_returns WHERE companyId='c1') AS returns,
    (SELECT COUNT(*) FROM lab_receipts WHERE companyId='c1') AS receipts,
    (SELECT COUNT(*) FROM lab_operations WHERE companyId='c1') AS operations,
    (SELECT COUNT(*) FROM lab_moves WHERE companyId='c1') AS moves,
    (SELECT COUNT(*) FROM lab_journal WHERE companyId='c1') AS journal,
    (SELECT COUNT(*) FROM lab_audit WHERE companyId='c1') AS audit,
    (SELECT COUNT(*) FROM lab_outbox WHERE companyId='c1') AS outbox,
    (SELECT COUNT(*) FROM lab_assert) AS guards`);
  async function scenario(name, fn) {
    const start = performance.now(), before = lab.budget.requests;
    try { await lab.reset(); const details = await fn(); await record({ name, status:'pass', wallMs:performance.now()-start, requests:lab.budget.requests-before, details }); }
    catch (error) {
      await record({ name, status:'fail', wallMs:performance.now()-start, requests:lab.budget.requests-before,
        error:{ code:error.code ?? 'ASSERTION', message:error.message } });
      if (error.code?.startsWith('CLOUD_') && error.code !== 'CLOUD_SQL_CONSTRAINT') throw error;
    }
  }

  await scenario('signed DECIMAL20,2 strings roundtrip and Decimal aggregate; schema rejects malformed shapes', async () => {
    const values = ['999999999999999999.99','-999999999999999999.99',...Array(100).fill('9007199254740999.91')];
    await lab.db.batch(values.map((value,index) => lab.db.prepare('INSERT INTO lab_money_probe VALUES (?,?)').bind(`m${index}`,value)));
    const rows = (await lab.db.prepare('SELECT amount FROM lab_money_probe ORDER BY rowid').all()).results;
    assert.deepEqual(rows.map(row=>row.amount),values);
    assert.equal(money(rows.reduce((sum,row)=>sum.plus(row.amount),new Money(0)).toFixed(2)),'900719925474099991.00');
    for (const invalid of ['1..0','01.00','-0.00','1000000000000000000.00','abc']) {
      await assert.rejects(lab.db.prepare('INSERT INTO lab_money_probe VALUES (?,?)').bind(`bad-${invalid}`,invalid).run(), error=>error.code==='CLOUD_SQL_CONSTRAINT');
    }
    const unsafe = (await one("SELECT SUM(amount) AS amount FROM lab_money_probe WHERE id='m0'")).amount;
    assert.notEqual(String(unsafe),values[0]);
    return { exactRows:rows.length, exactAggregate:'900719925474099991.00', unsafeSqlSum:String(unsafe) };
  });

  await scenario('cash and credit commit source, cash or AR, stock, journal, request, audit and outbox once', async () => {
    const cash = await ok(base({ quantity:3,unitPrice:'0.335' }));
    const credit = await ok(base({ mode:'CREDIT',customerId:'customer',quantity:2,unitPrice:'2.505' }));
    assert.equal(cash.total,'1.01'); assert.equal(credit.total,'5.01');
    const state = await snapshot();
    assert.deepEqual(state,{qty:95,reserved:0,cash:'1001.01',ar:'5.01',counter:3,invoices:2,orders:0,returns:0,receipts:1,operations:2,moves:2,journal:4,audit:2,outbox:2,guards:0});
    const amounts = (await lab.db.prepare('SELECT amount FROM lab_journal').all()).results;
    assert.equal(amounts.reduce((sum,row)=>sum.plus(row.amount),new Money(0)).toFixed(2),'0.00');
    return state;
  });

  await scenario('bounded POS/storefront, credit-limit, and duplicate-last-unit races preserve one durable effect', async () => {
    await lab.db.prepare("UPDATE lab_stock SET qty=1 WHERE companyId='c1' AND branchId='b1'").run();
    const competing = await Promise.all([lab.command(base()),lab.command(base({kind:'RESERVE'})),lab.command(base())]);
    assert.equal(competing.filter(item=>item.status===200).length,1);
    assert.ok(competing.filter(item=>item.status!==200).every(item=>item.body.error==='INSUFFICIENT_STOCK'));
    let state = await snapshot(); assert.equal(state.qty-state.reserved,0); assert.equal(state.invoices+state.orders,1); assert.equal(state.moves,1);
    await lab.reset();
    const credit = await Promise.all(Array.from({length:3},()=>lab.command(base({mode:'CREDIT',customerId:'customer',unitPrice:'75.00'}))));
    assert.equal(credit.filter(item=>item.status===200).length,1);
    assert.ok(credit.filter(item=>item.status!==200).every(item=>item.body.error==='CREDIT_LIMIT'));
    state = await snapshot(); assert.equal(state.ar,'75.00'); assert.equal(state.receipts,0);
    await lab.reset();
    await lab.db.prepare("UPDATE lab_stock SET qty=1 WHERE companyId='c1' AND branchId='b1'").run();
    const request = base(), duplicates = await Promise.all(Array.from({length:3},()=>lab.command(request)));
    assert.ok(duplicates.every(item=>item.status===200),JSON.stringify(duplicates));
    assert.equal(new Set(duplicates.map(item=>item.body.id)).size,1);
    state = await snapshot(); assert.equal(state.qty,0); assert.equal(state.receipts,1); assert.equal(state.operations,1);
    return { contendersPerPhase:3, phases:3, finalState:state };
  });

  await scenario('reservation then COD dispatch preserves stock and creates no premature cash receipt', async () => {
    const order = await ok(base({kind:'RESERVE',quantity:3}));
    let state = await snapshot(); assert.equal(state.invoices,0); assert.equal(state.receipts,0); assert.equal(state.reserved,3); assert.equal(state.qty,100);
    const dispatch = await ok(base({kind:'DISPATCH',orderId:order.id}));
    state = await snapshot(); assert.equal(dispatch.total,'30.00'); assert.equal(state.qty,97); assert.equal(state.reserved,0); assert.equal(state.receipts,0); assert.equal(state.cash,'1000.00');
    assert.equal((await one("SELECT status FROM lab_orders WHERE companyId='c1'")).status,'DISPATCHED');
    return state;
  });

  await scenario('dropped postcommit response replays through closed period, rotated epoch and fresh REST client', async () => {
    const request = base(), dropped = await lab.command(request,{dropResponse:true}); assert.equal(dropped.status,503);
    await ok(base({kind:'ROTATE_EPOCH'})); await ok(base({kind:'CLOSE_PERIOD',epoch:2}));
    const original = await ok(request);
    const reconnected = await createCloudLab({confirmSyntheticSandbox:true,budget:lab.budget,initialize:false});
    try { assert.deepEqual(await reconnected.command(request),{status:200,body:original}); }
    finally { await reconnected.close(); }
    const state = await snapshot(); assert.equal(state.invoices,1); assert.equal(state.receipts,1); assert.equal(state.cash,'1010.00');
    return { originalRequest:request, originalResult:original, durability:'fresh-REST-client-only-same-local-process', state };
  });

  await scenario('zero-row guard and late CHECK failure roll back source, counter and every effect', async () => {
    for (const controls of [{zeroGuard:true},{finalFailure:true}]) {
      const request = base(); await rejected(request,'INJECTED_ATOMIC_FAILURE',controls);
      const state = await snapshot();
      assert.deepEqual(state,{qty:100,reserved:0,cash:'1000.00',ar:'0.00',counter:1,invoices:0,orders:0,returns:0,receipts:0,operations:0,moves:0,journal:0,audit:0,outbox:0,guards:0});
      await ok(request); await lab.reset();
    }
    return { nativeBatchRollbackModes:2, originalPayloadRetrySucceeded:true };
  });

  await scenario('concurrent partial returns cannot exceed original invoice and refund rounding totals exactly', async () => {
    const sale = await ok(base({quantity:3,unitPrice:'0.335'}));
    const results = await Promise.all(Array.from({length:4},()=>lab.command(base({kind:'RETURN',invoiceId:sale.id,quantity:1}))));
    const successes = results.filter(item=>item.status===200); assert.equal(successes.length,3);
    assert.equal(results.find(item=>item.status!==200).body.error,'RETURN_QUANTITY_EXCEEDED');
    assert.equal(successes.reduce((sum,item)=>sum.plus(item.body.total),new Money(0)).toFixed(2),'1.01');
    const invoice = await one("SELECT returnedQty,returnedTotal FROM lab_invoices WHERE companyId='c1'");
    assert.deepEqual(invoice,{returnedQty:3,returnedTotal:'1.01'});
    const state = await snapshot(); assert.equal(state.cash,'1000.00'); assert.equal(state.qty,100); assert.equal(state.receipts,4); assert.equal(state.returns,3);
    return { invoice,state };
  });

  await scenario('stale epoch, changed replay payload and tenant/branch constraints refuse mutation', async () => {
    await ok(base({kind:'ROTATE_EPOCH'})); await rejected(base(),'STALE_WRITER_EPOCH');
    await rejected(base({actorId:'a-b2',epoch:2}),'ACTOR_NOT_ACTIVE_IN_BRANCH');
    const request = base({epoch:2}), original = await ok(request);
    await rejected({...request,unitPrice:'11.00'},'IDEMPOTENCY_PAYLOAD_MISMATCH');
    await rejected({...request,actorId:'a-b2',branchId:'b2'},'IDEMPOTENCY_PAYLOAD_MISMATCH');
    await lab.db.prepare("INSERT INTO lab_actors VALUES ('c2','only-other','b1',1,0)").run();
    await assert.rejects(lab.db.prepare("INSERT INTO lab_operations VALUES ('c1','cross','b1','only-other','h','{}','{}','SALE')").run(),error=>error.code==='CLOUD_SQL_CONSTRAINT'&&/FOREIGN KEY/.test(error.message));
    await rejected(base({companyId:'c2',actorId:'only-missing'}),'ACTOR_NOT_ACTIVE_IN_BRANCH');
    const state = await snapshot(); assert.equal(state.invoices,1); assert.equal(state.receipts,1); assert.equal(state.operations,2);
    return { original,state };
  });

  await scenario('synthetic digital UNKNOWN neither reissues intent nor posts wallet without reconciliation', async () => {
    const claim = base({kind:'DIGITAL_CLAIM',intentId:'cloud-intent',walletId:'wallet',amount:'12.34'});
    await ok(claim); await ok(claim); await ok(base({kind:'DIGITAL_UNKNOWN',intentId:'cloud-intent'}));
    await rejected(base({kind:'DIGITAL_POST',intentId:'cloud-intent'}),'RECONCILIATION_REQUIRED');
    await rejected(base({kind:'DIGITAL_CLAIM',intentId:'cloud-intent',walletId:'wallet',amount:'12.34'}),'INTENT_ALREADY_CLAIMED_RECONCILE_ONLY');
    const row = await one("SELECT state,providerCalls,(SELECT balance FROM lab_wallets WHERE companyId='c1' AND branchId='b1') AS wallet,(SELECT COUNT(*) FROM lab_journal) AS journal FROM lab_digital WHERE companyId='c1'");
    assert.deepEqual(row,{state:'UNKNOWN',providerCalls:1,wallet:'100.00',journal:0}); return { ...row, realProviderCalls:0 };
  });

  let finalFixture;
  await scenario('deterministic cashier/storefront fixture succeeds with Hostinger modeled unavailable and no Hostinger request', async () => {
    const request = base({clientRequestId:'cloud-final-sale',quantity:3,unitPrice:'0.335'}), result = await ok(request);
    await ok(base({clientRequestId:'cloud-final-return',kind:'RETURN',invoiceId:result.id,quantity:1}));
    const order = await ok(base({clientRequestId:'cloud-final-reserve',kind:'RESERVE',quantity:2}));
    await ok(base({clientRequestId:'cloud-final-dispatch',kind:'DISPATCH',orderId:order.id}));
    assert.deepEqual(await ok(request),result); assert.deepEqual(lab.networkAttempts,[]);
    const state = await snapshot(); assert.equal(state.cash,'1000.67'); assert.equal(state.qty,96); assert.equal(state.reserved,0);
    assert.deepEqual(await one("SELECT epoch,periodOpen FROM lab_control WHERE companyId='c1' AND branchId='b1'"),{epoch:1,periodOpen:1});
    finalFixture = {request,result,state}; return { ...finalFixture, hostinger:lab.hostinger, actualHostingerRequests:0 };
  });
  return finalFixture;
}
