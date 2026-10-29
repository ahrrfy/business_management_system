import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { invoiceToShippingLabel } from "./invoiceShippingLabel";
import { invoiceToReceipt } from "./invoiceReceipt";
import { invoiceDetailPrintData } from "./invoiceDetailPrintData";
import { shippingLabelHtml } from "./shippingLabel";

describe("طباعة الفاتورة المعدلة", () => {
  const savedInvoice = {
    invoiceNumber: "INV-RETURN", status: "PARTIALLY_PAID" as const,
    subtotal: "100.00", total: "100.00", returnedTotal: "40.00", paidAmount: "10.00",
    items: [{ productName: "دفتر", quantity: "2", unitPrice: "50.00", total: "100.00" }],
  };

  it("يبقي أصل الفاتورة وبنودها ويكشف الصافي والمتبقي الحالي بعد المرتجع", () => {
    const printed = invoiceDetailPrintData(savedInvoice, null);
    expect(printed).toMatchObject({
      total: "100.00", subtotal: "100.00", returnedTotal: "40.00", currentTotal: "60.00", remainingAmount: "50.00",
      items: [{ productName: "دفتر", quantity: "2", unitPrice: "50.00", total: "100.00" }],
    });
  });

  it("يطابق المتبقي الحراري بعد مرتجع غير مسدد دون تغيير إجمالي الفاتورة الأصلي", () => {
    const input = { ...savedInvoice, paidAmount: "0.00" };
    const printed = invoiceDetailPrintData(input, null);
    const receipt = invoiceToReceipt(input);
    expect(printed).toMatchObject({ total: "100.00", returnedTotal: "40.00", currentTotal: "60.00", remainingAmount: "60.00" });
    expect(receipt.credit).toBe("60");
  });

  it.each(["CANCELLED", "RETURNED", "SUPERSEDED"] as const)("لا يطبع ديناً على فاتورة %s مع الاحتفاظ بمبالغها الأصلية", (status) => {
    const printed = invoiceDetailPrintData({ ...savedInvoice, status, returnedTotal: "0" }, null);
    expect(printed).toMatchObject({ total: "100.00", status, currentTotal: "0.00", remainingAmount: "0.00" });
  });

  it("يحفظ الدقة ويقص المطالبة عند الصفر بعد زيادة السداد", () => {
    const printed = invoiceDetailPrintData({ ...savedInvoice, total: "100.10", returnedTotal: "40.20", paidAmount: "59.91" }, null);
    expect(printed.currentTotal).toBe("59.90");
    expect(printed.remainingAmount).toBe("0.00");
  });

  it("يحسب ليبل الشحن من المتبقي ويضيف أجرة المندوب فقط إذا كان هو من يقبضها", () => {
    const label = invoiceToShippingLabel({
      invoiceNumber: "1002",
      invoiceDate: "2026-09-15T10:00:00Z",
      total: "5000",
      paidAmount: "2000",
      returnedTotal: "500",
      customerName: "سارة",
      customerPhone: "07700000000",
      customerAddress: "بغداد",
      recipientName: "مريم",
      recipientPhone: "07800000000",
      deliveryAddress: "المنصور — شارع 14",
      deliveryGovernorate: "بغداد",
      qrPayload: "INV|1002|2026-09-15|5000|1|signed",
      courierFee: "1000",
      courierFeeCollection: "COURIER",
      items: [{ productName: "دفتر", unitName: "قطعة", quantity: "2" }],
    });
    expect(label.total).toBe("3500.00");
    expect(label.paymentState).toBe("COD");
    expect(label.customerName).toBe("مريم");
    expect(label.customerPhone).toBe("07800000000");
    expect(label.addressText).toBe("المنصور — شارع 14");
    expect(label.governorate).toBe("بغداد");
    expect(label.barcodeValue).toBe("INV-1002");
    expect(decodeURIComponent(label.qrUrl)).toContain("INV|1002");
  });

  it("يوسِم الفاتورة المسددة مدفوعة مسبقاً على الليبل", () => {
    const label = invoiceToShippingLabel({
      invoiceNumber: "1003",
      invoiceDate: "2026-09-15T10:00:00Z",
      total: "1000",
      paidAmount: "1000",
      items: [],
    });
    expect(label.paymentState).toBe("PREPAID");
    expect(label.total).toBe("0.00");
  });

  it.each(["COURIER", "COUNTER", "SHOP"] as const)("يبقي دين الفاتورة الآجلة خارج تحصيل ليبل الشحن مع أجرة %s", (feeCollection) => {
    const label = invoiceToShippingLabel({
      invoiceNumber: "101567", invoiceDate: "2026-10-24T17:25:00Z", paymentMode: "CREDIT",
      total: "35000", paidAmount: "30000", courierFee: "5000", courierFeeCollection: feeCollection, items: [],
    });
    expect(label.total).toBe(feeCollection === "COURIER" ? "5000.00" : "0.00");
    expect(label.paymentState).toBe(feeCollection === "COURIER" ? "COD" : "CREDIT");
    expect(label.creditAmount).toBe("5000.00");
  });

  it.each(["CANCELLED", "RETURNED", "SUPERSEDED"])("لا يطلب ليبل الشحن تحصيل بضائع أو أجرة لفاتورة %s", async (status) => {
    const label = invoiceToShippingLabel({
      invoiceNumber: "INV-DEAD", invoiceDate: "2026-10-24T17:25:00Z", status, paymentMode: "COD",
      total: "35000", paidAmount: "30000", courierFee: "5000", courierFeeCollection: "COURIER", items: [],
    });
    expect(label.total).toBe("0.00");
    expect(label.paymentState).toBe("CLOSED");
    const html = await shippingLabelHtml(label);
    expect(html).toContain("مستند مغلق؛ لا تحصيل");
    expect(html).not.toContain("مدفوعة مسبقاً");
    expect(html).not.toContain("تحصيل نقدي إلزامي");
  });

  it.each([
    { widthMm: 80, heightMm: 120 },
    { widthMm: 120, heightMm: 80 },
    { widthMm: 80, heightMm: 50 },
  ])("يفصل تحصيل الأجرة عن الحساب الآجل في ليبل $widthMm × $heightMm", async (size) => {
    for (const courierCollectsFee of [true, false]) {
      const label = invoiceToShippingLabel({
        invoiceNumber: "101567", invoiceDate: "2026-10-24T17:25:00Z", paymentMode: "CREDIT",
        total: "35000", paidAmount: "30000", courierFee: "5000", courierFeeCollection: courierCollectsFee ? "COURIER" : "COUNTER", items: [],
      });
      const html = await shippingLabelHtml(label, size);
      expect(html).toContain("رصيد البضاعة آجل؛ لا يحصله المندوب");
      expect(html).toContain("5,000");
      expect(html).not.toContain("PREPAID");
      expect(html).not.toContain("10,000");
      expect(html).not.toContain("تحصيل نقدي إلزامي");
      if (courierCollectsFee) expect(html).toContain("أجرة التوصيل فقط");
      else expect(html).toContain("بضاعة آجلة");
    }
  });

  it("لا يكرر بادئة INV في باركود الفواتير التاريخية", () => {
    const label = invoiceToShippingLabel({
      invoiceNumber: "INV-1004",
      invoiceDate: "2026-09-15T10:00:00Z",
      total: "0",
      items: [],
    });
    expect(label.barcodeValue).toBe("INV-1004");
  });

  it("يغذي ليبل فاتورة المتجر من عنوان المحافظة ومرجع التتبع ولو لم تنشأ إرسالية بعد", () => {
    const router = readFileSync(new URL("../../../../server/routers/saleRouter.ts", import.meta.url), "utf8");
    expect(router).toContain("NULLIF(${onlineOrders.shippingAddress}, '')");
    expect(router).toContain("NULLIF(${onlineOrders.governorate}, '')");
    expect(router).toContain("NULLIF(${onlineOrders.trackingNumber}, '')");
    expect(router).toContain(".leftJoin(onlineOrderCustomer");
  });

  it("يمرّر أصل الفاتورة ومن طلب واعتمد إلى الإيصال الحراري", () => {
    const receipt = invoiceToReceipt({
      invoiceNumber: "1002",
      invoiceDate: "2026-09-15T10:00:00Z",
      subtotal: "1000",
      total: "1000",
      items: [],
      correctionAudit: {
        originalInvoiceNumber: "1001",
        requestedBy: 7,
        requestedByName: "أحمد",
        requestedAt: "2026-09-15T09:00:00Z",
        reviewedBy: 8,
        reviewedByName: "علي",
        reviewedAt: "2026-09-15T09:30:00Z",
      },
    });
    expect(receipt.revision).toMatchObject({
      originalReceiptNumber: "1001",
      revisedByName: "المستخدم #7 (الاسم الحالي: أحمد)",
      approvedByName: "المستخدم #8 (الاسم الحالي: علي)",
    });
  });
});


it("prints CREDIT shipping label at10000 only for the explicit courier instruction",async()=>{
  const label=invoiceToShippingLabel({invoiceNumber:"101567",invoiceDate:"2026-10-24T17:25:00Z",paymentMode:"CREDIT",collectCreditOnDelivery:true,
    total:"35000",paidAmount:"30000",courierFee:"5000",courierFeeCollection:"COURIER",items:[]});
  expect(label).toMatchObject({total:"10000.00",paymentState:"COD"});
  expect(await shippingLabelHtml(label,{widthMm:80,heightMm:50})).toContain("10,000");
  expect(label.creditAmount).toBeUndefined();
});
