/**
 * اختبارات Slice 1 — كيان جهة التوصيل + نظافة مطابقة العهدة:
 *  1) CRUD: إنشاء/تعديل/قائمة جهة + الأجرة الافتراضية.
 *  2) حظر تعطيل جهة عليها عهدة قائمة.
 *  3) reconcileDeliveryFloat() == [] على أساس نظيف (لا قيود/أرصدة).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  addDeliveryPartyMember,
  createDeliveryParty,
  getDeliveryParty,
  listCourierAccounts,
  listDeliveryParties,
  removeDeliveryPartyMember,
  setDeliveryPartyActive,
  updateDeliveryParty,
} from "../deliveryService";
import { reconcileDeliveryFloat } from "../reconcileService";

const TABLES = ["accountingEntries", "deliveryConsignments", "deliveryRemittances", "deliveryPartyMembers", "invoices", "deliveryParties", "branches", "users"];

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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الفرع الثاني", code: "B2", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "courier_active", name: "مندوب نشط", email: "c@t.test", role: "courier", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "courier_disabled", name: "مندوب معطّل", email: "d@t.test", role: "courier", loginMethod: "local", branchId: 1, isActive: false },
    { id: 4, openId: "courier_branch_2", name: "مندوب الفرع الثاني", email: "b2@t.test", role: "courier", loginMethod: "local", branchId: 2 },
  ]);
}

describe("Slice 1 — delivery parties", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("CRUD جهة توصيل + الأجرة الافتراضية + القائمة", async () => {
    const { id } = await createDeliveryParty(
      { partyType: "INDIVIDUAL", name: "مندوب أحمد", phone: "+9647700000000", defaultFee: "2000", branchId: 1 },
      { userId: 1, branchId: 1 },
    );
    expect(id).toBeGreaterThan(0);
    const p = await getDeliveryParty(id);
    expect(p?.name).toBe("مندوب أحمد");
    expect(p?.defaultFee).toBe("2000.00");
    expect(p?.currentBalance).toBe("0.00");

    await updateDeliveryParty({ id, defaultFee: "2500", partyType: "COMPANY" }, { userId: 1, branchId: 1 });
    const p2 = await getDeliveryParty(id);
    expect(p2?.defaultFee).toBe("2500.00");
    expect(p2?.partyType).toBe("COMPANY");

    const list = await listDeliveryParties({ branchId: 1, activeOnly: true });
    expect(list.length).toBe(1);
    expect(list[0].openConsignments).toBe(0);
  });

  it("يحظر تعطيل جهة عليها عهدة قائمة، ويسمح بلا عهدة", async () => {
    const { id } = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "مندوب عهدة" }, { userId: 1, branchId: 1 });
    await db().update(s.deliveryParties).set({ currentBalance: "5000.00" }).where(eq(s.deliveryParties.id, id));
    await expect(setDeliveryPartyActive(id, false, { userId: 1, branchId: 1 })).rejects.toThrow();
    await db().update(s.deliveryParties).set({ currentBalance: "0.00" }).where(eq(s.deliveryParties.id, id));
    await expect(setDeliveryPartyActive(id, false, { userId: 1, branchId: 1 })).resolves.toBeTruthy();
  });

  it("reconcileDeliveryFloat فارغة على أساس نظيف", async () => {
    await createDeliveryParty({ partyType: "INDIVIDUAL", name: "مندوب بلا عهدة" }, { userId: 1, branchId: 1 });
    const issues = await reconcileDeliveryFloat();
    expect(issues).toEqual([]);
  });

  it("الجهة المشتركة تظهر مع جهات الفرع والحساب المعطّل لا يظهر ولا يُربط", async () => {
    const shared = await createDeliveryParty({ partyType: "COMPANY", name: "شركة مشتركة", branchId: null }, { userId: 1, branchId: 1 });
    const local = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "مندوب الفرع", branchId: 1 }, { userId: 1, branchId: 1 });
    const ids = (await listDeliveryParties({ branchId: 1, activeOnly: true })).map((p) => Number(p.id));
    expect(ids).toEqual(expect.arrayContaining([shared.id, local.id]));
    expect((await listCourierAccounts(1)).map((u) => u.id)).toEqual([2]);
    await expect(updateDeliveryParty({ id: local.id, userId: 3 }, { userId: 1, branchId: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(updateDeliveryParty({ id: local.id, userId: 4 }, { userId: 1, branchId: 1, role: "manager" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يمنع فك حساب الجهة أو نقله ما دامت لها إرسالية مفتوحة", async () => {
    const { id } = await createDeliveryParty({ partyType: "INDIVIDUAL", name: "مندوب مربوط", userId: 2, branchId: 1 }, { userId: 1, branchId: 1 });
    await db().insert(s.invoices).values({
      id: 1, invoiceNumber: "INV-OPEN", sourceType: "WORKORDER", branchId: 1,
      subtotal: "1000.00", total: "1000.00", createdBy: 1,
    });
    await db().insert(s.deliveryConsignments).values({
      consignmentNumber: "CN-OPEN", branchId: 1, partyId: id, invoiceId: 1,
      sourceType: "INVOICE", sourceId: 1,
      codAmount: "1000.00", status: "DISPATCHED", dispatchedBy: 1,
    });
    await expect(updateDeliveryParty({ id, userId: null }, { userId: 1, branchId: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("يعرض وصول البوابة للشركة عبر العضويات حتى بلا رابط الحساب القديم", async () => {
    const { id } = await createDeliveryParty(
      { partyType: "COMPANY", name: "شركة متعددة المستخدمين", branchId: 1 },
      { userId: 1, branchId: 1 },
    );
    await addDeliveryPartyMember(
      { partyId: id, userId: 2, memberRole: "MANAGER" },
      { userId: 1, branchId: 1 },
    );

    const party = (await listDeliveryParties({ branchId: 1, activeOnly: true }))
      .find((row) => Number(row.id) === id);
    expect(party?.userId).toBeNull();
    expect(party?.hasPortalAccess).toBe(true);
    expect(party?.drivers).toEqual([]);
  });

  it("يفصل رابط الحساب والعضوية معاً ثم يسمح بإعادة استخدام الحساب", async () => {
    const first = await createDeliveryParty(
      { partyType: "INDIVIDUAL", name: "الجهة الأولى", userId: 2, branchId: 1 },
      { userId: 1, branchId: 1 },
    );
    await updateDeliveryParty({ id: first.id, userId: null }, { userId: 1, branchId: 1 });

    const stale = await db().select({ id: s.deliveryPartyMembers.id })
      .from(s.deliveryPartyMembers)
      .where(eq(s.deliveryPartyMembers.userId, 2));
    expect(stale).toEqual([]);
    await expect(createDeliveryParty(
      { partyType: "INDIVIDUAL", name: "الجهة الثانية", userId: 2, branchId: 1 },
      { userId: 1, branchId: 1 },
    )).resolves.toMatchObject({ id: expect.any(Number) });
  });

  it("إزالة العضو الأساسي تفصل الرابط القديم ولا تترك وصولاً خفياً", async () => {
    const party = await createDeliveryParty(
      { partyType: "INDIVIDUAL", name: "مندوب قابل للفصل", userId: 2, branchId: 1 },
      { userId: 1, branchId: 1 },
    );
    await expect(removeDeliveryPartyMember({ partyId: party.id, userId: 2 }))
      .resolves.toEqual({ removed: true });
    expect((await getDeliveryParty(party.id))?.userId).toBeNull();
    expect(await db().select().from(s.deliveryPartyMembers).where(eq(s.deliveryPartyMembers.userId, 2))).toEqual([]);
  });
});
