import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { GENERIC_INTERNAL_AR, mysqlCodeFrom, toArabicMessage } from "@shared/errorMap.ar";
import { canSeeCost as _canSeeCost, moduleAccessAllowed, resolvePermissions, type AccessLevel, type RoleKey } from "@shared/permissions";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { logger } from "./logger";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error, ctx, path }) {
    let arabic = toArabicMessage({
      trpcCode: error.code,
      originalMessage: error.message,
      cause: error.cause,
    });
    const correlationId = (ctx?.req as { id?: string } | undefined)?.id ?? null;
    if (error.code === "INTERNAL_SERVER_ERROR") {
      logger.error({ err: error.cause ?? error, path, correlationId }, `tRPC error: ${path}`);
      // ترقية تشخيصية (١٥/٧/٢٦): الخطأ غير المتوقّع يحمل رمز متابعة يطابق سطر الخطأ في
      // سجلّ الخادم (genReqId في index.ts) — المستخدم يرسله للدعم فيُحدَّد موضع الخطأ فوراً.
      // يُلحق بالرسالة العامة فقط: رفض قواعد الأعمال (Error عربي من الخدمات يصعد INTERNAL)
      // رسالتُه مفهومة بذاتها، وإلحاق الرمز به يحوّل رفضاً سليماً لبلاغ عطل (alert fatigue).
      if (correlationId && arabic === GENERIC_INTERNAL_AR) {
        arabic += `\nرمز المتابعة: ${correlationId} — أرسله للدعم لتحديد موضع الخطأ في سجلّ الخادم.`;
      }
    } else if (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED") {
      // F5 (تدقيق ١٤/٦/٢٦): محاولات التجاوز الفاشلة كانت تمرّ صامتة ⇒ لا أثر forensic.
      // نُسجِّل في pino البنيوي (best-effort، خفيف، بلا i/o إضافي على القاعدة).
      // إن لزم لاحقاً سجلٌّ دائم: interceptor مستقلّ يكتب في auditLogs (errorFormatter sync).
      logger.warn(
        { path, correlationId, userId: ctx?.user?.id ?? null, role: ctx?.user?.role ?? null, code: error.code, message: error.message },
        `authz denied: ${path}`,
      );
    }
    // dbCode: رمز خطأ MySQL (إن وُجد) — يتيح للواجهة تمييز نوع الفشل برمجياً (تكرار/قفل/اتصال).
    return { ...shape, message: arabic, data: { ...shape.data, correlationId, dbCode: mysqlCodeFrom(error.cause) } };
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

/**
 * بوّابة الوحدة الموحّدة (٦/٧/٢٦) — إصلاح «فتحتُ صلاحيات لحساب ولم تُطبَّق»:
 * كانت requireRole تُنفَّذ قبل requireModule وترفض أي دور خارج قائمتها حتى لو مُنح
 * الوحدة صراحةً عبر مصفوفة الصلاحيات (override فردي أو دور مخصّص) ⇒ المنح ميت.
 * القاعدة الآن (moduleAccessAllowed في shared/permissions — مشتركة مع الواجهة):
 * admin يمرّ؛ دور القائمة يمرّ إن حقّقت خريطته المحلولة المستوى (F2 كما هو)؛
 * دور خارج القائمة يمرّ فقط بمنح **صريح** للوحدة بالمستوى المطلوب.
 * ملاحظة أمنية: المنح الصريح FULL يفتح كل إجراءات الوحدة (بما فيها ما كان مديرياً
 * كالإلغاءات) — هذا هو معنى «كامل» المعروض للمالك في المصفوفة، والمنح قرار أدمن.
 */
function requireModuleGate(allowedRoles: readonly string[], moduleKey: string, minLevel: AccessLevel) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    const override = (ctx.user as { permissionsOverride?: unknown }).permissionsOverride as
      | Record<string, AccessLevel>
      | null
      | undefined;
    if (!moduleAccessAllowed(ctx.user.role, override, moduleKey, minLevel, allowedRoles)) {
      throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_MSG });
    }
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

/** عمليات إدارية/مالية: المدير فأعلى (توافق خلفي كامل). */
export const managerProcedure = t.procedure.use(requireRole("manager"));

/**
 * RBAC-REPORTS (تدقيق ٢/٧ + ٦/٧): بوّابة الوحدة الموحّدة على التقارير — تُعامَل «reports»
 * كأي وحدة أخرى عبر requireModuleGate: الأدوار المالية القالبية (manager/accountant/auditor)
 * تمرّ بخريطتها، وأي دور آخر يمرّ **بمنحٍ صريح** فقط (override reports≥READ) — يفتح شكوى المالك
 * «فتحتُ الصلاحية ولم تُطبَّق».
 * ⚠️ حاسم: لا نُسقِط بوّابة الدور إلى requireModule العاري — إذ يفتح ذلك تقارير التكلفة/الربح
 * (P&L/الأستاذ/تقييم المخزون) لقوالب warehouse/purchasing/user (reports=READ، canSeeCost=false)
 * فيخرق ثابت «حجب التكلفة عن غير أدواره» (§٥، مراجعة عدائية ٦/٧). القائمة تُبقي القالب الافتراضي
 * لتلك الأدوار محجوباً، ويظلّ المنح الصريح قرار المالك الواعي (لا وحدة «تكلفة» منفصلة في المصفوفة).
 */
export const reportViewerProcedure = t.procedure
  .use(requireModuleGate(["manager", "accountant", "auditor"], "reports", "READ"))
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

// ─── F2 (تدقيق ٢/٧) + بوّابة المنح الصريح (٦/٧) — إجراءات module-gated ─────────
// F2: خريطة الدور (قالب + override) تُنفَّذ على أدوار القائمة (override مُقيِّد يُطاع).
// ٦/٧: أي دور خارج القائمة مُنح الوحدة **صراحةً** بالمستوى المطلوب يمرّ أيضاً
// (requireModuleGate أعلاه) — كان requireRole يرفضه قبل استشارة المنح إطلاقاً.
// توسيعات قوائم مستهدفة (وعود قوالب كانت مكسورة): purchasing⇐المشتريات/الموردون،
// accountant⇐الخزينة/إدخال المصروفات، sales_rep⇐كتابة العملاء الأساسية،
// warehouse⇐كتابة الموردين. الاصطلاح: query ⇒ READ، mutation ⇒ FULL.

/** بوّابة وحدة + إلزام فرع مُسنَد لغير admin/manager (G3) — الأساس لكل إجراءات الكتابة أدناه. */
function moduleProcedure(allowedRoles: readonly string[], moduleKey: string, minLevel: AccessLevel) {
  return t.procedure.use(requireModuleGate(allowedRoles, moduleKey, minLevel)).use(requireOwnBranch);
}

// pos (نقطة بيع خدمات الطباعة — printPos)
export const posCashierProcedure = moduleProcedure(["cashier", "manager"], "pos", "FULL");
// sales
export const salesReadProcedure = branchScopedProcedure.use(requireModule("sales", "READ"));
export const salesCashierProcedure = moduleProcedure(["cashier", "manager"], "sales", "FULL");
export const salesManagerProcedure = moduleProcedure(["manager"], "sales", "FULL");
// purchases — «مسؤول مشتريات» قالبه purchases=FULL ووصفه المعلن «أوامر شراء وموردون».
export const purchasesReadProcedure = branchScopedProcedure.use(requireModule("purchases", "READ"));
export const purchasesManagerProcedure = moduleProcedure(["manager", "purchasing"], "purchases", "FULL");
export const purchasesWarehouseProcedure = moduleProcedure(["warehouse", "manager", "purchasing"], "purchases", "FULL");
// inventory (يشمل production/stocktake — كلاهما يُحرّك المخزون)
export const inventoryReadProcedure = branchScopedProcedure.use(requireModule("inventory", "READ"));
export const inventoryWarehouseProcedure = moduleProcedure(["warehouse", "manager"], "inventory", "FULL");
export const inventoryManagerProcedure = moduleProcedure(["manager"], "inventory", "FULL");
// أسماء توافقية للراوترات القائمة؛ سلطة ملف العميل انتقلت فعلياً إلى وحدة CRM.
export const customersReadProcedure = protectedProcedure.use(requireModule("crm", "READ"));
export const customersCashierProcedure = moduleProcedure(["cashier", "manager", "sales_rep"], "crm", "FULL");
export const customersManagerProcedure = moduleProcedure(["manager"], "crm", "FULL");

// CRM هو مالك رحلة العميل؛ تبقى وحدات المبيعات/القنوات/الخزينة مزوّدات أحداث عبر حدود واضحة.
export const crmReadProcedure = branchScopedProcedure.use(requireModule("crm", "READ"));
export const crmWriteProcedure = moduleProcedure(["cashier", "manager", "sales_rep"], "crm", "FULL");
export const campaignsReadProcedure = branchScopedProcedure.use(requireModule("campaigns", "READ"));
export const campaignsManagerProcedure = moduleProcedure(["manager"], "campaigns", "FULL");
export const collectionsReadProcedure = branchScopedProcedure.use(requireModule("collections", "READ"));
export const collectionsManagerProcedure = moduleProcedure(["manager", "accountant"], "collections", "FULL");

// المتجر الإلكتروني (وحدة store): قراءة الطلبات/البنرات، تثبيت الطلبات وطباعة الملصقات (تشغيلي)،
// وإدارة البنرات/الإعدادات (مديري). branchScopedProcedure للقراءة ⇒ عزل فرع لغير المرتفعين.
export const storeReadProcedure = branchScopedProcedure.use(requireModule("store", "READ"));
export const storeFulfillProcedure = moduleProcedure(["manager", "cashier", "sales_rep"], "store", "FULL");
// الإرسال (فاتورة COD + خصم مخزون + إسناد مندوب) يستعمل storeManagerProcedure: المدير يُقرّ
// ائتمان COD المؤقّت للزبون النقدي (managerOverrideByUserId يجب أن يكون مديراً مُتحقَّقاً).
export const storeManagerProcedure = moduleProcedure(["manager"], "store", "FULL");
// courier (١٢/٧): شاشة المندوب الذاتية «توصيلاتي» — القراءة/التأكيد يحلّان partyId من ctx.user
// (deliveryParties.userId) لا من الفرع. **بلا requireOwnBranch** عمداً: العزل بالمندوب (userId) لا
// بالفرع، والمندوب قد يخدم عدّة فروع (عابرٌ لفروع طلباته) فيُنشأ أحياناً بلا فرع مُسنَد — فرضُ الفرع
// كان يقفل الميزة كلّها عليه (مراجعة عدائية ١٢/٧). الدور courier فقط (admin يعبُر البوّابة لكنه بلا
// جهة مرتبطة ⇒ النقاط الذاتية تعيد linked:false برشاقة).
export const courierProcedure = t.procedure.use(requireModuleGate(["courier"], "courier", "FULL"));
// قراءات مركز التوصيل (/delivery) — مقيّدة بوحدة store: كل مستعملي الشاشة (manager/cashier FULL،
// accountant/auditor READ، admin يعبُر) يملكون store≥READ، بينما courier=NONE ⇒ محجوبٌ من قراءة
// عهدة/بيانات جهات أخرى وPII زبائن الإرساليات (مراجعة عدائية ١٢/٧: branchScoped وحده لا يستشير
// خريطة الصلاحيات فيسرّبها لأي مستخدم مصادَق ذي فرع). branchScoped ⇒ يبقى scopedBranchId للعزل.
export const deliveryReadProcedure = branchScopedProcedure.use(requireModule("store", "READ"));
// suppliers — القراءة بالخريطة وحدها (كالعملاء): قوالب warehouse/purchasing/auditor/user تعِد
// بها وكان managerProcedure يصدّها. الكتابة: warehouse/purchasing قالباهما FULL.
export const suppliersReadProcedure = protectedProcedure.use(requireModule("suppliers", "READ"));
export const suppliersManagerProcedure = moduleProcedure(["manager", "warehouse", "purchasing"], "suppliers", "FULL");
// بضاعة الأمانة «consignments» (ش٢): سندات الإيداع/السحب — أمين المخزن يسجّلها (استلام فعليّ) + المدير + المحاسب.
// مقصورة على الفرع (requireOwnBranch عبر moduleProcedure) — السند لفرعه؛ admin يعبر عبر البوّابة.
export const consignmentWriteProcedure = moduleProcedure(["warehouse", "manager", "accountant"], "consignments", "FULL");
export const consignmentReadProcedure = protectedProcedure.use(requireModule("consignments", "READ"));
// products (catalog)
export const productsReadProcedure = protectedProcedure.use(requireModule("products", "READ"));
export const productsManagerProcedure = moduleProcedure(["manager"], "products", "FULL");
// forPurchase (بحث منتجات جانب الشراء — يكشف التكلفة): أدوار الشراء التي تبني/تستلم أوامر الشراء
// (purchasing/warehouse) تحتاجه لإضافة سطور PO، وكان محصوراً بالمدير فتعذّر عليها بناء أمر الشراء
// رغم تخويلها إنشاءه (purchasesManagerProcedure)/استلامه (purchasesWarehouseProcedure). قراءة فقط،
// ومحصور بأدوار الشراء + المدير ⇒ لا تتسرّب التكلفة للكاشير/المندوب/المستخدم العام.
export const productsPurchaseProcedure = moduleProcedure(["manager", "warehouse", "purchasing"], "products", "READ");
// expenses — «محاسب» قالبه expenses=FULL ⇒ يدخل بوّابة الإدخال (الإلغاء يبقى مديرياً).
export const expensesReadProcedure = branchScopedProcedure.use(requireModule("expenses", "READ"));
export const expensesCashierProcedure = moduleProcedure(["cashier", "manager", "accountant"], "expenses", "FULL");
export const expensesManagerProcedure = moduleProcedure(["manager"], "expenses", "FULL");
// workorders (خدمة العملاء)
export const workordersReadProcedure = branchScopedProcedure.use(requireModule("workorders", "READ"));
export const workordersCashierProcedure = moduleProcedure(["cashier", "manager"], "workorders", "FULL");
export const workordersExecProcedure = moduleProcedure(["cashier", "manager", "print_operator"], "workorders", "FULL");
export const workordersManagerProcedure = moduleProcedure(["manager"], "workorders", "FULL");

// ─── F7 (تدقيق ٢/٧): بوّابات الوحدة المالية «treasury» ─────────────────────────
// «محاسب» قالبه treasury=FULL ووصفه المعلن يشمل الخزينة والسندات — كان مصدوداً.
// **الورديات بمستوى READ** لأن قالب cashier treasury=READ (فتح/إغلاق الوردية سلوك كاشير قائم).
export const treasuryManagerProcedure = moduleProcedure(["manager", "accountant"], "treasury", "FULL");
export const treasuryManagerReadProcedure = moduleProcedure(["manager", "accountant"], "treasury", "READ");
export const treasuryReadProcedure = branchScopedProcedure.use(requireModule("treasury", "READ"));
export const treasuryCashierProcedure = moduleProcedure(["cashier", "manager"], "treasury", "READ");

// ─── الأهداف والعمولات «commissions» — خطط/أهداف شهرية/تشغيلات عمولات البائعين ───
// الكتابة (خطط/إسناد/أهداف/احتساب/اعتماد) مديرية بقالبها + منح صريح عبر البوّابة
// الموحّدة؛ القراءة بالخريطة (accountant/auditor قالباهما READ). العرض الذاتي «أدائي»
// لا يمرّ من هاتين البوّابتين إطلاقاً — protectedProcedure بهوية ctx.user حصراً
// (بلا مدخل employeeId) داخل راوتر الوحدة، اتّساقاً مع عزل scopedOwnerId.
export const commissionsManagerProcedure = moduleProcedure(["manager"], "commissions", "FULL");
export const commissionsReadProcedure = protectedProcedure.use(requireModule("commissions", "READ"));
