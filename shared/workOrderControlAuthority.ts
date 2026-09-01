/**
 * **سلطةُ التحكّم في أمر الشغل — قاموسٌ واحد يقرأه الخادمُ والشاشة** (١/٩/٢٦، قرار المالك).
 *
 * كانت البوّابات مبعثرةً: الراوتر يختار إجراءً، والشاشة تُعيد بناء نفس الشرط بيدها
 * (`canCancelWorkOrder`, `canDeliverWorkOrder`, `canRequestControl`…). فحين وُسّعت السلطةُ
 * لفنّي المطبعة كان لا بدّ من تعديل موضعَين لا يعرف أحدهما الآخر — وهو بالضبط نمطُ
 * «الشاشة تحجب ما يملكه الخادم» الذي أُغلق في #911. المصدر هنا واحد، والإنفاذُ خادميٌّ دائماً.
 *
 * **قرار المالك (١/٩/٢٦):** فنّي المطبعة أقربُ الناس إلى العميل — هو أوّل من يتحدّث معه عن
 * الطلب والتنفيذ، وإليه يتّصل العميلُ ليُلغي. فله **إلغاءُ الطلب**، على أن يمرّ الإلغاءُ
 * باعتماد مديرٍ/مسؤول **متى كان في الطلب عربونٌ أو نقد** — لأنّ المالَ لا يخرج إلّا بيد من
 * يملك الدرج والمسؤولية (§٥: لكلّ دينارٍ مسارٌ وفاعلٌ منسوبٌ إليه).
 *
 * وما عدا الإلغاء (تعديلٌ تجاريّ، تعديلُ خامة، عكسُ تسليم) يبقى على أهله — كاشير/مدير —
 * فتوسيعُ الإلغاء لا يُوسّع معه بابَ التسعير والفوترة والعكس.
 */
import { hasModuleAccess, moduleAccessAllowed, type PermissionMap } from "./permissions";

export const WORK_ORDER_CONTROL_TYPES = [
  "COMMERCIAL_EDIT",
  "MATERIAL_ADJUST",
  "CANCEL",
  "REVERSE_DELIVERY",
] as const;

export type WorkOrderControlTypeKey = (typeof WORK_ORDER_CONTROL_TYPES)[number];

/** أدوارُ التنفيذ — تشمل فنّي المطبعة (مرآة `workordersExecProcedure`). */
export const WORK_ORDER_EXEC_ROLES = ["cashier", "manager", "print_operator"] as const;
/** أدوارُ المال والتعديل التجاريّ (مرآة `workordersCashierProcedure`). */
export const WORK_ORDER_COMMERCIAL_ROLES = ["cashier", "manager"] as const;
/** مديرُ الوحدة (مرآة `workordersManagerProcedure`). */
export const WORK_ORDER_MANAGER_ROLES = ["manager"] as const;
/**
 * **الإلغاءُ المباشر** (مرآة `workordersDirectCancelProcedure`): مدير أو فنّي مطبعة.
 *
 * ⛔ **الكاشير خارجها عمداً.** قرارُ المالك أضاف صلاحيةً للفنّي، ولم يُعِد توزيعَ السلطة؛
 * ومسارُ الكاشير يبقى `requestControl` كما كان — وهو عقدُ RBAC مُختبَرٌ صراحةً.
 */
export const WORK_ORDER_DIRECT_CANCEL_ROLES = ["manager", "print_operator"] as const;

type Override = PermissionMap | null | undefined;

function allowed(role: string | null | undefined, override: Override, roles: readonly string[]): boolean {
  return (
    !!role &&
    moduleAccessAllowed(role, (override ?? null) as PermissionMap | null, "workorders", "FULL", roles)
  );
}

/** تنفيذُ المراحل (سحب/بدء/جاهز) + طلبُ الإلغاء — يشمل فنّي المطبعة. */
export function hasWorkOrderExecAuthority(role: string | null | undefined, override: Override): boolean {
  return allowed(role, override, WORK_ORDER_EXEC_ROLES);
}

/** المال والتعديل التجاريّ والتسليم والفوترة — كاشير/مدير. */
export function hasWorkOrderCommercialAuthority(role: string | null | undefined, override: Override): boolean {
  return allowed(role, override, WORK_ORDER_COMMERCIAL_ROLES);
}

/** مَن يجوز له محاولةُ إلغاءٍ مباشر أصلاً — قبل النظر في حالة الأمر أو ماله. */
export function hasWorkOrderDirectCancelAuthority(
  role: string | null | undefined,
  override: Override,
): boolean {
  return allowed(role, override, WORK_ORDER_DIRECT_CANCEL_ROLES);
}

/** سلطةُ المدير: اعتمادُ طلبات التحكّم، والإلغاءُ المباشر بحدوده القائمة. */
export function hasWorkOrderManagerAuthority(role: string | null | undefined, override: Override): boolean {
  return allowed(role, override, WORK_ORDER_MANAGER_ROLES);
}

/**
 * مَن يفتح طلبَ تحكّمٍ من أيّ نوع. الإلغاءُ وحده مفتوحٌ لأدوار التنفيذ (فنّي المطبعة)؛
 * وما سواه يبقى على كاشير/مدير.
 */
export function mayRequestWorkOrderControl(
  requestType: WorkOrderControlTypeKey,
  role: string | null | undefined,
  override: Override,
): boolean {
  if (hasWorkOrderCommercialAuthority(role, override)) return true;
  return requestType === "CANCEL" && hasWorkOrderExecAuthority(role, override);
}

/** رسالةُ الرفض — تقول لِمَ مُنع وما البديل، لا «ليس لديك صلاحية» عمياء. */
export function workOrderControlDeniedMessage(requestType: WorkOrderControlTypeKey): string {
  switch (requestType) {
    case "CANCEL":
      return "طلب إلغاء أمر الشغل محصور بمن يملك تنفيذ طلبات الخدمة (كاشير/مدير/فنّي مطبعة)";
    case "REVERSE_DELIVERY":
      return "طلب عكس التسليم محصور بكاشير أو مدير — الفنّي يطلب الإلغاء قبل التسليم فقط";
    default:
      return "تعديل بنود الأمر أو مواده محصور بكاشير أو مدير — الفنّي يطلب الإلغاء فقط";
  }
}

/**
 * **الإفصاح عن أرصدة الأدراج** — `treasury:READ` لا سلطةُ أمر الشغل.
 *
 * الأدراجُ تُعرَض لكلّ من يملك الفعل (وإلّا انسدّ بابُ اختيار الدرج)، لكنّ **الرقم** يبقى
 * على مالك الخزينة. مَن حُجب عنه يكفيه علَمُ `sufficient` (`shared/refundPreflight.ts`).
 *
 * ⚠️ **لا تُمرّر قائمةَ أدوارٍ لـ`moduleAccessAllowed` هنا**: تخطّي `hasModuleAccess` يحجب
 * رقمَ مديرٍ قالبُه `treasury: FULL` بلا تجاوز (مراجعة Codex P2 على #928).
 */
export function maySeeDrawerCash(
  role: string | null | undefined,
  override: Override,
): boolean {
  if (String(role ?? "") === "admin") return true;
  return hasModuleAccess(
    String(role ?? ""),
    (override ?? null) as PermissionMap | null,
    "treasury",
    "READ",
  );
}

/**
 * **الإلغاءُ المباشر بلا اعتماد** — شرطُ المالك حرفياً: أمرٌ لم يبدأ تنفيذُه ولا مالَ فيه.
 *
 * ⚠️ متعمَّدٌ ألّا يُقاس على `controlRequired.cancel` (بوّابةُ المدير): تلك تشترط زيادةً
 * **خلوّ الأمر من أسطر خامة** ولو كانت مخطَّطةً لم تُستهلَك بعد — وهو تشدّدٌ لا أثرَ له في
 * `RECEIVED` (الإلغاء لا يمسّ المخزون إلّا من `IN_PROGRESS`/`READY`). ولمّا كان أغلبُ أوامر
 * الطباعة يحمل أسطرَ خامةٍ منذ الإنشاء، فقياسُ الفنّي عليها كان يُلغي الصلاحيةَ عملياً.
 */
export function mayCancelWorkOrderWithoutApproval(input: {
  role: string | null | undefined;
  override: Override;
  status: string;
  /** هل يستدعي الإلغاءُ خروجَ مالٍ أو تحرير أمانة؟ يحسبه الخادم في `controlPreflight`. */
  moneyAtStake: boolean;
  /** بوّابةُ المدير القائمة كما يحسبها الخادم (`controlRequired.cancel`). */
  managerControlRequired: boolean;
}): boolean {
  if (input.moneyAtStake) return false;
  // مَن لا يملك الإلغاءَ المباشر أصلاً (الكاشير مثلاً) ⇒ مسارُه الطلبُ والاعتماد.
  if (!hasWorkOrderDirectCancelAuthority(input.role, input.override)) return false;
  // المديرُ يبقى على بوّابته القائمة حرفياً — لا توسيعَ ولا تضييقَ لسلطةٍ قائمة.
  if (hasWorkOrderManagerAuthority(input.role, input.override)) return !input.managerControlRequired;
  // الفنّي: أمرٌ لم يبدأ ولا مالَ فيه ⇒ إلغاءٌ مباشر بسببٍ مكتوب.
  return input.status === "RECEIVED";
}
