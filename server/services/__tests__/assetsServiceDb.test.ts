/**
 * اختبارات تكامل (DB) لخدمة الأصول — تغطّي التدفّقات الذرّية: الإنشاء بعهدة، تسليم العهدة،
 * والاستبعاد + سجلّ الاستبعاد. يتضمّن اختبار انحدار لإصلاح «القيمة الدفترية عند الاستبعاد المبكر».
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { addMaintenance, createAsset, disposalLog, disposeAsset, getAsset, handoverCustody, updateAsset } from "../assetsService";
import { computeDepreciation } from "../assets/depreciation";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { approveVoucher } from "../voucherService";

const ACTOR = { userId: 1, branchId: 1, role: "admin" as const };
const OWNER = { userId: 2, branchId: 1, role: "manager" as const };
const ADMIN_SCOPE = { branchId: null } as const;
// FI-01: createAsset يأخذ Actor الآن (لترحيل قيد الاقتناء) — مُغلِّف يُمرّره عن كل الاختبارات القائمة.
const mkAsset = (input: Parameters<typeof createAsset>[0]) =>
  createAsset({ ...input, branchId: input.branchId ?? 1 }, ACTOR);

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "assetMaintenance",
  "assetCustodyLog",
  "assetDocuments",
  "fixedAssets",
  "attendance",
  "employees",
  "suppliers",
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
  await d.insert(s.users).values([
    { id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local", isOwner: false },
    { id: 2, openId: "asset_owner", name: "مالك الأصول", role: "manager", loginMethod: "local", branchId: 1, isOwner: true },
  ]);
  await d.insert(s.employees).values([
    { id: 1, firstName: "موظف", lastName: "أول", email: "e1@test.local", branchId: 1, isActive: true },
    { id: 2, firstName: "موظف", lastName: "ثانٍ", email: "e2@test.local", branchId: 1, isActive: true },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد الأصول" }); // FI-01: اقتناء على ذمّة المورّد
  await d.insert(s.receipts).values({
    branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "100000000.00",
    paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
    referenceNumber: "TEST-ASSET-TREASURY-FUND", createdBy: 1,
  });
}

async function approveRequest(referenceNumber: string) {
  const [request] = await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, referenceNumber));
  expect(request).toMatchObject({ status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null });
  return approveVoucher(Number(request.id), OWNER);
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
    const after = await handoverCustody(a!.id, 2, "نقل", ACTOR);
    expect(after!.custodianId).toBe(2);
    const open = after!.custody.filter((c) => c.toDate === null);
    expect(open).toHaveLength(1);
    expect(open[0].employeeId).toBe(2);
    expect(after!.custody.filter((c) => c.toDate !== null).length).toBeGreaterThanOrEqual(1);
  });

  it("يرفض التسليم لنفس صاحب العهدة الحالي (لا سجلّ عهدة صفري)", async () => {
    const a = await mkAsset({ name: "لابتوب", category: "computers", purchaseDate: "2023-01-01", purchaseValue: "1000000", usefulLifeYears: 5, custodianId: 1 });
    await expect(handoverCustody(a!.id, 1, undefined, ACTOR)).rejects.toThrow();
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

    const row = (await disposalLog(ADMIN_SCOPE)).find((r) => r.id === a!.id);
    expect(row).toBeTruthy();
    expect(row!.bookValue).toBeGreaterThan(700000); // ليست التخريدية 100,000
    expect(row!.proceeds).toBe(700000);
    // FIN-14: gain صار نصاً (Decimal.toString) منعاً لخطأ float ⇒ نلفّه بـNumber للمقارنة العددية.
    expect(Number(row!.gain!)).toBeLessThan(0); // خسارة حقيقية، لا الربح الوهمي +600,000 قبل الإصلاح

    const fresh = await getAsset(a!.id, ADMIN_SCOPE);
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
    const [rcpt] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(cash.receiptId)));
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
      branchId: 1, location: "مكتب جديد", purchaseDate: "2023-02-01",
      purchaseValue: "1200000", salvageValue: "150000", usefulLifeYears: 6,
      depreciationMethod: "db", condition: "جيد", warrantyEnd: "2026-02-01",
    }, ACTOR);
    expect(up!.name).toBe("لابتوب مُحدَّث");
    expect(up!.category).toBe("display");
    expect(Number(up!.purchaseValue)).toBe(1200000);
    expect(Number(up!.salvageValue)).toBe(150000);
    expect(up!.usefulLifeYears).toBe(6);
    expect(up!.depreciationMethod).toBe("db");
    expect(up!.branchId).toBe(1);
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
    expect(Number((await getAsset(a!.id, ADMIN_SCOPE))!.purchaseValue)).toBe(1200000);
  });

  it("supplier→cash: خزينة صفر تُثبت التعديل وتعلّق الدفع بلا عكس نقد/دفتر حتى اعتماد المالك", async () => {
    await db().delete(s.receipts).where(eq(s.receipts.referenceNumber, "TEST-ASSET-TREASURY-FUND"));
    const a = await mkAsset({
      name: "طابعة آجلة", category: "computers", purchaseDate: "2026-01-01",
      purchaseValue: "1000", salvageValue: "0", usefulLifeYears: 5,
      depreciationMethod: "sl", branchId: 1, supplierId: 1,
    });
    await updateAsset(a!.id, {
      name: "طابعة نقدية", category: "computers", purchaseDate: "2026-01-01",
      purchaseValue: "1000", salvageValue: "0", usefulLifeYears: 5,
      depreciationMethod: "sl", branchId: 1, supplierId: null,
    }, ACTOR);

    const changed = await getAsset(a!.id, ADMIN_SCOPE);
    expect(changed!.supplierId).toBeNull();
    expect(Number(changed!.purchaseValue)).toBe(1000);
    expect(Number((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance)).toBe(0);
    const requests = await db().select().from(s.receipts);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ direction: "OUT", status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(2); // PURCHASE + عكس PURCHASE؛ لا PAYMENT_OUT
    await expect(approveVoucher(Number(requests[0].id), OWNER)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await db().select().from(s.receipts).where(eq(s.receipts.id, Number(requests[0].id))))[0].approvalStatus).toBe("PENDING_APPROVAL");
  });

  it("cash→cash المتكرر: كل عكس يسبق الطلب الجديد وبرقم حتمي فريد بلا اصطدام idempotency", async () => {
    await db().delete(s.receipts).where(eq(s.receipts.referenceNumber, "TEST-ASSET-TREASURY-FUND"));
    await db().insert(s.receipts).values({
      branchId: 1, cashBucket: "TREASURY", direction: "IN", amount: "1000.00",
      paymentMethod: "CASH", status: "COMPLETED", approvalStatus: "APPROVED",
      referenceNumber: "TEST-ASSET-EXACT-FUND", createdBy: 1,
    });
    const a = await mkAsset({
      name: "آلة نقدية", category: "computers", purchaseDate: "2026-01-01",
      purchaseValue: "1000", salvageValue: "0", usefulLifeYears: 5,
      depreciationMethod: "sl", branchId: 1,
    });
    await approveRequest(`ASSET-ACQ-${a!.id}`);
    await updateAsset(a!.id, {
      name: "آلة نقدية مصححة", category: "computers", purchaseDate: "2026-01-01",
      purchaseValue: "800", salvageValue: "0", usefulLifeYears: 5,
      depreciationMethod: "sl", branchId: 1, supplierId: null,
    }, ACTOR);
    const [reacq] = await db().select().from(s.receipts).where(sql`${s.receipts.referenceNumber} LIKE ${`ASSET-REACQ-${a!.id}-%`}`);
    await approveVoucher(Number(reacq.id), OWNER);

    await updateAsset(a!.id, {
      name: "آلة نقدية مصححة ثانية", category: "computers", purchaseDate: "2026-01-01",
      purchaseValue: "600", salvageValue: "0", usefulLifeYears: 5,
      depreciationMethod: "sl", branchId: 1, supplierId: null,
    }, ACTOR);
    const reacqs = await db().select().from(s.receipts)
      .where(sql`${s.receipts.referenceNumber} LIKE ${`ASSET-REACQ-${a!.id}-%`}`)
      .orderBy(s.receipts.id);
    expect(reacqs.map((row) => row.referenceNumber)).toEqual([
      `ASSET-REACQ-${a!.id}-1`,
      `ASSET-REACQ-${a!.id}-2`,
    ]);
    await approveVoucher(Number(reacqs[1].id), OWNER);

    await db().transaction(async (tx) => {
      expect((await computeTreasuryCashBalance(tx, 1)).toFixed(2)).toBe("400.00");
    });
    const asset = await getAsset(a!.id, ADMIN_SCOPE);
    expect(Number(asset!.purchaseValue)).toBe(600);
    const rows = await db().select().from(s.receipts);
    expect(rows.filter((r) => r.direction === "IN" && Number(r.amount) === 1000)).toHaveLength(2);
    expect(rows.filter((r) => r.direction === "OUT" && Number(r.amount) === 1000)).toHaveLength(1);
    expect(rows.filter((r) => r.direction === "OUT" && Number(r.amount) === 800)).toHaveLength(1);
    expect(rows.filter((r) => r.direction === "IN" && Number(r.amount) === 800)).toHaveLength(1);
    expect(rows.filter((r) => r.direction === "OUT" && Number(r.amount) === 600)).toHaveLength(1);
  });

  it("يرفض تعديل أصل مُستبعَد", async () => {
    const a = await mkAsset({ name: "قديم", category: "computers", purchaseDate: "2020-01-01", purchaseValue: "500000", salvageValue: "50000", usefulLifeYears: 4, depreciationMethod: "sl" });
    await disposeAsset(a!.id, { kind: "disposed", date: "2024-01-01", reason: "خردة", value: "0" }, ACTOR);
    await expect(
      updateAsset(a!.id, { name: "محاولة", category: "computers", purchaseDate: "2020-01-01", purchaseValue: "500000", usefulLifeYears: 4 }, ACTOR),
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

  it("شراء بلا مورّد ⇒ طلب PAYMENT معلّق ثم اعتماد مالك آخر ينفذ TREASURY/OUT مرة واحدة", async () => {
    const a = await mkAsset({ name: "كرسي", category: "computers", purchaseDate: "2024-03-01", purchaseValue: "150000", usefulLifeYears: 5 });
    const [pending] = await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `ASSET-ACQ-${a!.id}`));
    expect(pending).toMatchObject({ direction: "OUT", status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null, shiftId: null });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    await approveVoucher(Number(pending.id), OWNER);
    const [acq] = await db().select().from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.receiptId, Number(pending.id))));
    expect(acq).toBeTruthy();
    expect(Number(acq.amount)).toBe(150000);
    const [r] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(pending.id)));
    expect(r).toMatchObject({ status: "COMPLETED", approvalStatus: "APPROVED", cashBucket: "TREASURY", shiftId: null });
    expect(Number(r.amount)).toBe(150000);
  });

  it("tamper للـpayload أو تغيّر قيمة الأصل بعد الطلب يفشل مغلقاً بلا نقد/قيد جزئي", async () => {
    const asset = await mkAsset({
      name: "مقص ورق",
      category: "computers",
      purchaseDate: "2024-03-01",
      purchaseValue: "125000",
      usefulLifeYears: 5,
    });
    const [request] = await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `ASSET-ACQ-${asset!.id}`));
    const originalPayload = request.internalNote;
    await db().update(s.receipts).set({ internalNote: "@SYSTEM_PAYMENT_REQUEST:{\"kind\":\"ASSET_ACQUISITION\"}" }).where(eq(s.receipts.id, Number(request.id)));
    await expect(approveVoucher(Number(request.id), OWNER)).rejects.toMatchObject({ code: "CONFLICT" });
    await db().update(s.receipts).set({ internalNote: originalPayload }).where(eq(s.receipts.id, Number(request.id)));
    await db().update(s.fixedAssets).set({ purchaseValue: "126000.00" }).where(eq(s.fixedAssets.id, asset!.id));
    await expect(approveVoucher(Number(request.id), OWNER)).rejects.toMatchObject({ code: "CONFLICT" });

    const [pending] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(request.id)));
    expect(pending).toMatchObject({ status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null, approvedBy: null });
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
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

  it("صيانة بتكلفة ⇒ حالة maintenance + طلب معلّق، ثم اعتماد المالك ينفذ TREASURY/OUT", async () => {
    const asset = await mkAsset(A);
    await addMaintenance(asset!.id, { type: "تنظيف", vendor: "ورشة", cost: "50000", maintDate: "2026-07-10" }, ACTOR);

    const [a2] = await db().select().from(s.fixedAssets).where(eq(s.fixedAssets.id, asset!.id));
    expect(a2.status).toBe("maintenance");

    const [maintenance] = await db().select().from(s.assetMaintenance).where(eq(s.assetMaintenance.assetId, asset!.id));
    const [pending] = await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `ASSET-MAINT-${maintenance.id}`));
    expect(pending).toMatchObject({ direction: "OUT", status: "PENDING", approvalStatus: "PENDING_APPROVAL", cashBucket: null });
    expect((await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.receiptId, Number(pending.id))))).toHaveLength(0);
    await approveVoucher(Number(pending.id), OWNER);
    const [ent] = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.receiptId, Number(pending.id)));
    expect(ent).toMatchObject({ entryType: "PAYMENT_OUT", amount: "50000.00" });
    const [rc] = await db().select().from(s.receipts).where(eq(s.receipts.id, Number(pending.id)));
    expect(rc).toMatchObject({ direction: "OUT", cashBucket: "TREASURY", status: "COMPLETED", approvalStatus: "APPROVED" });
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

describe("createAsset — حرّاس العهدة عند الإنشاء (تدقيق ١٧/٧)", () => {
  const A = { name: "طابعة", category: "computers", purchaseDate: "2025-01-01", purchaseValue: "100000", usefulLifeYears: 3, branchId: 1 };

  it("عهدة على موظف منتهي الخدمة ⇒ ترفض ولا يُنشأ الأصل (المعاملة تتراجع)", async () => {
    await db().update(s.employees).set({ employmentStatus: "terminated" }).where(eq(s.employees.id, 1));
    await expect(mkAsset({ ...A, custodianId: 1 })).rejects.toThrow(/على رأس العمل/);
    expect(await db().select().from(s.fixedAssets)).toHaveLength(0); // تراجعٌ كامل — لا أصل ولا قيد
  });

  it("عهدة على موظف من فرعٍ مختلف عن فرع الأصل ⇒ ترفض", async () => {
    await db().update(s.employees).set({ branchId: 2 }).where(eq(s.employees.id, 2)); // موظف ٢ في فرع ٢
    await expect(mkAsset({ ...A, branchId: 1, custodianId: 2 })).rejects.toThrow(/فرع مختلف/);
    expect(await db().select().from(s.fixedAssets)).toHaveLength(0);
  });

  it("عهدة على موظف نشطٍ في نفس الفرع ⇒ تُقبَل ويُفتَح سطر عهدة جارية", async () => {
    const asset = await mkAsset({ ...A, custodianId: 1 });
    expect(Number(asset!.custodianId)).toBe(1);
    const custody = await db()
      .select()
      .from(s.assetCustodyLog)
      .where(and(eq(s.assetCustodyLog.assetId, asset!.id), isNull(s.assetCustodyLog.toDate)));
    expect(custody).toHaveLength(1);
    expect(Number(custody[0].employeeId)).toBe(1);
  });
});
