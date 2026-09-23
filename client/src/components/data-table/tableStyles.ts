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

/** كلاس ترويسة الجدول: خلفية باهتة + سُمك + محاذاة اتّجاه القراءة (RTL يعطي `text-start`) + تعامد رأسي. */
export const TABLE_HEAD_CLS =
  "bg-muted/50 text-xs font-bold text-foreground border-b border-border/80 align-middle";

/** hover للصف — استعماله على `<tr>` يظهر تفاعلاً بصرياً بلا نقل تركيز/تفاعل نقر. */
export const TABLE_ROW_HOVER_CLS =
  "hover:bg-muted/30 transition-colors";

/** صف الإجماليات في `<tfoot>` — تمييز بصريّ واضح مع حدٍّ علويّ سميك. */
export const TABLE_TFOOT_CLS =
  "bg-muted/40 font-bold border-t-2 border-border align-middle";

/**
 * كلاس الصف zebra — تخطيط بديل للصفوف الفردية. **اختياريّ**: بعض الجداول (كثيفة/رقمية)
 * تُقرأ أفضل بـzebra؛ الجداول قليلة الأعمدة تقرأ أفضل بلاه.
 */
export const TABLE_ROW_ZEBRA_CLS =
  "even:bg-muted/10";

/** كلاس الخلية الرقمية — RTL: `text-end` (يسار في RTL لتراصف المراتب العشرية اللاتينية) + `tabular-nums`. */
export const TABLE_CELL_NUMERIC_CLS =
  "text-end tabular-nums";

/** فواصل شبكية لرؤوس الأعمدة (Full-Bordered / Grid Table) — تدعم RTL منطقياً بـ border-e */
export const TABLE_GRID_HEAD_BORDER_CLS =
  "[&:not(:last-child)]:border-e [&:not(:last-child)]:border-border/70";

/** فواصل شبكية لخلايا الأعمدة (Full-Bordered / Grid Table) — تدعم RTL منطقياً بـ border-e */
export const TABLE_GRID_CELL_BORDER_CLS =
  "[&:not(:last-child)]:border-e [&:not(:last-child)]:border-border/45";

/** إطار الجدول الشبكي الأصولي الخارجي */
export const TABLE_GRID_FRAME_CLS =
  "rounded-md border border-border/80 shadow-xs";
