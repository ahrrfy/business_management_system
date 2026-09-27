/**
 * جسر مزامنة وتوفير فئات الإيرادات وأقسام الكتالوج (categories) إلى فئات السندات (voucherCategories).
 *
 * المشكلة:
 * كانت فئات سندات القبض (IN) محصورة تاريخياً في 10 فئات عامة فقط، وتغيب عنها كافة فئات
 * وأنشطة الشركة التشغيلية (خدمات الطباعة، مبيعات القرطاسية، الفلكس، التوصيل، الهدايا، التجهيزات المكتبية،
 * والتصميم)، إضافة إلى غياب أقسام الكتالوج التجاري وفئات استرداد القروض والاستثمار بالمشاركة.
 *
 * الحل:
 * هذه الخدمة تُؤمّن وتُزامن ذرياً:
 * 1. كتالوج الإيرادات التشغيلية والخدمية والتمويلية القياسية للشركة (STANDARD_REVENUE_CATEGORIES).
 * 2. كافة أقسام الكتالوج التجاري النشطة من جدول categories.
 * وتُسند لكل منها دورها المحاسبي المتوافق مع اتجاه القبض (IN) بأسلوب idempotent محصن.
 */
import { and, eq, isNull } from "drizzle-orm";
import { categories, voucherCategories } from "../../../drizzle/schema";
import type { VoucherCategoryPostingRole } from "../../../shared/voucherCategoryAccounting";
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

export interface SyncRevenueCategoriesResult {
  /** أسماء الفئات الجديدة التي أُضيفت إلى فئات السندات */
  inserted: string[];
  /** أسماء الفئات القائمة التي عُيّن لها الحساب المقابل */
  mapped: string[];
  /** أسماء الفئات التي تم تخطيها لوجودها مسبقاً بحساب معتمد */
  skipped: string[];
  /** إجمالي الفئات المعالجة والموجودة */
  total: number;
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ar");
}

export async function syncRevenueCategoriesToVouchersInTx(
  tx: Tx,
): Promise<SyncRevenueCategoriesResult> {
  // قفل فئات السندات لمنع التسابق
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

  // ١. معالجة كتالوج الإيرادات القياسية الشاملة
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

    // إذا كانت الفئة قائمة وبلا حساب مقابل واتجاهها IN
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

  // ٢. معالجة أقسام الكتالوج التجاري النشطة (categories)
  const activeCatalogCategories = await tx
    .select({
      id: categories.id,
      name: categories.name,
      description: categories.description,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .where(eq(categories.isActive, true));

  for (const cat of activeCatalogCategories) {
    const key = nameKey(cat.name);
    const current = byName.get(key);

    if (!current) {
      // تفادي التكرار إن كانت مسجلة بالفعل ضمن toInsert
      if (toInsert.some((item) => nameKey(item.name) === key)) {
        continue;
      }

      toInsert.push({
        name: cat.name.trim(),
        direction: "IN",
        postingRole: "OTHER_REVENUE",
        description:
          cat.description?.trim() ||
          `إيراد نشاط تجاري وخدمي مُزامن من أقسام الكتالوج (${cat.name.trim()})`,
        sortOrder: cat.sortOrder || 150,
        isActive: true,
      });
      continue;
    }

    result.total += 1;

    if (!current.postingRole && (current.direction === "IN" || current.direction === "BOTH")) {
      await tx
        .update(voucherCategories)
        .set({ postingRole: "OTHER_REVENUE" })
        .where(
          and(
            eq(voucherCategories.id, Number(current.id)),
            isNull(voucherCategories.postingRole),
          ),
        );
      result.mapped.push(cat.name.trim());
    } else {
      if (!result.skipped.includes(cat.name.trim())) {
        result.skipped.push(cat.name.trim());
      }
    }
  }

  if (toInsert.length > 0) {
    await tx.insert(voucherCategories).values(toInsert);
    result.inserted = toInsert.map((item) => item.name);
    result.total += toInsert.length;
  }

  return result;
}
