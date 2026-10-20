import { loadSupplierFormalCreditTotals } from "../purchase/supplierFormalCreditProjection";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  supplierInvoices,
  supplierPaymentAllocations,
  suppliers,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money } from "../money";
import { loadSupplierBookInvoiceTotals } from "../purchase/supplierBookProjection";

/** Native AP is settled only through invoice allocations, never a generic voucher. */
export async function assertNoNativeSupplierDebtForGenericPaymentTx(
  tx: Tx,
  supplierId: number,
  options: { currentRead?: boolean } = { currentRead: true },
): Promise<void> {
  // Serialize with invoice posting/payment/refund before taking a current read.
  // Creation is a nonlocking preflight: owner auto-approval must lock cash first.
  if (options.currentRead)
    await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.id, supplierId))
      .for("update");
  const invoiceQuery = tx
    .select({
      id: supplierInvoices.id,
      invoiceNumber: supplierInvoices.invoiceNumber,
      totalAmount: supplierInvoices.totalAmount,
      legacySettledAmount: supplierInvoices.legacySettledAmount,
      legacySettlementEvidenceHash:
        supplierInvoices.legacySettlementEvidenceHash,
    })
    .from(supplierInvoices)
    .where(
      and(
        eq(supplierInvoices.supplierId, supplierId),
        eq(supplierInvoices.status, "POSTED"),
        eq(supplierInvoices.liabilityClass, "NATIVE_AP"),
      ),
    )
    .orderBy(asc(supplierInvoices.id));
  const invoices = await (options.currentRead
    ? invoiceQuery.for("update")
    : invoiceQuery);
  if (!invoices.length) return;
  const invoiceIds = invoices.map((invoice) => Number(invoice.id));
  const bookTotals = await loadSupplierBookInvoiceTotals(tx, invoiceIds, options);
  // Raw locking reads avoid a pre-lock REPEATABLE READ snapshot in SQL sums/subqueries.
  const allocationQuery = tx
    .select()
    .from(supplierPaymentAllocations)
    .where(inArray(supplierPaymentAllocations.supplierInvoiceId, invoiceIds));
  const allocations = await (options.currentRead
    ? allocationQuery.for("share")
    : allocationQuery);
  const formalCredits = await loadSupplierFormalCreditTotals(tx, invoiceIds, options);
  const paid = new Map<number, ReturnType<typeof money>>();
  for (const row of allocations) {
    const invoiceId = Number(row.supplierInvoiceId);
    paid.set(
      invoiceId,
      (paid.get(invoiceId) ?? money(0)).plus(
        money(row.allocatedAmount).minus(row.refundedAmount),
      ),
    );
  }
  const credited = new Map(Array.from(formalCredits, ([id, amount]) => [id, money(amount)]));
  const outstanding = invoices.find((row) =>
    money(row.totalAmount)
      .minus(
        row.legacySettlementEvidenceHash
          ? money(row.legacySettledAmount)
          : money(0),
      )
      .minus(paid.get(Number(row.id)) ?? money(0))
      .minus(credited.get(Number(row.id)) ?? money(0))
      .minus(bookTotals.get(Number(row.id))?.paidAmount ?? 0)
      .minus(bookTotals.get(Number(row.id))?.creditedAmount ?? 0)
      .gt(0),
  );
  if (outstanding) {
    throw new TRPCError({
      code: "CONFLICT",
      message: appErrorMessage({
        what: "تعذر صرف سند عام للمورد",
        why: `فاتورة المورد ${outstanding.invoiceNumber} لها مبلغ مستحق دون تخصيص سداد، والسند العام لا يسدد الفاتورة`,
        doThis:
          "استخدم طلب سداد المورد واختر فاتورته لتسجيل الدفع وتخصيصه مرة واحدة",
      }),
    });
  }
}
