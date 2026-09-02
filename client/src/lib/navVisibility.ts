// navVisibility.ts — مصدر RBAC موحَّد للواجهة (تنقّل + تبويبات الـ hubs).
// يكرّر منطق AppLayout الثلاثي (adminOnly / managerOnly / roles) بالضبط في دالة واحدة
// قابلة لإعادة الاستخدام ⇒ لا تكرار بين الشريط الجانبي و PageTabs.
// ٦/٧/٢٦: أُضيف بُعد الوحدة (module/level): عنصرٌ فشل قيدُ دوره يظهر مع ذلك لمن مُنح
// وحدته صراحةً (permissionsOverride/دور مخصّص) — مرآةُ بوّابة الخادم requireModuleGate.
// ⚠️ راحة بصرية فقط — الإنفاذ الأمني الحقيقي خادمي (server/trpc.ts) + RequireRole.
import { hasModuleAccess, moduleAccessAllowed, type AccessLevel, type PermissionMap, type RoleKey } from "@shared/permissions";

/** قيد وصول لعنصر تنقّل/تبويب — أيٌّ منها (أو لا شيء = مرئي للكل). */
export type RoleGate = {
  /** مرئي لـ admin فقط. */
  adminOnly?: boolean;
  /** مرئي لـ admin أو manager. */
  managerOnly?: boolean;
  /** مرئي لأحد هذه الأدوار (admin يرى دائماً). */
  roles?: RoleKey[];
  /** مفتاح وحدة الصلاحيات — المنح الصريح لها (بالمستوى level) يُظهر العنصر ولو فشل قيد الدور. */
  module?: string;
  /** المستوى الأدنى المطلوب مع module (الافتراضي READ). */
  level?: AccessLevel;
  /**
   * بوّابةٌ مركّبة: يمرّ العنصر إن مرّت **أيّ** بوّابةٍ فرعية (١٩/٨).
   *
   * لزمت حين صار للفواتير نطاقٌ ثلاثيّ على الخادم (`invoiceViewScopeForUser`): مبيعاتٌ
   * كاملة، أو نطاقُ محطّة الاستقبال (`workorders:FULL`)، أو نطاقُ محطة الطباعة (`pos:FULL`).
   * بلا هذا التركيب كان مدخل «المبيعات» يحتاج بوّابةً واحدة فيخفى عمّن يملك نطاقاً آخر —
   * أي أنّ الشاشة تُرفض عرضاً على من يقبله الخادم فعلاً.
   */
  anyOf?: RoleGate[];
  /** بوّابة مركّبة تقاطعية: لا يظهر العنصر إلا إذا مرّت كل الفروع. */
  allOf?: RoleGate[];
};

/**
 * قائمةُ مداخل الكاشير البيضاء — **إتاحةُ وصولٍ لا منحُ صلاحية**.
 *
 * شريط الكاشير يُقصَر على مداخل عمله كي لا يغرق في تنقّلٍ لا يخصّه، لكنّ كلّ مدخلٍ هنا
 * يبقى محكوماً ببوّابته عبر `canSeeGate` — فوجودُ المسار في القائمة لا يُظهره لمن لا
 * يملك وحدته.
 *
 * ⚠️ **الخطر الذي أثبتته التجربة مرّتين:** القائمة تُصفّي **بعد** البوّابة، فمسارٌ غائبٌ
 * عنها يختفي عن الكاشير **ولو قبِله الخادم صراحةً**. هكذا اختفى مدخل الاستوديو عن موظّفٍ
 * مُنح `productStudio` صراحةً وأُسندت إليه مهمّة فعلاً: وصله الإشعار ولم يجد باباً
 * (بلاغ إنتاج ٢٠/٨). و`invoiceNavGate.test.ts` يحرس النصف الآخر من العطب نفسه.
 *
 * ⇒ **مصدَّرةٌ ليحرسها اختبار**: أيّ مسارٍ يقبله الخادم لدورٍ قاعدتُه `cashier` بمنحٍ
 * صريح **يجب** أن يكون هنا، وإلّا كان وعدُ الصلاحية كاذباً.
 */
export const CASHIER_NAV_PATHS: readonly string[] = Object.freeze([
  // يظهر لكل دور — البوّابة `protectedProcedure` والمحتوى يُصفّى خادمياً بصلاحية كل مصدر.
  "/my-work",
  "/pos",
  "/price-checker",
  "/invoices",
  "/work-orders",
  "/delivery",
  "/tasks",
  // ٢٠/٨: `assignStudioTask` يقبل أيّ موظّفٍ يملك `productStudio:FULL` — بمنحٍ صريح ولو كان
  // دورُه القالبيّ `cashier`؛ وشاشةُ الاستوديو تقبله كذلك. القائمة وحدها كانت تحجب المدخل.
  "/catalog/image-studio",
]);

/**
 * التقارير التشخيصية وإجراءات قطع/تفعيل الدفتر تشارك سطحاً واحداً؛ القراءة
 * خادميّاً adminProcedure والكتابة تضيف FULL + 2FA، لذلك لا يظهر التبويب لمدير.
 */
export const RECONCILE_CONTROL_GATE = Object.freeze({
  adminOnly: true,
}) satisfies RoleGate;

/**
 * هل يرى المستخدم (بدوره role وصلاحياته الممنوحة override) عنصراً يحمل القيد gate؟
 * قيد الدور يطابق حرفياً منطق AppLayout التاريخي، وmodule يفتح مساراً إضافياً بالمنح الصريح.
 */
export function canSeeGate(
  gate: RoleGate | undefined,
  role: string | null | undefined,
  override?: PermissionMap | null
): boolean {
  if (!gate) return true;
  const isAdmin = role === "admin";
  // البوّابة المركّبة أولاً: تُقيَّم فروعُها بنفس الدالّة (تعشيشٌ مسموح) ⇒ مرآةٌ دقيقة لأيّ
  // بوّابةٍ خادمية «أو»-ية بلا ازدواج منطقٍ في الواجهة.
  if (gate.anyOf?.length) {
    return gate.anyOf.some((g) => canSeeGate(g, role, override));
  }
  if (gate.allOf?.length) {
    return gate.allOf.every((g) => canSeeGate(g, role, override));
  }
  // adminOnly حصري عمداً (إدارة النظام) — لا يُفتح بمنح وحدة.
  if (gate.adminOnly) return isAdmin;
  // بوّابة الوحدة تُحسم بالخريطة المحلولة (قالب الدور + المنح الصريح) — تدقيق ١٧/٧: كان القيد بلا قيود
  // دور يعيد true فراغياً (roleOk صحيح فراغياً) فيُظهر تبويبات module-only لكل الأدوار وإن رفضها الخادم
  // بـ403؛ كما كان يستشير المنح الصريح (override) وحده لا قالب الدور. الآن يطابق الخادم بدقّة:
  //   مع قيد دور ⇒ مرآة requireModuleGate (منح صريح للأدوار خارج القائمة)؛ بلا قيد دور ⇒ مرآة requireModule (القالب).
  if (gate.module) {
    const lvl = gate.level ?? "READ";
    if (gate.roles) {
      return moduleAccessAllowed(role ?? "", override, gate.module, lvl, gate.roles);
    }
    if (gate.managerOnly) {
      return moduleAccessAllowed(role ?? "", override, gate.module, lvl, ["manager"]);
    }
    return hasModuleAccess(role ?? "", override, gate.module, lvl);
  }
  if (gate.managerOnly) return isAdmin || role === "manager";
  if (gate.roles) return isAdmin || (role != null && gate.roles.includes(role as RoleKey));
  // لا قيد دور ولا وحدة ⇒ مرئي للكل.
  return true;
}

/**
 * بوّابة **قائمة الفواتير** — مرآةُ `invoiceViewScopeForUser` على الخادم (١٩/٨).
 *
 * الخادم يمنح ثلاثة نطاقات: مبيعاتٌ كاملة (`sales≥READ`)، أو نطاقُ محطة الاستقبال
 * (`workorders:FULL` ⇒ فواتير ورديات RECEPTION وحدها)، أو نطاقُ محطة الطباعة
 * (`pos:FULL` ⇒ فواتير ورديات PRINT_SERVICES). القاصُّ هو **القناة** لا المنع:
 * كلٌّ يرى ما أصدرته محطّته ولا يُفتَح له بابٌ على غيرها.
 *
 * ⛔ لا تُعدَّل هنا وحدها: أيّ تغييرٍ في نطاقات الخادم يلزمه تغييرٌ مطابق هنا وإلا
 * ظهر مدخلٌ يُرفَض بـ403 أو اختفى مدخلٌ يقبله الخادم. يحرس التطابقَ اختبارٌ مخصّص.
 */
export const INVOICE_LIST_GATE: RoleGate = {
  anyOf: [
    { module: "sales" },
    { module: "workorders", level: "FULL" },
    { module: "pos", level: "FULL" },
  ],
};

/** مدخل المطبعة الموحّد: طابور أوامر الشغل أو إدارة الإنتاج المخزني. */
export const WORK_ORDERS_HUB_GATE: RoleGate = {
  anyOf: [
    { module: "workorders" },
    { roles: ["manager"], module: "inventory", level: "FULL" },
  ],
};
