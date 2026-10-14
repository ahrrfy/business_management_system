// navVisibility.ts — مصدر RBAC موحَّد للواجهة (تنقّل + تبويبات الـ hubs).
// يكرّر منطق AppLayout الثلاثي (adminOnly / managerOnly / roles) بالضبط في دالة واحدة
// قابلة لإعادة الاستخدام ⇒ لا تكرار بين الشريط الجانبي و PageTabs.
// ٦/٧/٢٦: أُضيف بُعد الوحدة (module/level): عنصرٌ فشل قيدُ دوره يظهر مع ذلك لمن مُنح
// وحدته صراحةً (permissionsOverride/دور مخصّص) — مرآةُ بوّابة الخادم requireModuleGate.
// ⚠️ راحة بصرية فقط — الإنفاذ الأمني الحقيقي خادمي (server/trpc.ts) + RequireRole.
import { hasModuleAccess, moduleAccessAllowed, POS_STATION_GATES, type AccessLevel, type PermissionMap, type RoleKey } from "@shared/permissions";
import {
  OPERATION_PERMISSIONS,
  getOperationPermission,
  type OperationPolicy,
} from "@shared/operationPermissions";

/** قيد وصول لعنصر تنقّل/تبويب — أيٌّ منها (أو لا شيء = مرئي للكل). */
export type RoleGate = {
  /** Exact operation paths when a page/tab has an explicit canonical contract. */
  operations?: string[];
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

/** بوابة محطة الاستقبال المشتركة للمسار والتبويبات وبطاقات الرئيسية. */
export const RECEPTION_STATION_GATE: RoleGate = {
  roles: [...POS_STATION_GATES.RECEPTION.allowedRoles],
  module: POS_STATION_GATES.RECEPTION.module,
  level: "FULL",
};

/** The credit screen initially creates approvals and loads its customer selectors. */
export const CREDIT_APPROVAL_CREATE_GATE: RoleGate = {
  allOf: ["creditApproval.create", "creditApproval.customerOptions", "creditApproval.listForCustomer"]
    .map(path => ({ operations: [path], managerOnly: true })),
};
export const CLOSING_ENTRY_GATE: RoleGate = {
  anyOf: [
    { operations: ["reports.monthlyClosePack", "reports.wipReport"], roles: ["admin", "manager", "accountant", "auditor"], module: "reports", level: "READ" },
    CREDIT_APPROVAL_CREATE_GATE,
  ],
};

/** Ordinary and digital sales have separate real execution paths. */
export const SALE_CREATION_OPERATION_GATE: RoleGate = {
  anyOf: [
    { operations: ["sales.create"] },
    { allOf: ["prepare", "getIntent", "claimExecution", "markExecution", "finalize"].map(
      (action) => ({ operations: [`digitalCards.sales.${action}`] }),
    ) },
  ],
};

/** Each return workflow must include the reads its editor performs. */
export const RETURNS_WORKSPACE_GATE: RoleGate = {
  anyOf: [
    {
      allOf: [
        { operations: ["returns.executeSalesReturnCart"] },
        { operations: ["returns.inspectInvoiceForReturn"] },
        { operations: ["returns.getOpenRefundDrawers"] },
        { operations: ["returns.lookupItemForReturn"] },
        { operations: ["returns.universalScan"] },
        { operations: ["returns.forensicTrace"] },
      ],
    },
    {
      allOf: [
        { operations: ["returns.executePurchaseReturnCart"] },
        { operations: ["returns.lookupItemForReturn"] },
        { operations: ["suppliers.list"] },
      ],
    },
    {
      allOf: [
        { operations: ["returns.getRequest"] },
        { operations: ["returns.getInvoice"] },
        { operations: ["returns.approveRequest"] },
      ],
    },
  ],
};

/** A governance action is usable only with its matching source/queue read. */
export const PURCHASE_RETURNS_GOVERNANCE_GATE: RoleGate = {
  anyOf: [
    { allOf: [{ operations: ["purchaseReturnGovernance.returnSources"] }, { operations: ["purchaseReturnGovernance.requestReturn"] }] },
    { allOf: [{ operations: ["purchaseReturnGovernance.reversalSources"] }, { operations: ["purchaseReturnGovernance.requestReversal"] }] },
    { allOf: [{ operations: ["purchaseReturnGovernance.pendingReturns"] }, { operations: ["purchaseReturnGovernance.decideReturn"] }] },
    { allOf: [{ operations: ["purchaseReturnGovernance.pendingReversals"] }, { operations: ["purchaseReturnGovernance.decideReversal"] }] },
  ],
};

/** Editors need their document read and at least one supported write action. */
export const EDITOR_OPERATION_GATES = {
  product: { allOf: [{ operations: ["catalog.getForVariantEdit"] }, { operations: ["catalog.updateProductVariants"] }] },
  customer: { allOf: [{ operations: ["customers.get"] }, { operations: ["customers.update"] }] },
  supplier: { allOf: [{ operations: ["suppliers.get"] }, { operations: ["suppliers.update"] }] },
  purchase: { allOf: [
    { operations: ["purchases.get"] },
    { operations: ["purchases.updateOrder"] },
    { operations: ["suppliers.get"] },
    { operations: ["suppliers.search"] },
  ] },
  asset: { allOf: [{ operations: ["assets.get"] }, { operations: ["assets.update"] }] },
  employee: { allOf: [{ operations: ["employees.get"] }, { operations: ["employees.update"] }] },
  quotation: { allOf: [{ operations: ["quotations.get"] }, { operations: ["quotations.update", "quotations.convert"] }] },
  correction: { allOf: [{ operations: ["sales.get"] }, { operations: ["catalog.byUnitIds"] }, { operations: ["sales.reissue", "salesControl.requestExchange"] }] },
} satisfies Record<string, RoleGate>;

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
  "/returns",
  "/work-orders",
  "/delivery",
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

export const AUDIT_LOGS_GATE: RoleGate = {
  roles: ["admin", "auditor"],
  operations: ["audit.list", "audit.facets"],
};

/**
 * هل يرى المستخدم (بدوره role وصلاحياته الممنوحة override) عنصراً يحمل القيد gate؟
 * قيد الدور يطابق حرفياً منطق AppLayout التاريخي، وmodule يفتح مساراً إضافياً بالمنح الصريح.
 */
export function canSeeGate(
  gate: RoleGate | undefined,
  role: string | null | undefined,
  override?: PermissionMap | null,
  operationPolicy?: OperationPolicy | null,
): boolean {
  if (!gate) return true;
  const isAdmin = role === "admin";
  // البوّابة المركّبة أولاً: تُقيَّم فروعُها بنفس الدالّة (تعشيشٌ مسموح) ⇒ مرآةٌ دقيقة لأيّ
  // بوّابةٍ خادمية «أو»-ية بلا ازدواج منطقٍ في الواجهة.
  if (gate.anyOf?.length) {
    return gate.anyOf.some((g) =>
      canSeeGate(g, role, override, operationPolicy),
    );
  }
  if (gate.allOf?.length) {
    return gate.allOf.every((g) =>
      canSeeGate(g, role, override, operationPolicy),
    );
  }
  // adminOnly حصري عمداً (إدارة النظام) — لا يُفتح بمنح وحدة.
  if (gate.adminOnly) return isAdmin;
  const operationAllowed = (operation: (typeof OPERATION_PERMISSIONS)[number]) =>
    operationPolicy?.grants[operation.key] === true &&
    (!operation.requiresCostVisibility ||
      (operationPolicy.dataVisibility?.purchaseCost === true &&
        operationPolicy.dataVisibility?.profitMargin === true));
  if (operationPolicy && gate.operations?.length)
    return gate.operations.some((path) => {
      const operation = getOperationPermission(path);
      return operation != null && operationAllowed(operation);
    });
  if (operationPolicy && gate.module) {
    return OPERATION_PERMISSIONS.some(
      (operation) =>
        operation.delegable &&
        (operation.navigationModule ?? operation.module)?.split("|").includes(gate.module!) &&
        // A cashier's shift helpers share treasury, but do not authorize its financial pages.
        (gate.module !== "treasury" || operation.domain === "treasury" ||
          ["cashTransfers.list", "cashTransfers.send", "vouchers.list", "vouchers.create", "voucherCategories.list", "shifts.list"].includes(operation.path)) &&
        // Mixed operational dashboards and lookup helpers are not a financial-report entry.
        (gate.module !== "reports" ||
          (operation.domain === "reports" && !["reports.dashboardMetrics", "reports.morningBrief"].includes(operation.path))) &&
        operationAllowed(operation),
    );
  }
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

/** محرّر التصحيح يحتاج قراءة الكتالوج، ويقبل مبيعات FULL أو محطة استقبال FULL. */
export const INVOICE_CORRECTION_GATE: RoleGate = {
  allOf: [
    { module: "products", level: "READ" },
    { anyOf: [
      { module: "sales", level: "FULL" },
      { module: "workorders", level: "FULL" },
    ] },
  ],
};

/** مدخل المطبعة الموحّد: طابور أوامر الشغل أو إدارة الإنتاج المخزني. */
export const WORK_ORDERS_HUB_GATE: RoleGate = {
  anyOf: [
    { module: "workorders" },
    { roles: ["manager"], module: "inventory", level: "FULL" },
  ],
};
