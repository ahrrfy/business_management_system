/**
 * اختبارات تكامل (DB) لخدمة الأصول — تغطّي التدفّقات الذرّية: الإنشاء بعهدة، تسليم العهدة،
 * والاستبعاد + سجلّ الاستبعاد. يتضمّن اختبار انحدار لإصلاح «القيمة الدفترية عند الاستبعاد المبكر».
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createAsset, disposalLog, disposeAsset, getAsset, handoverCustody } from "../assetsService";

const TABLES = [
  "assetMaintenance",
  "assetCustodyLog",
  "assetDocuments",
  "fixedAssets",
  "attendance",
  "employees",
  "auditLogs",
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
  await d.insert(s.branches).values([
    { id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values({ id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.employees).values([
    { id: 1, firstName: "موظف", lastName: "أول", email: "e1@test.local", branchId: 1, isActive: true },
    { id: 2, firstName: "موظف", lastName: "ثانٍ", email: "e2@test.local", branchId: 1, isActive: true },
  ]);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("assetsService — createAsset (DB)", () => {
  it("ينشئ أصلاً برمز AST ويفتح عهدة جارية واحدة عند تسليمه لموظف", async () => {
    const a = await createAsset({
      name: "لابتوب", category: "computers", purchaseDate: "2023-01-01",
      purchaseValue: "1000000", salvageValue: "100000", usefulLifeYears: 5,
      depreciationMethod: "sl", custodianId: 1, branchId: 1,
    });
    expect(a).toBeTruthy();
    expect(a!.code).toMatch(/^AST-\d+$/);
    expect(a!.custodianId).toBe(1);
    const open = a!.custody.filter((c) => c.toDate === null);
    expect(open).toHaveLength(1);
    expect(open[0].employeeId).toBe(1);
  });
});

describe("assetsService — handoverCustody (DB)", () => {
  it("يُغلق العهدة القديمة ويفتح جديدة ويحدّث صاحب العهدة", async () => {
    const a = await createAsset({ name: "لابتوب", category: "computers", purchaseDate: "2023-01-01", purchaseValue: "1000000", usefulLifeYears: 5, custodianId: 1 });
    const after = await handoverCustody(a!.id, 2, "نقل");
    expect(after!.custodianId).toBe(2);
    const open = after!.custody.filter((c) => c.toDate === null);
    expect(open).toHaveLength(1);
    expect(open[0].employeeId).toBe(2);
    expect(after!.custody.filter((c) => c.toDate !== null).length).toBeGreaterThanOrEqual(1);
  });

  it("يرفض التسليم لنفس صاحب العهدة الحالي (لا سجلّ عهدة صفري)", async () => {
    const a = await createAsset({ name: "لابتوب", category: "computers", purchaseDate: "2023-01-01", purchaseValue: "1000000", usefulLifeYears: 5, custodianId: 1 });
    await expect(handoverCustody(a!.id, 1)).rejects.toThrow();
  });
});

describe("assetsService — dispose + disposalLog (DB, انحدار)", () => {
  it("الاستبعاد المبكر يحسب الربح/الخسارة مقابل القيمة الدفترية الحقيقية لا التخريدية", async () => {
    // أصل عمره ~سنة عند الاستبعاد: NBV ≈ 820,000 (لا 100,000 التخريدية) ⇒ بيعه بـ700,000 خسارة لا ربح وهمي.
    const a = await createAsset({
      name: "جهاز", category: "computers", purchaseDate: "2023-01-01",
      purchaseValue: "1000000", salvageValue: "100000", usefulLifeYears: 5,
      depreciationMethod: "sl", custodianId: 1,
    });
    await disposeAsset(a!.id, { kind: "disposed", date: "2024-01-01", reason: "بيع", value: "700000" });

    const row = (await disposalLog()).find((r) => r.id === a!.id);
    expect(row).toBeTruthy();
    expect(row!.bookValue).toBeGreaterThan(700000); // ليست التخريدية 100,000
    expect(row!.proceeds).toBe(700000);
    expect(row!.gain!).toBeLessThan(0); // خسارة حقيقية، لا الربح الوهمي +600,000 قبل الإصلاح

    const fresh = await getAsset(a!.id);
    expect(fresh!.status).toBe("disposed");
    expect(fresh!.custodianId).toBeNull();
    expect(fresh!.custody.filter((c) => c.toDate === null)).toHaveLength(0); // العهدة أُغلقت
  });
});
