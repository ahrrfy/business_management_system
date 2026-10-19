import { primary, assertIdentity, failure } from "../cash/journal";
import { fixtureActor } from "../credit/fixture";
import { openBalanceOf } from "../../../shared/predicates/openBalance";
import {
  isDeadInvoiceStatus,
  isVoidedInvoiceStatus,
} from "../../../shared/invoiceStatus";
import Decimal from "decimal.js";
// One atomic statement: exact stored money strings, no floating point totals.
export async function creditEvidence(env: any, id: number) {
  const db = primary(env.DB);
  await assertIdentity(db, "primary");
  const row = await db
    .prepare(
      `SELECT epoch,
 (SELECT json_object('id',id,'number',invoiceNumber,'customerId',customerId,'total',total,'paidAmount',paidAmount,'returnedTotal',returnedTotal,'status',invoiceStatus,'mode',paymentMode,'cost',costTotal) FROM invoices WHERE id=? AND branchId=?) invoice,
 (SELECT json_object('id',c.id,'name',c.name,'balance',c.currentBalance,'creditLimit',c.creditLimit) FROM customers c JOIN invoices i ON i.customerId=c.id WHERE i.id=? AND i.branchId=?) customer,
 (SELECT json_group_array(json_object('variantId',b.variantId,'quantity',b.quantity)) FROM branchStock b WHERE b.branchId=? AND b.variantId IN(SELECT variantId FROM invoiceItems WHERE invoiceId=?)) stock,
 (SELECT COUNT(*) FROM receipts WHERE invoiceId=?) receiptCount,
 (SELECT json_group_array(json_object('id',id,'amount',amount,'method',paymentMethod,'shiftId',shiftId,'direction',direction)) FROM(SELECT * FROM receipts WHERE invoiceId=? ORDER BY id DESC LIMIT 20)) receipts,
 (SELECT COUNT(*) FROM accountingEntries WHERE invoiceId=?) entryCount,
 (SELECT json_group_array(json_object('id',id,'type',entryType,'amount',amount,'revenue',revenue,'cost',cost,'profit',profit,'receiptId',receiptId)) FROM(SELECT * FROM accountingEntries WHERE invoiceId=? ORDER BY id DESC LIMIT 30)) entries,
 (SELECT json_group_array(json_object('id',id,'variantId',variantId,'baseQuantity',baseQuantity,'returnedBaseQuantity',returnedBaseQuantity,'returnedRestockedBaseQuantity',returnedRestockedBaseQuantity,'total',total)) FROM invoiceItems WHERE invoiceId=?) items
 FROM cashEpoch WHERE id=1`,
    )
    .bind(
      id,
      fixtureActor.branchId,
      id,
      fixtureActor.branchId,
      fixtureActor.branchId,
      id,
      id,
      id,
      id,
      id,
      id,
    )
    .first();
  if (!row?.invoice) throw failure("INVOICE_NOT_FOUND", 404);
  const invoice = JSON.parse(row.invoice);
  return {
    epoch: row.epoch,
    invoice: {
      ...invoice,
      currentTotal: isVoidedInvoiceStatus(invoice.status)
        ? "0.00"
        : Decimal.max(
            0,
            new Decimal(invoice.total).minus(invoice.returnedTotal),
          ).toFixed(2),
      remainingAmount: isDeadInvoiceStatus(invoice.status)
        ? "0.00"
        : openBalanceOf(invoice, "COLLECTIBLE").toFixed(2),
    },
    items: JSON.parse(row.items),
    customer: JSON.parse(row.customer),
    stock: JSON.parse(row.stock),
    receiptCount: row.receiptCount,
    latestReceipts: JSON.parse(row.receipts),
    entryCount: row.entryCount,
    latestEntries: JSON.parse(row.entries),
  };
}
