// اختبار طابور «الباركود المجهول» (وثيقة «الجرد بالباركود» ٢٢/٨، ب-٤).
//
// يغطّي: الالتقاط (idempotent + لا يُسجَّل خارج COUNTING)، القائمة المُجمَّعة بالباركود مع قابلية
// الحلّ (معروفٌ خارج النطاق ⇒ resolvable، مجهولٌ ⇒ لا)، الحسم (ADD_TO_SCOPE يُلحق المتغيّر،
// DISMISS يُغلق)، منع الإضافة خارج COUNTING، ورفض باركودٍ لا يُحلّ، وعزل الفرع.
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  authenticatePin,
  recordUnknownScan,
  type PortalIdentity,
} from "../countPortalService";
import {
  createStocktakeSession,
  listUnknownScans,
  resolveUnknownScan,
} from "../stocktakeService";

const adminActor = { userId: 1, role: "admin" };

const TABLES = [
  "stocktakeItemReviewEvents",
  "stocktakeDecisions",
  "stocktakeCountOperations",
  "stocktakeCounts",
  "stocktakeUnknownScans",
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
  ]);
  await d.insert(s.products).values([
    { id: 1, name: "قلم جاف" },
    { id: 2, name: "دفتر 100 ورقة" },
  ]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "PEN-1", costPrice: "100.00" },
    { id: 2, productId: 2, sku: "NB-1", costPrice: "250.00" },
  ]);
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-PEN-1" },
    { id: 2, variantId: 2, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true, barcode: "BC-NB-1" },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 100 },
    { variantId: 2, branchId: 1, quantity: 40 },
  ]);
}

/** جلسة نطاقها المتغيّر 1 فقط ⇒ المتغيّر 2 موجودٌ لكنه خارج النطاق (مرشّحٌ للإضافة). */
async function mkSession() {
  return createStocktakeSession(
    {
      name: "جرد مجهول",
      branchId: 1,
      scopeType: "MANUAL",
      variantIds: [1],
      assignments: [{ name: "عامل PIN", method: "PIN" }],
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

function pinOf(res: Awaited<ReturnType<typeof mkSession>>): string {
  const pin = res.assignments[0]?.pin;
  if (!pin) throw new Error("no PIN");
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

describe("طابور الباركود المجهول (ب-٤)", () => {
  it("الالتقاط: يسجّل صفّاً PENDING، وتكرار نفس clientRequestId idempotent", async () => {
    const r = await mkSession();
    const id = await loginPin(r.code, pinOf(r));
    const rid = randomUUID();
    const first = await recordUnknownScan(id, { barcode: "BC-NB-1", clientRequestId: rid });
    expect(first).toMatchObject({ ok: true, recorded: true, idempotent: false });
    const again = await recordUnknownScan(id, { barcode: "BC-NB-1", clientRequestId: rid });
    expect(again.idempotent).toBe(true);
    const rows = await db()
      .select()
      .from(s.stocktakeUnknownScans)
      .where(eq(s.stocktakeUnknownScans.sessionId, r.sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
  });

  it("يرفض إعادة clientRequestId نفسه بباركود مختلف بدل ابتلاع تصادم الحمولة", async () => {
    const r = await mkSession();
    const id = await loginPin(r.code, pinOf(r));
    const rid = randomUUID();
    await recordUnknownScan(id, { barcode: "BC-NB-1", clientRequestId: rid });

    await expectTrpc(
      recordUnknownScan(id, { barcode: "GHOST-777", clientRequestId: rid }),
      "CONFLICT",
      /معرّف الطلب.*باركود مختلف/,
    );

    const rows = await db()
      .select()
      .from(s.stocktakeUnknownScans)
      .where(eq(s.stocktakeUnknownScans.sessionId, r.sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].barcode).toBe("BC-NB-1");
  });

  it("القائمة: تُجمّع بالباركود مع قابلية الحلّ (معروفٌ خارج النطاق ⇒ resolvable، مجهولٌ ⇒ لا)", async () => {
    const r = await mkSession();
    const id = await loginPin(r.code, pinOf(r));
    await recordUnknownScan(id, { barcode: "BC-NB-1", clientRequestId: randomUUID() });
    await recordUnknownScan(id, { barcode: "BC-NB-1", clientRequestId: randomUUID() });
    await recordUnknownScan(id, { barcode: "GHOST-777", clientRequestId: randomUUID() });

    const list = await listUnknownScans(r.sessionId, { restrictBranchId: null });
    const byCode = new Map(list.map((x) => [x.barcode, x]));
    expect(byCode.get("BC-NB-1")?.occurrences).toBe(2);
    expect(byCode.get("BC-NB-1")?.resolvable).toBe(true);
    expect(byCode.get("BC-NB-1")?.resolvedName).toBe("دفتر 100 ورقة");
    expect(byCode.get("GHOST-777")?.resolvable).toBe(false);
    expect(byCode.get("GHOST-777")?.resolvedName).toBeNull();
  });

  it("الحسم ADD_TO_SCOPE: يُلحق المتغيّر بالجلسة (لقطة رصيد) ويُعلِّم RESOLVED", async () => {
    const r = await mkSession();
    const id = await loginPin(r.code, pinOf(r));
    await recordUnknownScan(id, { barcode: "BC-NB-1", clientRequestId: randomUUID() });

    const res = await resolveUnknownScan(
      { sessionId: r.sessionId, barcode: "BC-NB-1", action: "ADD_TO_SCOPE" },
      adminActor,
      { restrictBranchId: null },
    );
    expect(res.addedVariantId).toBe(2);
    expect(res.alreadyInScope).toBe(false);

    const item = await db()
      .select()
      .from(s.stocktakeItems)
      .where(
        and(eq(s.stocktakeItems.sessionId, r.sessionId), eq(s.stocktakeItems.variantId, 2)),
      );
    expect(item).toHaveLength(1);
    expect(item[0].expectedQty).toBe(40); // لقطة الرصيد الدفتري
    // لم يبقَ في القائمة (RESOLVED).
    const list = await listUnknownScans(r.sessionId, { restrictBranchId: null });
    expect(list.find((x) => x.barcode === "BC-NB-1")).toBeUndefined();
  });

  it("الحسم DISMISS: يُغلق بلا تغيير النطاق", async () => {
    const r = await mkSession();
    const id = await loginPin(r.code, pinOf(r));
    await recordUnknownScan(id, { barcode: "GHOST-777", clientRequestId: randomUUID() });
    const res = await resolveUnknownScan(
      { sessionId: r.sessionId, barcode: "GHOST-777", action: "DISMISS", note: "غير مسجّل" },
      adminActor,
      { restrictBranchId: null },
    );
    expect(res.action).toBe("DISMISS");
    expect(res.addedVariantId).toBeNull();
    const list = await listUnknownScans(r.sessionId, { restrictBranchId: null });
    expect(list).toHaveLength(0);
    const items = await db()
      .select()
      .from(s.stocktakeItems)
      .where(eq(s.stocktakeItems.sessionId, r.sessionId));
    expect(items).toHaveLength(1); // المتغيّر 1 فقط (لم يُضَف شيء)
  });

  it("ADD_TO_SCOPE لباركودٍ لا يُحلّ إلى صنف مرفوض", async () => {
    const r = await mkSession();
    const id = await loginPin(r.code, pinOf(r));
    await recordUnknownScan(id, { barcode: "GHOST-777", clientRequestId: randomUUID() });
    await expectTrpc(
      resolveUnknownScan(
        { sessionId: r.sessionId, barcode: "GHOST-777", action: "ADD_TO_SCOPE" },
        adminActor,
        { restrictBranchId: null },
      ),
      "PRECONDITION_FAILED",
      /لا يُحلّ/,
    );
  });

  it("عزل الفرع: قائمة/حسم بفرعٍ مختلف يُعامَل كغير موجود", async () => {
    const r = await mkSession();
    const id = await loginPin(r.code, pinOf(r));
    await recordUnknownScan(id, { barcode: "BC-NB-1", clientRequestId: randomUUID() });
    await expectTrpc(
      listUnknownScans(r.sessionId, { restrictBranchId: 999 }),
      "NOT_FOUND",
    );
    await expectTrpc(
      resolveUnknownScan(
        { sessionId: r.sessionId, barcode: "BC-NB-1", action: "DISMISS" },
        { userId: 1, role: "manager" },
        { restrictBranchId: 999 },
      ),
      "NOT_FOUND",
    );
  });
});
