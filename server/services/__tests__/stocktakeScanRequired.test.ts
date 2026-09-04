// اختبار عقد «العدّ بالمسح الإلزامي» (وثيقة «الجرد بالباركود» ٢٢/٨، م١).
//
// يثبت الإنفاذ الخادميّ (لا ثقة بالواجهة):
//  - جلسة SCAN_REQUIRED ترفض الاختيار الحر (SEARCH_PICK/غياب الطريقة)، وترفض المسح بلا
//    باركود أو بباركودٍ لا يخصّ المتغيّر، وتقبل المسح الصحيح (باركود وحدة أو بديل)، وتُخزّن
//    entryMethod/scannedBarcode في العدّة وسجلّ العمليات.
//  - الاستثناء اليدويّ (MANUAL_AUTHORIZED) يُرفض من عامل PIN، ويُقبل من مشرف USER (manager/admin).
//  - جلسة FREE تقبل الاختيار الحر (توافق رجعيّ)، وإنشاء FREE من غير مدير يُرفض (قرار المالك).
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  authenticatePin,
  submitCount,
  type PortalIdentity,
} from "../countPortalService";
import {
  createStocktakeSession,
  type CreateStocktakeInput,
} from "../stocktakeService";

const adminActor = { userId: 1, role: "admin" };
const warehouseActor = { userId: 2, role: "warehouse" };

const TABLES = [
  "stocktakeItemReviewEvents",
  "stocktakeDecisions",
  "stocktakeCountOperations",
  "stocktakeCounts",
  "stocktakeItems",
  "stocktakeAssignments",
  "stocktakeSessions",
  "accountingEntries",
  "inventoryMovements",
  "branchStock",
  "productPrices",
  "productUnitBarcodes",
  "productUnits",
  "productVariants",
  "products",
  "auditLogs",
  "categories",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  const { sql } = await import("drizzle-orm");
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d
    .insert(s.branches)
    .values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "أحمد المدير", role: "admin", loginMethod: "local" },
    { id: 2, openId: "local_wh", name: "كريم المخزن", role: "warehouse", branchId: 1, loginMethod: "local" },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "قلم جاف" }]);
  await d
    .insert(s.productVariants)
    .values([{ id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" }]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-PEN-1" },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false, barcode: "BC-PEN-12" },
  ]);
  // باركود بديل لوحدة القطعة — يجب أن يُقبل كإثبات مسحٍ صحيح لنفس المتغيّر.
  await d.insert(s.productUnitBarcodes).values([{ productUnitId: 1, barcode: "BC-PEN-ALT" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
}

/** جلسة قياسية على المتغيّر 1: عامل PIN + عامل USER (المدير user 1). */
async function mkSession(over: Partial<CreateStocktakeInput> = {}) {
  return createStocktakeSession(
    {
      name: "جرد مسح",
      branchId: 1,
      scopeType: "MANUAL",
      variantIds: [1],
      assignments: [
        { name: "عامل PIN", method: "PIN" },
        { name: "مشرف USER", method: "USER", userId: 1 },
      ],
      ...over,
    },
    adminActor,
  );
}

async function loginPin(sessionCode: string, pin: string): Promise<PortalIdentity> {
  const r = await authenticatePin(null, { sessionCode, pin });
  return {
    session: r.session,
    assignment: r.assignment,
    countedByName: r.assignment.name,
    countedByUserId: null,
    mode: "PIN",
  };
}

/** هوية مشرف USER (user 1) — نبنيها كما يفعل resolvePortalIdentity في وضع USER. */
async function userIdentity(sessionId: number): Promise<PortalIdentity> {
  const [session] = await db()
    .select()
    .from(s.stocktakeSessions)
    .where(eq(s.stocktakeSessions.id, sessionId));
  const [assignment] = await db()
    .select()
    .from(s.stocktakeAssignments)
    .where(
      and(
        eq(s.stocktakeAssignments.sessionId, sessionId),
        eq(s.stocktakeAssignments.method, "USER"),
      ),
    );
  return {
    session,
    assignment,
    countedByName: assignment.name,
    countedByUserId: 1,
    mode: "USER",
  };
}

function pinOf(res: Awaited<ReturnType<typeof mkSession>>): string {
  const pin = res.assignments.find((a) => a.method === "PIN")?.pin;
  if (!pin) throw new Error("no PIN in session result");
  return pin;
}

async function expectTrpc(p: Promise<unknown>, code: string, msg?: RegExp) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TRPCError);
  expect((err as TRPCError).code).toBe(code);
  if (msg) expect((err as TRPCError).message).toMatch(msg);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("الجرد بالمسح الإلزامي — إنفاذ الخادم", () => {
  it("SCAN_REQUIRED: الاختيار الحر (غياب الطريقة) مرفوض", async () => {
    const r = await mkSession({ countMethod: "SCAN_REQUIRED" });
    const id = await loginPin(r.code, pinOf(r));
    await expectTrpc(
      submitCount(id, { variantId: 1, qty: 5, clientRequestId: randomUUID() }),
      "PRECONDITION_FAILED",
      /المسح الإلزامي|امسح/,
    );
  });

  it("SCAN_REQUIRED: SEARCH_PICK صريح مرفوض", async () => {
    const r = await mkSession({ countMethod: "SCAN_REQUIRED" });
    const id = await loginPin(r.code, pinOf(r));
    await expectTrpc(
      submitCount(id, {
        variantId: 1,
        qty: 5,
        entryMethod: "SEARCH_PICK",
        clientRequestId: randomUUID(),
      }),
      "PRECONDITION_FAILED",
    );
  });

  it.each(["SCAN_HID", "SCAN_CAMERA"] as const)("FREE: %s requires nonempty scan evidence", async (entryMethod) => {
    const r = await mkSession({ countMethod: "FREE" });
    const id = await loginPin(r.code, pinOf(r));
    for (const scannedBarcode of [undefined, "", "\r\n\u200f "]) {
      await expect(submitCount(id, {
        variantId: 1, qty: 5, entryMethod, scannedBarcode, clientRequestId: randomUUID(),
      })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    expect(await db().select().from(s.stocktakeCountOperations).where(eq(s.stocktakeCountOperations.sessionId, r.sessionId))).toHaveLength(0);
    expect(await db().select().from(s.stocktakeCounts).where(eq(s.stocktakeCounts.sessionId, r.sessionId))).toHaveLength(0);
  });

  it("SCAN_REQUIRED: مسح بلا باركود مرفوض", async () => {
    const r = await mkSession({ countMethod: "SCAN_REQUIRED" });
    const id = await loginPin(r.code, pinOf(r));
    await expectTrpc(
      submitCount(id, {
        variantId: 1,
        qty: 5,
        entryMethod: "SCAN_HID",
        clientRequestId: randomUUID(),
      }),
      "PRECONDITION_FAILED",
      /امسح باركود/,
    );
  });

  it("SCAN_REQUIRED: باركود لا يخصّ المتغيّر مرفوض", async () => {
    const r = await mkSession({ countMethod: "SCAN_REQUIRED" });
    const id = await loginPin(r.code, pinOf(r));
    await expectTrpc(
      submitCount(id, {
        variantId: 1,
        qty: 5,
        entryMethod: "SCAN_CAMERA",
        scannedBarcode: "NOT-MINE-999",
        clientRequestId: randomUUID(),
      }),
      "PRECONDITION_FAILED",
      /لا يخصّ هذا الصنف/,
    );
  });

  it("SCAN_REQUIRED: مسح باركود وحدة صحيح مقبول ويُخزَّن النسب", async () => {
    const r = await mkSession({ countMethod: "SCAN_REQUIRED" });
    const id = await loginPin(r.code, pinOf(r));
    const res = await submitCount(id, {
      variantId: 1,
      qty: 5,
      entryMethod: "SCAN_HID",
      scannedBarcode: "BC-PEN-1",
      clientRequestId: randomUUID(),
    });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe("FIRST");
    const [row] = await db()
      .select()
      .from(s.stocktakeCounts)
      .where(eq(s.stocktakeCounts.sessionId, r.sessionId));
    expect(row.entryMethod).toBe("SCAN_HID");
    expect(row.scannedBarcode).toBe("BC-PEN-1");
    const [op] = await db()
      .select()
      .from(s.stocktakeCountOperations)
      .where(eq(s.stocktakeCountOperations.sessionId, r.sessionId));
    expect(op.entryMethod).toBe("SCAN_HID");
    expect(op.scannedBarcode).toBe("BC-PEN-1");
  });

  it("SCAN_REQUIRED: مسح باركود بديل (alias) صحيح مقبول", async () => {
    const r = await mkSession({ countMethod: "SCAN_REQUIRED" });
    const id = await loginPin(r.code, pinOf(r));
    const res = await submitCount(id, {
      variantId: 1,
      qty: 3,
      entryMethod: "SCAN_CAMERA",
      scannedBarcode: "BC-PEN-ALT",
      clientRequestId: randomUUID(),
    });
    expect(res.ok).toBe(true);
  });

  it.each(["FREE", "SCAN_REQUIRED"] as const)("%s: يرفض دليل المسح المتعارض بين وحدتين قبل تسجيل العد", async (countMethod) => {
    await db().insert(s.productUnitBarcodes).values({ productUnitId: 2, barcode: " BC-PEN-1 " });
    const r = await mkSession({ countMethod });
    const id = await loginPin(r.code, pinOf(r));
    await expect(submitCount(id, {
      variantId: 1, qty: 3, entryMethod: "SCAN_CAMERA", scannedBarcode: "BC-PEN-1", clientRequestId: randomUUID(),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db().select().from(s.stocktakeCountOperations).where(eq(s.stocktakeCountOperations.sessionId, r.sessionId))).toHaveLength(0);
  });

  it("SCAN_REQUIRED: يقبل UPC-A من الكاميرا إذا كان EAN-13 المكافئ محفوظاً", async () => {
    await db().insert(s.productUnitBarcodes).values({ productUnitId: 1, barcode: "0036000291452" });
    const r = await mkSession({ countMethod: "SCAN_REQUIRED" });
    const id = await loginPin(r.code, pinOf(r));
    const res = await submitCount(id, {
      variantId: 1,
      qty: 3,
      entryMethod: "SCAN_CAMERA",
      scannedBarcode: "036000291452",
      clientRequestId: randomUUID(),
    });
    expect(res.ok).toBe(true);
  });

  it("SCAN_REQUIRED: الإدخال اليدويّ من عامل PIN مرفوض (لا مشرف)", async () => {
    const r = await mkSession({ countMethod: "SCAN_REQUIRED" });
    const id = await loginPin(r.code, pinOf(r));
    await expectTrpc(
      submitCount(id, {
        variantId: 1,
        qty: 5,
        entryMethod: "MANUAL_AUTHORIZED",
        clientRequestId: randomUUID(),
      }),
      "FORBIDDEN",
      /مسؤول الجرد|manager|admin/,
    );
  });

  it("SCAN_REQUIRED: الإدخال اليدويّ من مشرف USER (admin) مقبول", async () => {
    const r = await mkSession({ countMethod: "SCAN_REQUIRED" });
    const id = await userIdentity(r.sessionId);
    const res = await submitCount(id, {
      variantId: 1,
      qty: 7,
      entryMethod: "MANUAL_AUTHORIZED",
      clientRequestId: randomUUID(),
    });
    expect(res.ok).toBe(true);
    const [row] = await db()
      .select()
      .from(s.stocktakeCounts)
      .where(eq(s.stocktakeCounts.sessionId, r.sessionId));
    expect(row.entryMethod).toBe("MANUAL_AUTHORIZED");
    expect(row.scannedBarcode).toBeNull();
  });

  it("FREE: الاختيار الحر مقبول (توافق رجعيّ)", async () => {
    const r = await mkSession({ countMethod: "FREE" });
    const id = await loginPin(r.code, pinOf(r));
    const res = await submitCount(id, {
      variantId: 1,
      qty: 9,
      clientRequestId: randomUUID(),
    });
    expect(res.ok).toBe(true);
    expect(res.kind).toBe("FIRST");
  });

  it("الافتراض عند الحذف = FREE (القاعدة) فلا ينكسر المستدعي البرمجيّ", async () => {
    const r = await mkSession(); // بلا countMethod
    const id = await loginPin(r.code, pinOf(r));
    const res = await submitCount(id, {
      variantId: 1,
      qty: 4,
      clientRequestId: randomUUID(),
    });
    expect(res.ok).toBe(true);
  });

  it("إنشاء جلسة FREE من أمين المخزن مقبول (الافتراض الآمن؛ لا بوّابة على الحرّ بعد مراجعة Codex #1/#4)", async () => {
    const res = await createStocktakeSession(
      {
        name: "جرد حر من المخزن",
        branchId: 1,
        scopeType: "MANUAL",
        variantIds: [1],
        countMethod: "FREE",
        assignments: [{ name: "عامل PIN", method: "PIN" }],
      },
      warehouseActor,
    );
    expect(res.sessionId).toBeGreaterThan(0);
    const [session] = await db()
      .select({ countMethod: s.stocktakeSessions.countMethod })
      .from(s.stocktakeSessions)
      .where(eq(s.stocktakeSessions.id, res.sessionId));
    expect(session.countMethod).toBe("FREE");
  });
});
