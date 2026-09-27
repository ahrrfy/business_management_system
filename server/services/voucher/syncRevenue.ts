/**
 * تأمين ومزامنة فئات الإيرادات والأنشطة والقبوضات التمويلية القياسية في فئات السندات (voucherCategories)
 * وتطهيرها التام من أي تصنيفات بضائع أو كتب أو أقسام كتالوج منتجات متجرية تسربت سابقاً.
 *
 * المنظور المحاسبي والرقابي:
 * 1. سند القبض (Receipt Voucher) وثيقة مالية وتدفق نقدي وبنكي، يُثبت حركة النقدية مقابل الإيرادات
 *    العامة أو الخدمات أو التمويل، ولا يحتوي على باركود أو كميات ولا يخصم مخزوناً (branchStock) ولا يحسب COGS.
 * 2. أصناف وبضائع المتجر والكتب والمستلزمات تُباع حصراً عبر نقاط البيع (POS) وفواتير المبيعات
 *    لضمان انضباط الجرد المستمر وحساب الأرباح بدقة ومنع المخزون الوهمي (Phantom Inventory).
 * 3. هذه الخدمة تضمن ذرياً:
 *    - حصر فئات القبض في الكتالوج القياسي المعتمد للأنشطة والخدمات والمقبوضات التمويلية (STANDARD_REVENUE_CATEGORIES).
 *    - استئصال وحذف أي تصنيفات منتجات تسربت سابقاً إلى voucherCategories ولم ترتبط بسندات.
 *    - تعطيل (deactivate) أي فئة منتجات متسربة ارتبطت بسندات سابقة حفاظاً على الأثر التدقيقي والتاريخي.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { categories, receipts, voucherCategories } from "../../../drizzle/schema";
import type { VoucherCategoryPostingRole } from "../../../shared/voucherCategoryAccounting";
import { DEFAULT_VOUCHER_CATEGORIES } from "../../../shared/voucherCategoryDefaults";
import type { Tx } from "../../db";

export interface StandardRevenueCategoryDef {
  name: string;
  postingRole: VoucherCategoryPostingRole;
  description: string;
  sortOrder: number;
}

/**
 * الكتالوج التشغيلي القياسي لكافة فئات الإيرادات والأنشطة والقبوضات التمويلية للشركة.
 */
export const STANDARD_REVENUE_CATEGORIES: readonly StandardRevenueCategoryDef[] =
  Object.freeze([
    {
      name: "خدمات الطباعة والتصوير",
      postingRole: "OTHER_REVENUE",
      description: "إيرادات خدمات الطباعة الرقمية والتصوير والتجليد والوثائق",
      sortOrder: 110,
    },
    {
      name: "خدمات الفلكس والطباعة العريضة",
      postingRole: "OTHER_REVENUE",
      description: "إيرادات طباعة الفلكس والبنرات واللوحات الإعلانية الخارجية",
      sortOrder: 115,
    },
    {
      name: "مبيعات القرطاسية والمكتبيات",
      postingRole: "OTHER_REVENUE",
      description: "مقبوضات مبيعات القرطاسية والأدوات المكتبية والمدرسية والكتب",
      sortOrder: 120,
    },
    {
      name: "مبيعات الهدايا والترويج والتخرج",
      postingRole: "OTHER_REVENUE",
      description: "مقبوضات مبيعات الهدايا الترويجية والدروع ومستلزمات التخرج",
      sortOrder: 125,
    },
    {
      name: "مبيعات التجهيزات المكتبية",
      postingRole: "OTHER_REVENUE",
      description: "مقبوضات مبيعات وتجهيزات المكاتب والأثاث والمعدات المكتبية",
      sortOrder: 130,
    },
    {
      name: "خدمات التوصيل والنقل والشحن",
      postingRole: "OTHER_REVENUE",
      description: "إيرادات خدمات الشحن وتوصيل الطرود والإرساليات للزبائن",
      sortOrder: 135,
    },
    {
      name: "خدمات التصميم والمونتاج والدعاية",
      postingRole: "OTHER_REVENUE",
      description: "إيرادات خدمات التصميم الجرافيكي والمونتاج والحملات الإعلانية",
      sortOrder: 142,
    },
    {
      name: "خدمات الصيانة والتجهيز الفني",
      postingRole: "OTHER_REVENUE",
      description: "إيرادات صيانة الطابعات وتجهيز الأجهزة والمعدات الفنية",
      sortOrder: 145,
    },
    {
      name: "عمولات الصيرفة والتحويلات المالية",
      postingRole: "OTHER_REVENUE",
      description: "عمولات تحويل الأموال والخدمات المالية المباشرة والوساطة",
      sortOrder: 148,
    },
    {
      name: "تحصيل قروض وسلف مستردة من الغير",
      postingRole: "LOAN_RECEIVABLE",
      description: "استرداد سلفة أو قرض حسن ممنوح سابقاً للغير (أصل — تصفية ذمة)",
      sortOrder: 235,
    },
    {
      name: "استلام أموال تشغيل واستثمار بالمشاركة",
      postingRole: "INVESTMENT_PAYABLE",
      description: "أموال واردة للمشاركة في التشغيل والاستثمار (التزام ومشاركة)",
      sortOrder: 245,
    },
    {
      name: "منح وإعانات ومساعدات مستلمة",
      postingRole: "OTHER_REVENUE",
      description: "منح وإعانات وتبرعات واردة للمؤسسة",
      sortOrder: 275,
    },
    {
      name: "فائض نقدي وتسوية تسليمات",
      postingRole: "OTHER_REVENUE",
      description: "فائض صندوق أو تسوية فوارق تسليمات نقدية مثبتة بعد الجرد",
      sortOrder: 285,
    },
  ]);

export interface CleanupProductCategoriesResult {
  /** أسماء فئات المنتجات التي حُذفت نهائياً لعدم ارتباطها بأي سندات */
  deleted: string[];
  /** أسماء فئات المنتجات التي عُطّلت لارتباطها بسندات سابقة */
  deactivated: string[];
}

export interface SyncRevenueCategoriesResult {
  /** أسماء الفئات الجديدة التي أُضيفت إلى فئات السندات */
  inserted: string[];
  /** أسماء الفئات القائمة التي عُيّن لها الحساب المقابل */
  mapped: string[];
  /** أسماء الفئات التي تم تخطيها لوجودها مسبقاً بحساب معتمد */
  skipped: string[];
  /** فئات المنتجات التي حُذفت نهائياً أثناء التنظيف */
  deleted: string[];
  /** فئات المنتجات التي عُطّلت أثناء التنظيف */
  deactivated: string[];
  /** إجمالي الفئات المعالجة والموجودة */
  total: number;
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ar");
}

/**
 * تنظيف وتطهير فئات السندات (voucherCategories) من تصنيفات المنتجات المخزنية والكتب.
 * - إذا لم ترتبط الفئة بأي سند: تُحذف فوراً.
 * - إذا ارتبطت الفئة بسند تاريخي: تُعطّل فوراً لمنع اختيارها مستقبلاً دون كسر الأثر التدقيقي.
 */
export async function cleanupProductCategoriesFromVouchersInTx(
  tx: Tx,
): Promise<CleanupProductCategoriesResult> {
  const protectedNames = new Set<string>();
  for (const item of STANDARD_REVENUE_CATEGORIES) {
    protectedNames.add(nameKey(item.name));
  }
  for (const item of DEFAULT_VOUCHER_CATEGORIES) {
    protectedNames.add(nameKey(item.name));
  }

  // جلب كافة أسماء الفئات من جدول كتالوج المنتجات
  const productCats = await tx
    .select({ name: categories.name })
    .from(categories);
  const productCatNames = new Set(productCats.map((c) => nameKey(c.name)));

  const allVoucherCategories = await tx
    .select({
      id: voucherCategories.id,
      name: voucherCategories.name,
      description: voucherCategories.description,
      isActive: voucherCategories.isActive,
    })
    .from(voucherCategories)
    .for("update");

  const deleted: string[] = [];
  const deactivated: string[] = [];

  for (const vCat of allVoucherCategories) {
    const key = nameKey(vCat.name);
    // حماية الفئات القياسية والافتراضية
    if (protectedNames.has(key)) {
      continue;
    }

    const isLeakedProductCat =
      productCatNames.has(key) ||
      (vCat.description?.includes("مُزامن من أقسام الكتالوج") ?? false);

    if (!isLeakedProductCat) {
      continue;
    }

    // فحص الارتباط بالسندات
    const [usage] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(receipts)
      .where(eq(receipts.voucherCategoryId, Number(vCat.id)));

    const usedCount = Number(usage?.count || 0);

    if (usedCount === 0) {
      await tx
        .delete(voucherCategories)
        .where(eq(voucherCategories.id, Number(vCat.id)));
      deleted.push(vCat.name);
    } else if (vCat.isActive) {
      await tx
        .update(voucherCategories)
        .set({ isActive: false })
        .where(eq(voucherCategories.id, Number(vCat.id)));
      deactivated.push(vCat.name);
    }
  }

  return { deleted, deactivated };
}

/**
 * مزامنة وتوفير فئات الإيرادات والأنشطة والقبوضات التمويلية القياسية في فئات السندات ذرياً،
 * وتطهير جدول voucherCategories من أي فئات منتجات متسربة.
 */
export async function syncRevenueCategoriesToVouchersInTx(
  tx: Tx,
): Promise<SyncRevenueCategoriesResult> {
  // أولاً: تنظيف أي فئات منتجات متسربة
  const cleanup = await cleanupProductCategoriesFromVouchersInTx(tx);

  // ثانياً: قفل فئات السندات لمنع التسابق
  const existingVouchers = await tx
    .select({
      id: voucherCategories.id,
      name: voucherCategories.name,
      direction: voucherCategories.direction,
      postingRole: voucherCategories.postingRole,
      isActive: voucherCategories.isActive,
    })
    .from(voucherCategories)
    .for("update");

  const byName = new Map(
    existingVouchers.map((row) => [nameKey(row.name), row]),
  );

  const result: SyncRevenueCategoriesResult = {
    inserted: [],
    mapped: [],
    skipped: [],
    deleted: cleanup.deleted,
    deactivated: cleanup.deactivated,
    total: 0,
  };

  const toInsert: Array<{
    name: string;
    direction: "IN";
    postingRole: VoucherCategoryPostingRole;
    description: string | null;
    sortOrder: number;
    isActive: boolean;
  }> = [];

  // ثالثاً: معالجة كتالوج الإيرادات القياسية المعتمدة حصراً
  for (const item of STANDARD_REVENUE_CATEGORIES) {
    const key = nameKey(item.name);
    const current = byName.get(key);

    if (!current) {
      toInsert.push({
        name: item.name.trim(),
        direction: "IN",
        postingRole: item.postingRole,
        description: item.description,
        sortOrder: item.sortOrder,
        isActive: true,
      });
      continue;
    }

    result.total += 1;

    // إذا كانت الفئة قائمة وبلا حساب مقابل واتجاهها IN أو BOTH
    if (!current.postingRole && (current.direction === "IN" || current.direction === "BOTH")) {
      await tx
        .update(voucherCategories)
        .set({ postingRole: item.postingRole })
        .where(
          and(
            eq(voucherCategories.id, Number(current.id)),
            isNull(voucherCategories.postingRole),
          ),
        );
      result.mapped.push(item.name.trim());
    } else {
      result.skipped.push(item.name.trim());
    }
  }

  if (toInsert.length > 0) {
    await tx.insert(voucherCategories).values(toInsert);
    result.inserted = toInsert.map((item) => item.name);
    result.total += toInsert.length;
  }

  return result;
}
