/**
 * أعمدة الإسناد الموحّدة — **جواب شكوى المالك (١/٩/٢٦)**:
 * «الجداول لا تظهر المعلومات المرادة والمتفق عليها: مَن نفّذ ومَن قام ومَن المستفيد
 *  والجهة الأخرى».
 *
 * القياس الذي أثبتها: `check:operation-attribution` يقول **٧ جداول بإسنادٍ داخل الصفّ من
 * أصل ٢٦١ سطحاً**. أي أنّ ٢٥٤ سطحاً يعرض حركةً ماليّة أو مخزنيّة **بلا اسمٍ لفاعلها**،
 * والموظّف يفتح «سجلّ الشاشة العامّ» ليعرف مَن فعل ماذا — وهو ما لا يفعله أحد عملياً.
 *
 * ⭐ لماذا **أربعة** أعمدة لا عمودٌ واحد اسمه «المستخدم»:
 * صفٌّ يعرض اسماً واحداً لا يقول أهو الفاعل أم المستفيد. الحركة الواحدة لها أربعة أدوار
 * متمايزة، وخلطُها هو جوهر «المعلومات غير المرادة»:
 *
 *   • `performedBy`  «نفّذها»      — مَن ضغط الزرّ (مسؤولية تشغيلية).
 *   • `beneficiary`  «المستفيد»    — لمن وقع الأثر (وجهة القيمة).
 *   • `counterparty` «الطرف الآخر» — الطرف المقابل في المستند.
 *   • `approvedBy`   «اعتمدها»     — مَن اعتمد حين يفصل SOD المُنشئ عن المُعتمِد.
 *
 * التسميات تُقرأ من `@shared/uiContracts` وحده ⇒ العمود يحمل نفس الاسم على الشاشة وفي
 * تصدير Excel وفي الورقة المطبوعة.
 *
 * ⛔ لا تكتب عمود إسنادٍ يدوياً (`header: "المستخدم"`) — استعمل هذه البواني.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { ActorCell, actorLabel, type OperationActor } from "@/components/data-table/ActorCell";
import { ATTRIBUTION_LABELS } from "@shared/uiContracts";
import { fmtDateTime } from "@/lib/date";

/** يستخرج الفاعل من الصفّ؛ يُرجع `null` حين لا إسناد (فيُعرض «غير موثّق» لا شرطة مبهمة). */
export type ActorAccessor<T> = (row: T) => OperationActor | null | undefined;

type BuildOptions = {
  /** تسمية بديلة حين يكون الدور أدقّ في سياق الشاشة («البائع» بدل «نفّذها»). */
  header?: string;
  /** يُخفي العمود افتراضياً في `columnVisibility` (يبقى متاحاً في منتقي الأعمدة). */
  id?: string;
};

function actorColumn<T>(
  role: keyof typeof ATTRIBUTION_LABELS,
  accessor: ActorAccessor<T>,
  options: BuildOptions = {},
): ColumnDef<T, unknown> {
  return {
    id: options.id ?? role,
    header: options.header ?? ATTRIBUTION_LABELS[role],
    // الفرز والتصدير على النصّ المقروء لا على الكائن.
    accessorFn: (row) => actorLabel(accessor(row)),
    cell: ({ row }) => <ActorCell actor={accessor(row.original)} />,
    meta: { kind: "actor", width: "actor" },
  };
}

/** «نفّذها» — مَن قام بالعملية في النظام. */
export function performedByColumn<T>(accessor: ActorAccessor<T>, options?: BuildOptions) {
  return actorColumn("performedBy", accessor, options);
}

/** «المستفيد» — الطرف الذي وقع الأثر لصالحه (عميل/موظّف/مندوب). */
export function beneficiaryColumn<T>(accessor: ActorAccessor<T>, options?: BuildOptions) {
  return actorColumn("beneficiary", accessor, options);
}

/** «الطرف الآخر» — المورّد/الجهة الخارجية/الفرع المقابل. */
export function counterpartyColumn<T>(accessor: ActorAccessor<T>, options?: BuildOptions) {
  return actorColumn("counterparty", accessor, options);
}

/** «اعتمدها» — المُعتمِد حين يفصل فصلُ المهام المُنشئَ عن المُعتمِد. */
export function approvedByColumn<T>(accessor: ActorAccessor<T>, options?: BuildOptions) {
  return actorColumn("approvedBy", accessor, options);
}

/** «التوقيت» — لحظة وقوع الحركة، بتنسيقٍ واحد عبر النظام. */
export function occurredAtColumn<T>(
  accessor: (row: T) => string | Date | null | undefined,
  options: BuildOptions = {},
): ColumnDef<T, unknown> {
  return {
    id: options.id ?? "occurredAt",
    header: options.header ?? ATTRIBUTION_LABELS.at,
    accessorFn: (row) => {
      const at = accessor(row);
      return at ? fmtDateTime(at) : "غير موثّق";
    },
    meta: { kind: "datetime", width: "date" },
  };
}

/**
 * بانٍ مُجمَّع — يُنتج أعمدة الإسناد الموجودة فقط، بالترتيب الدلاليّ الثابت:
 * نفّذها ← اعتمدها ← المستفيد ← الطرف الآخر ← التوقيت.
 *
 * الترتيب ثابتٌ عمداً: الموظّف يقرأ نفس التسلسل في كل شاشة، فلا يبحث عن العمود في كل مرّة.
 *
 * @example
 * columns={[...myCols, ...attributionColumns<Row>({
 *   performedBy: (r) => ({ userId: r.createdBy, name: r.createdByName, at: r.createdAt }),
 *   beneficiary: (r) => ({ name: r.customerName }),
 *   at: (r) => r.createdAt,
 * })]}
 */
export function attributionColumns<T>(spec: {
  performedBy?: ActorAccessor<T>;
  approvedBy?: ActorAccessor<T>;
  beneficiary?: ActorAccessor<T>;
  counterparty?: ActorAccessor<T>;
  at?: (row: T) => string | Date | null | undefined;
  /** تسميات بديلة لكل دور («البائع» بدل «نفّذها»). */
  headers?: Partial<Record<"performedBy" | "approvedBy" | "beneficiary" | "counterparty" | "at", string>>;
}): ColumnDef<T, unknown>[] {
  const out: ColumnDef<T, unknown>[] = [];
  const h = spec.headers ?? {};
  if (spec.performedBy) out.push(performedByColumn(spec.performedBy, { header: h.performedBy }));
  if (spec.approvedBy) out.push(approvedByColumn(spec.approvedBy, { header: h.approvedBy }));
  if (spec.beneficiary) out.push(beneficiaryColumn(spec.beneficiary, { header: h.beneficiary }));
  if (spec.counterparty) out.push(counterpartyColumn(spec.counterparty, { header: h.counterparty }));
  if (spec.at) out.push(occurredAtColumn(spec.at, { header: h.at }));
  return out;
}
