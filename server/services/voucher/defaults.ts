/**
 * بذر فئات السندات الافتراضية — مسارٌ واحد تستعمله البذرة (`pnpm seed`) وزرّ «استعادة الفئات
 * الافتراضية» في الشاشة، وهجرة 0202 تفعل الشيء نفسه بـSQL للقواعد القائمة.
 *
 * لماذا مسارٌ برمجيّ إضافةً إلى الهجرة؟ لأنّ القاعدة تُبنى بثلاثة مسارات مختلفة:
 *  - الإنتاج بالهجرات (`db:migrate:safe`) ⇒ 0202 تكفيه.
 *  - التطوير بـ`pnpm db:push` (المسار الموثَّق في CLAUDE.md §٣) يبني الجداول من `schema.ts`
 *    وحده ⇒ **صفر فئة** لأنّ البذر يعيش في SQL الهجرات؛ فكان الحقل الإلزامي بلا خيارات.
 *  - قاعدةٌ قائمة عُطّلت فئاتها أو حُذفت يدوياً ⇒ يلزم مخرجٌ تشغيليّ بلا وصول SQL.
 *
 * الضمانات (تحرسها اختبارات الوحدة والقيود):
 *  - **idempotent**: الاسم مفتاح التطابق (UNIQUE في DB)، فإعادة التشغيل لا تُكرّر ولا تُعدّل.
 *  - **لا يمسّ ما عيّنه المالك**: لا يغيّر اسماً ولا اتجاهاً ولا حساباً مقابلاً غير فارغ ولا ترتيباً،
 *    ولا يُعيد تفعيل فئةٍ عطّلها المالك عمداً.
 *  - **لا يُعيد تصنيف تاريخٍ صامتاً**: ملء `postingRole` الفارغ مشروطٌ بتطابق الاتجاه مع الكتالوج،
 *    فإن غيّر المالك اتجاه فئةٍ تُترك له ويُبلَّغ عنها في `skipped`.
 */
import { and, eq, isNull } from "drizzle-orm";
import { voucherCategories } from "../../../drizzle/schema";
import {
  DEFAULT_VOUCHER_CATEGORIES,
  type DefaultVoucherCategory,
} from "../../../shared/voucherCategoryDefaults";
import type { Tx } from "../../db";
import { withTx } from "../tx";

export interface EnsureDefaultCategoriesResult {
  /** فئات أُنشئت الآن. */
  inserted: string[];
  /** فئات قائمة كانت بلا حساب مقابل فعُيِّن لها حساب الكتالوج. */
  mapped: string[];
  /** فئات قائمة بلا حساب مقابل لكن اتجاهها يخالف الكتالوج ⇒ تُترك لقرار المالك. */
  skipped: string[];
  /** إجمالي فئات الكتالوج الموجودة بعد التنفيذ. */
  total: number;
}

/** مطابقة الاسم كما في DB: تُقلَّم الأطراف والحالة غير مؤثّرة (ترتيب utf8mb4_*_ci). */
function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ar");
}

/**
 * يضمن وجود كل فئة في الكتالوج داخل معاملةٍ واحدة (يقبل `tx` جاهزة للاستعمال ضمن معاملة أكبر).
 * لا يحذف ولا يعطّل شيئاً — التقاعد قرارٌ لمرّةٍ واحدة تملكه هجرة 0202 وحدها.
 */
export async function ensureDefaultVoucherCategoriesInTx(
  tx: Tx,
): Promise<EnsureDefaultCategoriesResult> {
  // قفل الجدول منطقياً بقراءةٍ حابسة: تشغيلان متزامنان (بذرة + زرّ الاستعادة) لا يتسابقان على
  // نفس الاسم فيسقط أحدهما بـER_DUP_ENTRY. القيد الفريد يبقى الحارس الأخير.
  const existing = await tx
    .select({
      id: voucherCategories.id,
      name: voucherCategories.name,
      direction: voucherCategories.direction,
      postingRole: voucherCategories.postingRole,
    })
    .from(voucherCategories)
    .for("update");

  const byName = new Map(existing.map((row) => [nameKey(row.name), row]));
  const result: EnsureDefaultCategoriesResult = {
    inserted: [],
    mapped: [],
    skipped: [],
    total: 0,
  };

  const missing: DefaultVoucherCategory[] = [];
  for (const def of DEFAULT_VOUCHER_CATEGORIES) {
    const current = byName.get(nameKey(def.name));
    if (!current) {
      missing.push(def);
      continue;
    }
    result.total += 1;
    if (current.postingRole) continue;
    if (current.direction !== def.direction) {
      result.skipped.push(def.name);
      continue;
    }
    await tx
      .update(voucherCategories)
      .set({ postingRole: def.postingRole })
      .where(
        and(
          eq(voucherCategories.id, Number(current.id)),
          isNull(voucherCategories.postingRole),
        ),
      );
    result.mapped.push(def.name);
  }

  if (missing.length) {
    await tx.insert(voucherCategories).values(
      missing.map((def) => ({
        name: def.name,
        direction: def.direction,
        postingRole: def.postingRole,
        description: def.description,
        sortOrder: def.sortOrder,
        isActive: true,
      })),
    );
    result.inserted = missing.map((def) => def.name);
    result.total += missing.length;
  }

  return result;
}

/** غلاف بمعاملته الخاصة — للبذرة والإجراء الخادميّ. */
export async function ensureDefaultVoucherCategories(): Promise<EnsureDefaultCategoriesResult> {
  return withTx((tx) => ensureDefaultVoucherCategoriesInTx(tx));
}
