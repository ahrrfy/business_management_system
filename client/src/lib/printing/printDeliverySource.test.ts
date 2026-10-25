import { describe, expect, it, vi } from "vitest";
vi.mock("./print", () => ({ printDoc: vi.fn() }));
import {
  buildDeliveryDispatchSlipDoc,
  type DispatchSlipData,
} from "./printDeliveryDispatchSlip";
import { buildDeliveryManifestDoc } from "./deliveryDocs";
import { buildRemittanceReceiptDoc } from "@/components/delivery/printRemittanceReceipt";
import { docToHtml } from "./render";
import {
  resolveShippingLabelPaymentState,
  resolveShippingLabelQrTarget,
  shippingLabelHtml,
} from "./shippingLabel";

const aftercare: DispatchSlipData = {
  consignmentNumber: "AC-19",
  orderNumber: "19",
  orderKind: "aftercare",
  sourceType: "AFTERCARE_EXECUTION",
  aftercareExecutionId: 19,
  invoiceId: null,
  partyName: "شركة التوصيل",
  recipientName: "عميل",
  recipientPhone: "07701234567",
  deliveryAddress: "بغداد",
  salePrice: "0.00",
  codAmount: "0.00",
  deliveryFee: "5000.00",
  feeCollection: "SHOP",
  dispatchedAt: "2026-10-23T12:00:00Z",
};

describe("source-aware delivery slip", () => {
  it("prints a zero-collection aftercare slip without a fictitious invoice", () => {
    const doc = buildDeliveryDispatchSlipDoc(aftercare);
    expect(doc.title).toContain("استكمال نقص");
    expect(doc.meta?.join(" ")).toContain("لا يُطلب مبلغ من العميل");
    expect(doc.meta?.join(" ")).not.toContain("الفاتورة");
    expect(doc.totals?.at(-1)?.value).toBe("0 د.ع");
  });
  it("rejects an aftercare print payload that would demand customer money", () => {
    expect(() =>
      buildDeliveryDispatchSlipDoc({ ...aftercare, codAmount: "1.00" }),
    ).toThrow(/تحصيلاً صفرياً/);
    expect(() =>
      buildDeliveryDispatchSlipDoc({ ...aftercare, feeCollection: "COURIER" }),
    ).toThrow(/أجرة على المكتبة/);
  });
  it("preserves the ordinary invoice slip", () => {
    expect(
      buildDeliveryDispatchSlipDoc({
        ...aftercare,
        sourceType: "INVOICE",
        invoiceId: 4,
        invoiceNumber: "INV-4",
        orderKind: "invoice",
        codAmount: "10000.00",
        feeCollection: "COURIER",
      }).title,
    ).toBe("بوليصة إسناد وتوصيل");
  });

  it("keeps the dispatch event time separate from reprint time", () => {
    const doc = buildDeliveryDispatchSlipDoc(
      {
        ...aftercare,
        copy: { kind: "REPRINT", reason: "نسخة بدل فاقد" },
      },
      new Date("2026-10-25T15:30:00Z"),
    );
    expect(doc.meta?.some((line) => line.startsWith("وقت الإسناد:"))).toBe(
      true,
    );
    expect(doc.meta?.some((line) => line.startsWith("وقت الطباعة:"))).toBe(
      true,
    );
    expect(doc.meta?.join(" ")).toContain("نسخة معاد طباعتها");
    expect(doc.meta?.join(" ")).toContain("نسخة بدل فاقد");
    expect(doc.barcodeSet?.qrPayload).toBe("");
  });

  it("labels unavailable historical amounts instead of silently printing zero", () => {
    const doc = buildDeliveryDispatchSlipDoc({
      ...aftercare,
      sourceType: "INVOICE",
      invoiceId: 4,
      orderKind: "invoice",
      salePrice: null,
      deposit: null,
      codAmount: null,
      deliveryFee: null,
      feeCollection: "COURIER",
      notes:
        "نسخة تاريخية: المبالغ وقت الإسناد غير متاحة؛ تحقق من المطالبة الحالية.",
    });
    expect(doc.totals?.map((row) => row.value)).toEqual([
      "غير متاحة تاريخياً",
      "غير متاح تاريخياً",
    ]);
    expect(doc.meta?.join(" ")).toContain("نسخة تاريخية");
  });
});

describe("unified delivery documents", () => {
  it("keeps prepaid goods COD when the courier still collects its fee", () => {
    const prepaidGoodsCod = 0;
    const courierFee = 5_000;
    expect(
      resolveShippingLabelPaymentState(prepaidGoodsCod + courierFee),
    ).toBe("COD");
    expect(resolveShippingLabelPaymentState(0)).toBe("PREPAID");
  });

  it("creates QR only for the real ORD verification route", () => {
    expect(
      resolveShippingLabelQrTarget(
        { orderNumber: "ORD-100009" },
        "https://srv1548487.hstgr.cloud",
      ),
    ).toBe("https://srv1548487.hstgr.cloud/verify?ref=ORD-100009");
    expect(
      resolveShippingLabelQrTarget(
        { orderNumber: "CN-1-20260917-00275" },
        "https://srv1548487.hstgr.cloud",
      ),
    ).toBeNull();
  });

  it("renders a real handover table with source, recipient and phone", () => {
    const doc = buildDeliveryManifestDoc(
      { name: "شركة النقل", phone: "07800000000" },
      [
        {
          consignmentNumber: "CN-9",
          invoiceNumber: "INV-8",
          orderNumber: "ORD-7",
          recipientName: "سارة",
          recipientPhone: "07701234567",
          address: "بغداد",
          codAmount: "50000",
          deliveryFee: "5000",
        },
      ],
      {
        branchName: "الفرع الرئيسي",
        shiftId: 22,
        cashierName: "أحمد",
        eventAt: "2026-10-25T12:00:00Z",
      },
      new Date("2026-10-25T12:05:00Z"),
    );
    expect(doc.itemBlocks).toEqual([
      expect.objectContaining({
        name: expect.stringContaining("INV-8"),
        quantityPrice: expect.stringContaining("07701234567"),
        total: expect.stringContaining("50,000"),
      }),
    ]);
    expect(doc.meta?.join(" ")).toContain("الوردية: 22");
    expect(doc.meta?.join(" ")).toContain("الموظف المسلم: أحمد");
  });

  it("prints remittance allocations and audit facts without an invented QR", async () => {
    const doc = buildRemittanceReceiptDoc(
      "شركة النقل",
      {
        remittanceNumber: "DR-17",
        collectedTotal: "58000",
        cashReceived: "48000",
        feesTotal: "5000",
        netRemitted: "48000",
        shortfallTotal: "1000",
        receivedAt: "2026-10-25T13:00:00Z",
        branchName: "الرئيسي",
        shiftId: 44,
        cashierName: "ليلى",
        paymentMethod: "نقدي",
        copy: { kind: "REPRINT", reason: "مراجعة التسوية" },
        allocations: [
          {
            consignmentNumber: "CN-1",
            invoiceNumber: "INV-1",
            recipientName: "علي",
            recipientPhone: "07700000000",
            grossApplied: "50000",
            feeOffset: "5000",
            cashReceived: "48000",
            paymentMethod: "نقدي",
          },
        ],
      },
      new Date("2026-10-25T14:00:00Z"),
    );
    expect(doc).not.toBeNull();
    expect(doc?.itemBlocks?.[0]?.name).toContain("INV-1");
    expect(doc?.itemBlocks?.[0]?.quantityPrice).toContain("07700000000");
    expect(doc?.itemBlocks?.[0]?.total).toBe("مخصص 50,000\nنقد 48,000");
    expect(doc?.meta?.join(" ")).toContain("طريقة الدفع: نقدي");
    expect(doc?.meta?.join(" ")).toContain("نسخة معاد طباعتها");
    expect(doc?.barcodeSet?.qrPayload).toBe("");
    const html = await docToHtml(doc!);
    expect(html).toContain("مخصص 50,000<br>نقد 48,000");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain('class="bc-128"');
    expect(html).not.toContain('class="bc-qr"');
    expect(html).not.toContain("/remittance/DR-17");
  });

  it("keeps shipping-label event and print dates distinct on reprint", async () => {
    const html = await shippingLabelHtml({
      orderNumber: "CN-44",
      customerName: "علي",
      customerPhone: "07700000000",
      governorate: "بغداد",
      addressText: "المنصور",
      total: "0",
      createdAt: "2026-10-24T12:00:00Z",
      printedAt: "2026-10-25T12:00:00Z",
      isReprint: true,
      items: [],
    });
    expect(html).toContain("تاريخ الإسناد:");
    expect(html).toContain("تاريخ الطباعة:");
    expect(html).toContain("إعادة طباعة");
  });

  it("does not turn an unavailable historical label amount into COD zero", async () => {
    const html = await shippingLabelHtml({
      orderNumber: "CN-LEGACY-44",
      customerName: "علي",
      customerPhone: "07700000000",
      governorate: "بغداد",
      addressText: "المنصور",
      total: null,
      notes: "نسخة تاريخية: المبلغ غير متاح.",
      createdAt: "2026-10-24T12:00:00Z",
      printedAt: "2026-10-25T12:00:00Z",
      isReprint: true,
      items: [],
    });
    expect(html).toContain("المبلغ وقت الإسناد غير متاح");
    expect(html).toContain("تحقق من المطالبة الحالية قبل التسليم");
    expect(html).not.toContain("تحصيل نقدي إلزامي");
    expect(html).not.toContain('class="bc-qr"');
  });
});
