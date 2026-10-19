import { describe, expect, it } from "vitest";
import {
  collapseLinkedDeliveryBarcodeCandidates,
  prepareDeliveryBarcodeLookup,
  resolveActiveInvoiceCandidates,
  resolveUniqueDeliveryBarcodeTarget,
} from "./barcodeLookupPolicy";

describe("resolveUniqueDeliveryBarcodeTarget", () => {
  it("يفك رمز الآلة WO وINV وCN إلى رقم العرض القصير مع إبقاء البادئة للسجلات القديمة", () => {
    expect(prepareDeliveryBarcodeLookup("WO-5285")).toMatchObject({
      namespace: "WORK_ORDER",
      systemCode: "WO-5285",
      documentCode: "5285",
    });
    expect(prepareDeliveryBarcodeLookup("CN-100034")).toMatchObject({
      namespace: "CONSIGNMENT",
      systemCode: "CN-100034",
      documentCode: "100034",
    });
    expect(prepareDeliveryBarcodeLookup("CN-1-20261019-00001")).toMatchObject({
      namespace: "CONSIGNMENT",
      systemCode: "CN-1-20261019-00001",
      documentCode: "CN-1-20261019-00001",
    });
  });

  it("يفضّل رقم المستند المطابق على مفاتيح السجلات الرقمية المتصادمة", () => {
    expect(resolveUniqueDeliveryBarcodeTarget("5285", [
      { kind: "ONLINE_ORDER", id: 5285, matchRank: 10 },
      { kind: "INVOICE", id: 5285, matchRank: 10 },
      { kind: "WORK_ORDER", id: 91, matchRank: 100 },
    ])).toEqual({ kind: "WORK_ORDER", id: 91, matchRank: 100 });
  });

  it("يبقى مغلقاً عند تطابق مستندين حقيقيين بالرتبة نفسها", () => {
    expect(() => resolveUniqueDeliveryBarcodeTarget("5285", [
      { kind: "WORK_ORDER", id: 91, matchRank: 100 },
      { kind: "INVOICE", id: 77, matchRank: 100 },
    ])).toThrow(/يطابق أكثر من سجل/);
  });

  it("يطوي المستندات المترابطة لنفس المعاملة الموحدة (طلب متجر + فاتورة + إرسالية) دون خطأ غموض زائف", () => {
    const collapsedOnline = collapseLinkedDeliveryBarcodeCandidates({
      namespace: "NUMERIC",
      onlineOrders: [{ id: 15, matchRank: 100, invoiceId: 80 }],
      invoices: [{ id: 80, matchRank: 100, sourceType: "ONLINE", sourceId: "online-dispatch:15" }],
      consignments: [{ id: 200, matchRank: 100, invoiceId: 80, workOrderId: null }],
      mapConsignmentToSource: true,
    });
    expect(resolveUniqueDeliveryBarcodeTarget("100034", collapsedOnline)).toMatchObject({
      kind: "ONLINE_ORDER",
      id: 15,
    });

    const collapsedWorkOrder = collapseLinkedDeliveryBarcodeCandidates({
      namespace: "NUMERIC",
      workOrders: [{ id: 50, matchRank: 100, invoiceId: 90 }],
      invoices: [{ id: 90, matchRank: 100, sourceType: "WORKORDER", sourceId: "WO-50" }],
      consignments: [{ id: 201, matchRank: 100, workOrderId: 50, invoiceId: 90 }],
      mapConsignmentToSource: true,
    });
    expect(resolveUniqueDeliveryBarcodeTarget("100035", collapsedWorkOrder)).toMatchObject({
      kind: "WORK_ORDER",
      id: 50,
    });

    const collapsedInvoiceConsignment = collapseLinkedDeliveryBarcodeCandidates({
      namespace: "NUMERIC",
      invoices: [{ id: 95, matchRank: 100, sourceType: "POS", sourceId: null }],
      consignments: [{ id: 202, matchRank: 100, invoiceId: 95, workOrderId: null }],
      mapConsignmentToSource: false,
    });
    expect(resolveUniqueDeliveryBarcodeTarget("100036", collapsedInvoiceConsignment)).toMatchObject({
      kind: "INVOICE",
      id: 95,
    });
  });

  it("يرفض السجلات غير المترابطة حتى لو حملا نفس الرقم العاري", () => {
    const unrelated = collapseLinkedDeliveryBarcodeCandidates({
      namespace: "NUMERIC",
      workOrders: [{ id: 50, matchRank: 100, invoiceId: 90 }],
      invoices: [{ id: 99, matchRank: 100, sourceType: "POS", sourceId: null }],
      mapConsignmentToSource: true,
    });
    expect(() => resolveUniqueDeliveryBarcodeTarget("100035", unrelated)).toThrow(/يطابق أكثر من سجل/);
  });

  it("يتتبّع سلسلة الفواتير المستبدلة بالتصحيح (SUPERSEDED) ويطويها مع الإرسالية المعاد ربطها", async () => {
    const chain = new Map([
      [500, { id: 500, sourceType: "POS", sourceId: null, correctedByInvoiceId: 501 }],
      [501, { id: 501, sourceType: "POS", sourceId: null, correctedByInvoiceId: 502 }],
      [502, { id: 502, sourceType: "POS", sourceId: null, correctedByInvoiceId: null }],
    ]);
    const resolvedInvoices = await resolveActiveInvoiceCandidates(
      [{ id: 500, sourceType: "POS", sourceId: null, correctedByInvoiceId: 501, matchRank: 100 }],
      async (id) => chain.get(id) ?? null,
    );
    expect(resolvedInvoices).toEqual([
      { id: 502, sourceType: "POS", sourceId: null, correctedByInvoiceId: null, matchRank: 100 },
    ]);

    const collapsed = collapseLinkedDeliveryBarcodeCandidates({
      namespace: "NUMERIC",
      invoices: resolvedInvoices,
      consignments: [{ id: 88, invoiceId: 502, sourceType: "INVOICE", sourceId: 502, matchRank: 100 }],
      mapConsignmentToSource: false,
    });
    expect(resolveUniqueDeliveryBarcodeTarget("100034", collapsed)).toEqual({
      kind: "INVOICE",
      id: 502,
      matchRank: 100,
    });
  });

  it("يجهّز كود التتبع مع نواته بعد إسقاط الأصفار البادئة (0, 00, 000)", () => {
    expect(prepareDeliveryBarcodeLookup("0404221")).toMatchObject({
      trackingCode: "0404221",
      strippedTrackingCode: "404221",
      namespace: "NUMERIC",
    });
    expect(prepareDeliveryBarcodeLookup("00404221")).toMatchObject({
      trackingCode: "00404221",
      strippedTrackingCode: "404221",
      namespace: "NUMERIC",
    });
    expect(prepareDeliveryBarcodeLookup("404221")).toMatchObject({
      trackingCode: "404221",
      strippedTrackingCode: "404221",
      namespace: "NUMERIC",
    });
  });
});


