import { beforeEach, describe, expect, it, vi } from "vitest";

let capturedWindows: Array<{ html: string; opts?: unknown }> = [];

vi.mock("../brand", async () => {
  const actual = await vi.importActual<typeof import("../brand")>("../brand");
  return {
    ...actual,
    logoUrl: () => "/logo.png",
    openPrintWindow: vi.fn((html: string, opts?: unknown) => {
      capturedWindows.push({ html, opts });
      return true;
    }),
  };
});

import { esc, fmt, openPrintWindow } from "../brand";
import { docToHtml } from "../render";
import { shippingLabelHtml } from "../shippingLabel";
import { parseShippingLabelSize } from "../shippingLabelSize";
import {
  buildAssignmentCancelDoc,
  buildCashDropDoc,
  buildDeliveryFeePaymentDoc,
  buildDeliveryFeeRefundDoc,
  buildDrawerExpenseDoc,
  buildInvoicePaymentDoc,
  buildOrderCancellationDoc,
  buildOverageRefundDoc,
  buildPosDeliveryShippingLabelData,
  buildShortfallSettlementDoc,
  printAftercarePrepareLabel,
  printPosDeliveryShippingLabel,
} from "../cashierLifecycleReceipts";
import { buildCheckoutAllocationReceiptDoc } from "@/components/pos/printChargeReceipt";

describe("Cashier Lifecycle Thermal 80mm & Shipping Label Suite", () => {
  beforeEach(() => {
    capturedWindows = [];
    vi.mocked(openPrintWindow).mockClear();
  });

  it("يبني إيصال صرف أجور التوصيل 80مم مع جدول الإرساليات والتفقيط والباركود", async () => {
    const doc = buildDeliveryFeePaymentDoc({
      voucherNumber: "DFP-2026-0041",
      partyName: "شركة البرق السريع",
      amount: "15000.00",
      paymentMethod: "CASH",
      consignmentNumbers: ["CN-1001", "CN-1002"],
      branchName: "الفرع الرئيسي",
      cashierName: "أحمد الكاشير",
      shiftId: 19,
      notes: "تصفية أجور يومية",
      paidAt: "2026-10-28T12:00:00Z",
    });

    expect(doc.kind).toBe("receipt");
    expect(doc.includeBrandHeader).toBe(true);
    expect(doc.barcodeSet?.barcode128).toBe("DFP-2026-0041");

    const html = await docToHtml(doc);
    expect(html).toContain("سند صرف أجور التوصيل");
    expect(html).toContain("شركة البرق السريع");
    expect(html).toContain("CN-1001");
    expect(html).toContain("CN-1002");
    expect(html).toContain("15,000");
    expect(html).toContain("<svg");
  });

  it("يبني سند تسوية عجز المندوب وسند استرداد الدين المعدوم بعناوين متمايزة", async () => {
    const shortfallDoc = buildShortfallSettlementDoc({
      kind: "SETTLE_SHORTFALL",
      voucherNumber: "SHF-77",
      partyName: "مندوب الكرخ",
      amount: 25000,
      paymentMethod: "CASH",
      reason: "فرق تسليم عهدة",
    });
    const recoverDoc = buildShortfallSettlementDoc({
      kind: "RECOVER_WRITEOFF",
      voucherNumber: "REC-88",
      partyName: "مندوب الرصافة",
      amount: "40000.00",
      paymentMethod: "CARD",
    });

    const shortfallHtml = await docToHtml(shortfallDoc);
    const recoverHtml = await docToHtml(recoverDoc);

    expect(shortfallHtml).toContain("سند تسوية عجز المندوب");
    expect(shortfallHtml).toContain("مبلغ تسوية العجز");
    expect(recoverHtml).toContain("سند تحصيل دين توصيل معدوم");
    expect(recoverHtml).toContain("المبلغ المسترد للخزينة");
  });

  it("يبني إيصالي رد أجرة التوصيل ورد فائض التحصيل للعميل أو الناقل", async () => {
    const feeRefundHtml = await docToHtml(
      buildDeliveryFeeRefundDoc({
        refundNumber: "DFR-101",
        sourceRef: "INV-2026-0900",
        customerName: "سارة محمود",
        customerPhone: "+9647701112233",
        amount: "5000",
        paymentMethod: "CASH",
        reason: "تحويل الطلب إلى استلام من الفرع",
      }),
    );
    expect(feeRefundHtml).toContain("إيصال رد أمانة / أجرة توصيل");
    expect(feeRefundHtml).toContain("INV-2026-0900");
    expect(feeRefundHtml).toContain("5,000");

    const overageHtml = await docToHtml(
      buildOverageRefundDoc({
        refundNumber: "OVR-302",
        sourceRef: "CASE-55",
        beneficiaryName: "شركة الرافدين للتوصيل",
        beneficiaryRole: "CARRIER",
        amount: "7500",
        paymentMethod: "CASH",
      }),
    );
    expect(overageHtml).toContain("إيصال رد فائض تحصيل / رسوم");
    expect(overageHtml).toContain("ناقل / مندوب توصيل");
    expect(overageHtml).toContain("7,500");
  });

  it("يميز بين محضر إلغاء إسناد الشحنة ومحضر إعلان رجوع الطرد", async () => {
    const cancelAssignHtml = await docToHtml(
      buildAssignmentCancelDoc({
        action: "cancelAssignment",
        consignmentNumber: "CN-5001",
        sourceRef: "ORD-901",
        partyName: "مندوب المنصور",
        codAmount: "35000",
        reason: "تغيير شركة التوصيل قبل الخروج",
      }),
    );
    const declareReturnHtml = await docToHtml(
      buildAssignmentCancelDoc({
        action: "declareReturn",
        consignmentNumber: "CN-5002",
        sourceRef: "ORD-902",
        partyName: "مندوب زيونة",
        codAmount: "42000",
        reason: "رفض المستلم عند الباب",
      }),
    );

    expect(cancelAssignHtml).toContain("محضر إلغاء إسناد شحنة");
    expect(cancelAssignHtml).toContain("لا يلغي الفاتورة ولا يرد نقداً للعميل");
    expect(declareReturnHtml).toContain("محضر إعلان رجوع شحنة");
    expect(declareReturnHtml).toContain("بانتظار الاستلام والفحص المادي");
  });

  it("يبني إيصالات إلغاء الطلب وقبض الدفعة والسحب النقدي ومصروف الدرج حرارياً 80مم", async () => {
    const cancelHtml = await docToHtml(
      buildOrderCancellationDoc({
        documentNumber: "WO-2026-0044",
        orderKind: "WORK_ORDER",
        customerName: "مؤسسة النور",
        originalTotal: "120000",
        refundedAmount: "50000",
        refundMethod: "CASH",
        reason: "إلغاء بطلب الزبون قبل الإنتاج",
      }),
    );
    expect(cancelHtml).toContain("إيصال إلغاء واسترداد مستحقات");
    expect(cancelHtml).toContain("أمر عمل — WO-2026-0044");
    expect(cancelHtml).toContain("50,000");

    const paymentHtml = await docToHtml(
      buildInvoicePaymentDoc({
        receiptNumber: "RCV-881",
        invoiceNumber: "INV-2026-1200",
        customerName: "حيدر جاسم",
        invoiceTotal: "100000",
        paidBefore: "25000",
        amountPaid: "75000",
        remainingAfter: "0",
        paymentMethod: "CASH",
      }),
    );
    expect(paymentHtml).toContain("إيصال قبض دفعة فاتورة");
    expect(paymentHtml).toContain("INV-2026-1200");
    expect(paymentHtml).toContain("75,000");

    const dropHtml = await docToHtml(
      buildCashDropDoc({
        dropNumber: "DRP-12",
        shiftId: 44,
        amount: "250000",
        destinationLabel: "الخزينة الرئيسية",
        cashierName: "زينب علي",
      }),
    );
    expect(dropHtml).toContain("قسيمة سحب نقدي من الدرج");
    expect(dropHtml).toContain("250,000");

    const expenseHtml = await docToHtml(
      buildDrawerExpenseDoc({
        expenseNumber: "EXP-2026-310",
        categoryName: "قرطاسية وضيافة",
        payeeName: "أسواق السلام",
        amount: "12500",
        paymentMethod: "CASH",
        shiftId: 44,
      }),
    );
    expect(expenseHtml).toContain("سند صرف مصروف من الدرج");
    expect(expenseHtml).toContain("EXP-2026-310");
    expect(expenseHtml).toContain("12,500");
  });

  it("يطبع ملصق تجهيز التعويض / المعالجة كشحنة مدفوعة مسبقاً مع تمرير النافذة المحجوزة", async () => {
    let writtenHtml = "";
    const fakeWin = {
      closed: false,
      close: vi.fn(),
      focus: vi.fn(),
      document: {
        open: vi.fn(),
        write: vi.fn((html: string) => {
          writtenHtml = html;
        }),
        close: vi.fn(),
      },
    } as unknown as Window;
    const res = await printAftercarePrepareLabel(
      {
        executionId: 709,
        caseNumber: "AC-2026-19",
        customerName: "عمر فاروق",
        customerPhone: "07709998877",
        governorate: "baghdad",
        addressText: "حي الجامعة - شارع الربيع",
      },
      { into: fakeWin },
    );

    expect(res.ok).toBe(true);
    expect(writtenHtml).toContain("AE-709");
    expect(writtenHtml).toContain("PREPAID");
    expect(writtenHtml).toContain("لا يُحصَّل أي مبلغ نقدي من المستلم");
  });

  it("يحسب COD وحالة الدفع بدقة عشرية في ملصق شحن نقطة البيع ويغلق النافذة عند غياب التوصيل", async () => {
    const codLabel = buildPosDeliveryShippingLabelData({
      invoiceNumber: "INV-2026-500",
      invoiceId: 500,
      customerName: "مصطفى كامل",
      customerPhone: "07801234567",
      total: 45000,
      received: 15000,
      lines: [{ name: "حقيبة مدرسية", unit: "قطعة", qty: 1 }],
      delivery: {
        partyName: "مندوب الفرع",
        fee: "5000",
        feeCollection: "COURIER",
        governorate: "baghdad",
        address: "الكرادة الشرقية",
      },
      consignmentNumber: "CN-2026-500",
    });

    expect(codLabel.orderNumber).toBe("CN-2026-500");
    expect(codLabel.total).toBe("35000.00");
    expect(codLabel.paymentState).toBe("COD");
    const codHtml = await shippingLabelHtml(codLabel);
    expect(codHtml).toContain("CN-2026-500");
    expect(codHtml).toContain("35,000");

    const prepaidLabel = buildPosDeliveryShippingLabelData({
      invoiceNumber: "INV-2026-501",
      invoiceId: 501,
      total: 45000,
      received: 45000,
      lines: [{ name: "دفتر جامعي", unit: "عدد", qty: 3 }],
      delivery: {
        partyName: "مندوب الفرع",
        fee: "5000",
        feeCollection: "COUNTER",
      },
    });
    expect(prepaidLabel.total).toBe("0.00");
    expect(prepaidLabel.paymentState).toBe("PREPAID");

    const unusedWin = { close: vi.fn() } as unknown as Window;
    const authSpy = vi.fn();
    await printPosDeliveryShippingLabel(
      {
        invoiceNumber: "INV-2026-502",
        invoiceId: 502,
        total: 10000,
        received: 10000,
        lines: [],
        delivery: null,
        consignmentNumber: null,
      },
      authSpy,
      unusedWin,
    );
    expect(unusedWin.close).toHaveBeenCalledTimes(1);
    expect(authSpy).not.toHaveBeenCalled();
  });

  it("يحول إيصال القبض الموحد للرسوم والأمانات إلى مستند حراري 80مم قياسي", async () => {
    const doc = buildCheckoutAllocationReceiptDoc(
      {
        checkoutReceipts: [
          { receiptId: 91, kind: "GOODS", method: "CASH", amount: "30000.00" },
          { receiptId: 92, kind: "CHARGE", method: "CASH", amount: "5000.00" },
        ],
        chargeAllocations: [
          { chargeId: 14, receiptId: 92, amount: "5000.00" },
        ],
        checkoutPaymentSummary: {
          tenderedAmount: "40000.00",
          appliedAmount: "35000.00",
          changeAmount: "5000.00",
        },
      } as unknown as Parameters<typeof buildCheckoutAllocationReceiptDoc>[0],
      "RCV-TOKEN-91",
    );

    expect(doc.kind).toBe("receipt");
    expect(doc.barcodeSet?.barcode128).toBe("CHG-14");
    const html = await docToHtml(doc);
    expect(html).toContain("إيصال قبض موحد");
    expect(html).toContain("الباقي النقدي");
    expect(html).toContain("35,000");
  });

  it("يدعم المقاسين الأفقيين المعتمدين 120×80 و80×50 دون تشويه الباركود ومع إخفاء QR الفارغ", async () => {
    expect(parseShippingLabelSize("120x80")).toEqual({ widthMm: 120, heightMm: 80 });
    expect(parseShippingLabelSize("80x50")).toEqual({ widthMm: 80, heightMm: 50 });

    const compact = await shippingLabelHtml(
      {
        orderNumber: "AE-999",
        customerName: "عميل مقاس مضغوط",
        customerPhone: "07701234567",
        governorate: "baghdad",
        addressText: "شارع فلسطين - محلة 504",
        total: "0",
        items: [],
        paymentState: "PREPAID",
        qrUrl: null,
        isReprint: true,
      },
      { widthMm: 80, heightMm: 50 },
    );

    expect(compact).toContain("@page{size:80mm 50mm;margin:0mm !important}");
    expect(compact).not.toContain('preserveAspectRatio="none"');
    expect(compact).not.toContain("تتبع الشحنة");
    expect(compact).toContain("إعادة طباعة");
  });

  it("يحصّن دوال الهروب وتنسيق المبالغ من علامات التنصيص المفردة وقيم NaN", () => {
    expect(esc("O'Reilly & <script>")).toBe("O&#39;Reilly &amp; &lt;script&gt;");
    expect(fmt("not-a-number")).toBe("—");
    expect(fmt("12500.5")).not.toContain("NaN");
  });
});
