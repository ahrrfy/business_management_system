/**
 * Tier-2 #1 (٢٥/٨) — ترقيمُ قوائم التوصيل. كانت الدوال الأربع تُحمّل الصفوف كلّها بلا حدّ ⇒
 * تعطُّل الشاشة عند ~١٠ آلاف صفٍّ. الاختبار يُثبت:
 *   1) hasMore = true عندما تكون الصفوف > limit
 *   2) nextCursor يُشير إلى id أصغر ⇒ الصفحة الثانية تجلب ما هو أقدم
 *   3) المجموع عبر الصفحات = المجموع الأصليّ (بلا فقدان صفٍّ)
 *   4) بلا limit ⇒ يُطبَّق الافتراض ٢٠٠ (يبقى محدوداً بحدّ آمن)
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  listInTransitConsignments,
  listOpenConsignments,
  listConsignmentsForParty,
  getDeliveryPartyFinancials,
} from "../delivery/queries";
import { truncateTables } from "./__testUtils__";

const TABLES = [
  "deliveryLedgerEntries",
  "deliveryRemittanceLines",
  "deliveryRemittances",
  "deliveryEvents",
  "deliveryConsignments",
  "deliveryPartyMembers",
  "deliveryParties",
  "invoices",
  "customers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function seed(consignmentCount: number) {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values({ id: 1, openId: "u-admin", name: "أدمن", role: "admin", loginMethod: "local", branchId: 1 });
  await db().insert(s.deliveryParties).values({ id: 1, name: "شركة توصيل", partyKind: "COMPANY", branchId: 1 });
  // فواتير وهمية للـFK — الاختبار يقيس الترقيم لا سلامة الفاتورة
  for (let i = 1; i <= consignmentCount; i++) {
    await db().insert(s.invoices).values({
      id: i,
      invoiceNumber: `INV-${i}`,
      branchId: 1,
      subtotal: "1000.00",
      total: "1000.00",
      paidAmount: "0.00",
      returnedTotal: "0.00",
      createdBy: 1,
    });
    await db().insert(s.deliveryConsignments).values({
      id: i,
      consignmentNumber: `CN-${String(i).padStart(5, "0")}`,
      partyId: 1,
      branchId: 1,
      invoiceId: i,
      sourceType: "INVOICE",
      sourceId: i,
      status: "DISPATCHED",
      parcelStatus: "ASSIGNED",
      moneyStatus: "UNSETTLED",
      codAmount: "1000.00",
      collectedAmount: "0.00",
      counterSettledAmount: "0.00",
      deliveryFee: "0.00",
      feeCollection: "COURIER",
      dispatchedAt: new Date(2026, 0, i),
      dispatchedBy: 1,
    });
  }
}

beforeEach(async () => {
  await truncateTables(TABLES);
});

describe("listInTransitConsignments — ترقيم keyset", () => {
  it("بلا limit ⇒ يُعيد كل الصفوف حتى الافتراض ٢٠٠ + hasMore=false للعدد الصغير", async () => {
    await seed(5);
    const res = await listInTransitConsignments(1);
    expect(res.rows).toHaveLength(5);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
  });

  it("limit=3 مع 5 صفوف ⇒ hasMore=true و nextCursor يُشير إلى id الأكبر في الصفحة", async () => {
    await seed(5);
    const page1 = await listInTransitConsignments(1, null, { limit: 3 });
    expect(page1.rows).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    // Codex P1 #2 (٢٥/٨): ASC by id ⇒ الأقدم أوّلاً (الصفوف [1,2,3]، nextCursor = 3)
    // — «الأقدم أوّلاً» شرطُ سير العمل: المطالبةُ بأقدم عهدةٍ أوّلاً لا بأحدثها.
    expect(page1.rows.map((r) => Number(r.id))).toEqual([1, 2, 3]);
    expect(page1.nextCursor).toBe(3);

    const page2 = await listInTransitConsignments(1, null, { limit: 3, cursor: page1.nextCursor! });
    expect(page2.rows.map((r) => Number(r.id))).toEqual([4, 5]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    // المجموع عبر الصفحات = المجموع الكامل بلا فقدان صفّ
    const all = [...page1.rows, ...page2.rows].map((r) => Number(r.id));
    expect(new Set(all).size).toBe(5);
  });

  it("سقفٌ آمن ٥٠٠ يمنع طلب حجمٍ غير معقول", async () => {
    await seed(3);
    // limit = 1000 → يُقصّ إلى 500. مع 3 صفوف، لا hasMore.
    const res = await listInTransitConsignments(1, null, { limit: 1000 });
    expect(res.rows).toHaveLength(3);
    expect(res.hasMore).toBe(false);
  });
});

describe("listOpenConsignments — ترقيم keyset", () => {
  it("limit صغير + eligible remittable ⇒ hasMore و nextCursor صحيحان", async () => {
    // صفوف مؤهَّلة (parcelStatus=DELIVERED + moneyStatus=UNSETTLED)
    await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
    await db().insert(s.users).values({ id: 1, openId: "u", name: "u", role: "admin", loginMethod: "local", branchId: 1 });
    await db().insert(s.deliveryParties).values({ id: 1, name: "شركة", partyKind: "COMPANY", branchId: 1 });
    for (let i = 1; i <= 5; i++) {
      await db().insert(s.invoices).values({
        id: i, invoiceNumber: `INV-${i}`, branchId: 1,
        subtotal: "500.00", total: "500.00", paidAmount: "0.00", returnedTotal: "0.00", createdBy: 1,
      });
      await db().insert(s.deliveryConsignments).values({
        id: i,
        consignmentNumber: `CN-${i}`,
        partyId: 1,
        branchId: 1,
        invoiceId: i,
        sourceType: "INVOICE",
        sourceId: i,
        status: "DISPATCHED",
        parcelStatus: "DELIVERED",
        moneyStatus: "UNSETTLED",
        codAmount: "500.00",
        collectedAmount: "0.00",
        counterSettledAmount: "0.00",
        deliveryFee: "0.00",
        feeCollection: "COURIER",
        dispatchedAt: new Date(2026, 0, i),
        dispatchedBy: 1,
      });
    }
    const page = await listOpenConsignments(1, 1, { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe("listConsignmentsForParty — ترقيم keyset", () => {
  it("openOnly=false يُعيد كل الصفوف مُرقَّمةً", async () => {
    await seed(4);
    const page1 = await listConsignmentsForParty(1, false, { limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await listConsignmentsForParty(1, false, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.rows).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
  });
});

describe("getDeliveryPartyFinancials — كل قسمٍ مُرقَّمٌ مستقلاً", () => {
  it("ledger/allocations/events تُعيد {rows,hasMore,nextCursor} — قصفُ الـ٣٠٠ الصامت أُزيل", async () => {
    await seed(2);
    // نُضيف ٥ قيود دفتر
    for (let i = 1; i <= 5; i++) {
      await db().insert(s.deliveryLedgerEntries).values({
        id: i, partyId: 1, consignmentId: 1, branchId: 1,
        entryType: "FEE_EARNED", amount: "100.00", occurredAt: new Date(2026, 0, i),
        eventKey: `k-${i}`, createdBy: 1,
      });
    }
    const res = await getDeliveryPartyFinancials(1, { ledger: { limit: 2 } });
    expect(res).not.toBeNull();
    expect(res!.ledger.rows).toHaveLength(2);
    expect(res!.ledger.hasMore).toBe(true);
    expect(res!.ledger.nextCursor).not.toBeNull();
    // allocations/events فارغة في هذا الـfixture ⇒ hasMore=false
    expect(res!.allocations.hasMore).toBe(false);
    expect(res!.events.hasMore).toBe(false);
  });
});
