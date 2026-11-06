import { and, eq, like, or } from "drizzle-orm";
import { accountingEntries, auditLogs, digitalSaleDetails, invoiceItems, invoices } from "../../../drizzle/schema";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "../../../shared/errors";
import type { Actor } from "../tx";
import type { Tx } from "../../db";
import { money, sumMoney, toDbMoney } from "../money";

/** Current read under the invoice mutex: an authority probe may have opened an older RR snapshot. */
export async function remainingInvoiceCashRounding(tx: Tx, invoiceId: number, original: string | null) {
  const reversals = await tx.select({ revenue: accountingEntries.revenue }).from(accountingEntries).where(and(
    eq(accountingEntries.invoiceId, invoiceId), eq(accountingEntries.entryType, "ADJUST"),
    or(eq(accountingEntries.dedupeKey, `ADJUST:IQD:RETURN:${invoiceId}`), like(accountingEntries.dedupeKey, `ADJUST:IQD:GOODS_RETURN:${invoiceId}:%`), like(accountingEntries.dedupeKey, `ADJUST:IQD:DIGITAL_RETURN:${invoiceId}:%`)),
  )).orderBy(accountingEntries.id).for("update");
  return money(original ?? "0").plus(sumMoney(reversals.map((row) => row.revenue ?? "0")));
}


type AllocationLine={id:number;quantity:number;returnedBefore:number;rounding:string;total:string};
type AllocationPlan={version:1;original:string;remainingAtStart:string;lines:AllocationLine[]};
function invalidRounding():never {throw new TRPCError({code:"CONFLICT",message:appErrorMessage({what:"تعذّر تخصيص تقريب المرتجع",why:"لقطة التقريب أو البنود لا تطابق سجل المرتجعات",doThis:"احتفظ بالمبالغ المسددة وراجع تخصيص الفاتورة؛ لا تعدّل الردود السابقة أو تصرف فرقاً تخمينياً"})});}

/** Caller holds the invoice mutex before locking items, then digital markers.
 * Terminal digital reversals are financial completion even for legacy writers with quantity=0.
 * Locking reads are required: locking the header alone does not refresh a prior RR snapshot.
 */
export async function financialReturnItems(tx:Tx,invoiceId:number) {
 const items=await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId,invoiceId)).orderBy(invoiceItems.id).for("update");
 const digital=await tx.select({id:digitalSaleDetails.invoiceItemId,status:digitalSaleDetails.fulfillmentStatus}).from(digitalSaleDetails).where(eq(digitalSaleDetails.invoiceId,invoiceId)).orderBy(digitalSaleDetails.id).for("update");
 const terminal=new Set(digital.filter(d=>["REVERSED","LOSS_REFUND"].includes(d.status)).map(d=>d.id));
 return items.map(item=>({...item,returnedBaseQuantity:terminal.has(item.id)?item.baseQuantity:item.returnedBaseQuantity}));
}

/** Mandatory immutable arithmetic policy. Invoice lock serializes creation; this is not a money/evidence ledger.
 * Historical payments are retained: only the ledger's remaining signed adjustment is allocated at first adoption.
 * PREVIEW derives the same tentative plan without persisting it. Writers always revalidate and save it atomically.
 */
export async function allocatedReturnRounding(tx:Tx,invoice:{id:number;cashRoundingAdjustment:string|null},
 selection:Array<{invoiceItemId:number;baseQuantity:number}>,actor:Actor,mode:"WRITE"|"PREVIEW"="WRITE") {
 await tx.select({id:invoices.id}).from(invoices).where(eq(invoices.id,invoice.id)).for("update");
 const items=await financialReturnItems(tx,invoice.id);
 if(money(invoice.cashRoundingAdjustment??"0").isZero())return money(0);
 const saved=await tx.select({value:auditLogs.newValue}).from(auditLogs).where(and(eq(auditLogs.action,"invoice.return.roundingAllocation.v1"),eq(auditLogs.entityType,"invoiceRoundingAllocation"),eq(auditLogs.entityId,String(invoice.id)))).for("update");
 if(saved.length>1)invalidRounding();
 let plan=saved[0]?.value as AllocationPlan|undefined;
 if(!plan) {
   const remaining=await remainingInvoiceCashRounding(tx,invoice.id,invoice.cashRoundingAdjustment);
   const sorted=items.filter(i=>i.returnedBaseQuantity<i.baseQuantity).sort((a,b)=>a.id-b.id);
   const weights=sorted.map(i=>money(i.total).times(i.baseQuantity-i.returnedBaseQuantity).div(i.baseQuantity));
   const basis=sumMoney(weights);if(basis.isZero() && !remaining.isZero())invalidRounding();
   let prefix=money(0);let assigned=money(0);
   plan={version:1,original:invoice.cashRoundingAdjustment!,remainingAtStart:toDbMoney(remaining),lines:sorted.map((i,n)=>{
     prefix=prefix.plus(weights[n]);const boundary=basis.isZero()?money(0):money(toDbMoney(remaining.times(prefix).div(basis)));
     const share=boundary.minus(assigned);assigned=boundary;
     return {id:i.id,quantity:i.baseQuantity,returnedBefore:i.returnedBaseQuantity,rounding:toDbMoney(share),total:i.total};
   })};
   if(mode==="WRITE")await tx.insert(auditLogs).values({userId:actor.userId,branchId:actor.branchId,action:"invoice.return.roundingAllocation.v1",entityType:"invoiceRoundingAllocation",entityId:String(invoice.id),newValue:plan});
 }
 if(plan.version!==1 || !money(plan.original).eq(invoice.cashRoundingAdjustment!) || !Array.isArray(plan.lines))invalidRounding();
 let released=money(0);let selected=money(0);
 for(const line of plan.lines) {
   const item=items.find(i=>i.id===line.id);
   if(!item || item.baseQuantity!==line.quantity || item.total!==line.total || item.returnedBaseQuantity<line.returnedBefore)invalidRounding();
   const units=line.quantity-line.returnedBefore;
   const before=item.returnedBaseQuantity-line.returnedBefore;
   const count=selection.find(s=>s.invoiceItemId===line.id)?.baseQuantity??0;
   if(units<=0 || count<0 || before+count>units)invalidRounding();
   const prior=money(toDbMoney(money(line.rounding).times(before).div(units)));
   released=released.plus(prior);
   selected=selected.plus(money(toDbMoney(money(line.rounding).times(before+count).div(units))).minus(prior));
 }
 if(selection.some(s=>!plan!.lines.some(l=>l.id===s.invoiceItemId)))invalidRounding();
 const remaining=await remainingInvoiceCashRounding(tx,invoice.id,invoice.cashRoundingAdjustment);
 if(!money(plan.remainingAtStart).minus(released).eq(remaining))invalidRounding();
 return selected;
}

export async function digitalInvoiceReturnAmounts(tx: Tx, invoice: { id: number; total: string; returnedTotal: string | null; cashRoundingAdjustment: string | null },
 rawSell: string, returningInvoiceItemIds: number[],actor:Actor,mode:"WRITE"|"PREVIEW"="WRITE") {
 const items=await financialReturnItems(tx,invoice.id);
 const fullyReturned=items.length>0 && items.every(i=>returningInvoiceItemIds.includes(i.id) || i.returnedBaseQuantity>=i.baseQuantity);
 const selection=items.filter(i=>returningInvoiceItemIds.includes(i.id)).map(i=>({invoiceItemId:i.id,baseQuantity:i.baseQuantity-i.returnedBaseQuantity}));
 const rounding=await allocatedReturnRounding(tx,invoice,selection,actor,mode);
 return {returnAmount:toDbMoney(money(rawSell).plus(rounding)),roundingAdjustment:toDbMoney(rounding),fullyReturned};
}
