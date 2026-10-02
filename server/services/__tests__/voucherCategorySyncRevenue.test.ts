import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../../services/tx";
import { truncateTables } from "./__testUtils__";
import {
  cleanupProductCategoriesFromVouchersInTx,
  STANDARD_REVENUE_CATEGORIES,
  syncRevenueCategoriesToVouchersInTx,
} from "../voucher/syncRevenue";
import { ensureDefaultVoucherCategoriesInTx } from "../voucher/defaults";
import { isVoucherCategoryRoleCompatible } from "../../../shared/voucherCategoryAccounting";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

describe("تأمين ومزامنة فئات الإيرادات وتطهير فئات السندات من تصنيفات المنتجات", () => {
  beforeEach(async () => {
    await truncateTables([
      "receipts",
      "categories",
      "voucherCategories",
      "branches",
    ]);
    await db().insert(s.branches).values({
      id: 1,
      name: "الفرع الرئيسي",
      code: "MAIN",
      type: "MAIN",
    });
  });

  it("يُزامن فئات الإيرادات والأنشطة القياسية فقط ولا يستورد تصنيفات المنتجات من جدول categories", async () => {
    // 1. إدخال تصنيفات منتجات وكتب وبضائع في جدول categories
    await db().insert(s.categories).values([
      {
        id: 1,
        name: "كتب السادس العلمي",
        description: "كتب ومناهج دراسية لطلاب السادس العلمي",
        sortOrder: 10,
        isActive: true,
      },
      {
        id: 2,
        name: "كتب الاول متوسط متميزين",
        description: "مناهج مدارس المتميزين",
        sortOrder: 20,
        isActive: true,
      },
      {
        id: 3,
        name: "حاسبات علمية ومكتبية",
        description: "أجهزة حاسبة كاسيو",
        sortOrder: 30,
        isActive: true,
      },
    ]);

    // 2. إدخال فئة قياسية قائمة بدون حساب مقابل لمطابقتها
    await db().insert(s.voucherCategories).values({
      id: 10,
      name: "خدمات الطباعة والتصوير",
      direction: "IN",
      postingRole: null,
      isActive: true,
      sortOrder: 110,
    });

    // 3. تشغيل المزامنة
    const result = await withTx((tx) => syncRevenueCategoriesToVouchersInTx(tx));

    expect(result.mapped).toContain("خدمات الطباعة والتصوير");
    expect(result.inserted).toEqual(
      expect.arrayContaining([
        "خدمات الفلكس والطباعة العريضة",
        "مبيعات القرطاسية والمكتبيات",
        "مبيعات الهدايا والترويج والتخرج",
        "مبيعات التجهيزات المكتبية",
        "خدمات التوصيل والنقل والشحن",
        "خدمات التصميم والمونتاج والدعاية",
        "خدمات الصيانة والتجهيز الفني",
        "عمولات الصيرفة والتحويلات المالية",
        "تحصيل قروض وسلف مستردة من الغير",
        "استلام أموال تشغيل واستثمار بالمشاركة",
        "منح وإعانات ومساعدات مستلمة",
        "فائض نقدي وتسوية تسليمات",
      ]),
    );

    // 4. الحاسم: التأكد التام من عدم تسرب أي فئة منتجات من جدول categories إلى voucherCategories!
    expect(result.inserted).not.toContain("كتب السادس العلمي");
    expect(result.inserted).not.toContain("كتب الاول متوسط متميزين");
    expect(result.inserted).not.toContain("حاسبات علمية ومكتبية");

    const allVouchers = await db().select().from(s.voucherCategories);
    const voucherNames = allVouchers.map((v) => v.name);
    expect(voucherNames).not.toContain("كتب السادس العلمي");
    expect(voucherNames).not.toContain("كتب الاول متوسط متميزين");
    expect(voucherNames).not.toContain("حاسبات علمية ومكتبية");

    // التحقق من توافق كافة فئات القبض محاسبياً
    for (const v of allVouchers.filter((v) => v.direction === "IN")) {
      expect(
        isVoucherCategoryRoleCompatible("IN", v.postingRole),
        `الفئة «${v.name}» بدور «${v.postingRole}» غير متوافقة مع القبض`,
      ).toBe(true);
    }

    // 5. التحقق من ثبات الـ idempotency في التشغيل الثاني
    const secondRun = await withTx((tx) => syncRevenueCategoriesToVouchersInTx(tx));
    expect(secondRun.inserted).toHaveLength(0);
    expect(secondRun.mapped).toHaveLength(0);
    expect(secondRun.skipped.length).toBeGreaterThanOrEqual(13);
  });

  it("يُطهّر تلقائياً أي فئات منتجات متسربة: يحذف غير المستخدمة ويُعطّل المستخدمة بسندات تاريخية", async () => {
    // 1. إدخال تصنيف في جدول categories
    await db().insert(s.categories).values([
      { id: 101, name: "ملصقات ودفاتر قديمة", isActive: true },
      { id: 102, name: "كتب تاريخية مستعملة", isActive: true },
    ]);

    // 2. إدخال فئتين متسربتين في voucherCategories
    await db().insert(s.voucherCategories).values([
      {
        id: 501,
        name: "ملصقات ودفاتر قديمة",
        direction: "IN",
        postingRole: "OTHER_REVENUE",
        description: "إيراد نشاط تجاري وخدمي مُزامن من أقسام الكتالوج (ملصقات ودفاتر قديمة)",
        isActive: true,
      },
      {
        id: 502,
        name: "كتب تاريخية مستعملة",
        direction: "IN",
        postingRole: "OTHER_REVENUE",
        description: "إيراد نشاط تجاري وخدمي مُزامن من أقسام الكتالوج (كتب تاريخية مستعملة)",
        isActive: true,
      },
    ]);

    // 3. ربط سند قبض بالفئة 502 لمحاكاة وجود سند تاريخي كُتب عليها سابقاً
    await db().insert(s.receipts).values({
      voucherNumber: "RCT-CLEANUP-TEST-1",
      direction: "IN",
      voucherPartyType: "OTHER",
      amount: "50000.00",
      branchId: 1,
      paymentMethod: "CASH",
      voucherCategoryId: 502,
      createdAt: new Date(),
    });

    // 4. تشغيل عملية التطهير والمزامنة
    const result = await withTx((tx) => syncRevenueCategoriesToVouchersInTx(tx));

    // الفئة 501 غير مرتبطة بسندات => يجب حذفها نهائياً
    expect(result.deleted).toContain("ملصقات ودفاتر قديمة");
    // الفئة 502 مرتبطة بسند تاريخي => يجب تعطيلها حفاظاً على الأثر التدقيقي
    expect(result.deactivated).toContain("كتب تاريخية مستعملة");

    // التحقق المباشر من قاعدة البيانات
    const remaining501 = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.id, 501));
    expect(remaining501).toHaveLength(0); // حُذفت تماماً!

    const remaining502 = await db()
      .select()
      .from(s.voucherCategories)
      .where(eq(s.voucherCategories.id, 502));
    expect(remaining502).toHaveLength(1);
    expect(remaining502[0].isActive).toBe(false); // معطلة!

    // والتأكد أن السند لا يزال يشير للفئة 502 ولم يُحذف أو يُصبح NULL
    const rct = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.voucherNumber, "RCT-CLEANUP-TEST-1"));
    expect(rct[0].voucherCategoryId).toBe(502);
  });

  it("تتكامل مع ensureDefaultVoucherCategoriesInTx لإنشاء الكتالوج الافتراضي المعتمد دون فئات منتجات", async () => {
    const result = await withTx((tx) => ensureDefaultVoucherCategoriesInTx(tx));

    expect(result.inserted.length).toBeGreaterThanOrEqual(25);

    const allVouchers = await db().select().from(s.voucherCategories);
    const names = new Set(allVouchers.map((v) => v.name));

    // فئات القبض الافتراضية المحاسبية
    expect(names.has("إيرادات متفرّقة")).toBe(true);
    expect(names.has("فوائد بنكية")).toBe(true);
    expect(names.has("رأس مال — إيداع المالك")).toBe(true);
    expect(names.has("قرض مستلم")).toBe(true);

    // فئات الإيرادات والأنشطة التشغيلية والخدمية
    expect(names.has("خدمات الطباعة والتصوير")).toBe(true);
    expect(names.has("خدمات الفلكس والطباعة العريضة")).toBe(true);
    expect(names.has("مبيعات القرطاسية والمكتبيات")).toBe(true);
    expect(names.has("مبيعات الهدايا والترويج والتخرج")).toBe(true);
    expect(names.has("خدمات التوصيل والنقل والشحن")).toBe(true);
    expect(names.has("تحصيل قروض وسلف مستردة من الغير")).toBe(true);
    expect(names.has("استلام أموال تشغيل واستثمار بالمشاركة")).toBe(true);

    // التحقق من توافق كافة فئات القبض
    for (const v of allVouchers.filter((v) => v.direction === "IN")) {
      expect(
        isVoucherCategoryRoleCompatible("IN", v.postingRole),
        `الفئة «${v.name}» بدور «${v.postingRole}» غير متوافقة مع القبض`,
      ).toBe(true);
    }
  });
});
