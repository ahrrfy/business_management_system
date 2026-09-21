import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  classifyDeliveryBarcode,
  namespaceAllowsTarget,
  prepareDeliveryBarcodeLookup,
  resolveUniqueDeliveryBarcodeTarget,
} from "../delivery/barcodeLookupPolicy";

describe("delivery barcode namespace policy", () => {
  it.each([
    ["CNS-41", "CONSIGNMENT"],
    ["cn-41", "CONSIGNMENT"],
    ["INV-41", "INVOICE"],
    ["wo-41", "WORK_ORDER"],
    ["ORD-41", "ONLINE_ORDER"],
    ["00041", "NUMERIC"],
    ["carrier-41", "REFERENCE"],
  ] as const)("classifies %s as %s", (code, namespace) => {
    const lookup = classifyDeliveryBarcode(code);
    expect(lookup.namespace).toBe(namespace);
    expect(lookup.numericId).toBe(namespace === "NUMERIC" ? 41 : null);
  });

  it("reserves internal prefixes for exactly one target kind", () => {
    expect(namespaceAllowsTarget("INVOICE", "INVOICE")).toBe(true);
    expect(namespaceAllowsTarget("INVOICE", "CONSIGNMENT")).toBe(false);
    expect(namespaceAllowsTarget("WORK_ORDER", "ONLINE_ORDER")).toBe(false);
    expect(namespaceAllowsTarget("NUMERIC", "ONLINE_ORDER")).toBe(true);
  });

  it("keeps internal and external canonical keys separate", () => {
    const lookup = prepareDeliveryBarcodeLookup("٠٠٠٤١");
    expect(lookup.systemCode).toBe("٠٠٠٤١");
    expect(lookup.trackingCode).toBe("00041");
    expect(lookup.namespace).toBe("NUMERIC");
    expect(lookup.numericId).toBe(41);
  });

  it("deduplicates joins that resolve to the same logical target", () => {
    expect(resolveUniqueDeliveryBarcodeTarget("41", [
      { kind: "WORK_ORDER", id: 41 },
      { kind: "WORK_ORDER", id: 41 },
    ])).toEqual({ kind: "WORK_ORDER", id: 41 });
  });

  it("rejects cross-namespace numeric collisions", () => {
    expect(() => resolveUniqueDeliveryBarcodeTarget("41", [
      { kind: "WORK_ORDER", id: 41 },
      { kind: "INVOICE", id: 41 },
    ])).toThrowError(TRPCError);
  });

  it("rejects two records in the same namespace", () => {
    expect(() => resolveUniqueDeliveryBarcodeTarget("carrier-41", [
      { kind: "CONSIGNMENT", id: 8 },
      { kind: "CONSIGNMENT", id: 9 },
    ])).toThrowError(/أكثر من سجل/);
  });
});
