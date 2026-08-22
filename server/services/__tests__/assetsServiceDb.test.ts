/**
 * اختبارات تكامل (DB) لخدمة الأصول — تغطّي التدفّقات الذرّية: الإنشاء بعهدة، تسليم العهدة،
 * والاستبعاد + سجلّ الاستبعاد. يتضمّن اختبار انحدار لإصلاح «القيمة الدفترية عند الاستبعاد المبكر».
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  addMaintenance as addMaintenanceRaw,
  createAsset,
  disposalLog,
  disposeAsset,
  getAsset,
  handoverCustody,
  postMonthlyDepreciation,
  updateAsset,
} from "../assetsService";
import { computeDepreciation } from "../assets/depreciation";
import { computeTreasuryCashBalance } from "../cash/cashAvailability";
import { approveVoucher, rejectVoucher } from "../voucherService";
import { resubmitRejectedExpensePayment } from "../voucher/approval";
import { cancelExpense } from "../expenseService";
import {
  approveAccrualCorrection,
  requestAccrualCorrection,
} from "../accounting/accrualCorrection";
import { requestSupplierAssetSettlement } from "../assets/supplierSettlement";

const ACTOR = { userId: 1, branchId: 1, role: "admin" as const };
const OWNER = {
  userId: 2,
  branchId: 1,
  role: "manager" as const,
  isOwner: true,
};
const ADMIN_SCOPE = { branchId: null } as const;
let assetRequestSequence = 0;
let maintenanceRequestSequence = 0;
// FI-01: createAsset يأخذ Actor الآن (لترحيل قيد الاقتناء) — مُغلِّف يُمرّره عن كل الاختبارات القائمة.
const mkPendingAsset = (input: Parameters<typeof createAsset>[0]) => {
  assetRequestSequence += 1;
  return createAsset(
    {
      ...input,
      branchId: input.branchId ?? 1,
      acquisitionBeneficiaryName:
        input.supplierId == null
          ? (input.acquisitionBeneficiaryName ?? "شركة تجهيز الأصول التجريبية")
          : input.acquisitionBeneficiaryName,
      acquisitionEvidenceReference:
        input.acquisitionEvidenceReference ||
        `ASSET-INVOICE-${assetRequestSequence}`,
      clientRequestId:
        input.clientRequestId || `asset-db-${assetRequestSequence}`,
    },
    input.supplierId == null ? ACTOR : OWNER,
  );
};
const addMaintenance = (
  assetId: number,
  input: Parameters<typeof addMaintenanceRaw>[1],
  actor: Parameters<typeof addMaintenanceRaw>[2],
) => {
  maintenanceRequestSequence += 1;
  const hasCost = String(input.cost ?? "0") !== "0";
  return addMaintenanceRaw(
    assetId,
    {
      ...input,
      vendor:
        hasCost && (!input.vendor || input.vendor.trim() === "ورشة")
          ? "شركة صيانة الرافدين"
          : input.vendor,
      evidenceReference: hasCost
        ? input.evidenceReference ||
          `MAINT-INVOICE-${maintenanceRequestSequence}`
        : input.evidenceReference,
      clientRequestId:
        input.clientRequestId || `asset-maint-db-${maintenanceRequestSequence}`,
    },
    actor,
  );
};
const mkAsset = async (input: Parameters<typeof createAsset>[0]) => {
  const asset = await mkPendingAsset(input);
  if (asset != null) {
    const [cashAcquisitionRequest] = await db()
      .select({ id: s.receipts.id })
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `ASSET-ACQ-${asset.id}`));
    if (cashAcquisitionRequest != null) {
      await approveVoucher(Number(cashAcquisitionRequest.id), OWNER);
    }
    return getAsset(asset.id, ADMIN_SCOPE);
  }
  return asset;
};

const TABLES = [
  "idempotencyKeys",
  "cashTransfers",
  "accrualCorrectionRequests",
  "accrualObligationEvents",
  "accrualObligations",
  "accountingEntries",
  "receipts",
  "expenses",
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
    {
      id: 1,
      openId: "local_test",
      name: "admin",
      role: "admin",
      loginMethod: "local",
      isOwner: false,
    },
    {
      id: 2,
      openId: "asset_owner",
      name: "مالك الأصول",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await d.insert(s.employees).values([
    {
      id: 1,
      firstName: "موظف",
      lastName: "أول",
      email: "e1@test.local",
      branchId: 1,
      isActive: true,
    },
    {
      id: 2,
      firstName: "موظف",
      lastName: "ثانٍ",
      email: "e2@test.local",
      branchId: 1,
      isActive: true,
    },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد الأصول" }); // FI-01: اقتناء على ذمّة المورّد
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "100000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: "TEST-ASSET-TREASURY-FUND",
    createdBy: 1,
  });
}

async function approveRequest(referenceNumber: string) {
  const [request] = await db()
    .select()
    .from(s.receipts)
    .where(eq(s.receipts.referenceNumber, referenceNumber));
  expect(request).toMatchObject({
    status: "PENDING",
    approvalStatus: "PENDING_APPROVAL",
    cashBucket: null,
  });
  return approveVoucher(Number(request.id), OWNER);
}

beforeEach(async () => {
  assetRequestSequence = 0;
  maintenanceRequestSequence = 0;
  await reset();
  await seedBase();
});

describe("assetsService — createAsset (DB)", () => {
  it("ينشئ أصلاً برمز AST ويفتح عهدة جارية واحدة عند تسليمه لموظف", async () => {
    const a = await mkAsset({
      name: "لابتوب",
      category: "computers",
      purchaseDate: "2023-01-01",
      purchaseValue: "1000000",
      salvageValue: "100000",
      usefulLifeYears: 5,
      depreciationMethod: "sl",
      custodianId: 1,
      branchId: 1,
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
    const a = await mkAsset({
      name: "لابتوب",
      category: "computers",
      purchaseDate: "2023-01-01",
      purchaseValue: "1000000",
      usefulLifeYears: 5,
      custodianId: 1,
    });
    const after = await handoverCustody(a!.id, 2, "نقل", ACTOR);
    expect(after!.custodianId).toBe(2);
    const open = after!.custody.filter((c) => c.toDate === null);
    expect(open).toHaveLength(1);
    expect(open[0].employeeId).toBe(2);
    expect(
      after!.custody.filter((c) => c.toDate !== null).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("يرفض التسليم لنفس صاحب العهدة الحالي (لا سجلّ عهدة صفري)", async () => {
    const a = await mkAsset({
      name: "لابتوب",
      category: "computers",
      purchaseDate: "2023-01-01",
      purchaseValue: "1000000",
      usefulLifeYears: 5,
      custodianId: 1,
    });
    await expect(handoverCustody(a!.id, 1, undefined, ACTOR)).rejects.toThrow();
  });
});

describe("assetsService — dispose + disposalLog (DB, انحدار)", () => {
  it("الاستبعاد المبكر يحسب الربح/الخسارة مقابل القيمة الدفترية الحقيقية لا التخريدية", async () => {
    // أصل عمره ~سنة عند الاستبعاد: NBV ≈ 820,000 (لا 100,000 التخريدية) ⇒ بيعه بـ700,000 خسارة لا ربح وهمي.
    const a = await mkAsset({
      name: "جهاز",
      category: "computers",
      purchaseDate: "2023-01-01",
      purchaseValue: "1000000",
      salvageValue: "100000",
      usefulLifeYears: 5,
      depreciationMethod: "sl",
      custodianId: 1,
    });
    await disposeAsset(
      a!.id,
      { kind: "disposed", date: "2024-01-01", reason: "بيع", value: "700000" },
      ACTOR,
    );

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
      name: "جهاز",
      category: "computers",
      purchaseDate: "2023-01-01",
      purchaseValue: "1000000",
      salvageValue: "100000",
      usefulLifeYears: 5,
      depreciationMethod: "sl",
    });
    await disposeAsset(
      a!.id,
      { kind: "disposed", date: "2024-01-01", reason: "بيع", value: "700000" },
      ACTOR,
    );

    // (أ) النقد المتحصّل مُرحَّل: قيد PAYMENT_IN + إيصال IN ⇒ النقد لم يَعُد غير مرئيّ.
    const [cash] = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.entryType, "PAYMENT_IN"),
          eq(s.accountingEntries.dedupeKey, `ASSET_DISP:${a!.id}`),
        ),
      );
    expect(cash).toBeTruthy();
    expect(Number(cash.amount)).toBe(700000);
    const [rcpt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(cash.receiptId)));
    expect(rcpt).toBeTruthy();
    expect(Number(rcpt.amount)).toBe(700000);

    // (ب) الربح/الخسارة مُرحَّل: 700,000 − NBV(~820,000) = خسارة ~(−120,000).
    const [pl] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `ASSET_DISP_PL:${a!.id}`));
    expect(pl).toBeTruthy();
    expect(Number(pl.profit)).toBeLessThan(0);
  });
});

describe("assetsService — updateAsset (DB)", () => {
  it("يحفظ التعديلات على الحقول القابلة للتعديل (دون لمس العهدة)", async () => {
    const a = await mkAsset({
      name: "لابتوب",
      category: "computers",
      purchaseDate: "2023-01-01",
      purchaseValue: "1000000",
      salvageValue: "100000",
      usefulLifeYears: 5,
      depreciationMethod: "sl",
      custodianId: 1,
      branchId: 1,
    });
    const updated = await updateAsset(
      a!.id,
      {
        name: "لابتوب مُحدَّث",
        category: "display",
        brand: "Dell",
        serial: "SN-9",
        branchId: 1,
        location: "مكتب جديد",
        purchaseDate: "2023-01-01",
        purchaseValue: "1000000",
        salvageValue: "150000",
        usefulLifeYears: 6,
        depreciationMethod: "db",
        condition: "جيد",
        warrantyEnd: "2026-02-01",
      },
      ACTOR,
    );
    expect(updated!.paymentPending).toBe(false);
    const up = await getAsset(a!.id, ADMIN_SCOPE);
    expect(up!.name).toBe("لابتوب مُحدَّث");
    expect(up!.category).toBe("display");
    expect(Number(up!.purchaseValue)).toBe(1000000);
    expect(Number(up!.salvageValue)).toBe(150000);
    expect(up!.usefulLifeYears).toBe(6);
    expect(up!.depreciationMethod).toBe("db");
    expect(up!.branchId).toBe(1);
    expect(up!.custodianId).toBe(1); // العهدة لها مسارها (handover) ولا تتغيّر بالتعديل
  });

  it("يرفض تعديل قيمة اقتناء أصلٍ على ذمّة مورّد ذرّياً بلا تغيير AP أو إيصال أو قيد", async () => {
    const a = await mkAsset({
      name: "طابعة",
      category: "computers",
      purchaseDate: "2023-01-01",
      purchaseValue: "1000000",
      salvageValue: "0",
      usefulLifeYears: 5,
      depreciationMethod: "sl",
      branchId: 1,
      supplierId: 1,
    });
    const sup = (
      await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1))
    )[0];
    expect(Number(sup.currentBalance)).toBe(1000000);
    const entriesBefore = await db().select().from(s.accountingEntries);
    const receiptsBefore = await db().select().from(s.receipts);
    await expect(
      updateAsset(
        a!.id,
        {
          name: "طابعة",
          category: "computers",
          purchaseDate: "2023-01-01",
          purchaseValue: "1200000",
          salvageValue: "0",
          usefulLifeYears: 5,
          depreciationMethod: "sl",
          branchId: 1,
          supplierId: 1,
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const unchangedSupplier = (
      await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1))
    )[0];
    expect(Number(unchangedSupplier.currentBalance)).toBe(1000000);
    expect(Number((await getAsset(a!.id, ADMIN_SCOPE))!.purchaseValue)).toBe(
      1000000,
    );
    expect(await db().select().from(s.accountingEntries)).toHaveLength(
      entriesBefore.length,
    );
    expect(await db().select().from(s.receipts)).toHaveLength(
      receiptsBefore.length,
    );
  });

  it("supplier→cash: يرفض تغيير التمويل من الشاشة العامة ولا ينشئ طلب دفع", async () => {
    await db()
      .delete(s.receipts)
      .where(eq(s.receipts.referenceNumber, "TEST-ASSET-TREASURY-FUND"));
    const a = await mkAsset({
      name: "طابعة آجلة",
      category: "computers",
      purchaseDate: "2026-01-01",
      purchaseValue: "1000",
      salvageValue: "0",
      usefulLifeYears: 5,
      depreciationMethod: "sl",
      branchId: 1,
      supplierId: 1,
    });
    const entriesBefore = await db().select().from(s.accountingEntries);
    await expect(
      updateAsset(
        a!.id,
        {
          name: "طابعة نقدية",
          category: "computers",
          purchaseDate: "2026-01-01",
          purchaseValue: "1000",
          salvageValue: "0",
          usefulLifeYears: 5,
          depreciationMethod: "sl",
          branchId: 1,
          supplierId: null,
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const changed = await getAsset(a!.id, ADMIN_SCOPE);
    expect(changed!.supplierId).toBe(1);
    expect(Number(changed!.purchaseValue)).toBe(1000);
    expect(
      Number(
        (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0]
          .currentBalance,
      ),
    ).toBe(1000);
    const requests = await db().select().from(s.receipts);
    expect(requests).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(
      entriesBefore.length,
    );
    expect(
      Number(
        (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0]
          .currentBalance,
      ),
    ).toBe(1000);
  });

  it("cash→cash: يرفض تغيير القيمة ولا يصطنع قبضاً أو عكساً نقدياً", async () => {
    const a = await mkAsset({
      name: "آلة نقدية",
      category: "computers",
      purchaseDate: "2026-01-01",
      purchaseValue: "1000",
      salvageValue: "0",
      usefulLifeYears: 5,
      depreciationMethod: "sl",
      branchId: 1,
    });
    const receiptsBefore = await db().select().from(s.receipts);
    const entriesBefore = await db().select().from(s.accountingEntries);
    const cashBefore = await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    );

    await expect(
      updateAsset(
        a!.id,
        {
          name: "آلة نقدية مصححة",
          category: "computers",
          purchaseDate: "2026-01-01",
          purchaseValue: "800",
          salvageValue: "0",
          usefulLifeYears: 5,
          depreciationMethod: "sl",
          branchId: 1,
          supplierId: null,
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(Number((await getAsset(a!.id, ADMIN_SCOPE))!.purchaseValue)).toBe(
      1000,
    );
    expect(await db().select().from(s.receipts)).toHaveLength(
      receiptsBefore.length,
    );
    expect(await db().select().from(s.accountingEntries)).toHaveLength(
      entriesBefore.length,
    );
    const cashAfter = await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    );
    expect(cashAfter).toBe(cashBefore);
    expect(
      (await db().select().from(s.receipts)).some((row) =>
        row.referenceNumber?.startsWith(`ASSET-REACQ-${a!.id}-`),
      ),
    ).toBe(false);
  });

  it("يرفض تعديل أصل مُستبعَد", async () => {
    const a = await mkAsset({
      name: "قديم",
      category: "computers",
      purchaseDate: "2020-01-01",
      purchaseValue: "500000",
      salvageValue: "50000",
      usefulLifeYears: 4,
      depreciationMethod: "sl",
    });
    await disposeAsset(
      a!.id,
      { kind: "disposed", date: "2024-01-01", reason: "خردة", value: "0" },
      ACTOR,
    );
    await expect(
      updateAsset(
        a!.id,
        {
          name: "محاولة",
          category: "computers",
          purchaseDate: "2020-01-01",
          purchaseValue: "500000",
          usefulLifeYears: 4,
        },
        ACTOR,
      ),
    ).rejects.toThrow();
  });

  it("تغيير فرع الاقتناء مرفوض بلا طلب إعادة اقتناء أو حركة بين الفروع", async () => {
    const asset = await mkAsset({
      name: "أصل عابر للفروع",
      category: "computers",
      purchaseDate: "2026-01-01",
      purchaseValue: "1000",
      usefulLifeYears: 5,
      branchId: 1,
    });
    const receiptsBefore = await db().select().from(s.receipts);
    const entriesBefore = await db().select().from(s.accountingEntries);
    await expect(
      updateAsset(
        asset!.id,
        {
          name: "أصل عابر للفروع",
          category: "computers",
          purchaseDate: "2026-01-01",
          purchaseValue: "1000",
          usefulLifeYears: 5,
          branchId: 2,
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const updated = await getAsset(asset!.id, ADMIN_SCOPE);
    expect(updated).toMatchObject({
      branchId: 1,
      purchaseValue: "1000.00",
      isActive: true,
    });
    expect(await db().select().from(s.receipts)).toHaveLength(
      receiptsBefore.length,
    );
    expect(await db().select().from(s.accountingEntries)).toHaveLength(
      entriesBefore.length,
    );
    expect(await db().select().from(s.cashTransfers)).toHaveLength(0);
  });
});

describe("assetsService — FI-01 اقتناء يُرحَّل للدفتر (DB)", () => {
  it("شراء بمورّد ⇒ قيد PURCHASE + زيادة ذمم المورّد (لا تُنفَخ حقوق الملكية)", async () => {
    const a = await mkAsset({
      name: "طابعة",
      category: "computers",
      purchaseDate: "2024-03-01",
      purchaseValue: "600000",
      usefulLifeYears: 5,
      supplierId: 1,
    });
    expect(a).toMatchObject({
      isActive: true,
      paymentPending: true,
      settlementStatus: "PAYABLE_UNSETTLED",
    });
    const [acq] = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.entryType, "PURCHASE"),
          eq(s.accountingEntries.dedupeKey, `ASSET_ACQ:${a!.id}`),
        ),
      );
    expect(acq).toBeTruthy();
    expect(Number(acq.amount)).toBe(600000);
    expect(Number(acq.supplierId)).toBe(1);
    const [sup] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    expect(Number(sup.currentBalance)).toBe(600000); // AP زادت بقيمة الأصل
  });

  it("أصل المورد يبقى PAYABLE_UNSETTLED حتى طلب مستقل واعتماد مالك آخر يصفر AP مرة واحدة", async () => {
    const asset = await mkAsset({
      name: "ماكينة قص",
      category: "computers",
      purchaseDate: "2026-08-01",
      purchaseValue: "650000",
      usefulLifeYears: 5,
      supplierId: 1,
    });
    expect(asset).toMatchObject({
      isActive: true,
      paymentPending: true,
      settlementStatus: "PAYABLE_UNSETTLED",
    });
    const requested = await requestSupplierAssetSettlement(
      { assetId: asset!.id, clientRequestId: "supplier-asset-settlement-1" },
      ACTOR,
    );
    const replayedRequest = await requestSupplierAssetSettlement(
      { assetId: asset!.id, clientRequestId: "supplier-asset-settlement-1" },
      ACTOR,
    );
    expect(requested).toMatchObject({
      replayed: false,
      status: "PAYMENT_PENDING",
    });
    expect(replayedRequest).toMatchObject({
      replayed: true,
      receiptId: requested.receiptId,
      obligationId: requested.obligationId,
    });
    expect(
      (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0]
        .currentBalance,
    ).toBe("650000.00");
    await approveVoucher(Number(requested.receiptId), OWNER);
    await approveVoucher(Number(requested.receiptId), OWNER);
    const [supplier] = await db()
      .select()
      .from(s.suppliers)
      .where(eq(s.suppliers.id, 1));
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.id, requested.obligationId));
    const [receipt] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(requested.receiptId)));
    const settlements = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.entryType, "PAYMENT_OUT"),
          eq(s.accountingEntries.receiptId, Number(requested.receiptId)),
        ),
      );
    expect(supplier.currentBalance).toBe("0.00");
    expect(obligation.status).toBe("PAID");
    expect(receipt).toMatchObject({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "SUPPLIER",
      partyId: 1,
      cashBucket: "TREASURY",
    });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      supplierId: 1,
      amount: "650000.00",
    });
  });

  it("شراء بلا مورّد ⇒ أصل نشط وقيد استحقاق فوراً، ثم اعتماد مالك آخر يسوّي TREASURY/OUT مرة واحدة", async () => {
    const a = await mkPendingAsset({
      name: "كرسي",
      category: "computers",
      purchaseDate: "2024-03-01",
      purchaseValue: "150000",
      usefulLifeYears: 5,
    });
    expect(a!.paymentPending).toBe(true);
    expect(a!.isActive).toBe(true);
    const [pending] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `ASSET-ACQ-${a!.id}`));
    expect(pending).toMatchObject({
      direction: "OUT",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
      shiftId: null,
    });
    const [recognition] = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `ASSET_ACCRUAL:${a!.id}`));
    expect(recognition).toMatchObject({
      entryType: "ADJUST",
      amount: "150000.00",
      receiptId: null,
    });
    const approved = await approveVoucher(Number(pending.id), OWNER);
    const replayed = await approveVoucher(Number(pending.id), OWNER);
    expect(approved.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    const [acq] = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.entryType, "PAYMENT_OUT"),
          eq(s.accountingEntries.receiptId, Number(pending.id)),
        ),
      );
    expect(acq).toBeTruthy();
    expect(Number(acq.amount)).toBe(150000);
    expect(acq.dedupeKey).toBe(`ASSET_ACQ:${a!.id}`);
    const [r] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(pending.id)));
    expect(r).toMatchObject({
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      cashBucket: "TREASURY",
      shiftId: null,
    });
    expect(Number(r.amount)).toBe(150000);
    expect((await getAsset(a!.id, ADMIN_SCOPE))!.isActive).toBe(true);
  });

  it("tamper للـpayload أو تغيّر قيمة الأصل بعد الطلب يفشل مغلقاً بلا نقد/قيد جزئي", async () => {
    const asset = await mkPendingAsset({
      name: "مقص ورق",
      category: "computers",
      purchaseDate: "2024-03-01",
      purchaseValue: "125000",
      usefulLifeYears: 5,
    });
    const [request] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `ASSET-ACQ-${asset!.id}`));
    const originalPayload = request.internalNote;
    await db()
      .update(s.receipts)
      .set({
        internalNote: '@SYSTEM_PAYMENT_REQUEST:{"kind":"ASSET_ACQUISITION"}',
      })
      .where(eq(s.receipts.id, Number(request.id)));
    await expect(
      approveVoucher(Number(request.id), OWNER),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db()
      .update(s.receipts)
      .set({ internalNote: originalPayload })
      .where(eq(s.receipts.id, Number(request.id)));
    await db()
      .update(s.fixedAssets)
      .set({ purchaseValue: "126000.00" })
      .where(eq(s.fixedAssets.id, asset!.id));
    await expect(
      approveVoucher(Number(request.id), OWNER),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const [pending] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(request.id)));
    expect(pending).toMatchObject({
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
      approvedBy: null,
    });
    const entries = await db().select().from(s.accountingEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "ADJUST",
      dedupeKey: `ASSET_ACCRUAL:${asset!.id}`,
      amount: "125000.00",
      receiptId: null,
    });
    expect(
      entries.filter((entry) => entry.entryType === "PAYMENT_OUT"),
    ).toHaveLength(0);
  });

  it("الأصل المثبت يعمل ويُهلك رغم بقاء تسوية اقتنائه معلّقة", async () => {
    const pending = await mkPendingAsset({
      name: "أصل غير مدفوع",
      category: "computers",
      purchaseDate: "2026-08-01",
      purchaseValue: "250000",
      usefulLifeYears: 5,
      branchId: 1,
    });
    expect(pending).toMatchObject({
      paymentPending: true,
      isActive: true,
      status: "active",
    });

    await handoverCustody(pending!.id, 1, "عهدة تشغيلية", ACTOR);
    await addMaintenance(pending!.id, { type: "فحص كفالة", cost: "0" }, ACTOR);
    expect((await postMonthlyDepreciation(2026, 8, ACTOR)).assetsPosted).toBe(
      1,
    );

    const [row] = await db()
      .select()
      .from(s.fixedAssets)
      .where(eq(s.fixedAssets.id, pending!.id));
    expect(row).toMatchObject({
      isActive: true,
      status: "maintenance",
      disposalValue: null,
    });
    expect(await db().select().from(s.assetCustodyLog)).toHaveLength(1);
    expect(await db().select().from(s.assetMaintenance)).toHaveLength(1);
    expect(Number(row.accumulatedDepreciation)).toBeGreaterThan(0);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.entryType, "PAYMENT_IN")),
    ).toHaveLength(0);
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.direction, "IN")),
    ).toHaveLength(1); // تمويل الاختبار فقط
  });

  it("تصحيح اقتناء نقدي مدفوع ينتظر استرداد مزود فعلي ثم يعكس التسوية والاعتراف مرة واحدة", async () => {
    const asset = await mkPendingAsset({
      name: "آلة تغليف للتصحيح",
      category: "computers",
      purchaseDate: "2026-08-01",
      purchaseValue: "175000",
      usefulLifeYears: 5,
    });
    const [paymentRequest] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `ASSET-ACQ-${asset!.id}`));
    await approveVoucher(Number(paymentRequest.id), OWNER);
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.assetId, asset!.id));
    expect(obligation.status).toBe("PAID");

    const correctionInput = {
      obligationId: Number(obligation.id),
      expectedAssetId: asset!.id,
      reason: "إلغاء فاتورة الاقتناء بموجب إشعار دائن",
      externalEvidenceReference: "CREDIT-NOTE-ASSET-17",
      attachmentUrl: "data:image/png;base64,QUJD",
      refundPaymentMethod: "CASH" as const,
      refundCashBucket: "TREASURY" as const,
      refundReferenceNumber: null,
      refundCardLastFour: null,
      clientRequestId: "asset-paid-correction-17",
    };
    const requested = await requestAccrualCorrection(correctionInput, ACTOR);
    expect(requested.refundRequestReceiptId).not.toBeNull();
    expect(
      (await requestAccrualCorrection(correctionInput, ACTOR)).replayed,
    ).toBe(true);
    await expect(
      requestAccrualCorrection(
        {
          ...correctionInput,
          externalEvidenceReference: "TAMPERED-CREDIT-NOTE",
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const refundReceiptId = Number(requested.refundRequestReceiptId);
    const [pendingRefund] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, refundReceiptId));
    expect(pendingRefund).toMatchObject({
      direction: "IN",
      paymentMethod: "CASH",
      cardLastFour: null,
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
    });
    const approved = await approveVoucher(refundReceiptId, OWNER);
    const approvalReplay = await approveVoucher(refundReceiptId, OWNER);
    expect(approved.replayed).toBe(false);
    expect(approvalReplay.replayed).toBe(true);

    const [correctedAsset] = await db()
      .select()
      .from(s.fixedAssets)
      .where(eq(s.fixedAssets.id, asset!.id));
    const [correctedObligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.id, Number(obligation.id)));
    const [correction] = await db()
      .select()
      .from(s.accrualCorrectionRequests)
      .where(eq(s.accrualCorrectionRequests.id, requested.correctionRequestId));
    expect(correctedAsset).toMatchObject({
      isActive: false,
      status: "retired",
      recognitionStatus: "CORRECTED",
    });
    expect(correctedObligation.status).toBe("RECOGNITION_REVERSED");
    expect(correction).toMatchObject({
      status: "APPROVED",
      refundRequestReceiptId: refundReceiptId,
    });
    const events = await db()
      .select()
      .from(s.accrualObligationEvents)
      .where(eq(s.accrualObligationEvents.obligationId, Number(obligation.id)));
    expect(events.map((event) => event.eventType)).toEqual([
      "RECOGNIZED",
      "PAYMENT_REQUESTED",
      "PAYMENT_SETTLED",
      "CORRECTION_REQUESTED",
      "SETTLEMENT_REVERSED",
      "RECOGNITION_REVERSED",
    ]);
    const reversalEntries = (
      await db().select().from(s.accountingEntries)
    ).filter(
      (entry) =>
        entry.dedupeKey === `ACCRUAL:SETTLEMENT_REVERSAL:${obligation.id}` ||
        entry.dedupeKey === `ACCRUAL:RECOGNITION_REVERSAL:${obligation.id}`,
    );
    expect(reversalEntries).toHaveLength(2);
    expect(reversalEntries.map((entry) => entry.amount)).toEqual([
      "-175000.00",
      "-175000.00",
    ]);
  });

  it("تصحيح اقتناء أصل استُخدم يفشل مغلقاً ويترك الأصل والتزامه قائمين", async () => {
    const asset = await mkPendingAsset({
      name: "حاسوب مستخدم",
      category: "computers",
      purchaseDate: "2026-08-01",
      purchaseValue: "90000",
      usefulLifeYears: 4,
    });
    await handoverCustody(asset!.id, 1, "عهدة تشغيلية", ACTOR);
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.assetId, asset!.id));
    await expect(
      requestAccrualCorrection(
        {
          obligationId: Number(obligation.id),
          expectedAssetId: asset!.id,
          reason: "محاولة إلغاء أصل مستخدم",
          externalEvidenceReference: "CREDIT-NOTE-USED-ASSET",
          attachmentUrl: "data:image/png;base64,QUJD",
          clientRequestId: "used-asset-correction",
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      (
        await db()
          .select()
          .from(s.fixedAssets)
          .where(eq(s.fixedAssets.id, asset!.id))
      )[0].isActive,
    ).toBe(true);
    expect(
      (
        await db()
          .select()
          .from(s.accrualObligations)
          .where(eq(s.accrualObligations.id, Number(obligation.id)))
      )[0].status,
    ).toBe("PAYMENT_PENDING");
    expect(await db().select().from(s.accrualCorrectionRequests)).toHaveLength(
      0,
    );
  });
});

describe("updateAsset — تصحيح الإهلاك المتراكم (DEPR-REVAL، تدقيق ١٧/٧)", () => {
  const PARAMS = {
    name: "آلة طباعة",
    category: "computers",
    purchaseDate: "2024-01-01",
    salvageValue: "0",
    usefulLifeYears: 5,
    depreciationMethod: "sl" as const,
    branchId: 1,
  };

  it("تغيير تقدير التخريد/العمر يُصحّح المتراكم بقيد ADJUST دون إعادة كتابة قيمة الاقتناء", async () => {
    const asset = await mkAsset({ ...PARAMS, purchaseValue: "1200000" });
    // نُثبّت متراكماً مُرحَّلاً كبيراً (٨٠٠ألف) كأن الكنسة الشهريّة رحّلته على القيمة القديمة.
    await db()
      .update(s.fixedAssets)
      .set({ accumulatedDepreciation: "800000.00" })
      .where(eq(s.fixedAssets.id, asset!.id));

    const updated = await updateAsset(
      asset!.id,
      {
        ...PARAMS,
        purchaseValue: "1200000",
        salvageValue: "300000",
        usefulLifeYears: 10,
      },
      ACTOR,
    );
    expect(updated!.paymentPending).toBe(false);

    const [a2] = await db()
      .select()
      .from(s.fixedAssets)
      .where(eq(s.fixedAssets.id, asset!.id));
    const expected = computeDepreciation(
      {
        purchaseValue: "1200000",
        salvageValue: "300000",
        usefulLifeYears: 10,
        depreciationMethod: "sl",
        purchaseDate: PARAMS.purchaseDate,
        status: "active",
      },
      new Date(),
    ).accumulated;
    expect(Number(a2.accumulatedDepreciation)).toBe(expected);
    expect(Number(a2.purchaseValue)).toBe(1200000);
    expect(Number(a2.salvageValue)).toBe(300000);
    expect(a2.usefulLifeYears).toBe(10);

    // قيد ADJUST تعويضيّ بالفرق (expected − ٨٠٠ألف، والسالب يعكس الإهلاك الزائد).
    const adj = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.entryType, "ADJUST"),
          sql`${s.accountingEntries.dedupeKey} LIKE ${`DEPR_ADJ:${asset!.id}:%`}`,
        ),
      );
    expect(adj).toHaveLength(1);
    expect(Number(adj[0].cost)).toBe(expected - 800000);
    expect(Number(adj[0].amount)).toBe(expected - 800000);
  });

  it("تعديلٌ لا يمسّ بارامترات الإهلاك (الاسم فقط) ⇒ لا تصحيح ولا قيد", async () => {
    const asset = await mkAsset({ ...PARAMS, purchaseValue: "1200000" });
    await db()
      .update(s.fixedAssets)
      .set({ accumulatedDepreciation: "480000.00" })
      .where(eq(s.fixedAssets.id, asset!.id));
    await updateAsset(
      asset!.id,
      { ...PARAMS, name: "آلة طباعة (محدّثة)", purchaseValue: "1200000" },
      ACTOR,
    );
    const [a2] = await db()
      .select()
      .from(s.fixedAssets)
      .where(eq(s.fixedAssets.id, asset!.id));
    expect(Number(a2.accumulatedDepreciation)).toBe(480000); // بلا تغيير
    const adj = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        sql`${s.accountingEntries.dedupeKey} LIKE ${`DEPR_ADJ:${asset!.id}:%`}`,
      );
    expect(adj).toHaveLength(0);
  });
});

describe("addMaintenance — ترحيل تكلفة الصيانة للدفتر والخزينة (تدقيق ١٧/٧)", () => {
  const A = {
    name: "مكيّف",
    category: "computers",
    purchaseDate: "2025-01-01",
    purchaseValue: "500000",
    usefulLifeYears: 5,
    branchId: 1,
  };

  it("صيانة بتكلفة ⇒ حالة maintenance + طلب معلّق، ثم اعتماد المالك ينفذ TREASURY/OUT", async () => {
    const asset = await mkAsset(A);
    await addMaintenance(
      asset!.id,
      { type: "تنظيف", vendor: "ورشة", cost: "50000", maintDate: "2026-07-10" },
      ACTOR,
    );

    const [a2] = await db()
      .select()
      .from(s.fixedAssets)
      .where(eq(s.fixedAssets.id, asset!.id));
    expect(a2.status).toBe("maintenance");

    const [maintenance] = await db()
      .select()
      .from(s.assetMaintenance)
      .where(eq(s.assetMaintenance.assetId, asset!.id));
    const [pending] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `ASSET-MAINT-${maintenance.id}`));
    expect(pending).toMatchObject({
      direction: "OUT",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
      cashBucket: null,
    });
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.maintenanceId, Number(maintenance.id)));
    const [recognizedExpense] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    expect(recognizedExpense).toMatchObject({
      category: "MAINTENANCE",
      amount: "50000.00",
      paymentMethod: "ACCRUAL",
      source: "ACCRUAL",
      receiptId: null,
      cashBucket: null,
      status: "ACTIVE",
    });
    const [recognizedEntry] = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        eq(
          s.accountingEntries.dedupeKey,
          `ASSET_MAINT_ACCRUAL:${maintenance.id}`,
        ),
      );
    expect(recognizedEntry).toMatchObject({
      entryType: "ADJUST",
      amount: "50000.00",
      receiptId: null,
    });
    await approveVoucher(Number(pending.id), OWNER);
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(
          eq(
            s.accountingEntries.dedupeKey,
            `ASSET_MAINT_ACCRUAL:${maintenance.id}`,
          ),
        ),
    ).toHaveLength(1);
    const [rc] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(pending.id)));
    expect(rc).toMatchObject({
      direction: "OUT",
      cashBucket: "TREASURY",
      status: "COMPLETED",
      approvalStatus: "APPROVED",
    });
    const settlement = await db()
      .select()
      .from(s.accountingEntries)
      .where(
        and(
          eq(s.accountingEntries.entryType, "PAYMENT_OUT"),
          eq(s.accountingEntries.receiptId, Number(pending.id)),
        ),
      );
    expect(settlement).toHaveLength(1);
  });

  it("رفض دفع الصيانة يبقي الاعتراف، وإعادة تقديمه ثم اعتماده لا تكرر المصروف أو القيد", async () => {
    const asset = await mkAsset(A);
    await addMaintenance(
      asset!.id,
      {
        type: "إصلاح لوحة",
        vendor: "ورشة",
        cost: "25000",
        maintDate: "2026-07-11",
      },
      ACTOR,
    );
    const [maintenance] = await db()
      .select()
      .from(s.assetMaintenance)
      .where(eq(s.assetMaintenance.assetId, asset!.id));
    const [request] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `ASSET-MAINT-${maintenance.id}`));

    await rejectVoucher(Number(request.id), OWNER, "فاتورة الورشة غير واضحة");
    const [rejectedRequest] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.id, Number(request.id)));
    expect(rejectedRequest).toMatchObject({
      status: "FAILED",
      approvalStatus: "REJECTED",
    });
    expect(
      await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.approvalStatus, "PENDING_APPROVAL")),
    ).toHaveLength(0);
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(
          eq(
            s.accountingEntries.dedupeKey,
            `ASSET_MAINT_ACCRUAL:${maintenance.id}`,
          ),
        ),
    ).toHaveLength(1);

    const replacement = await resubmitRejectedExpensePayment(
      Number(request.id),
      ACTOR,
      {
        note: "أُرفقت فاتورة مصححة",
        priorReceiptId: Number(request.id),
        reissueReason: "أُرفقت فاتورة الورشة المصححة",
      },
    );
    await approveVoucher(replacement.receiptId, OWNER);
    expect(await db().select().from(s.expenses)).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(s.accountingEntries)
        .where(
          eq(
            s.accountingEntries.dedupeKey,
            `ASSET_MAINT_ACCRUAL:${maintenance.id}`,
          ),
        ),
    ).toHaveLength(1);
    const material = (await db().select().from(s.receipts)).filter(
      (row) =>
        row.cashBucket === "TREASURY" &&
        row.direction === "OUT" &&
        row.approvalStatus === "APPROVED",
    );
    expect(material).toHaveLength(2); // اقتناء الأصل + دفع الصيانة؛ كلٌ مرة واحدة
  });

  it.each([
    ["قبل الاعتماد", false],
    ["بعد رفض الطلب", true],
  ])(
    "الإلغاء العام لمصروف صيانة %s يفشل مغلقاً بلا أي أثر مالي",
    async (_label, rejectFirst) => {
      const asset = await mkAsset(A);
      await addMaintenance(
        asset!.id,
        { type: "صيانة ستلغى", vendor: "ورشة", cost: "30000" },
        ACTOR,
      );
      const [maintenance] = await db()
        .select()
        .from(s.assetMaintenance)
        .where(eq(s.assetMaintenance.assetId, asset!.id));
      const [request] = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.referenceNumber, `ASSET-MAINT-${maintenance.id}`));
      const [obligation] = await db()
        .select()
        .from(s.accrualObligations)
        .where(eq(s.accrualObligations.maintenanceId, Number(maintenance.id)));
      const [expense] = await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, Number(obligation.expenseId)));
      if (rejectFirst)
        await rejectVoucher(
          Number(request.id),
          OWNER,
          "إلغاء الخدمة قبل السداد",
        );

      const before = await db().transaction(async (tx) =>
        (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
      );
      const receiptsBefore = await db().select().from(s.receipts);
      const entriesBefore = await db().select().from(s.accountingEntries);
      await expect(
        cancelExpense(Number(expense.id), ACTOR),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      const after = await db().transaction(async (tx) =>
        (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
      );
      expect(after).toBe(before);

      const [activeExpense] = await db()
        .select()
        .from(s.expenses)
        .where(eq(s.expenses.id, Number(expense.id)));
      const [terminalRequest] = await db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, Number(request.id)));
      expect(activeExpense.status).toBe("ACTIVE");
      expect(terminalRequest.status).toBe(rejectFirst ? "FAILED" : "PENDING");
      expect(await db().select().from(s.receipts)).toEqual(receiptsBefore);
      expect(await db().select().from(s.accountingEntries)).toEqual(
        entriesBefore,
      );
    },
  );

  it("الإلغاء العام لصيانة مدفوعة لا ينشئ استرداداً تلقائياً", async () => {
    const asset = await mkAsset(A);
    await addMaintenance(
      asset!.id,
      { type: "صيانة مدفوعة ستلغى", vendor: "ورشة", cost: "40000" },
      ACTOR,
    );
    const [maintenance] = await db()
      .select()
      .from(s.assetMaintenance)
      .where(eq(s.assetMaintenance.assetId, asset!.id));
    const [request] = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `ASSET-MAINT-${maintenance.id}`));
    const [obligation] = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.maintenanceId, Number(maintenance.id)));
    const [expense] = await db()
      .select()
      .from(s.expenses)
      .where(eq(s.expenses.id, Number(obligation.expenseId)));
    const beforeApproval = await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    );
    await approveVoucher(Number(request.id), OWNER);
    const afterApproval = await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    );
    expect(Number(beforeApproval) - Number(afterApproval)).toBe(40000);

    const receiptsBefore = await db().select().from(s.receipts);
    const entriesBefore = await db().select().from(s.accountingEntries);
    await expect(
      cancelExpense(Number(expense.id), ACTOR),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const afterCancel = await db().transaction(async (tx) =>
      (await computeTreasuryCashBalance(tx, 1)).toFixed(2),
    );
    expect(afterCancel).toBe(afterApproval);
    expect(await db().select().from(s.receipts)).toEqual(receiptsBefore);
    expect(await db().select().from(s.accountingEntries)).toEqual(
      entriesBefore,
    );
  });

  it("صيانة بتكلفة صفر (كفالة) ⇒ لا إيصال ولا قيد، لكن صفّ الصيانة يُدرَج", async () => {
    const asset = await mkAsset(A);
    await addMaintenance(asset!.id, { type: "فحص كفالة", cost: "0" }, ACTOR);
    const maintEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(sql`${s.accountingEntries.dedupeKey} LIKE ${`ASSET_MAINT:%`}`);
    expect(maintEntries).toHaveLength(0);
    const maint = await db()
      .select()
      .from(s.assetMaintenance)
      .where(eq(s.assetMaintenance.assetId, asset!.id));
    expect(maint).toHaveLength(1);
  });
});

describe("createAsset — حرّاس العهدة عند الإنشاء (تدقيق ١٧/٧)", () => {
  const A = {
    name: "طابعة",
    category: "computers",
    purchaseDate: "2025-01-01",
    purchaseValue: "100000",
    usefulLifeYears: 3,
    branchId: 1,
  };

  it("عهدة على موظف منتهي الخدمة ⇒ ترفض ولا يُنشأ الأصل (المعاملة تتراجع)", async () => {
    await db()
      .update(s.employees)
      .set({ employmentStatus: "terminated" })
      .where(eq(s.employees.id, 1));
    await expect(mkAsset({ ...A, custodianId: 1 })).rejects.toThrow(
      /على رأس العمل/,
    );
    expect(await db().select().from(s.fixedAssets)).toHaveLength(0); // تراجعٌ كامل — لا أصل ولا قيد
  });

  it("عهدة على موظف من فرعٍ مختلف عن فرع الأصل ⇒ ترفض", async () => {
    await db()
      .update(s.employees)
      .set({ branchId: 2 })
      .where(eq(s.employees.id, 2)); // موظف ٢ في فرع ٢
    await expect(
      mkAsset({ ...A, branchId: 1, custodianId: 2 }),
    ).rejects.toThrow(/فرع مختلف/);
    expect(await db().select().from(s.fixedAssets)).toHaveLength(0);
  });

  it("عهدة على موظف نشطٍ في نفس الفرع ⇒ تُقبَل ويُفتَح سطر عهدة جارية", async () => {
    const asset = await mkAsset({ ...A, custodianId: 1 });
    expect(Number(asset!.custodianId)).toBe(1);
    const custody = await db()
      .select()
      .from(s.assetCustodyLog)
      .where(
        and(
          eq(s.assetCustodyLog.assetId, asset!.id),
          isNull(s.assetCustodyLog.toDate),
        ),
      );
    expect(custody).toHaveLength(1);
    expect(Number(custody[0].employeeId)).toBe(1);
  });
});
