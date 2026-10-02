import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createAsset,
  getAsset,
  reclassifyAssetToOpening,
} from "../assetsService";
import { money } from "../money";

const OWNER = {
  userId: 2,
  branchId: 1,
  role: "manager" as const,
  isOwner: true,
};
const NON_OWNER = {
  userId: 1,
  branchId: 1,
  role: "admin" as const,
  isOwner: false,
};
const ADMIN_SCOPE = { branchId: null } as const;

let seq = 0;

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const TABLES = [
  "idempotencyKeys",
  "accrualCorrectionRequests",
  "accrualObligationEvents",
  "accrualObligations",
  "accountingEntries",
  "receipts",
  "assetCustodyLog",
  "fixedAssets",
  "auditLogs",
  "branches",
  "users",
];

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
  ]);
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "local_test",
      username: "admin1",
      name: "Admin User",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: false,
    },
    {
      id: 2,
      openId: "asset_owner",
      username: "owner1",
      name: "Owner User",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
}

describe("الأصول السابقة لبناء النظام (الرصيد الافتتاحي) وإعادة التصنيف", () => {
  beforeEach(async () => {
    await reset();
    await seedBase();
  });

  it("إنشاء أصل افتتاحي سابق للنظام: لا يُنشئ سند صرف، لا يُنشئ التزام استحقاق، ويُرحّل مباشرة لحقوق الملكية", async () => {
    seq += 1;
    const asset = await createAsset(
      {
        name: "طابعة صناعية قديمة",
        category: "printing",
        branchId: 1,
        purchaseDate: "2024-01-15",
        purchaseValue: "15000000",
        usefulLifeYears: 5,
        depreciationMethod: "sl",
        acquisitionType: "OPENING",
        clientRequestId: `req-opening-${seq}`,
      },
      OWNER,
    );

    expect(asset).toBeDefined();
    expect(asset?.code).toMatch(/^AST-\d+$/);

    const assetData = await getAsset(asset!.id, ADMIN_SCOPE);
    expect(assetData).toBeDefined();
    expect(assetData?.paymentPending).toBe(false);
    expect(assetData?.settlementStatus).toBeNull();

    // التأكد من عدم إنشاء أي سند صرف في جدول receipts
    const vouchers = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `ASSET-ACQ-${asset!.id}`));
    expect(vouchers).toHaveLength(0);

    // التأكد من عدم إنشاء أي التزام استحقاق
    const obligations = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.assetId, asset!.id));
    expect(obligations).toHaveLength(0);

    // التأكد من ترحيل قيد OPENING للأصل مقابل حقوق الملكية الافتتاحية
    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `ASSET_OPENING:${asset!.id}`));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.entryType).toBe("OPENING");
    expect(Number(entry.amount)).toBe(15000000);
    expect(entry.notes).toContain("أصل افتتاحي سابق لبناء النظام");
  });

  it("إنشاء أصل افتتاحي مع إهلاك متراكم سابق: يُثبت مجمع الإهلاك ويُقيّد صافي القيمة في حقوق الملكية", async () => {
    seq += 1;
    const cost = "10000000"; // 10 مليون
    const prevDep = "3000000"; // 3 مليون إهلاك سابق

    const asset = await createAsset(
      {
        name: "سيارة نقل بضائع",
        category: "vehicles",
        branchId: 1,
        purchaseDate: "2023-06-01",
        purchaseValue: cost,
        usefulLifeYears: 5,
        depreciationMethod: "sl",
        acquisitionType: "OPENING",
        accumulatedDepreciation: prevDep,
        clientRequestId: `req-opening-dep-${seq}`,
      },
      OWNER,
    );

    const assetData = await getAsset(asset!.id, ADMIN_SCOPE);
    expect(assetData).toBeDefined();
    expect(assetData?.accumulatedDepreciation).toBe("3000000.00");

    const entries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `ASSET_OPENING:${asset!.id}`));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.entryType).toBe("OPENING");
    expect(Number(entry.amount)).toBe(10000000);
    expect(entry.notes).toContain("أصل افتتاحي سابق لبناء النظام");
  });

  it("رفض إدخال إهلاك متراكم سابق يتجاوز قيمة الشراء الأصلية", async () => {
    seq += 1;
    await expect(
      createAsset(
        {
          name: "أصل غير صالح",
          category: "computers",
          branchId: 1,
          purchaseDate: "2024-01-01",
          purchaseValue: "5000000",
          usefulLifeYears: 3,
          depreciationMethod: "sl",
          acquisitionType: "OPENING",
          accumulatedDepreciation: "6000000", // أكثر من الشراء
          clientRequestId: `req-invalid-dep-${seq}`,
        },
        OWNER,
      ),
    ).rejects.toThrow("يتجاوز تكلفة الشراء الأصلية");
  });

  it("تحويل أصل نقدي ذي طلب صرف معلق إلى رصيد افتتاحي: إلغاء السند المعلق، عكس الاستحقاق، وإثبات حقوق الملكية الافتتاحية", async () => {
    seq += 1;
    // 1. نُنشئ أصلاً بنظام الشراء النقدي الحديث (كما حدث مع AST-1001 عند المستخدم)
    const rawAsset = await createAsset(
      {
        name: "خادم بيانات رئيسي",
        category: "computers",
        branchId: 1,
        purchaseDate: "2024-01-01",
        purchaseValue: "1000000000", // 1 مليار كما في حالة المستخدم
        usefulLifeYears: 5,
        depreciationMethod: "sl",
        acquisitionType: "NEW_PURCHASE_CASH",
        acquisitionBeneficiaryName: "شركة الرافدين للتجهيزات",
        acquisitionEvidenceReference: "INV-OLD-2024",
        clientRequestId: `req-cash-wrong-${seq}`,
      },
      NON_OWNER,
    );

    expect(rawAsset).toBeDefined();
    const assetId = rawAsset!.id;

    // التحقق من أن السند المعلق والالتزام كلاهما موجودان الآن
    const pendingVouchers = await db()
      .select()
      .from(s.receipts)
      .where(
        and(
          eq(s.receipts.referenceNumber, `ASSET-ACQ-${assetId}`),
          eq(s.receipts.approvalStatus, "PENDING_APPROVAL"),
        ),
      );
    expect(pendingVouchers).toHaveLength(1);
    expect(pendingVouchers[0].status).toBe("PENDING");

    const obligations = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.assetId, assetId));
    expect(obligations).toHaveLength(1);
    expect(obligations[0].status).toBe("PAYMENT_PENDING");

    const assetBefore = await getAsset(assetId, ADMIN_SCOPE);
    expect(assetBefore?.paymentPending).toBe(true);

    // 2. غير المالك يحاول إعادة التصنيف -> يرفض فوراً FORBIDDEN
    await expect(reclassifyAssetToOpening(assetId, NON_OWNER)).rejects.toThrow(
      "صلاحية غير كافية لتحويل الأصل",
    );

    // 3. المالك يقوم بإعادة التصنيف إلى رصيد افتتاحي سابق للنظام
    const reclassifiedAsset = await reclassifyAssetToOpening(assetId, OWNER);
    expect(reclassifiedAsset).toBeDefined();
    expect(reclassifiedAsset?.paymentPending).toBe(false);
    expect(reclassifiedAsset?.settlementStatus).toBe("RECOGNITION_REVERSED");

    // 4. التحقق من إلغاء السند المعلق في receipts
    const updatedVouchers = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `ASSET-ACQ-${assetId}`));
    expect(updatedVouchers).toHaveLength(1);
    expect(updatedVouchers[0].approvalStatus).toBe("REJECTED");
    expect(updatedVouchers[0].status).toBe("FAILED");
    expect(updatedVouchers[0].internalNote).toContain("تم تحويل الأصل إلى أصل افتتاحي سابق لبناء النظام");

    // 5. التحقق من انتقال التزام الاستحقاق إلى RECOGNITION_REVERSED
    const updatedObligations = await db()
      .select()
      .from(s.accrualObligations)
      .where(eq(s.accrualObligations.assetId, assetId));
    expect(updatedObligations).toHaveLength(1);
    expect(updatedObligations[0].status).toBe("RECOGNITION_REVERSED");

    // 6. التحقق من تسجيل قيد عكس الاستحقاق وقيد الأصول الافتتاحية
    const openingEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `ASSET_OPENING:${assetId}`));
    expect(openingEntries).toHaveLength(1);
    expect(openingEntries[0].entryType).toBe("OPENING");
    expect(Number(openingEntries[0].amount)).toBe(1000000000);

    const reversalEntries = await db()
      .select()
      .from(s.accountingEntries)
      .where(eq(s.accountingEntries.dedupeKey, `ACCRUAL:REVERSAL_RECLASSIFY:${assetId}`));
    expect(reversalEntries).toHaveLength(1);
    expect(reversalEntries[0].entryType).toBe("ADJUST");
    expect(Number(reversalEntries[0].amount)).toBe(-1000000000);

    // 7. محاولة إعادة التصنيف مرة أخرى تفشل لأن الأصل أصبح افتتاحياً ولم يعد هناك التزام نقدي معلق
    await expect(reclassifyAssetToOpening(assetId, OWNER)).rejects.toThrow();
  });
});
