import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { toArabicMessage } from "@shared/errorMap.ar";
import { canSeeCost as _canSeeCost, resolvePermissions, type AccessLevel, type RoleKey } from "@shared/permissions";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { logger } from "./logger";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error, ctx, path }) {
    const arabic = toArabicMessage({
      trpcCode: error.code,
      originalMessage: error.message,
      cause: error.cause,
    });
    const correlationId = (ctx?.req as { id?: string } | undefined)?.id ?? null;
    if (error.code === "INTERNAL_SERVER_ERROR") {
      logger.error({ err: error.cause ?? error, path, correlationId }, `tRPC error: ${path}`);
    } else if (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED") {
      // F5 (تدقيق ١٤/٦/٢٦): محاولات التجاوز الفاشلة كانت تمرّ صامتة ⇒ لا أثر forensic.
      // نُسجِّل في pino البنيوي (best-effort، خفيف، بلا i/o إضافي على القاعدة).
      // إن لزم لاحقاً سجلٌّ دائم: interceptor مستقلّ يكتب في auditLogs (errorFormatter sync).
      logger.warn(
        { path, correlationId, userId: ctx?.user?.id ?? null, role: ctx?.user?.role ?? null, code: error.code, message: error.message },
        `authz denied: ${path}`,
      );
    }
    return { ...shape, message: arabic, data: { ...shape.data, correlationId } };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(requireUser);

const requireAdmin = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const adminProcedure = t.procedure.use(requireAdmin);

// ─── مدير المنصّة (تعدّد الشركات) — منفصل تماماً عن أدوار أي شركة ──────────
const requirePlatformAdmin = t.middleware(async ({ ctx, next }) => {
  if (!ctx.platformAdmin) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  return next({ ctx: { ...ctx, platformAdmin: ctx.platformAdmin } });
});

export const platformAdminProcedure = t.procedure.use(requirePlatformAdmin);

// ─── تفويض الأدوار (RBAC) ───────────────────────────────────────────────
const FORBIDDEN_MSG = "صلاحيات غير كافية لهذا الإجراء.";

function requireRole(...allowed: string[]) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    if (ctx.user.role !== "admin" && !allowed.includes(ctx.user.role)) {
      throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    }
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

/** إنفاذ وحدة بمستوى وصول — يستخدم الخريطة المحسوبة (قالب + override). */
export function requireModule(moduleKey: string, minLevel: AccessLevel) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    if (ctx.user.role === "admin") return next({ ctx: { ...ctx, user: ctx.user } });
    const override = (ctx.user as any).permissionsOverride as Record<string, AccessLevel> | null;
    const map = resolvePermissions(ctx.user.role as RoleKey, override);
    const level = map[moduleKey] ?? "NONE";
    const allowed = level === "FULL" || (minLevel === "READ" && level === "READ");
    if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

/** عمليات إدارية/مالية: المدير فأعلى (توافق خلفي كامل). */
export const managerProcedure = t.procedure.use(requireRole("manager"));

/**
 * RBAC-REPORTS (تدقيق ٢/٧): التقارير كانت مقفلة بـmanagerProcedure حصراً ⇒ دورا «محاسب» و«مدقّق»
 * المعلَنان (قالبهما reports=FULL/READ) لا يصلان أي تقرير — الدور بلا فائدة. نسمح لهذه الأدوار الثلاثة
 * ثم نُنفِذ خريطة الصلاحية (requireModule) — فالمحاسب/المدقّق (والدور المخصّص أساسه أحدها) يصل حسب خريطته.
 */
export const reportViewerProcedure = t.procedure
  .use(requireRole("manager", "accountant", "auditor"))
  .use(requireModule("reports", "READ"))
  .use(async ({ ctx, getRawInput, next }) => {
    // عزل الفرع: admin يعبُر أي فرع؛ غير الأدمن يُرفَض إن طلب فرعاً غير فرعه (أثر forensic صريح
    // بدل قصٍّ صامت) — مرآةٌ لِمنطق managerBranchScopedProcedure الذي كان يحرس هذه التقارير.
    if (!ctx.user || ctx.user.role === "admin") return next({ ctx });
    const raw = (await getRawInput()) as { branchId?: number | string } | undefined;
    const requestedBranch = raw?.branchId;
    if (requestedBranch !== undefined && Number(requestedBranch) !== Number(ctx.user.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن قراءة بيانات فرع آخر" });
    }
    return next({ ctx });
  });
export const managerBranchScopedProcedure = managerProcedure.use(async ({ ctx, getRawInput, next }) => {
  if (ctx.user.role === "admin") return next({ ctx });
  // G7 (تدقيق ٢٣/٦/٢٦): `input` في middleware يَأتي parsed بعد `.input()` فقط. هذا middleware
  // يُسجَّل قبل `.input()` ⇒ `input` كان `undefined` دائماً والفحص يَمرّ صامتاً ⇒ المدير يَطلب
  // فرع آخر فيُعاد له بيانات فرعه (لا تَسريب فعلي بفضل scopedBranchId في الـhandler، لكن لا
  // FORBIDDEN forensic). `getRawInput()` يَصل للحمولة الخام قبل التحليل ⇒ الفحص يَعمل بحقّ.
  const raw = (await getRawInput()) as { branchId?: number | string } | undefined;
  const requestedBranch = raw?.branchId;
  if (requestedBranch !== undefined && Number(requestedBranch) !== Number(ctx.user.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "مدير الفرع لا يَستطيع قراءة بيانات فرع آخر" });
  }
  return next({ ctx });
});
// G3 (تدقيق ١٩/٦/٢٦): الكاشير والمخزن **يجب** أن يكون لهما فرع مُسنَد — لا معنى
// لتشغيل وردية/استلام بضاعة بلا فرع. كان غياب الفحص يتفاعل مع `?? 1` في الراوترات
// فيصبح المستخدم بلا فرع يكتب صامتاً على الفرع رقم ١ (IDOR). المدير/الأدمن مستثنيان
// لأن لهما حالات شرعية للعمل عبر الفروع.
const requireOwnBranch = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  if (ctx.user.role === "admin" || ctx.user.role === "manager") return next({ ctx: { ...ctx, user: ctx.user } });
  if (ctx.user.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** عمليات البيع/الصندوق: الكاشير فأعلى (مع فحص branchId إلزامي لغير المدير). */
export const cashierProcedure = t.procedure.use(requireRole("cashier", "manager")).use(requireOwnBranch);
/** عمليات المخزون: أمين المخزن فأعلى (مع فحص branchId إلزامي لغير المدير). */
export const warehouseProcedure = t.procedure.use(requireRole("warehouse", "manager")).use(requireOwnBranch);
/**
 * تنفيذ أوامر الشغل في المحطة (سحب/بدء/تجهيز): الكاشير/المدير + **فني المطبعة** (print_operator)،
 * بفرع مُسنَد إلزامي لغير المدير. لا يشمل التسليم/الفوترة (cashierProcedure حصراً — مالٌ ونقد).
 * عزلٌ إضافي في الخدمة: فني المطبعة يعمل على أوامره المُسنَدة إليه فقط (لا أوامر زملائه).
 */
export const workOrderExecProcedure = t.procedure
  .use(requireRole("cashier", "manager", "print_operator"))
  .use(requireOwnBranch);

/** هل يُسمح لهذا الدور برؤية التكلفة/هامش الربح؟ (يشمل المحاسب الآن). */
export const canSeeCost = (role: string) => _canSeeCost(role);

/**
 * RBAC-COST (تدقيق ٢/٧): رؤية التكلفة/الربح لمستخدمٍ بعينه — تحترم خريطة الدور المخصّص لا القالب فقط.
 * كان canSeeCost(role) يتبع baseRole ⇒ دور مخصّص أساسه manager يرى التكلفة رغم تقييد خريطته. الآن:
 * القالب لا يرى ⇒ لا (كما هو)، وإن كان دوراً مخصّصاً (له override) فالرؤية مشروطة بأن صلاحية «التقارير»
 * (نطاق التكلفة/الربح) ليست NONE. الأدوار القالبية (بلا override) بلا تغيير.
 */
export function canSeeCostForUser(user: { role: string; permissionsOverride?: unknown }): boolean {
  if (!_canSeeCost(user.role)) return false;
  const override = user.permissionsOverride as Record<string, AccessLevel> | null | undefined;
  if (!override) return true;
  const map = resolvePermissions(user.role as RoleKey, override);
  return (map.reports ?? "NONE") !== "NONE";
}

// ─── عزل الفروع (منع IDOR عبر branchId) ─────────────────────────────────
// F1 (تدقيق ١٤/٦/٢٦): استُبدِل magic value `-1` برميٍ صريح لـFORBIDDEN حين يحاول
// مستخدم غير-elevated الوصول وهو بلا فرع مُسنَد. كان `-1` يجعل الاستعلامات تُرجع
// `[]` صامتاً (المستخدم يرى «لا بيانات» بدل «ممنوع») ⇒ لا أثر forensic + سلوك مضلّل.
// الآن: المسار آمن، والـauthz failure يُسجَّل في pino عبر errorFormatter (F5).
export const branchScopedProcedure = protectedProcedure.use(({ ctx, next }) => {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  if (!elevated && ctx.user.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
  }
  const scopedBranchId = elevated ? null : Number(ctx.user.branchId);
  // ─── عزل سجلّات الموظف («يرى ما يخصّه فقط») — سياسة المالك (٢٤/٦/٢٦) ───
  // غير المرتفعين (كاشير/مندوب/فني…) يرون ما أنشأوه فقط في القوائم الترانزاكشنية
  // (فواتير/عروض/مصروفات/حركات مخزون/أوامر شغل). admin|manager = null = كل بيانات الفرع.
  // (نفس مجموعة elevated في عزل الفرع ⇒ اتّساق.) لا يشمل الكتالوج المشترك (منتجات/عملاء/موردون).
  const scopedOwnerId = elevated ? null : Number(ctx.user.id);
  return next({ ctx: { ...ctx, scopedBranchId, scopedOwnerId } });
});

// ─── F2 (تدقيق ٢/٧): إجراءات module-gated للوحدات غير المالية ──────────────────
// المشكلة: البوّابات الخشنة (managerProcedure/cashierProcedure/warehouseProcedure/…) تفحص الدور
// الأساس (baseRole) فقط عبر requireRole ⇒ دور مخصّص أساسه manager بخريطةٍ تُقيّد وحدةً (مثلاً
// inventory=NONE) كان يتجاوز القيد على تلك الوحدة (الخريطة وهم). الحلّ: نُركّب requireModule فوق
// البوّابة الخشنة القائمة (تحافظ على requireOwnBranch/عزل الفرع/عزل الموظف) فتُنفَّذ خريطة الدور
// المخصّص (القالب + override) لا الأساس فقط. admin يعبُر requireModule داخلياً. الأدوار القالبية
// (بلا override) بلا انحدار: resolvePermissions(role,null)=القالب يمنح المستوى (تُحقِّق منه §٤ في
// docs/audit-followups-2026-07-02.md). السابقة المعتمدة: conversationRouter (channels).
// الاصطلاح: query ⇒ READ، mutation ⇒ FULL.

// pos (نقطة بيع خدمات الطباعة — printPos)
export const posCashierProcedure = cashierProcedure.use(requireModule("pos", "FULL"));
// sales
export const salesReadProcedure = branchScopedProcedure.use(requireModule("sales", "READ"));
export const salesCashierProcedure = cashierProcedure.use(requireModule("sales", "FULL"));
export const salesManagerProcedure = managerProcedure.use(requireModule("sales", "FULL"));
// purchases
export const purchasesReadProcedure = branchScopedProcedure.use(requireModule("purchases", "READ"));
export const purchasesManagerProcedure = managerProcedure.use(requireModule("purchases", "FULL"));
export const purchasesWarehouseProcedure = warehouseProcedure.use(requireModule("purchases", "FULL"));
// inventory (يشمل production/stocktake — كلاهما يُحرّك المخزون)
export const inventoryReadProcedure = branchScopedProcedure.use(requireModule("inventory", "READ"));
export const inventoryWarehouseProcedure = warehouseProcedure.use(requireModule("inventory", "FULL"));
export const inventoryManagerProcedure = managerProcedure.use(requireModule("inventory", "FULL"));
// customers
export const customersReadProcedure = protectedProcedure.use(requireModule("customers", "READ"));
export const customersCashierProcedure = cashierProcedure.use(requireModule("customers", "FULL"));
export const customersManagerProcedure = managerProcedure.use(requireModule("customers", "FULL"));
// suppliers (أساسها managerProcedure — لا تُوسَّع لأدوار أدنى ضمن F2)
export const suppliersReadProcedure = managerProcedure.use(requireModule("suppliers", "READ"));
export const suppliersManagerProcedure = managerProcedure.use(requireModule("suppliers", "FULL"));
// products (catalog)
export const productsReadProcedure = protectedProcedure.use(requireModule("products", "READ"));
export const productsManagerProcedure = managerProcedure.use(requireModule("products", "FULL"));
// expenses
export const expensesReadProcedure = branchScopedProcedure.use(requireModule("expenses", "READ"));
export const expensesCashierProcedure = cashierProcedure.use(requireModule("expenses", "FULL"));
export const expensesManagerProcedure = managerProcedure.use(requireModule("expenses", "FULL"));
// workorders (خدمة العملاء)
export const workordersReadProcedure = branchScopedProcedure.use(requireModule("workorders", "READ"));
export const workordersCashierProcedure = cashierProcedure.use(requireModule("workorders", "FULL"));
export const workordersExecProcedure = workOrderExecProcedure.use(requireModule("workorders", "FULL"));
export const workordersManagerProcedure = managerProcedure.use(requireModule("workorders", "FULL"));

// ─── F7 (تدقيق ٢/٧): إكمال بوّابات الوحدة المالية «treasury» ────────────────────
// تكملة F2: الوحدات المالية للكتابة (السندات/التحويلات النقدية/الصيرفة/الورديات) كانت مبوَّبة
// بالدور الأساس فقط ⇒ دور مخصّص manager بـtreasury=NONE ينفّذ صرف نقد/تحويل/صيرفة رغم الخريطة.
// نُركّب requireModule("treasury",…) فوق البوّابة الخشنة (voucher/cashTransfers/exchange = manager؛
// الورديات = cashier). **الورديات بمستوى READ** لأن قالب cashier treasury=READ (فتح/إغلاق الوردية
// سلوك كاشير قائم) — التقييد الفعليّ يُغلق دور treasury=NONE بلا حجب الكاشير القالبي.
export const treasuryManagerProcedure = managerProcedure.use(requireModule("treasury", "FULL"));
export const treasuryManagerReadProcedure = managerProcedure.use(requireModule("treasury", "READ"));
export const treasuryReadProcedure = branchScopedProcedure.use(requireModule("treasury", "READ"));
export const treasuryCashierProcedure = cashierProcedure.use(requireModule("treasury", "READ"));
