/**
 * اختبارات تكامل (DB) لخدمة الأصول — تغطّي التدفّقات الذرّية: الإنشاء بعهدة، تسليم العهدة،
 * والاستبعاد + سجلّ الاستبعاد. يتضمّن اختبار انحدار لإصلاح «القيمة الدفترية عند الاستبعاد المبكر».
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { addMaintenance, createAsset, disposalLog, disposeAsset, getAsset, handoverCustody, updateAsset } from "../assetsService";
import { computeDepreciation } from "../assets/depreciation";

const ACTOR = { userId: 1, branchId: 1, role: "admin" as const };
// FI-01: createAsset يأخذ Actor الآن (لترحيل قيد الاقتناء) — مُغلِّف يُمرّره عن كل الاختبارات القائمة.
const mkAsset = (input: Parameters<typeof createAsset>[0]) => createAsset(input, ACTOR);

const TABLES = [
  "accountingEntries",
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
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد الأصول" }); // FI-01: اقتناء على ذمّة المورّد
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("assetsService — createAsset (DB)", () => {
  it("ينشئ أصلاً برمز AST ويفتح عهدة جارية واحدة عند تسليمه لموظف", async () => {
    const a = await mkAsset({
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
    const a = await mkAsset({ name: "لابتوب", category: "computers", purchaseDate: "2023-01-01", purchaseValue: "1000000", usefulLifeYears: 5, custodianId: 1 });
    const after = await handoverCustody(a!.id, 2, "نقل");
    expect(after!.custodianId).toBe(2);
    const open = after!.custody.filter((c) => c.toDate === null);
    expect(open).toHaveLength(1);
    expect(open[0].employeeId).toBe(2);
    expect(after!.custody.filter((c) => c.toDate !== null).length).toBeGreaterThanOrEqual(1);
  });

  it("يرفض التسليم لنفس صاحب العهدة الحالي (لا سجلّ عهدة صفري)", async () => {
    const a = await mkAsset({ name: "لابتوب", category: "computers", purchaseDate: "2023-01-01", purchaseValue: "1000000", usefulLifeYears: 5, custodianId: 1 });
    await expect(handoverCustody(a!.id, 1)).rejects.toThrow();
  });
});

describe("assetsService — dispose + disposalLog (DB, انحدار)", () => {
  it("الاستبعاد المبكر يحسب الربح/الخسارة مقابل القيمة الدفترية الحقيقية لا التخريدية", async () => {
    // أصل عمره ~سنة عند الاستبعاد: NBV ≈ 820,000 (لا 100,000 التخريدية) ⇒ بيعه بـ700,000 خسارة لا ربح وهمي.
    const a = await mkAsset({
      name: "جهاز", category: "computers", purchaseDate: "2023-01-01",
      purchaseValue: "1000000", salvageValue: "100000", usefulLifeYears: 5,
      depreciationMethod: "sl", custodianId: 1,
    });
    await disposeAsset(a!.id, { kind: "disposed", date: "2024-01-01", reason: "بيع", value: "700000" }, ACTOR);

    const row = (await disposalLog()).find((r) => r.id === a!.id);
    expect(row).toBeTruthy();
    expect(row!.bookValue).toBeGreaterThan(700000); // ليست التخريدية 100,000
    expect(row!.proceeds).toBe(700000);
    // FIN-14: gain صار نصاً (Decimal.toString) منعاً لخطأ float ⇒ نلفّه بـNumber للمقارنة العددية.
    expect(Number(row!.gain!)).toBeLessThan(0); // خسارة حقيقية، لا الربح الوهمي +600,000 قبل الإصلاح

    const fresh = await getAsset(a!.id);
    expect(fresh!.status).toBe("disposed");
    expect(fresh!.custodianId).toBeNull();
    expect(fresh!.custody.filter((c) => c.toDate === null)).toHaveLength(0); // العهدة أُغلقت
  });

  it("FA-02: التصرّف يُرحّل النقد (PAYMENT_IN + إيصال) وقيد الربح/الخسارة للدفتر (لا يُهمَلان)", async () => {
    const a = await mkAsset({
      name: "جهاز", category: "computers", purchaseDate: "2023-01-01",
      purchaseValue: "1000000", salvageValue: "100000", usefulLifeYears: 5, depreciationMethod: "sl",
    });
    await disposeAsset(a!.id, { kind: "disposed", date: "2024-01-01", reason: "بيع", value: "700000" }, ACTOR);

    // (أ) النقد المتحصّل مُرحَّل: قيد PAYMENT_IN + إيصال IN ⇒ النقد لم يَعُد غير مرئيّ.
    const [cash] = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_IN"), eq(s.accountingEntries.dedupeKey, `ASSET_DISP:${a!.id}`)));
    expect(cash).toBeTruthy();
    expect(Number(cash.amount)).toBe(700000);
    const [rcpt] = await db().select().from(s.receipts).where(eq(s.receipts.direction, "IN"));
    expect(rcpt).toBeTruthy();
    expect(Number(rcpt.amount)).toBe(700000);

    // (ب) الربح/الخسارة مُرحَّل: 700,000 − NBV(~820,000) = خسارة ~(−120,000).
    const [pl] = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `ASSET_DISP_PL:${a!.id}`));
    expect(pl).toBeTruthy();
    expect(Number(pl.profit)).toBeLessThan(0);
  });
});

describe("assetsService — updateAsset (DB)", () => {
  it("يحفظ التعديلات على الحقول القابلة للتعديل (دون لمس العهدة)", async () => {
    const a = await mkAsset({
      name: "لابتوب", category: "computers", purchaseDate: "2023-01-01",
      purchaseValue: "1000000", salvageValue: "100000", usefulLifeYears: 5,
      depreciationMethod: "sl", custodianId: 1, branchId: 1,
    });
    const up = await updateAsset(a!.id, {
      name: "لابتوب مُحدَّث", category: "display", brand: "Dell", serial: "SN-9",
      branchId: 2, location: "مكتب جديد", purchaseDate: "2023-02-01",
      purchaseValue: "1200000", salvageValue: "150000", usefulLifeYears: 6,
      depreciationMethod: "db", condition: "جيد", warrantyEnd: "2026-02-01",
    });
    expect(up!.name).toBe("لابتوب مُحدَّث");
    expect(up!.category).toBe("display");
    expect(Number(up!.purchaseValue)).toBe(1200000);
    expect(Number(up!.salvageValue)).toBe(150000);
    expect(up!.usefulLifeYears).toBe(6);
    expect(up!.depreciationMethod).toBe("db");
    expect(up!.branchId).toBe(2);
    expect(up!.custodianId).toBe(1); // العهدة لها مسارها (handover) ولا تتغيّر بالتعديل
  });

  it("ASSET-REVAL: تعديل قيمة أصلٍ على ذمّة مورّد يُصحّح رصيد المورد بالفرق (قيد تعويضي)", async () => {
    const a = await mkAsset({
      name: "طابعة", category: "computers", purchaseDate: "2023-01-01",
      purchaseValue: "1000000", salvageValue: "0", usefulLifeYears: 5,
      depreciationMethod: "sl", branchId: 1, supplierId: 1,
    });
    // الاقتناء الآجل رفع ذمّة المورد (AP) إلى 1,000,000.
    let sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(Number(sup.currentBalance)).toBe(1000000);
    // تعديل القيمة إلى 1,200,000 ⇒ قيدٌ تعويضيّ يجعل AP = 1,200,000 (فرق +200,000).
    await updateAsset(
      a!.id,
      {
        name: "طابعة", category: "computers", purchaseDate: "2023-01-01",
        purchaseValue: "1200000", salvageValue: "0", usefulLifeYears: 5,
        depreciationMethod: "sl", branchId: 1, supplierId: 1,
      },
      ACTOR,
    );
    sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(Number(sup.currentBalance)).toBe(1200000);
    // القيمة المُرسمَلة الجديدة تُغذّي الإهلاك.
    expect(Number((await getAsset(a!.id))!.purchaseValue)).toBe(1200000);
  });

  it("يرفض تعديل أصل مُستبعَد", async () => {
    const a = await mkAsset({ name: "قديم", category: "computers", purchaseDate: "2020-01-01", purchaseValue: "500000", salvageValue: "50000", usefulLifeYears: 4, depreciationMethod: "sl" });
    await disposeAsset(a!.id, { kind: "disposed", date: "2024-01-01", reason: "خردة", value: "0" }, ACTOR);
    await expect(
      updateAsset(a!.id, { name: "محاولة", category: "computers", purchaseDate: "2020-01-01", purchaseValue: "500000", usefulLifeYears: 4 }),
    ).rejects.toThrow();
  });
});

describe("assetsService — FI-01 اقتناء يُرحَّل للدفتر (DB)", () => {
  it("شراء بمورّد ⇒ قيد PURCHASE + زيادة ذمم المورّد (لا تُنفَخ حقوق الملكية)", async () => {
    const a = await mkAsset({ name: "طابعة", category: "computers", purchaseDate: "2024-03-01", purchaseValue: "600000", usefulLifeYears: 5, supplierId: 1 });
    const [acq] = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PURCHASE"), eq(s.accountingEntries.dedupeKey, `ASSET_ACQ:${a!.id}`)));
    expect(acq).toBeTruthy();
    expect(Number(acq.amount)).toBe(600000);
    expect(Number(acq.supplierId)).toBe(1);
    const [sup] = await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1));
    expect(Number(sup.currentBalance)).toBe(600000); // AP زادت بقيمة الأصل
  });

  it("شراء بلا مورّد ⇒ نقد PAYMENT_OUT + إيصال OUT (الأصل مُقابَل بنقد)", async () => {
    const a = await mkAsset({ name: "كرسي", category: "computers", purchaseDate: "2024-03-01", purchaseValue: "150000", usefulLifeYears: 5 });
    const [acq] = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.dedupeKey, `ASSET_ACQ:${a!.id}`)));
    expect(acq).toBeTruthy();
    expect(Number(acq.amount)).toBe(150000);
    const [r] = await db().select().from(s.receipts).where(eq(s.receipts.direction, "OUT"));
    expect(Number(r.amount)).toBe(150000);
  });
});

describe("updateAsset — تصحيح الإهلاك المتراكم (DEPR-REVAL، تدقيق ١٧/٧)", () => {
  const PARAMS = {
    name: "آلة طباعة", category: "computers", purchaseDate: "2024-01-01",
    salvageValue: "0", usefulLifeYears: 5, depreciationMethod: "sl" as const, branchId: 1,
  };

  it("خفض القيمة دون المتراكم ⇒ يُصحَّح المتراكم للقيمة التحليلية (NBV غير سالب) + قيد ADJUST تعويضيّ", async () => {
    const asset = await mkAsset({ ...PARAMS, purchaseValue: "1200000" });
    // نُثبّت متراكماً مُرحَّلاً كبيراً (٨٠٠ألف) كأن الكنسة الشهريّة رحّلته على القيمة القديمة.
    await db().update(s.fixedAssets).set({ accumulatedDepreciation: "800000.00" }).where(eq(s.fixedAssets.id, asset!.id));

    // نخفض القيمة إلى ٣٠٠ألف (المتراكم ٨٠٠ألف يتجاوز الأساس ⇒ كان NBV = −٥٠٠ألف عالقاً للأبد).
    await updateAsset(asset!.id, { ...PARAMS, purchaseValue: "300000" }, ACTOR);

    const [a2] = await db().select().from(s.fixedAssets).where(eq(s.fixedAssets.id, asset!.id));
    const expected = computeDepreciation(
      { purchaseValue: "300000", salvageValue: "0", usefulLifeYears: 5, depreciationMethod: "sl", purchaseDate: PARAMS.purchaseDate, status: "active" },
      new Date(),
    ).accumulated;
    expect(Number(a2.accumulatedDepreciation)).toBe(expected);
    expect(expected).toBeLessThanOrEqual(300000); // مقصور على الأساس — لا إهلاك زائد
    expect(Number(a2.purchaseValue) - Number(a2.accumulatedDepreciation)).toBeGreaterThanOrEqual(0); // NBV غير سالب

    // قيد ADJUST تعويضيّ بالفرق (expected − ٨٠٠ألف، سالب = عكس الإهلاك الزائد).
    const adj = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "ADJUST"), sql`${s.accountingEntries.dedupeKey} LIKE ${`DEPR_ADJ:${asset!.id}:%`}`));
    expect(adj).toHaveLength(1);
    expect(Number(adj[0].cost)).toBe(expected - 800000);
    expect(Number(adj[0].amount)).toBe(expected - 800000);
  });

  it("تعديلٌ لا يمسّ بارامترات الإهلاك (الاسم فقط) ⇒ لا تصحيح ولا قيد", async () => {
    const asset = await mkAsset({ ...PARAMS, purchaseValue: "1200000" });
    await db().update(s.fixedAssets).set({ accumulatedDepreciation: "480000.00" }).where(eq(s.fixedAssets.id, asset!.id));
    await updateAsset(asset!.id, { ...PARAMS, name: "آلة طباعة (محدّثة)", purchaseValue: "1200000" }, ACTOR);
    const [a2] = await db().select().from(s.fixedAssets).where(eq(s.fixedAssets.id, asset!.id));
    expect(Number(a2.accumulatedDepreciation)).toBe(480000); // بلا تغيير
    const adj = await db()
      .select()
      .from(s.accountingEntries)
      .where(sql`${s.accountingEntries.dedupeKey} LIKE ${`DEPR_ADJ:${asset!.id}:%`}`);
    expect(adj).toHaveLength(0);
  });
});

describe("addMaintenance — ترحيل تكلفة الصيانة للدفتر والخزينة (تدقيق ١٧/٧)", () => {
  const A = { name: "مكيّف", category: "computers", purchaseDate: "2025-01-01", purchaseValue: "500000", usefulLifeYears: 5, branchId: 1 };

  it("صيانة بتكلفة ⇒ إيصال TREASURY/OUT + قيد PAYMENT_OUT (ASSET_MAINT) + حالة maintenance", async () => {
    const asset = await mkAsset(A);
    await addMaintenance(asset!.id, { type: "تنظيف", vendor: "ورشة", cost: "50000", maintDate: "2026-07-10" }, ACTOR);

    const [a2] = await db().select().from(s.fixedAssets).where(eq(s.fixedAssets.id, asset!.id));
    expect(a2.status).toBe("maintenance");

    const [ent] = await db()
      .select()
      .from(s.accountingEntries)
      .where(sql`${s.accountingEntries.dedupeKey} LIKE ${`ASSET_MAINT:%`}`);
    expect(ent).toBeTruthy();
    expect(ent.entryType).toBe("PAYMENT_OUT");
    expect(Number(ent.amount)).toBe(50000);

    const [rc] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(ent.receiptId)));
    expect(rc.direction).toBe("OUT");
    expect(rc.cashBucket).toBe("TREASURY");
    expect(Number(rc.amount)).toBe(50000);
  });

  it("صيانة بتكلفة صفر (كفالة) ⇒ لا إيصال ولا قيد، لكن صفّ الصيانة يُدرَج", async () => {
    const asset = await mkAsset(A);
    await addMaintenance(asset!.id, { type: "فحص كفالة", cost: "0" }, ACTOR);
    const maintEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(sql`${s.accountingEntries.dedupeKey} LIKE ${`ASSET_MAINT:%`}`);
    expect(maintEntries).toHaveLength(0);
    const maint = await db().select().from(s.assetMaintenance).where(eq(s.assetMaintenance.assetId, asset!.id));
    expect(maint).toHaveLength(1);
  });
});
