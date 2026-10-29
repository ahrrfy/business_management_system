import { allocateLineTax } from '@/components/invoice/totals';
import { D, round2 } from '@/lib/money';
import { paymentMethodLabel } from '@/lib/paymentMethod';
import { variantDisplayName } from '@shared/variantDisplay';
import type { RouterOutputs } from '@/lib/trpc';
import type { InvoicePrintData } from './printTemplates';
import { invoiceRemaining, isDeadInvoice } from '@shared/predicates';

type SavedInvoice = NonNullable<RouterOutputs['sales']['get']>;
type SavedItem = SavedInvoice['items'][number];
type PrintSource = Pick<SavedInvoice, 'invoiceNumber' | 'subtotal' | 'total' | 'status'> &
  Partial<Pick<SavedInvoice, 'invoiceDate' | 'customerName' | 'customerPhone' | 'customerAddress' |
    'customerId' | 'customerBalance' | 'salespersonName' | 'paymentMethod' | 'paymentMode' |
    'payments' | 'discountAmount' | 'taxAmount' | 'taxRatePercent' | 'paidAmount' | 'returnedTotal' |
    'qrPayload' | 'deliveryFee' | 'deliveryFree' | 'deliveryWaivedAmount' | 'courierName' |
    'courierFee' | 'courierFeeCollection' | 'consignmentStatus' | 'collectCreditOnDelivery'>> & {
      items: (Pick<SavedItem, 'quantity' | 'unitPrice' | 'total'> &
        Partial<Pick<SavedItem, 'productName' | 'variantName' | 'color' | 'size' | 'variantKind' |
          'sku' | 'unitName' | 'isGift' | 'barcode'>>)[];
    };

export function invoiceDetailPrintData(data: PrintSource, companyTaxId: string | null): InvoicePrintData {
    // توزيع ضريبة الفاتورة على السطور لعمود «الضريبة» في القالب الرسمي.
    const afterDisc = round2(
      D(data.subtotal).minus(D(data.discountAmount ?? "0")),
    ).toFixed(2);
    const shares = allocateLineTax(
      data.items.map((it) => ({ total: String(it.total) })),
      String(data.taxAmount ?? "0"),
      afterDisc,
    );
    const inPayments = (data.payments ?? []).filter(
      (p) => p.direction === "IN" && p.status === "COMPLETED" && D(p.amount ?? "0").gt(0),
    );
    const paymentLegs =
      inPayments.length > 1 || (data.paymentMethod === "MIXED" && inPayments.length > 0)
        ? inPayments.map((p) => ({
            method: paymentMethodLabel(p.paymentMethod),
            amount: p.amount,
            reference: p.referenceNumber ?? null,
          }))
        : null;
    return {
      invoiceNumber: data.invoiceNumber,
      invoiceDate: data.invoiceDate,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      customerAddress: data.customerAddress,
      customerBalance: data.customerId ? data.customerBalance : null,
      salespersonName: data.salespersonName,
      companyTaxId: companyTaxId,
      paymentMethod: paymentMethodLabel(data.paymentMethod),
      paymentLegs,
      paymentMode: data.paymentMode,
    collectCreditOnDelivery: data.collectCreditOnDelivery,
      subtotal: data.subtotal,
      discountAmount: data.discountAmount,
      taxAmount: data.taxAmount,
      taxRate: Number(data.taxRatePercent ?? 0),
      total: data.total,
      paidAmount: data.paidAmount,
      status: data.status,
      returnedTotal: data.returnedTotal ?? '0',
      currentTotal: isDeadInvoice(data.status) ? '0.00' : round2(D(data.total).minus(D(data.returnedTotal))).clamp(0, Infinity).toFixed(2),
      remainingAmount: isDeadInvoice(data.status) ? '0.00' : round2(invoiceRemaining({ total: data.total, returnedTotal: data.returnedTotal, paidAmount: data.paidAmount })).clamp(0, Infinity).toFixed(2),
      qrPayload: data.qrPayload ?? null,
      items: data.items.map((it, i) => ({
        productName: variantDisplayName({
          productName: it.productName ?? "",
          variantName: it.variantName,
          color: it.color,
          size: it.size,
          variantKind: it.variantKind,
          sku: it.sku,
        }),
        unitName: it.unitName,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        total: it.total,
        taxAmount: shares[i] ?? "0",
        isGift: it.isGift,
        barcode: it.barcode ?? it.sku ?? null,
      })),
      deliveryFee: data.deliveryFee,
      deliveryFree: data.deliveryFree,
      deliveryWaivedAmount: data.deliveryWaivedAmount,
      // ٨/٨ — توصيل الاستقبال (COURIER/COD): الأجرة على الإرسالية لا الفاتورة ⇒ نمرّرها للعرض
      // كي تُظهر الفاتورة المطبوعة «المجموع النهائي الذي يدفعه الزبون شاملاً التوصيل».
      courierDelivery: data.courierName && Number(data.courierFee ?? 0) > 0 && data.consignmentStatus !== "CANCELLED"
        ? { partyName: data.courierName, fee: data.courierFee ?? "0", feeCollection: data.courierFeeCollection ?? "COURIER",
            }
        : null,
    };

}
