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
  createDeliveryParty,
  getDeliveryParty,
  listDeliveryParties,
  setDeliveryPartyActive,
  updateDeliveryParty,
} from "../deliveryService";
import { reconcileDeliveryFloat } from "../reconcileService";

const TABLES = ["accountingEntries", "deliveryConsignments", "deliveryRemittances", "deliveryParties", "branches", "users"];

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
  await d.insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
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
});
