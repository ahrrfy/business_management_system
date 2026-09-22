import { isDupEntry } from "@shared/errorMap.ar";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import {
  assertExternalTrackingRefAvailable,
  DELIVERY_TRACKING_REF_UNIQUE_KEY,
  normalizeExternalTrackingRef,
  rethrowExternalTrackingRefDuplicate,
} from "../delivery/trackingRefPolicy";

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

describe("سياسة الهوية القانونية لبوليصة شركة التوصيل", () => {
  it("توحّد صيغ الماسح وتحفظ الأصفار البادئة", () => {
    expect(normalizeExternalTrackingRef("\u200e٠٠٤٤١٤٤٦ ")).toBe("00441446");
    expect(normalizeExternalTrackingRef("]C1۰۰۴۴۱۴۴۶")).toBe("00441446");
    expect(normalizeExternalTrackingRef("÷آ{٠٠٤٢")).toBe("INV0042");
    expect(normalizeExternalTrackingRef("  00017  ")).toBe("00017");
    expect(normalizeExternalTrackingRef("\u200b\ufeff  ")).toBeNull();
  });

  it("يجعل فحص التوافر قراءة قفل داخل معاملة الكاتب", async () => {
    const calls: string[] = [];
    const query = {
      from() { calls.push("from"); return this; },
      where() { calls.push("where"); return this; },
      for(mode: string) { calls.push(`for:${mode}`); return this; },
      async limit() { calls.push("limit"); return []; },
    };
    const tx = {
      select() { calls.push("select"); return query; },
    } as unknown as Tx;

    await assertExternalTrackingRefAvailable(tx, 71, "00441446");
    expect(calls).toEqual(["select", "from", "where", "for:update", "limit"]);
  });

  it("يترجم فقط تصادم قيد البوليصة عبر سلسلة cause المتداخلة", () => {
    const trackingDuplicate = {
      message: "Failed query",
      cause: {
        code: "ER_DUP_ENTRY",
        cause: {
          sqlMessage: `Duplicate entry '71-00441446' for key 'deliveryConsignments.${DELIVERY_TRACKING_REF_UNIQUE_KEY}'`,
        },
      },
    };

    let translated: unknown;
    try {
      rethrowExternalTrackingRefDuplicate(trackingDuplicate, "00441446");
    } catch (error) {
      translated = error;
    }
    expect(translated).toMatchObject({ code: "CONFLICT", cause: trackingDuplicate });

    const unrelatedDuplicate = {
      cause: {
        code: "ER_DUP_ENTRY",
        sqlMessage: "Duplicate entry 'CN-1' for key 'deliveryConsignments.consignmentNumber'",
      },
    };
    let unchanged: unknown;
    try {
      rethrowExternalTrackingRefDuplicate(unrelatedDuplicate, "00441446");
    } catch (error) {
      unchanged = error;
    }
    expect(unchanged).toBe(unrelatedDuplicate);
  });

  it("يمنع قيد القاعدة كاتبين متزامنين للشركة نفسها ويسمح بالرقم نفسه لشركة أخرى", async () => {
    const database = db();
    await database.insert(schema.branches).values({ id: 71, name: "فرع فحص البوليصة", code: "TRK71", type: "MAIN" });
    await database.insert(schema.users).values({
      id: 71,
      openId: "tracking_ref_writer",
      name: "كاتب البوليصة",
      email: "tracking-ref@test.local",
      role: "manager",
      loginMethod: "local",
      branchId: 71,
    });
    await database.insert(schema.deliveryParties).values([
      { id: 71, name: "شركة التوصيل الأولى", partyType: "COMPANY", branchId: 71 },
      { id: 72, name: "شركة التوصيل الثانية", partyType: "COMPANY", branchId: 71 },
    ]);
    await database.insert(schema.invoices).values([
      { id: 71, invoiceNumber: "INV-TRACK-RACE-A", sourceType: "WORKORDER", branchId: 71, subtotal: "1000.00", total: "1000.00", createdBy: 71 },
      { id: 72, invoiceNumber: "INV-TRACK-RACE-B", sourceType: "WORKORDER", branchId: 71, subtotal: "1000.00", total: "1000.00", createdBy: 71 },
      { id: 73, invoiceNumber: "INV-TRACK-OTHER", sourceType: "WORKORDER", branchId: 71, subtotal: "1000.00", total: "1000.00", createdBy: 71 },
    ]);

    const canonical = normalizeExternalTrackingRef("]C1۰۰۴۴۱۴۴۶");
    expect(canonical).toBe("00441446");
    if (!canonical) throw new Error("canonical tracking reference unexpectedly empty");

    const attempts = await Promise.allSettled([
      database.insert(schema.deliveryConsignments).values({
        consignmentNumber: "CN-TRACK-RACE-A",
        branchId: 71,
        partyId: 71,
        invoiceId: 71,
        sourceType: "INVOICE",
        sourceId: 71,
        codAmount: "1000.00",
        dispatchedBy: 71,
        externalTrackingRef: canonical,
      }),
      database.insert(schema.deliveryConsignments).values({
        consignmentNumber: "CN-TRACK-RACE-B",
        branchId: 71,
        partyId: 71,
        invoiceId: 72,
        sourceType: "INVOICE",
        sourceId: 72,
        codAmount: "1000.00",
        dispatchedBy: 71,
        externalTrackingRef: canonical,
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toBeDefined();
    expect(isDupEntry(rejected?.reason)).toBe(true);
    let translated: unknown;
    try {
      rethrowExternalTrackingRefDuplicate(rejected?.reason, canonical);
    } catch (error) {
      translated = error;
    }
    expect(translated).toMatchObject({ code: "CONFLICT" });

    await expect(database.insert(schema.deliveryConsignments).values({
      consignmentNumber: "CN-TRACK-OTHER",
      branchId: 71,
      partyId: 72,
      invoiceId: 73,
      sourceType: "INVOICE",
      sourceId: 73,
      codAmount: "1000.00",
      dispatchedBy: 71,
      externalTrackingRef: canonical,
    })).resolves.toBeDefined();

    const rows = await database.select({ partyId: schema.deliveryConsignments.partyId })
      .from(schema.deliveryConsignments)
      .where(eq(schema.deliveryConsignments.externalTrackingRef, canonical));
    expect(rows.map((row) => Number(row.partyId)).sort()).toEqual([71, 72]);
  });
});
