import Decimal from 'decimal.js';
export const Money = Decimal.clone({precision:40,rounding:Decimal.ROUND_HALF_UP});
const MAX = new Money('999999999999999999.99');
export function money(value) {
  if(typeof value!=='string'||! /^-?\d+(\.\d+)?$/.test(value)) throw new Error('money must be a decimal string');
  const result=new Money(value).toDecimalPlaces(2);
  if(result.abs().gt(MAX)) throw new Error('money range exceeded');
  return result.isZero()?'0.00':result.toFixed(2);
}
export function total(lines,discount='0',taxRate='0',deliveryFee='0') {
  let subtotal=new Money(0);
  for(const line of lines) {
    if(!Number.isSafeInteger(line.quantity)||line.quantity<=0) throw new Error('invalid quantity');
    if(typeof line.unitPrice!=='string'||!/^\d+(\.\d+)?$/.test(line.unitPrice)) throw new Error('invalid price');
    subtotal=subtotal.plus(new Money(line.unitPrice).times(line.quantity).toDecimalPlaces(2));
  }
  if(typeof taxRate!=='string'||!/^\d+(\.\d+)?$/.test(taxRate)||new Money(taxRate).gt(100)) throw new Error('invalid tax rate');
  if(new Money(discount).isNegative()||new Money(deliveryFee).isNegative()) throw new Error('invalid discount or delivery fee');
  const net=subtotal.minus(Money.min(money(discount),subtotal));
  return money(net.plus(net.times(taxRate).div(100).toDecimalPlaces(2)).plus(money(deliveryFee)).toFixed(2));
}
export function canonicalPayload(value) {
  if(Array.isArray(value)) return '['+value.map(canonicalPayload).join(',')+']';
  if(value&&typeof value==='object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalPayload(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function reject(code) {throw Object.assign(new Error(code),{code,status:409});}
const required=(row,code)=>row??reject(code);
const exact=(value)=>money(value.toFixed(2));
async function executeCommand(db,input,controls={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)) reject('INVALID_COMMAND');
  for(const field of ['companyId','actorId','branchId','clientRequestId','kind']) if(typeof input[field]!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(input[field])) reject('INVALID_'+field);
  if(!Number.isSafeInteger(input.epoch)||input.epoch<1) reject('INVALID_EPOCH');
  if(['finalFailure','zeroGuard','dropResponse','controls'].some(key=>key in input)) reject('CONTROLS_MUST_BE_HEADERS');
  const payload=canonicalPayload(input);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
  const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const {companyId:c,branchId:b,actorId:a,clientRequestId:op,kind}=input;
  const prepare=(sql,...values)=>db.prepare(sql).bind(...values);
  const first=(sql,...values)=>prepare(sql,...values).first();
  for(let attempt=0;attempt<16;attempt++) {
    // A committed result is recovered using its original scoped payload before live admission.
    const existing=await first('SELECT * FROM lab_operations WHERE companyId=? AND clientRequestId=?',c,op);
    if(existing) {
      if(existing.payloadHash!==hash||existing.payload!==payload||existing.actorId!==a||existing.branchId!==b) reject('IDEMPOTENCY_PAYLOAD_MISMATCH');
      return JSON.parse(existing.result);
    }
    if(controls.admissionDelay&&attempt===0) await new Promise(resolve=>setTimeout(resolve,50));
    const actor=required(await first('SELECT * FROM lab_actors WHERE companyId=? AND id=? AND branchId=? AND active=1',c,a,b),'ACTOR_NOT_ACTIVE_IN_BRANCH');
    const control=required(await first('SELECT * FROM lab_control WHERE companyId=? AND branchId=?',c,b),'NO_CONTROL');
    if(control.epoch!==input.epoch) reject('STALE_WRITER_EPOCH');
    if(!control.periodOpen&&!['CLOSE_PERIOD','ROTATE_EPOCH'].includes(kind)) reject('PERIOD_CLOSED');
    const counter=required(await first('SELECT * FROM lab_counters WHERE companyId=? AND branchId=?',c,b),'NO_COUNTER');
    const id=`${kind==='RESERVE'?'O':kind==='RETURN'?'R':kind==='SALE'||kind==='DISPATCH'?'I':'X'}-${b}-${counter.next}`;
    const statements=[];
    const add=(sql,...values)=>statements.push(prepare(sql,...values));
    const check=(predicate,...values)=>{add(`INSERT INTO lab_assert(ok) SELECT CASE WHEN (${predicate}) THEN 1 ELSE 0 END`,...values);add('DELETE FROM lab_assert');};
    const cas=(sql,...values)=>{add(sql,...values);check('changes()=1');};
    check('EXISTS(SELECT 1 FROM lab_actors a JOIN lab_branches b ON b.companyId=a.companyId AND b.id=a.branchId WHERE a.companyId=? AND a.id=? AND a.branchId=? AND a.active=1 AND a.version=? AND b.active=1)',c,a,b,actor.version);
    check('EXISTS(SELECT 1 FROM lab_control WHERE companyId=? AND branchId=? AND epoch=? AND periodOpen=? AND version=?)',c,b,input.epoch,control.periodOpen,control.version);
    cas('UPDATE lab_counters SET next=next+1,version=version+1 WHERE companyId=? AND branchId=? AND next=? AND version=?',c,b,counter.next,counter.version);
    const effects=[];
    const effect=(sql,...values)=>effects.push([sql,values]);
    const post=(debit,credit,amount)=>{
      effect('INSERT INTO lab_journal VALUES (?,?,?,?)',c,op,debit,amount);
      effect('INSERT INTO lab_journal VALUES (?,?,?,?)',c,op,credit,exact(new Money(amount).negated()));
    };
    const stockChange=async(sku,qtyDelta,reservedDelta)=>{
      const stock=required(await first('SELECT * FROM lab_stock WHERE companyId=? AND branchId=? AND sku=?',c,b,sku),'STOCK_NOT_FOUND');
      const qty=stock.qty+qtyDelta,reserved=stock.reserved+reservedDelta;
      if(!Number.isSafeInteger(qty)||!Number.isSafeInteger(reserved)||qty<0||reserved<0||reserved>qty) reject('INSUFFICIENT_STOCK');
      cas('UPDATE lab_stock SET qty=?,reserved=?,version=version+1 WHERE companyId=? AND branchId=? AND sku=? AND version=? AND qty=? AND reserved=?',qty,reserved,c,b,sku,stock.version,stock.qty,stock.reserved);
      effect('INSERT INTO lab_moves VALUES (?,?,?,?,?,?)',c,op,b,sku,qtyDelta,reservedDelta);
    };
    const cashChange=async(amount)=>{
      const cash=required(await first('SELECT * FROM lab_cash WHERE companyId=? AND branchId=?',c,b),'CASH_NOT_FOUND');
      const balance=exact(new Money(cash.balance).plus(amount));if(new Money(balance).isNegative()) reject('INSUFFICIENT_CASH');
      cas('UPDATE lab_cash SET balance=?,version=version+1 WHERE companyId=? AND branchId=? AND version=? AND balance=?',balance,c,b,cash.version,cash.balance);
    };
    const customerChange=async(customerId,amount,approvalId)=>{
      const customer=required(await first('SELECT * FROM lab_customers WHERE companyId=? AND branchId=? AND id=?',c,b,customerId),'CUSTOMER_NOT_FOUND');
      const balance=exact(new Money(customer.balance).plus(amount));
      if(new Money(amount).gt(0)&&new Money(balance).gt(customer.creditLimit)&&!approvalId) reject('CREDIT_LIMIT');
      if(approvalId) {
        const approval=required(await first('SELECT * FROM lab_approvals WHERE companyId=? AND branchId=? AND id=? AND customerId=?',c,b,approvalId,customerId),'APPROVAL_NOT_FOUND');
        if(!approval.unused||new Money(amount).gt(approval.allowance)) reject('APPROVAL_EXHAUSTED');
        cas('UPDATE lab_approvals SET unused=0,version=version+1 WHERE companyId=? AND branchId=? AND id=? AND version=? AND unused=1 AND allowance=? AND customerId=?',c,b,approvalId,approval.version,approval.allowance,customerId);
      }
      cas('UPDATE lab_customers SET balance=?,version=version+1 WHERE companyId=? AND branchId=? AND id=? AND version=? AND balance=? AND creditLimit=?',balance,c,b,customerId,customer.version,customer.balance,customer.creditLimit);
    };
    let result={id,kind,total:'0.00'};
    if(kind==='SALE'||kind==='RESERVE') {
      if(!Number.isSafeInteger(input.quantity)||input.quantity<=0) reject('INVALID_QUANTITY');
      if(typeof input.sku!=='string') reject('INVALID_SKU');
      let discount=input.discount??'0';
      if(input.couponId) {
        const coupon=required(await first('SELECT * FROM lab_coupons WHERE companyId=? AND branchId=? AND id=?',c,b,input.couponId),'COUPON_NOT_FOUND');
        if(coupon.remaining<=0) reject('COUPON_EXHAUSTED');
        discount=exact(new Money(discount).plus(coupon.discount));
        cas('UPDATE lab_coupons SET remaining=remaining-1,version=version+1 WHERE companyId=? AND branchId=? AND id=? AND version=? AND remaining=? AND discount=?',c,b,input.couponId,coupon.version,coupon.remaining,coupon.discount);
      }
      result.total=total([{quantity:input.quantity,unitPrice:input.unitPrice}],discount,input.taxRate??'0',input.deliveryFee??'0');
      if(kind==='RESERVE') {
        await stockChange(input.sku,0,input.quantity);
        effect("INSERT INTO lab_orders VALUES (?,?,?,?,?,?,'RESERVED',0)",c,id,b,input.sku,input.quantity,result.total);
      } else {
        if(!['CASH','CREDIT'].includes(input.mode)) reject('INVALID_MODE');
        await stockChange(input.sku,-input.quantity,0);
        effect('INSERT INTO lab_invoices(companyId,id,branchId,actorId,sku,quantity,mode,customerId,total) VALUES (?,?,?,?,?,?,?,?,?)',c,id,b,a,input.sku,input.quantity,input.mode,input.customerId??null,result.total);
        if(input.mode==='CASH') {
          await cashChange(result.total);
          if(new Money(result.total).gt(0)) effect("INSERT INTO lab_receipts VALUES (?,?,?,?,'IN',?)",c,op,b,id,result.total);post('CASH','REVENUE',result.total);
        } else {
          await customerChange(input.customerId,result.total,input.approvalId);post('AR','REVENUE',result.total);
        }
      }
    } else if(kind==='DISPATCH') {
      const order=required(await first('SELECT * FROM lab_orders WHERE companyId=? AND branchId=? AND id=?',c,b,input.orderId),'ORDER_NOT_FOUND');
      if(order.status!=='RESERVED') reject('ORDER_ALREADY_DISPATCHED');
      result.total=order.total;
      cas("UPDATE lab_orders SET status='DISPATCHED',version=version+1 WHERE companyId=? AND id=? AND branchId=? AND version=? AND status='RESERVED' AND total=? AND sku=? AND quantity=?",c,order.id,b,order.version,order.total,order.sku,order.quantity);
      await stockChange(order.sku,-order.quantity,-order.quantity);
      effect("INSERT INTO lab_invoices(companyId,id,branchId,actorId,sku,quantity,mode,total) VALUES (?,?,?,?,?,?,'COD',?)",c,id,b,a,order.sku,order.quantity,order.total);
      post('COD_RECEIVABLE','REVENUE',order.total);
    } else if(kind==='RETURN') {
      const invoice=required(await first('SELECT * FROM lab_invoices WHERE companyId=? AND branchId=? AND id=?',c,b,input.invoiceId),'INVOICE_NOT_FOUND');
      if(!Number.isSafeInteger(input.quantity)||input.quantity<=0||input.quantity>invoice.quantity-invoice.returnedQty) reject('RETURN_QUANTITY_EXCEEDED');
      // Cumulative allocation makes the final return absorb earlier rounding pennies exactly.
      const returnedQty=invoice.returnedQty+input.quantity;
      const returnedTotal=exact(new Money(invoice.total).times(returnedQty).div(invoice.quantity));
      const amount=exact(new Money(returnedTotal).minus(invoice.returnedTotal));result.total=amount;result.invoiceId=invoice.id;
      cas('UPDATE lab_invoices SET returnedQty=?,returnedTotal=?,version=version+1 WHERE companyId=? AND branchId=? AND id=? AND version=? AND returnedQty=? AND returnedTotal=? AND total=? AND quantity=? AND mode=?',returnedQty,returnedTotal,c,b,invoice.id,invoice.version,invoice.returnedQty,invoice.returnedTotal,invoice.total,invoice.quantity,invoice.mode);
      await stockChange(invoice.sku,input.quantity,0);
      effect('INSERT INTO lab_returns VALUES (?,?,?,?,?,?)',c,id,b,invoice.id,input.quantity,amount);
      const signed=new Money(amount).negated();
      if(invoice.mode==='CASH') {
        await cashChange(signed);if(new Money(amount).gt(0)) effect("INSERT INTO lab_receipts VALUES (?,?,?,?,'OUT',?)",c,op,b,invoice.id,amount);post('CASH','REVENUE',exact(signed));
      } else if(invoice.mode==='CREDIT') {
        await customerChange(invoice.customerId,signed);post('AR','REVENUE',exact(signed));
      } else post('COD_RECEIVABLE','REVENUE',exact(signed));
    } else if(kind==='CLOSE_PERIOD'||kind==='ROTATE_EPOCH') {
      cas('UPDATE lab_control SET periodOpen=?,epoch=?,version=version+1 WHERE companyId=? AND branchId=? AND version=? AND epoch=?',kind==='CLOSE_PERIOD'?0:control.periodOpen,kind==='ROTATE_EPOCH'?control.epoch+1:control.epoch,c,b,control.version,control.epoch);
      result.epoch=kind==='ROTATE_EPOCH'?control.epoch+1:control.epoch;
    } else if(kind==='DIGITAL_CLAIM') {
      if(typeof input.intentId!=='string'||typeof input.walletId!=='string') reject('INVALID_DIGITAL_INTENT');
      if(await first('SELECT 1 FROM lab_digital WHERE companyId=? AND id=?',c,input.intentId)) reject('INTENT_ALREADY_CLAIMED_RECONCILE_ONLY');
      const amount=money(input.amount);if(new Money(amount).lte(0)) reject('INVALID_AMOUNT');
      const wallet=required(await first('SELECT * FROM lab_wallets WHERE companyId=? AND branchId=? AND id=?',c,b,input.walletId),'WALLET_NOT_FOUND');
      check('EXISTS(SELECT 1 FROM lab_wallets WHERE companyId=? AND branchId=? AND id=? AND version=? AND balance=?)',c,b,input.walletId,wallet.version,wallet.balance);
      effect("INSERT INTO lab_digital VALUES (?,?,?,?,?,'CLAIMED',1,0)",c,input.intentId,b,input.walletId,amount);
      result={...result,id:input.intentId,total:amount,state:'CLAIMED',providerInstruction:'SYNTHETIC_ONLY_NO_PROVIDER_CALL'};
    } else if(['DIGITAL_UNKNOWN','DIGITAL_RECONCILE','DIGITAL_POST'].includes(kind)) {
      const intent=required(await first('SELECT * FROM lab_digital WHERE companyId=? AND branchId=? AND id=?',c,b,input.intentId),'INTENT_NOT_FOUND');
      const target=kind==='DIGITAL_UNKNOWN'?'UNKNOWN':kind==='DIGITAL_RECONCILE'?'CONFIRMED':'POSTED';
      if(kind==='DIGITAL_UNKNOWN'&&intent.state!=='CLAIMED') reject('INVALID_INTENT_TRANSITION');
      if(kind==='DIGITAL_RECONCILE'&&(intent.state!=='UNKNOWN'||money(input.confirmedAmount)!==intent.amount)) reject('RECONCILIATION_MISMATCH');
      if(kind==='DIGITAL_POST'&&intent.state!=='CONFIRMED') reject('RECONCILIATION_REQUIRED');
      cas('UPDATE lab_digital SET state=?,version=version+1 WHERE companyId=? AND branchId=? AND id=? AND state=? AND version=? AND amount=? AND walletId=?',target,c,b,intent.id,intent.state,intent.version,intent.amount,intent.walletId);
      if(kind==='DIGITAL_POST') {
        const wallet=required(await first('SELECT * FROM lab_wallets WHERE companyId=? AND branchId=? AND id=?',c,b,intent.walletId),'WALLET_NOT_FOUND');
        const balance=exact(new Money(wallet.balance).minus(intent.amount));if(new Money(balance).lt(0)) reject('WALLET_INSUFFICIENT');
        cas('UPDATE lab_wallets SET balance=?,version=version+1 WHERE companyId=? AND branchId=? AND id=? AND version=? AND balance=?',balance,c,b,intent.walletId,wallet.version,wallet.balance);post('WALLET','DIGITAL_REVENUE',exact(new Money(intent.amount).negated()));
      }
      result={...result,id:intent.id,total:intent.amount,state:target};
    } else reject('UNKNOWN_COMMAND');
    // All admissions, source/effects and durable replay are one real D1 atomic batch.
    add('INSERT INTO lab_operations VALUES (?,?,?,?,?,?,?,?)',c,op,b,a,hash,payload,JSON.stringify(result),kind);
    for(const [sql,values] of effects)add(sql,...values);
    add('INSERT INTO lab_audit VALUES (?,?,?)',c,op,JSON.stringify({actorId:a,branchId:b,kind,id:result.id}));
    add('INSERT INTO lab_outbox VALUES (?,?,?)',c,op,JSON.stringify(result));
    if(controls.zeroGuard)cas('UPDATE lab_stock SET version=version WHERE companyId=? AND branchId=? AND sku=?',c,b,'forced-missing');
    if(controls.finalFailure)add('INSERT INTO lab_assert VALUES (0)');
    try {await db.batch(statements);return result;}
    catch(error) {
      if(controls.zeroGuard||controls.finalFailure) reject('INJECTED_ATOMIC_FAILURE');
      if(!/CHECK constraint failed|UNIQUE constraint failed|SQLITE_BUSY|database is locked/.test(error.message)) throw error;
      if(attempt===15) reject('CAS_RETRY_LIMIT');
    }
  }
  reject('CAS_RETRY_LIMIT');
}



export async function execute(db,input,controls={}) {
  try {return await executeCommand(db,input,controls);}
  catch(error) {
    // Another invocation may commit between our replay read and a rejected admission.
    // Recover that original payload instead of returning a misleading live-state error.
    if(typeof input?.companyId==='string'&&typeof input?.clientRequestId==='string') {
      const existing=await db.prepare('SELECT * FROM lab_operations WHERE companyId=? AND clientRequestId=?').bind(input.companyId,input.clientRequestId).first();
      if(existing&&existing.payload===canonicalPayload(input)&&existing.actorId===input.actorId&&existing.branchId===input.branchId) return JSON.parse(existing.result);
    }
    throw error;
  }
}
