import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../../services/tx";
import { truncateTables } from "./__testUtils__";
import { syncRevenueCategoriesToVouchersInTx } from "../voucher/syncRevenue";
import { ensureDefaultVoucherCategoriesInTx } from "../voucher/defaults";
import { isVoucherCategoryRoleCompatible } from "../../../shared/voucherCategoryAccounting";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

describe("مزامنة وتوفير فئات الإيرادات وأقسام الكتالوج إلى فئات السندات", () => {
  beforeEach(async () => {
    await truncateTables([
      "receipts",
      "categories",
      "voucherCategories",
    ]);
  });

  it("يُزامن فئات الإيرادات القياسية وأقسام الكتالوج النشطة ويربطها بأدوار مقبولة في القبض (IN) ذرياً ويدعم idempotency", async () => {
    // 1. إدخال أقسام كتالوج تجارية في جدول categories
    await db().insert(s.categories).values([
      {
        id: 1,
        name: "قرطاسية ومكتبيات عامة",
        description: "قسم القرطاسية والمكتبية",
        sortOrder: 10,
        isActive: true,
      },
      {
        id: 2,
        name: "خدمات التصوير السريع",
        description: "تصوير ووثائق",
        sortOrder: 20,
        isActive: true,
      },
      {
        id: 3,
        name: "قسم أرشيفي معطل",
        description: "معطل",
        sortOrder: 30,
        isActive: false,
      },
    ]);

    // 2. إدخال فئة قائمة في السندات بلا حساب مقابل لمطابقتها
    await db().insert(s.voucherCategories).values({
      id: 10,
      name: "خدمات الطباعة والتصوير",
      direction: "IN",
      postingRole: null,
      isActive: true,
      sortOrder: 110,
    });

    // 3. تنفيذ المزامنة لأول مرة
    const firstRun = await withTx((tx) => syncRevenueCategoriesToVouchersInTx(tx));

    expect(firstRun.mapped).toContain("خدمات الطباعة والتصوير");
    expect(firstRun.inserted).toEqual(
      expect.arrayContaining([
        "خدمات الفلكس والطباعة العريضة",
        "مبيعات القرطاسية والمكتبيات",
        "مبيعات الهدايا والترويج والتخرج",
        "مبيعات التجهيزات المكتبية",
        "خدمات التوصيل والنقل والشحن",
        "خدمات التصميم والمونتاج والدعاية",
        "عمولات الصيرفة والتحويلات المالية",
        "تحصيل قروض وسلف مستردة من الغير",
        "استلام أموال تشغيل واستثمار بالمشاركة",
        "قرطاسية ومكتبيات عامة",
        "خدمات التصوير السريع",
      ]),
    );
    expect(firstRun.inserted).not.toContain("قسم أرشيفي معطل");

    // 4. التحقق من السجلات في جدول voucherCategories
    const allVouchers = await db().select().from(s.voucherCategories);
    const byName = new Map(allVouchers.map((row) => [row.name, row]));

    // فئة قياسية تم تعيين حسابها القائم
    const printCat = byName.get("خدمات الطباعة والتصوير");
    expect(printCat?.postingRole).toBe("OTHER_REVENUE");
    expect(printCat?.direction).toBe("IN");
    expect(isVoucherCategoryRoleCompatible("IN", printCat?.postingRole)).toBe(true);

    // فئات تمويلية
    const loanRecCat = byName.get("تحصيل قروض وسلف مستردة من الغير");
    expect(loanRecCat?.postingRole).toBe("LOAN_RECEIVABLE");
    expect(loanRecCat?.direction).toBe("IN");
    expect(isVoucherCategoryRoleCompatible("IN", loanRecCat?.postingRole)).toBe(true);

    const investCat = byName.get("استلام أموال تشغيل واستثمار بالمشاركة");
    expect(investCat?.postingRole).toBe("INVESTMENT_PAYABLE");
    expect(investCat?.direction).toBe("IN");
    expect(isVoucherCategoryRoleCompatible("IN", investCat?.postingRole)).toBe(true);

    // أقسام كتالوج نشطة
    const catalogCat1 = byName.get("قرطاسية ومكتبيات عامة");
    expect(catalogCat1?.postingRole).toBe("OTHER_REVENUE");
    expect(catalogCat1?.direction).toBe("IN");
    expect(isVoucherCategoryRoleCompatible("IN", catalogCat1?.postingRole)).toBe(true);

    const catalogCat2 = byName.get("خدمات التصوير السريع");
    expect(catalogCat2?.postingRole).toBe("OTHER_REVENUE");
    expect(catalogCat2?.direction).toBe("IN");

    // 5. التحقق من الـ Idempotency في التشغيل الثاني
    const secondRun = await withTx((tx) => syncRevenueCategoriesToVouchersInTx(tx));
    expect(secondRun.inserted).toHaveLength(0);
    expect(secondRun.mapped).toHaveLength(0);
    expect(secondRun.skipped.length).toBeGreaterThanOrEqual(10);
  });

  it("تتكامل مع ensureDefaultVoucherCategoriesInTx لإنشاء الكتالوج الافتراضي وكافة فئات الإيرادات معاً", async () => {
    const result = await withTx((tx) => ensureDefaultVoucherCategoriesInTx(tx));

    expect(result.inserted.length).toBeGreaterThanOrEqual(30);

    const allVouchers = await db().select().from(s.voucherCategories);
    const names = new Set(allVouchers.map((v) => v.name));

    // فئات القبض الافتراضية
    expect(names.has("إيرادات متفرّقة")).toBe(true);
    expect(names.has("فوائد بنكية")).toBe(true);
    expect(names.has("رأس مال — إيداع المالك")).toBe(true);
    expect(names.has("قرض مستلم")).toBe(true);

    // فئات الإيرادات التشغيلية والخدمية المضافة
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
