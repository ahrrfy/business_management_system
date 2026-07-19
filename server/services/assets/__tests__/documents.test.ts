/**
 * اختبارات مستندات الأصل (addAssetDocument / deleteAssetDocument) — رفع/حذف صورة data-URL،
 * ظهورها في getAsset().docs، وحرّاس عدم الوجود. لا مال (تخزين مستند بحت).
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../../drizzle/schema";
import { getDb } from "../../../db";
import { addAssetDocument, createAsset, deleteAssetDocument, getAsset } from "../../assetsService";

const ACTOR = { userId: 1, branchId: 1, role: "admin" as const };
const TABLES = [
  "accountingEntries", "assetMaintenance", "assetCustodyLog", "assetDocuments",
  "fixedAssets", "suppliers", "auditLogs", "branches", "users",
];
const TINY = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";

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
  await d.insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({ id: 1, openId: "t", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد" });
}

async function mkAsset() {
  return createAsset(
    { name: "لابتوب", category: "computers", purchaseDate: "2023-01-01", purchaseValue: "1000000", usefulLifeYears: 5, branchId: 1 },
    ACTOR,
  );
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("assets documents — رفع/حذف", () => {
  it("رفع مستند يظهر في getAsset().docs بعنوانه وصورته", async () => {
    const a = await mkAsset();
    const doc = await addAssetDocument(a!.id, { title: "فاتورة الشراء", dataUrl: TINY });
    expect(doc.id).toBeGreaterThan(0);
    const got = await getAsset(a!.id);
    expect(got!.docs).toHaveLength(1);
    expect(got!.docs[0].title).toBe("فاتورة الشراء");
    expect(got!.docs[0].dataUrl).toBe(TINY);
  });

  it("حذف مستند يزيله من الأصل", async () => {
    const a = await mkAsset();
    const doc = await addAssetDocument(a!.id, { title: "كفالة", dataUrl: TINY });
    const res = await deleteAssetDocument(doc.id);
    expect(res.ok).toBe(true);
    expect(res.assetId).toBe(a!.id);
    expect((await getAsset(a!.id))!.docs).toHaveLength(0);
  });

  it("رفع لأصلٍ غير موجود ⇒ NOT_FOUND", async () => {
    await expect(addAssetDocument(999999, { title: "x", dataUrl: TINY })).rejects.toThrow(/غير موجود/);
  });

  it("حذف مستندٍ غير موجود ⇒ NOT_FOUND", async () => {
    await expect(deleteAssetDocument(999999)).rejects.toThrow(/غير موجود/);
  });

  it("العنوان يُقلَّم فراغُه", async () => {
    const a = await mkAsset();
    const doc = await addAssetDocument(a!.id, { title: "  فاتورة  ", dataUrl: TINY });
    expect(doc.title).toBe("فاتورة");
  });
});
