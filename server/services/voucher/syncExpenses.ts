/**
 * جسر مزامنة فئات المصروفات التشغيلية (expenseCategories) إلى فئات السندات (voucherCategories).
 *
 * المشكلة:
 * المصروفات تُدار في جدول مستقل (expenseCategories)، وسندات الصرف تُدار في جدول آخر (voucherCategories).
 * عندما يُنشئ المحاسب فئة في شاشة المصروفات، كانت تختفي من سندات الصرف.
 *
 * الحل:
 * هذه الخدمة تقرأ الفئات المُدارة النشطة من expenseCategories وتُنشئ نظيرتها في voucherCategories
 * مع ربط كل فئة بحسابها المقابل المتوافق مع اتجاه الصرف (OUT) وفق خريطة الدلاء المحاسبية الرسمية.
 */
import { and, eq, isNull } from "drizzle-orm";
import { expenseCategories, voucherCategories } from "../../../drizzle/schema";
import type { ExpenseBucket } from "../../../shared/expenseCategories";
import type { VoucherCategoryPostingRole } from "../../../shared/voucherCategoryAccounting";
import type { Tx } from "../../db";

export const EXPENSE_BUCKET_TO_VOUCHER_POSTING_ROLE: Readonly<
  Record<ExpenseBucket, VoucherCategoryPostingRole>
> = Object.freeze({
  RENT: "RENT",
  UTILITIES: "UTILITIES",
  SUPPLIES: "OPERATING_EXPENSE",
  SALARY: "SALARIES",
  TRANSPORT: "DELIVERY_EXPENSE",
  MAINTENANCE: "OPERATING_EXPENSE",
  MARKETING: "OPERATING_EXPENSE",
  OTHER: "OTHER_EXPENSE",
});

export interface SyncExpenseCategoriesResult {
  /** أسماء الفئات الجديدة التي أُضيفت إلى فئات السندات */
  inserted: string[];
  /** أسماء الفئات القائمة التي عُيّن لها الحساب المقابل */
  mapped: string[];
  /** أسماء الفئات التي تم تخطيها لوجودها مسبقاً بحساب معتمد أو اختلاف الاتجاه */
  skipped: string[];
  /** إجمالي الفئات المزامنة */
  total: number;
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ar");
}

export async function syncExpenseCategoriesToVouchersInTx(
  tx: Tx,
): Promise<SyncExpenseCategoriesResult> {
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

  // جلب فئات المصروفات النشطة
  const activeExpenses = await tx
    .select({
      id: expenseCategories.id,
      name: expenseCategories.name,
      bucket: expenseCategories.bucket,
      description: expenseCategories.description,
      sortOrder: expenseCategories.sortOrder,
    })
    .from(expenseCategories)
    .where(eq(expenseCategories.isActive, true));

  const byName = new Map(
    existingVouchers.map((row) => [nameKey(row.name), row]),
  );

  const result: SyncExpenseCategoriesResult = {
    inserted: [],
    mapped: [],
    skipped: [],
    total: 0,
  };

  const toInsert: Array<{
    name: string;
    direction: "OUT";
    postingRole: VoucherCategoryPostingRole;
    description: string | null;
    sortOrder: number;
    isActive: boolean;
  }> = [];

  for (const exp of activeExpenses) {
    const key = nameKey(exp.name);
    const targetRole = EXPENSE_BUCKET_TO_VOUCHER_POSTING_ROLE[exp.bucket];
    const current = byName.get(key);

    if (!current) {
      toInsert.push({
        name: exp.name.trim(),
        direction: "OUT",
        postingRole: targetRole,
        description:
          exp.description?.trim() ||
          `فئة مصروف تشغيلي مُزامنة من إدارة المصروفات (${exp.name.trim()})`,
        sortOrder: exp.sortOrder ?? 100,
        isActive: true,
      });
      continue;
    }

    result.total += 1;

    // إذا كانت الفئة قائمة وبلا حساب مقابل واتجاهها OUT
    if (!current.postingRole && current.direction === "OUT") {
      await tx
        .update(voucherCategories)
        .set({ postingRole: targetRole })
        .where(
          and(
            eq(voucherCategories.id, Number(current.id)),
            isNull(voucherCategories.postingRole),
          ),
        );
      result.mapped.push(exp.name.trim());
    } else {
      result.skipped.push(exp.name.trim());
    }
  }

  if (toInsert.length > 0) {
    await tx.insert(voucherCategories).values(toInsert);
    result.inserted = toInsert.map((item) => item.name);
    result.total += toInsert.length;
  }

  return result;
}
