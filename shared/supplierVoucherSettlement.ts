import Decimal from "decimal.js";

export interface SupplierVoucherAllocation {
  supplierInvoiceId: number;
  invoiceVersion: number;
  amount: string;
}
export interface SupplierVoucherInvoice {
  id: number;
  invoiceNumber: string;
  invoiceDate: string;
  version: number;
  remainingAmount: string;
}
function positiveAmount(value: string): Decimal {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error("أدخل مبلغاً موجباً بمنزلتين عشريتين كحد أقصى");
  const amount = new Decimal(value);
  if (!amount.isFinite() || !amount.gt(0))
    throw new Error("مبلغ السداد يجب أن يكون موجباً");
  return amount;
}
export function allocateSupplierVoucherFifo(
  amount: string,
  invoices: readonly SupplierVoucherInvoice[],
): SupplierVoucherAllocation[] {
  let remaining = positiveAmount(amount);
  const allocations: SupplierVoucherAllocation[] = [];
  const sorted = [...invoices].sort(
    (a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.id - b.id,
  );
  for (const invoice of sorted) {
    if (remaining.isZero()) break;
    const available = new Decimal(invoice.remainingAmount);
    if (!available.isFinite() || available.lte(0)) continue;
    const allocated = Decimal.min(remaining, available);
    allocations.push({
      supplierInvoiceId: invoice.id,
      invoiceVersion: invoice.version,
      amount: allocated.toFixed(2),
    });
    remaining = remaining.minus(allocated);
  }
  if (remaining.gt(0))
    throw new Error(
      "المبلغ يتجاوز المتبقي المتاح في فواتير المورد؛ راجع الفواتير والطلبات المعلقة",
    );
  validateSupplierVoucherAllocations(amount, invoices, allocations);
  return allocations;
}
export function validateSupplierVoucherAllocations(
  amount: string,
  invoices: readonly SupplierVoucherInvoice[],
  allocations: readonly SupplierVoucherAllocation[],
): void {
  const expected = positiveAmount(amount);
  if (!allocations.length || allocations.length > 500)
    throw new Error("اختر من فاتورة واحدة إلى 500 فاتورة للسداد");
  const byId = new Map(invoices.map((row) => [row.id, row]));
  const seen = new Set<number>();
  let total = new Decimal(0);
  for (const row of allocations) {
    const invoice = byId.get(row.supplierInvoiceId);
    if (seen.has(row.supplierInvoiceId))
      throw new Error("لا يجوز تخصيص الفاتورة مرتين في السند نفسه");
    if (!invoice || invoice.version !== row.invoiceVersion)
      throw new Error(
        "تغيّرت الفاتورة أو لم تعد مؤهلة؛ حدّث الفواتير وأعد التوزيع",
      );
    seen.add(row.supplierInvoiceId);
    const allocated = positiveAmount(row.amount);
    if (allocated.gt(invoice.remainingAmount))
      throw new Error(
        `تخصيص الفاتورة ${invoice.invoiceNumber} يتجاوز المتبقي المتاح`,
      );
    total = total.plus(allocated);
  }
  if (!total.eq(expected))
    throw new Error("يجب أن يساوي مجموع التخصيصات مبلغ سند الصرف بالضبط");
}
