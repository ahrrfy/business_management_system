/**
 * أنماط جدول موحّدة — مصدرٌ وحيدٌ يستهلكه DataTable وجداولٌ يدوية باقية أثناء الترحيل.
 *
 * السبب: كانت الشاشات تعيد كتابة نفس classes الترويسة/الصف/الإجماليات بأنماط متفاوتة
 * (`bg-muted/50` vs `bg-slate-100`، `border-b` vs `border-t-2`، إلخ). النتيجة: كل جدول
 * بشكلٍ مختلف داخل نفس الحزمة. توحيد الثوابت هنا يعني: يكفي تعديلٌ واحد ليُغيَّر شكلها كلّها،
 * والحرّاس تمنع عودة نصوصٍ محلّية.
 *
 * الاستهلاك:
 *   ```tsx
 *   import { TABLE_HEAD_CLS, TABLE_ROW_HOVER_CLS, TABLE_TFOOT_CLS } from "@/components/data-table/tableStyles";
 *   <thead className={TABLE_HEAD_CLS}>…</thead>
 *   ```
 */

/** كلاس ترويسة الجدول: خلفية باهتة + سُمك + محاذاة اتّجاه القراءة (RTL يعطي `text-start`). */
export const TABLE_HEAD_CLS =
  "bg-muted/50 text-xs font-bold text-foreground border-b border-border/80";

/** hover للصف — استعماله على `<tr>` يظهر تفاعلاً بصرياً بلا نقل تركيز/تفاعل نقر. */
export const TABLE_ROW_HOVER_CLS =
  "hover:bg-muted/30 transition-colors";

/** صف الإجماليات في `<tfoot>` — تمييز بصريّ واضح مع حدٍّ علويّ سميك. */
export const TABLE_TFOOT_CLS =
  "bg-muted/40 font-bold border-t-2 border-border";

/**
 * كلاس الصف zebra — تخطيط بديل للصفوف الفردية. **اختياريّ**: بعض الجداول (كثيفة/رقمية)
 * تُقرأ أفضل بـzebra؛ الجداول قليلة الأعمدة تقرأ أفضل بلاه.
 */
export const TABLE_ROW_ZEBRA_CLS =
  "even:bg-muted/10";

/** كلاس الخلية الرقمية — RTL: `text-end` (يمين للأرقام) + `tabular-nums` (محاذاة عمودية). */
export const TABLE_CELL_NUMERIC_CLS =
  "text-end tabular-nums";
