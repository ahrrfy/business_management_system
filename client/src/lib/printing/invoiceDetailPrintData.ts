import { allocateLineTax } from '@/components/invoice';
import { D, round2 } from '@/lib/money';
import { paymentMethodLabel } from '@/lib/paymentMethod';
import { variantDisplayName } from '@shared/variantDisplay';
import type { RouterOutputs } from '@/lib/trpc';
import type { InvoicePrintData } from './printTemplates';

export function invoiceDetailPrintData(data: NonNullable<RouterOutputs['sales']['get']>, companyTaxId: string | null): InvoicePrintData {
    // توزيع ضريبة الفاتورة على السطور لعمود «الضريبة» في القالب الرسمي.
    const afterDisc = round2(
      D(data.subtotal).minus(D(data.discountAmount ?? "0")),
    ).toFixed(2);
    const shares = allocateLineTax(
      data.items.map((it) => ({ total: String(it.total) })),
      String(data.taxAmount ?? "0"),
      afterDisc,
    );
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
      paymentMode: data.paymentMode,
      subtotal: data.subtotal,
      discountAmount: data.discountAmount,
      taxAmount: data.taxAmount,
      taxRate: Number(data.taxRatePercent ?? 0),
      total: data.total,
      paidAmount: data.paidAmount,
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
