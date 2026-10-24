import { describe, expect, it } from "vitest";
import { deliverySourceView } from "./deliverySource";
import { collapseLinkedDeliveryBarcodeCandidates } from "../server/services/delivery/barcodeLookupPolicy";

describe("current delivery source", () => {
  it("opens the aftercare execution even when a historical sale reference is present", () => {
    const source = deliverySourceView({
      sourceType: "AFTERCARE_EXECUTION",
      aftercareExecutionId: 8,
      invoiceId: 42,
      invoiceNumber: "OLD-42",
    });
    expect(source.href).toBe(
      "/reception/workflow?section=aftercare&executionId=8",
    );
    expect(source.reference).not.toContain("OLD-42");
    expect(source.customerCollectionForbidden).toBe(true);
  });
  it("keeps invoice-less charge requests actionable", () => {
    expect(
      deliverySourceView({
        sourceType: "FULFILLMENT_REQUEST",
        fulfillmentRequestId: 11,
        invoiceId: null,
      }).href,
    ).toBe("/reception/workflow?section=dispatch&requestId=11");
  });
  it("links a legacy invoice member to its real request without changing the source type", () => {
    expect(
      deliverySourceView({
        sourceType: "INVOICE",
        invoiceId: 25,
        fulfillmentRequestId: 11,
        invoiceNumber: "INV-25",
      }),
    ).toMatchObject({
      reference: "طلب توصيل #11 · INV-25",
      href: "/reception/workflow?section=dispatch&requestId=11",
      customerCollectionForbidden: false,
    });
  });
  it("never manufactures invoice zero from a missing reference", () => {
    expect(
      deliverySourceView({ sourceType: "INVOICE", invoiceId: null }).href,
    ).toBeNull();
    expect(
      deliverySourceView({ sourceType: "INVOICE", invoiceId: 4 }).href,
    ).toBe("/invoices/4");
  });
  it("does not collapse an aftercare barcode to an invoice with a colliding historical ID", () => {
    const result = collapseLinkedDeliveryBarcodeCandidates({
      namespace: "NUMERIC",
      invoices: [{ id: 7 }],
      consignments: [
        {
          id: 12,
          sourceType: "AFTERCARE_EXECUTION",
          sourceId: 7,
          invoiceId: 7,
        },
      ],
      mapConsignmentToSource: true,
    });
    expect(result).toContainEqual(
      expect.objectContaining({ kind: "CONSIGNMENT", id: 12 }),
    );
  });
});
