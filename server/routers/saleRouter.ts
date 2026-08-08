import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { paginateKeyset, countIfOffset } from "../lib/paginateKeyset";
import { escLike } from "../lib/sqlLike";
import { normalizeSearchText } from "@shared/searchNormalize";
import { z } from "zod";
import {
  customers,
  accountingEntries,
  auditLogs,
  deliveryConsignments,
  deliveryParties,
  invoiceItems,
  invoices,
  productUnits,
  productVariants,
  products,
  receipts,
  shifts,
  workOrders,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { logger } from "../logger";
import { users } from "../../drizzle/schema";
import { localDayStart, localNextDayStart } from "../services/dateRange";
import { verifyPassword } from "../auth/password";
import { logAudit, logAuditTx } from "../services/auditService";
import { createSale, processPayment } from "../services/saleService";
import { canSeeCostForUser, router, salesCashierProcedure, salesManagerProcedure, salesReadProcedure } from "../trpc";
import { invoiceBarcodeSet } from "../services/barcodeService";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { isDupEntry } from "@shared/errorMap.ar";
import { withTx } from "../services/tx";

// فاتورة أمر الشغل تُنشأ عند التسليم/الإرسال، وقد ينفّذها كاشير آخر عن الذي استقبل
// الطلب. نصل الفاتورة بأمرها عبر invoiceId (علاقة 1:1) كي تبقى مرئية لصاحب الطلب
// الأصلي أيضاً، من دون توسيع كشف فواتير الموظفين الآخرين.
const workOrderInvoiceCustomer = alias(customers, "workOrderInvoiceCustomer");

// تحصين verifyManagerApproval ضدّ تخمين كلمة المرور:
// (١) حدّ معدّل بالبريد المُحاوَل: ≤ ٥ محاولات / ٦٠ ثانية.
// (٢) توقيت ثابت: نُجبر الاستجابة على ≥٣٠٠ms (ولو فشلت سريعاً) لتفادي timing attacks
//     التي تكشف هل البريد موجود (verifyPassword لا يُستدعى لو غاب الحساب).
// (٣) كل محاولة فاشلة تُسجَّل في auditLogs (auth.creditOverride.fail).
// (٤) الـlogger يَلتقطها لاحقاً للتنبيه.
const MGR_APPROVAL_MAX = 5;
const MGR_APPROVAL_WINDOW_MS = 60_000;
const MGR_APPROVAL_MIN_RESPONSE_MS = 300;
const mgrApprovalAttempts = new Map<string, number[]>();

// مكنسة دورية تُجلي المفاتيح التي صارت كل محاولاتها أقدم من النافذة (تمنع تسرّب الذاكرة
// عند تدفّق إيميلات مختلفة). .unref?.() كي لا يَمنع المؤقّت إغلاق العملية.
setInterval(() => {
  const now = Date.now();
  mgrApprovalAttempts.forEach((times, key) => {
    const fresh = times.filter((t) => now - t < MGR_APPROVAL_WINDOW_MS);
    if (fresh.length === 0) mgrApprovalAttempts.delete(key);
    else if (fresh.length !== times.length) mgrApprovalAttempts.set(key, fresh);
  });
}, MGR_APPROVAL_WINDOW_MS).unref?.();

function _trackMgrAttempt(email: string): boolean {
  const now = Date.now();
  const key = email.trim().toLowerCase();
  const arr = (mgrApprovalAttempts.get(key) ?? []).filter((t) => now - t < MGR_APPROVAL_WINDOW_MS);
  arr.push(now);
  mgrApprovalAttempts.set(key, arr);
  return arr.length <= MGR_APPROVAL_MAX;
}

/** يتحقّق من هوية مدير (بريد + كلمة مرور) لاعتماد تجاوز حدّ الائتمان. يعيد معرّف المدير.
 *  مُحصَّن: rate limit بالبريد، توقيت ثابت ≥٣٠٠ms، وكل فشل يُسجَّل في auditLogs.
 *  عزل الفرع: admin يَعبر دائماً؛ manager يَجب أن يكون مدير نفس الفرع المُمرَّر (branchId).
 *  (تدقيق ١٥/٦/٢٦): قبل الإصلاح كان أي manager في أي فرع يعتمد بيع فرع آخر — IDOR إداري. */
export async function verifyManagerApproval(
  approval: { email: string; password: string },
  ctx: { user: { id: number; branchId?: number | null } },
  branchId?: number,
): Promise<number> {
  const start = Date.now();
  const email = approval.email.trim().toLowerCase();
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  // rate limit (لا يُلَتقَط في الـcatch — يُرمى مباشرة لإفهام المستخدم بحدّ المعدّل).
  if (!_trackMgrAttempt(email)) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.rateLimited",
      entityType: "user",
      newValue: { email, attempts: mgrApprovalAttempts.get(email)?.length ?? 0 },
    });
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "محاولات كثيرة جداً لاعتماد المدير — جرّب بعد دقيقة.",
    });
  }

  const u = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  const ok = u && u.isActive !== false && verifyPassword(approval.password, u.passwordHash) && (u.role === "manager" || u.role === "admin");

  // ثبّت الحدّ الأدنى للوقت قبل الإرجاع (يَمنع timing attack).
  const elapsed = Date.now() - start;
  if (elapsed < MGR_APPROVAL_MIN_RESPONSE_MS) {
    await new Promise((r) => setTimeout(r, MGR_APPROVAL_MIN_RESPONSE_MS - elapsed));
  }

  if (!ok) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.fail",
      entityType: "user",
      entityId: u?.id ?? null,
      newValue: { email, reason: !u ? "no_user" : (u.isActive === false ? "inactive" : "wrong_password_or_role") },
    });
    throw new TRPCError({ code: "FORBIDDEN", message: "موافقة المدير غير صالحة (تأكّد من البريد وكلمة المرور وأنّ الحساب مدير)." });
  }
  // SOD-03 (فصل المهام): لا يجوز للمستخدم اعتماد عمليته بنفسه (كاشير بدور مدير يُدخل بيانات نفسه).
  // كان غياب الفحص يُتيح للمدير-الكاشير تجاوز حدّ الائتمان على بيعه ذاتياً بلا حسيب.
  if (Number(u.id) === Number(ctx.user.id)) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.fail",
      entityType: "user",
      entityId: u.id,
      newValue: { email, reason: "self_approval" },
    });
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز اعتماد عمليتك بنفسك — يلزم مدير آخر (فصل المهام)." });
  }
  // عزل الفرع: admin يَعبر؛ manager يَجب أن يَخدم فرع الفاتورة نفسه.
  if (u.role === "manager" && branchId != null && Number(u.branchId) !== branchId) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.fail",
      entityType: "user",
      entityId: u.id,
      newValue: { email, reason: "cross_branch", approverBranchId: u.branchId, saleBranchId: branchId },
    });
    throw new TRPCError({ code: "FORBIDDEN", message: "المعتمد ليس مدير هذا الفرع" });
  }
  // M (تَدقيق ٢٣/٦/٢٦): admin عابر-الفرع يَجتاز بلا تَوثيق صريح ⇒ نَسجّل سطر تَدقيق مُكثَّف
  // عند المرور. لا يَمنع المرور (admin له سلطة عليا بالتَصميم)، لكن يَترك أَثَراً forensic
  // كَشّافاً لإساءة استعمال admin مُخترَق (نافذة تَحقيقات لاحقة كاشفة).
  if (u.role === "admin" && branchId != null && u.branchId != null && Number(u.branchId) !== branchId) {
    await logAudit(ctx as any, {
      action: "sale.creditOverride.adminCrossBranch",
      entityType: "user",
      entityId: u.id,
      newValue: { email, approverBranchId: u.branchId, saleBranchId: branchId, saleActorId: ctx.user.id },
    });
  }
  return Number(u.id);
}

const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
// تاريخ فلترة YYYY-MM-DD (فلاتر الفترات الخادمية — لا فلترة محلية تُخفي صفحات الخادم).
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");
// قيمة override/خصم: مالية غير سالبة (٢ منزلتان) — nonNegMoneyString المركزية (سدّ تكرار schemas).
const lineSchema = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  // تدقيق ٣/٨: سقف علويّ (١ مليون) — بلا حدّ، كمية بـ٢٠ خانة تفيض MAX_SAFE_INTEGER/BIGINT بعد
  // ×conversionFactor في convertToBaseQuantity (اتساقٌ مع سقف openingStock). أطول من ٧ خانات صحيحة مرفوض.
  quantity: z
    .string()
    .regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة (موجبة، ثلاث منازل)")
    .refine((s) => Number(s) > 0 && Number(s) <= 1_000_000, "الكمية خارج المدى المسموح"),
  unitPriceOverride: nonNegMoneyString.optional(),
  discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "نسبة خصم غير صالحة").optional(),
  discountAmount: nonNegMoneyString.optional(),
  // promotions v2 (٨/٧/٢٦): معرّف العرض الذي عرضه POS للعميل — الخادم يتحقّق (idempotent)
  // ويُخزّن promotionId + promotionDiscount على invoiceItem. إن اختلف عن حلّ الخادم ⇒ يعامل كيدوي.
  promotionId: z.number().int().positive().optional(),
  // هدايا الفاتورة (0149): وسمُ سطرٍ مُهدىً. الخادم يُصفّر سعره وخصمه بنفسه ويُرحّل تكلفته قيدَ
  // GIFT_OUT — فالشاشة تُعلن النيّة فقط، ولا تُملي مبلغاً.
  isGift: z.boolean().optional(),
});

// مخطط فلترة قائمة المبيعات — مشترك بين list و listSummary (نفس الفلاتر حتماً).
// S3 (٣٠/٦): cursor اختياري للترقيم keyset — عمق O(log n) بدل OFFSET الأُسّي.
// إن مُرّر cursor، يُقيَّد `id < cursor` ويُتجاهل offset؛ وإلّا يبقى OFFSET للتوافق.
const salesListInput = z
  .object({
    // تدقيق ٣/٨: سقف صريح — كانت `z.number()` عارية تصل `.limit()` بلا قصّ (paginateKeyset لا يقصّها)
    // ⇒ `limit: 1e8` يحاول جلب ملايين الصفوف للذاكرة (DoS)، وقيمة سالبة/عشرية ⇒ خطأ MySQL/500.
    limit: z.number().int().positive().max(500).default(50),
    offset: z.number().int().min(0).max(1_000_000).default(0),
    cursor: z.number().int().positive().optional(),
    // فلترة خادمية بالفترة (invoiceDate) والحالة والعميل.
    from: ymd.optional(),
    to: ymd.optional(),
    status: z.enum(["PENDING", "CONFIRMED", "PAID", "PARTIALLY_PAID", "CANCELLED", "RETURNED"]).optional(),
    sourceType: z.enum(["POS", "ONLINE", "ORDER", "WORKORDER"]).optional(),
    balanceState: z.enum(["DEPOSIT_DUE", "OUTSTANDING", "UNPAID", "SETTLED"]).optional(),
    customerId: z.number().int().positive().optional(),
    salespersonId: z.number().int().positive().optional(),
    // فلترة بطريقة الدفع (invoices.paymentMethod — نفس مصدر عمود «طريقة الدفع» في الشاشة).
    // الحاجة التشغيلية: مطابقة يوم البطاقات مع كشف جهاز الدفع تتطلّب حصر فواتير CARD.
    // ش٥ (V19): TELECOM في **فلتر القراءة** فقط — الكتابة (create/pay) تبقى بلا رصيد زين
    // (مقصورٌ على محطة الاستقبال خلف ضوابطها)، لكن فواتيرها تُفلتَر وتُقرأ من هنا.
    paymentMethod: z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM"]).optional(),
    // فرع صريح للمرتفعين (admin/manager عابرَي الفروع) — يُفعَّل فقط حين scopedBranchId فارغ؛
    // غير المرتفع يبقى محصوراً بفرعه مهما أرسل (انظر buildSalesListConds).
    branchId: z.number().int().positive().optional(),
    // فلترة بفواتير وردية بعينها — لتحقيق فروقات الوردية النقدية من سجلّ الورديات (Shifts.tsx).
    shiftId: z.number().int().positive().optional(),
    // بحث نصّي خادميّ: رقم الفاتورة أو اسم العميل. كان البحث محلّياً على الصفحة المُحمَّلة وحدها
    // (سقف ٢٠٠) ⇒ فاتورة أقدم تُعطي «لا نتائج» وهي موجودة. خادميّ ⇒ يطال كل المطابق للفلتر.
    q: z.string().trim().min(1).optional(),
  })
  .optional();

type SalesListInput = z.infer<typeof salesListInput>;

/** يبني شروط WHERE لقائمة المبيعات — مستخدم في list و listSummary معاً
 *  ⇒ يضمن تطابق الفلترة بينهما للأبد (نفس عزل الفرع ونفس الحدّ نصف المفتوح [from, to+يوم)). */
export function buildSalesListConds(input: SalesListInput, scopedBranchId: number | null, scopedOwnerId: number | null = null) {
  const conds = [];
  if (scopedBranchId) conds.push(eq(invoices.branchId, scopedBranchId));
  // فلتر الفرع الصريح — else حتماً: العزل الحاكم (scopedBranchId) مقدَّم دائماً، فلا يستطيع
  // غير المرتفع توسيع نطاقه بإرسال branchId مغاير (يُتجاهَل مدخله بصمت ويبقى محصوراً بفرعه).
  else if (input?.branchId) conds.push(eq(invoices.branchId, input.branchId));
  // عزل الموظف: يرى الموظف فواتيره التي أنشأها، وفواتير أوامر الشغل التي استقبلها
  // ولو أصدرها/أرسلها لاحقاً كاشير آخر. علاقة workOrders.invoiceId فريدة 1:1، لذلك
  // لا توسّع هذا الاستثناء إلى أي فاتورة لا تخص طلبه ولا تكرّر صفوف القائمة.
  // كل مستهلك لهذا الشرط يضم leftJoin(workOrders, workOrders.invoiceId = invoices.id).
  if (scopedOwnerId != null) {
    const ownerOrReceptionOrder = or(
      eq(invoices.createdBy, scopedOwnerId),
      eq(workOrders.createdBy, scopedOwnerId),
    );
    // مدخلا or ثابتان هنا، لكن تعريف Drizzle العام يسمح بقائمة فارغة.
    conds.push(ownerOrReceptionOrder!);
  }
  // نصف مفتوح [from, to+يوم) بمنتصف ليلٍ محلي (Date("YYYY-MM-DD") = UTC ⇒ انزياح +03:00).
  if (input?.from) conds.push(gte(invoices.invoiceDate, localDayStart(input.from)));
  if (input?.to) conds.push(lt(invoices.invoiceDate, localNextDayStart(input.to)));
  if (input?.status) conds.push(eq(invoices.status, input.status));
  if (input?.sourceType) conds.push(eq(invoices.sourceType, input.sourceType));
  if (input?.paymentMethod) conds.push(eq(invoices.paymentMethod, input.paymentMethod));
  if (input?.balanceState === "DEPOSIT_DUE") {
    conds.push(inArray(invoices.sourceType, ["ORDER", "WORKORDER"]));
    conds.push(sql`CAST(${invoices.paidAmount} AS DECIMAL(15,2)) > 0`);
    conds.push(sql`CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(${invoices.paidAmount} AS DECIMAL(15,2)) - CAST(${invoices.returnedTotal} AS DECIMAL(15,2)) > 0`);
  } else if (input?.balanceState === "OUTSTANDING") {
    conds.push(sql`CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(${invoices.paidAmount} AS DECIMAL(15,2)) - CAST(${invoices.returnedTotal} AS DECIMAL(15,2)) > 0`);
    conds.push(sql`${invoices.status} NOT IN ('CANCELLED', 'RETURNED')`);
  } else if (input?.balanceState === "UNPAID") {
    conds.push(sql`CAST(${invoices.paidAmount} AS DECIMAL(15,2)) = 0`);
    conds.push(sql`CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(${invoices.returnedTotal} AS DECIMAL(15,2)) > 0`);
    conds.push(sql`${invoices.status} NOT IN ('CANCELLED', 'RETURNED')`);
  } else if (input?.balanceState === "SETTLED") {
    conds.push(sql`CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(${invoices.paidAmount} AS DECIMAL(15,2)) - CAST(${invoices.returnedTotal} AS DECIMAL(15,2)) <= 0`);
    conds.push(sql`${invoices.status} NOT IN ('CANCELLED', 'RETURNED')`);
  }
  if (input?.customerId) conds.push(eq(invoices.customerId, input.customerId));
  if (input?.shiftId) conds.push(eq(invoices.shiftId, input.shiftId));
  // المدير/الأدمن يستطيعان اختيار موظف؛ الموظف العادي يبقى مُجبَراً على نفسه.
  if (scopedOwnerId == null && input?.salespersonId) conds.push(eq(invoices.createdBy, input.salespersonId));
  if (input?.q) {
    // رقم الفاتورة يُطابَق خاماً (رموز/أرقام لا معنى للتطبيع العربي فيها)، واسم العميل عبر
    // customers.searchNorm المطبَّع عربياً (D2 ١/٧ — «احمد» يجد «أحمد»)، نفس نمط customerService.
    // ⚠️ يتطلّب join على customers في **كل** مستهلك لهذه الشروط (list وlistSummary معاً).
    const raw = `%${escLike(input.q)}%`;
    const folded = `%${escLike(normalizeSearchText(input.q))}%`;
    conds.push(
      or(
        sql`${invoices.invoiceNumber} LIKE ${raw} ESCAPE '!'`,
        sql`coalesce(${customers.searchNorm}, '') LIKE ${folded} ESCAPE '!'`,
      )!,
    );
  }
  return conds;
}

export const saleRouter = router({
  create: salesCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        priceTier: tier.optional(),
        sourceType: z.enum(["POS", "ONLINE", "ORDER", "WORKORDER"]).default("POS"),
        lines: z.array(lineSchema).min(1),
        invoiceDiscount: z.string().optional(),
        taxRatePercent: z.string().optional(),
        // أجرة التوصيل: إيرادُ شحنٍ بلا تكلفةٍ ولا مخزون، يدخل إجمالي الفاتورة ويُعكَس كاملاً عند
        // الإرجاع الكامل (`returnService`). كان المحرّك يدعمه (`createSale`) بينما الراوتر لا يقبله،
        // فبقيت خانة الشحن مخفيّةً في شاشة الفاتورة المتقدّمة. «توصيل مجاني» = صفر (أو تركُه فارغاً).
        deliveryFee: nonNegMoneyString.optional(),
        // إفصاح التوصيل المجّاني (0152): يميّز «أُهديت أجرته» عن «بلا توصيل». بلا أثر ماليّ.
        deliveryFree: z.boolean().optional(),
        deliveryWaivedAmount: nonNegMoneyString.optional(),
        payment: z.object({
          amount: positiveMoneyString,
          method,
          reference: z.string().trim().min(1).max(100).optional(),
        }).optional(),
        // dueDate للبيع الآجل (YYYY-MM-DD) — يُحفظ على invoices.dueDate ليظهر في AR aging
        // ولينبّه على الفواتير المتأخرة. اختياري؛ إن غاب فلا تاريخ استحقاق محدّد.
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)").optional(),
        // تقريب نقدي IQD للبيع النقدي الكامل (يُحسب على الخادم، يُسجَّل ADJUST لفرق التقريب).
        cashRoundIQD: z.boolean().optional(),
        clientRequestId: z.string().optional(),
        deviceId: z.string().trim().min(1).max(64).optional(),
        couponCode: z.string().trim().min(3).max(64).optional(),
        notes: z.string().optional(),
        // موافقة مدير لتجاوز حدّ الائتمان (بريد+كلمة مرور، تُتحقَّق خادمياً).
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المدير يُجبَر على فرعه (لا يُصدَّق branchId القادم من العميل — منع IDOR).
      // G1 (تدقيق ١٤/٦/٢٦): قبل الإصلاح كان `ctx.user.branchId ?? input.branchId` يسمح
      // لكاشير بـbranchId=null أن يحقن أي input.branchId (بيع في فرع آخر — IDOR مالي).
      // الآن: throw FORBIDDEN صريح (نمط F4 expense.create).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let effectiveBranchId = input.branchId;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        effectiveBranchId = Number(ctx.user.branchId);
      }
      // role إلزامي: خدمة البيع تفحص ملكية الوردية (SHIFT-OWN) وتُعفي admin/manager — بدونه يُحجب الجميع.
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role };
      let approvedBy: number | null = null;
      const { managerApproval, ...saleInput } = input;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);
      // SALES-01/02: سلطة البيع تحت التكلفة. المدير/الأدمن لهما السلطة ذاتياً (elevated)؛
      // الكاشير يحتاج managerApproval مُتحقَّقاً (approvedBy). الخدمة تَكشف البيع تحت COGS وتَرفضه بلا سلطة.
      const priceOverrideApprovedBy: number | null = approvedBy ?? (elevated ? ctx.user.id : null);
      // B5 (١٩/٦/٢٦): الراوتر لا يمرّر creditApproved منفرداً — يمرّر معه managerOverrideByUserId
      // لتُنشئ saleService approval ذرّياً مرتبطاً بـ(customer, unpaid, single-use, 5min).
      const effectiveInput = {
        ...saleInput,
        branchId: effectiveBranchId,
        creditApproved: approvedBy != null,
        managerOverrideByUserId: approvedBy ?? undefined,
        priceOverrideApproved: priceOverrideApprovedBy != null,
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createSale(effectiveInput, actor);
          // AUDIT-REPLAY (تدقيق ٢/٧): إعادة التشغيل الـidempotent لا تُنشئ بيعاً جديداً ⇒ لا نكتب سطر
          // تدقيق مكرَّراً في كل مرة (كان يضخّم السجلّ بأحداث «بيع» وهميّة لعملية واحدة).
          if (!res.idempotentReplay) {
            await logAudit(ctx, { action: "sale.create", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { lines: input.lines.length, creditApprovedBy: approvedBy } });
            if (approvedBy != null) await logAudit(ctx, { action: "sale.creditOverride", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { approvedByManagerId: approvedBy } });
            // SALES-01/02: أثر تدقيقي صريح للبيع تحت التكلفة (لا يُكتفى بعدّ الأسطر).
            if (res.priceOverride) await logAudit(ctx, { action: "sale.priceOverride", entityType: "invoice", entityId: res.invoiceId, newValue: { approvedByUserId: priceOverrideApprovedBy, byRole: ctx.user.role } });
            // هدايا الفاتورة (0149): أثرٌ تدقيقيّ صريح — مَن أهدى وبأيّ فاتورة وبكم **تكلفة** (لا سعر،
            // فالسعر صفر). نظير `gifts.outbound` في سند الهدية المستقلّ ⇒ الإهداء من الشاشتين مُتعقَّب.
            if (res.giftCost) await logAudit(ctx, { action: "sale.gift", entityType: "invoice", entityId: res.invoiceId, newValue: { giftCost: res.giftCost, byRole: ctx.user.role, approvedByUserId: priceOverrideApprovedBy } });
            // «وضع الافتتاح» (ش٢): أثر تدقيقي لكل بيعٍ أنزل صنفاً تحت الصفر — يقع مرّة واحدة على
            // المحاولة الفائزة (replay لا يعيد negativeDips). مصدر الحقيقة الدائم = حركة المخزون بملاحظتها.
            if (res.negativeDips?.length) await logAudit(ctx, { action: "sale.openingNegative", entityType: "invoice", entityId: res.invoiceId, newValue: { dips: res.negativeDips } });
          }
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          // لا نبتلع السبب الجذري: نُسجّله كاملاً (رسالة + كود SQL + الاستعلام) قبل
          // إرجاع رسالة عامة للواجهة — وإلا صار تشخيص أعطال الإنتاج تخميناً (درس ١٢/٦:
          // عمود مخطط ناقص ظهر للمستخدم كـ«تعذّر إتمام البيع» بلا أثرٍ يكشف العمود).
          logger.error(
            {
              err: { message: e?.message, code: e?.code, sqlMessage: e?.sqlMessage, sql: e?.sql },
              userId: actor.userId,
              branchId: actor.branchId,
              lines: input.lines.length,
            },
            "sale.create فشل بخطأ غير متوقّع (السبب الجذري أدناه)"
          );
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام البيع" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),

  pay: salesCashierProcedure
    .input(z.object({
      // SALES-04: المبلغ مُقيّد موجباً بـ٢ منازل (كان z.string() ⇒ يَقبل أُسّاً/أكثر من منزلتين).
      invoiceId: z.number().int().positive(), amount: positiveMoneyString, method, reference: z.string().trim().max(100).nullish(), shiftId: z.number().int().positive().optional(),
      // idempotency: نفس المفتاح ⇒ دفعة واحدة (لا إيصال/قيد PAYMENT_IN/خصم AR مزدوج عند النقر المزدوج).
      clientRequestId: z.string().min(1).max(80).optional(),
    }).superRefine((input, ctx) => {
      if (input.method !== "CASH" && !input.reference?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reference"], message: "مرجع عملية البطاقة/التحويل مطلوب" });
      }
    }))
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المدير يُرفض دفعه على فاتورة فرع آخر (منع IDOR).
      // G1 (تدقيق ١٤/٦/٢٦): استبدل `?? -1` برميٍ صريح. كان -1 يجعل enforceBranchId يطابق
      // عدم وجود فاتورة (silent failure)؛ الآن: FORBIDDEN مباشر لكاشير بلا فرع.
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      let enforceBranchId: number | null = null;
      if (!elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        enforceBranchId = Number(ctx.user.branchId);
      }
      // G3 (١٩/٦/٢٦): إزالة fallback `|| 1` الصامت. للأدمن بلا فرع نطلب branchId صريحاً
      // (إن غاب نرفع FORBIDDEN — لا نسقط بصمت على فرع ١).
      let actorBranchId: number;
      if (elevated) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد للمستخدم — حدّد فرعك قبل تسجيل دفعات" });
        }
        actorBranchId = Number(ctx.user.branchId);
      } else {
        actorBranchId = enforceBranchId!;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await processPayment({ ...input, enforceBranchId }, { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role });
          await logAudit(ctx, { action: "sale.pay", entityType: "invoice", entityId: input.invoiceId, newValue: { amount: input.amount, method: input.method } });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام الدفعة" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إتمام الدفعة (تكرار)" });
    }),

  // عزل الفرع: غير المدير يرى فواتير فرعه فقط (منع IDOR).
  // /simplify ٣٠/٦: list = listPage().rows ⇒ كاتب واحد للاستعلام، صفر تَكرار.
  correct: salesManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        notes: z.string().max(5_000).optional(),
        dueDate: ymd.nullable().optional(),
        receiptMethods: z
          .array(
            z.object({
              receiptId: z.number().int().positive(),
              method,
            }),
          )
          .max(50)
          .optional(),
        reason: z.string().trim().min(3, "اكتب سبب التعديل").max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return withTx(async (tx) => {
        const inv = (
          await tx
            .select()
            .from(invoices)
            .where(eq(invoices.id, input.invoiceId))
            .for("update")
            .limit(1)
        )[0];
        if (!inv)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الفاتورة غير موجودة",
          });

        const invoiceReceipts = await tx
          .select({
            id: receipts.id,
            paymentMethod: receipts.paymentMethod,
            cashBucket: receipts.cashBucket,
            shiftId: receipts.shiftId,
            status: receipts.status,
          })
          .from(receipts)
          .where(eq(receipts.invoiceId, input.invoiceId))
          .for("update");

        const requestedMethods = new Map<number, z.infer<typeof method>>();
        for (const receipt of input.receiptMethods ?? []) {
          if (requestedMethods.has(receipt.receiptId)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "تكرر سند الدفع في طلب التعديل",
            });
          }
          requestedMethods.set(receipt.receiptId, receipt.method);
        }
        const receiptIds = new Set(
          invoiceReceipts.map((receipt) => Number(receipt.id)),
        );
        for (const receiptId of Array.from(requestedMethods.keys())) {
          if (!receiptIds.has(receiptId)) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "سند الدفع لا يتبع هذه الفاتورة",
            });
          }
        }

        const oldFields = {
          notes: inv.notes ?? null,
          dueDate: inv.dueDate ? String(inv.dueDate).slice(0, 10) : null,
          paymentMethod: inv.paymentMethod ?? null,
          receipts: invoiceReceipts.map((receipt) => ({
            receiptId: Number(receipt.id),
            method: receipt.paymentMethod,
            cashBucket: receipt.cashBucket,
          })),
        };

        const nextNotes =
          input.notes === undefined
            ? (inv.notes ?? null)
            : input.notes.trim() || null;
        const nextDueDate =
          input.dueDate === undefined
            ? inv.dueDate
              ? String(inv.dueDate).slice(0, 10)
              : null
            : input.dueDate;
        const nextReceipts = invoiceReceipts.map((receipt) => ({
          ...receipt,
          nextMethod:
            requestedMethods.get(Number(receipt.id)) ?? receipt.paymentMethod,
        }));
        const receiptMethodChanged = nextReceipts.some(
          (receipt) => receipt.nextMethod !== receipt.paymentMethod,
        );
        const headerChanged =
          nextNotes !== (inv.notes ?? null) ||
          nextDueDate !==
            (inv.dueDate ? String(inv.dueDate).slice(0, 10) : null);
        if (!headerChanged && !receiptMethodChanged) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "لم يتغير أي حقل في الفاتورة",
          });
        }

        for (const receipt of nextReceipts) {
          if (receipt.nextMethod === receipt.paymentMethod) continue;
          // لا يجوز إنشاء حركة درج نقدي بلا وردية؛ إن كانت دفعة البطاقة الأصلية
          // مرتبطة بورديّة الفاتورة نستخدمها عند التصحيح، وإلا يلزم تسجيلها عبر
          // مسار خزينة مناسب بدلاً من توليد نقدٍ يتيم في التقارير.
          if (
            receipt.nextMethod === "CASH" &&
            receipt.shiftId == null &&
            inv.shiftId == null
          ) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "لا يمكن تحويل الدفعة إلى نقدي بلا وردية مرتبطة بالفاتورة",
            });
          }
          // طريقة الدفع هي مصدر تقارير الصندوق والبطاقات. لذلك تُعدّل في سند القبض
          // نفسه، لا في شارة الفاتورة فقط. النقد يبقى مرتبطاً بدرج الكاشير إن وُجد.
          await tx
            .update(receipts)
            .set({
              paymentMethod: receipt.nextMethod,
              cashBucket: receipt.nextMethod === "CASH" ? "DRAWER" : null,
              shiftId:
                receipt.nextMethod === "CASH"
                  ? (receipt.shiftId ?? inv.shiftId)
                  : receipt.shiftId,
            })
            .where(eq(receipts.id, receipt.id));
        }

        // invoices.paymentMethod حقل عرض مختصر فقط؛ مصدر الحقيقة للدفعات هو receipts.
        // في الدفع المختلط نحتفظ بآخر طريقة قبض، كما يفعل تسجيل الدفعة الاعتيادي.
        const lastReceipt = nextReceipts.at(-1);
        const nextPaymentMethod =
          lastReceipt?.nextMethod ?? inv.paymentMethod ?? null;
        await tx
          .update(invoices)
          .set({
            notes: nextNotes,
            dueDate: nextDueDate
              ? new Date(`${nextDueDate}T00:00:00.000Z`)
              : null,
            paymentMethod: nextPaymentMethod,
          })
          .where(eq(invoices.id, input.invoiceId));

        const newFields = {
          notes: nextNotes,
          dueDate: nextDueDate,
          paymentMethod: nextPaymentMethod,
          receipts: nextReceipts.map((receipt) => ({
            receiptId: Number(receipt.id),
            method: receipt.nextMethod,
            cashBucket: receipt.nextMethod === "CASH" ? "DRAWER" : null,
          })),
        };
        await logAuditTx(tx, ctx, {
          action: "sale.invoiceCorrect",
          entityType: "invoice",
          entityId: input.invoiceId,
          oldValue: oldFields,
          newValue: { reason: input.reason, fields: newFields },
        });

        return { invoiceId: input.invoiceId };
      });
    }),

  /** سجل تصحيحات الفاتورة للمدير/المالك فقط. */
  correctionHistory: salesManagerProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return [];
      return db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          oldValue: auditLogs.oldValue,
          newValue: auditLogs.newValue,
          createdAt: auditLogs.createdAt,
          userName: users.name,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(
          and(
            eq(auditLogs.entityType, "invoice"),
            eq(auditLogs.entityId, String(input.invoiceId)),
            eq(auditLogs.action, "sale.invoiceCorrect"),
          ),
        )
        .orderBy(desc(auditLogs.id));
    }),

  // عزل الفرع: غير المدير يرى فواتير فرعه فقط (منع IDOR).
  // /simplify ٣٠/٦: list = listPage().rows ⇒ كاتب واحد للاستعلام، صفر تَكرار.
  list: salesReadProcedure
    .input(salesListInput)
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const baseConds = buildSalesListConds(input, ctx.scopedBranchId, ctx.scopedOwnerId);
      const page = await paginateKeyset({
        cursor: input?.cursor,
        limit: input?.limit,
        offset: input?.offset,
        defaultLimit: 50,
        idCol: invoices.id,
        baseConds,
        runQuery: (where, lim, off) => db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            sourceType: invoices.sourceType,
            // branchId يُعرَض في عمود «الفرع» لدى المرتفعين حين الفلتر «كل الفروع» (التسمية من branches.list واجهياً).
            branchId: invoices.branchId,
            invoiceDate: invoices.invoiceDate,
            total: invoices.total,
            paidAmount: invoices.paidAmount,
            returnedTotal: invoices.returnedTotal,
            status: invoices.status,
            paymentMethod: invoices.paymentMethod,
            // فاتورة COD لا تحمل العميل كطرف مدين، لكن نعرض عميل أمر الخدمة الأصلي
            // كي لا تختفي طلبات واتساب تحت «عميل نقدي».
            customerId: sql<number | null>`COALESCE(${invoices.customerId}, ${workOrders.customerId})`,
            customerName: sql<string | null>`COALESCE(${customers.name}, ${workOrderInvoiceCustomer.name})`,
            customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${workOrderInvoiceCustomer.whatsapp}, ''), NULLIF(${workOrderInvoiceCustomer.phone}, ''))`,
            salespersonName: sql<string | null>`COALESCE(${invoices.salespersonNameSnapshot}, ${users.name})`,
            shiftId: invoices.shiftId,
            deviceId: invoices.posDeviceId,
          })
          .from(invoices)
          .leftJoin(customers, eq(invoices.customerId, customers.id))
          .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
          .leftJoin(workOrderInvoiceCustomer, eq(workOrders.customerId, workOrderInvoiceCustomer.id))
          .leftJoin(users, eq(invoices.createdBy, users.id))
          .where(where)
          .orderBy(desc(invoices.id))
          .limit(lim)
          .offset(off),
      });
      return page.rows;
    }),

  // S3+S4 (٣٠/٦): listPage — صياغة keyset رسمية تُعيد `{rows, nextCursor, hasMore}`.
  // للواجهات الجَديدة (useInfiniteQuery({getNextPageParam})).
  listPage: salesReadProcedure
    .input(salesListInput)
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], nextCursor: null as number | null, hasMore: false };
      const baseConds = buildSalesListConds(input, ctx.scopedBranchId, ctx.scopedOwnerId);
      const { rows, hasMore, nextCursor } = await paginateKeyset({
        cursor: input?.cursor,
        limit: input?.limit,
        offset: input?.offset,
        defaultLimit: 50,
        idCol: invoices.id,
        baseConds,
        runQuery: (where, lim, off) => db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            sourceType: invoices.sourceType,
            // branchId يُعرَض في عمود «الفرع» لدى المرتفعين حين الفلتر «كل الفروع» (التسمية من branches.list واجهياً).
            branchId: invoices.branchId,
            invoiceDate: invoices.invoiceDate,
            total: invoices.total,
            paidAmount: invoices.paidAmount,
            returnedTotal: invoices.returnedTotal,
            status: invoices.status,
            paymentMethod: invoices.paymentMethod,
            customerId: sql<number | null>`COALESCE(${invoices.customerId}, ${workOrders.customerId})`,
            customerName: sql<string | null>`COALESCE(${customers.name}, ${workOrderInvoiceCustomer.name})`,
            customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${workOrderInvoiceCustomer.whatsapp}, ''), NULLIF(${workOrderInvoiceCustomer.phone}, ''))`,
            salespersonName: sql<string | null>`COALESCE(${invoices.salespersonNameSnapshot}, ${users.name})`,
            shiftId: invoices.shiftId,
            deviceId: invoices.posDeviceId,
          })
          .from(invoices)
          .leftJoin(customers, eq(invoices.customerId, customers.id))
          .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
          .leftJoin(workOrderInvoiceCustomer, eq(workOrders.customerId, workOrderInvoiceCustomer.id))
          .leftJoin(users, eq(invoices.createdBy, users.id))
          .where(where)
          .orderBy(desc(invoices.id))
          .limit(lim)
          .offset(off),
      });
      return { rows, nextCursor, hasMore };
    }),

  /** موظفو المبيعات الذين لديهم فواتير ضمن نطاق صلاحية المستدعي — لتغذية الفلتر بلا كشف دليل المستخدمين. */
  salespeople: salesReadProcedure.query(async ({ ctx }) => {
    const db = getDb();
    if (!db) return [];
    const conds = [isNotNull(invoices.createdBy)];
    if (ctx.scopedBranchId != null) conds.push(eq(invoices.branchId, ctx.scopedBranchId));
    if (ctx.scopedOwnerId != null) conds.push(eq(invoices.createdBy, ctx.scopedOwnerId));
    return db
      .select({
        id: invoices.createdBy,
        name: sql<string>`COALESCE(MAX(${invoices.salespersonNameSnapshot}), MAX(${users.name}), '—')`,
      })
      .from(invoices)
      .leftJoin(users, eq(invoices.createdBy, users.id))
      .where(and(...conds))
      .groupBy(invoices.createdBy)
      .orderBy(sql`name ASC`);
  }),

  // مجاميع كل النتائج المطابقة للفلتر (لا الصفحة المعروضة فقط) — نفس شروط list حتماً
  // عبر buildSalesListConds. الأموال نصّية كما تعيدها mysql2 (SUM على decimal) — لا parseFloat.
  listSummary: salesReadProcedure
    .input(salesListInput)
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { count: 0, totalAmount: "0", paidAmount: "0", dueAmount: "0" };
      const conds = buildSalesListConds(input, ctx.scopedBranchId, ctx.scopedOwnerId);
      const row = (
        await db
          .select({
            count: sql<number>`COUNT(*)`,
            totalAmount: sql<string>`COALESCE(SUM(${invoices.total}), 0)`,
            paidAmount: sql<string>`COALESCE(SUM(${invoices.paidAmount}), 0)`,
            // المتبقي (AR الحقيقي): total − paidAmount − returnedTotal لغير الملغاة
            // (الملغاة لا ذمة عليها؛ المرتجع جزئياً يُخصم منه ما أُرجع).
            dueAmount: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.status} != 'CANCELLED'
              THEN CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(${invoices.paidAmount} AS DECIMAL(15,2)) - CAST(${invoices.returnedTotal} AS DECIMAL(15,2)) ELSE 0 END), 0)`,
          })
          .from(invoices)
          // join إلزاميّ: buildSalesListConds قد يُشير لـcustomers.searchNorm عند البحث بـq.
          // leftJoin على مفتاح أجنبيّ أحاديّ ⇒ لا يُضاعف صفوف الفواتير ⇒ المجاميع تبقى صحيحة،
          // وcount يبقى مطابقاً تماماً لعدد صفوف list (نفس الشروط ونفس الجداول).
          .leftJoin(customers, eq(invoices.customerId, customers.id))
          .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
          .where(conds.length ? and(...conds) : undefined)
      )[0];
      return {
        count: Number(row?.count ?? 0),
        totalAmount: String(row?.totalAmount ?? "0"),
        paidAmount: String(row?.paidAmount ?? "0"),
        dueAmount: String(row?.dueAmount ?? "0"),
      };
    }),

  get: salesReadProcedure.input(z.object({ invoiceId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return null;
    const inv = (
      await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          sourceType: invoices.sourceType,
          branchId: invoices.branchId,
          // العميل هنا مرجع عرضٍ وتشغيل لفاتورة COD فقط؛ الطرف المالي يبقى جهة التوصيل.
          customerId: sql<number | null>`COALESCE(${invoices.customerId}, ${workOrders.customerId})`,
          customerName: sql<string | null>`COALESCE(${customers.name}, ${workOrderInvoiceCustomer.name})`,
          customerPhone: sql<string | null>`COALESCE(${customers.phone}, ${workOrderInvoiceCustomer.phone})`,
          customerBalance: sql<string | null>`COALESCE(${customers.currentBalance}, ${workOrderInvoiceCustomer.currentBalance})`,
          priceTier: invoices.priceTier,
          invoiceDate: invoices.invoiceDate,
          dueDate: invoices.dueDate,
          subtotal: invoices.subtotal,
          taxAmount: invoices.taxAmount,
          taxRatePercent: invoices.taxRatePercent,
          discountAmount: invoices.discountAmount,
          total: invoices.total,
          costTotal: invoices.costTotal,
          paidAmount: invoices.paidAmount,
          // #1 (تدقيق التثبيت): المتبقّي الحقيقي = total − returnedTotal − paidAmount (كـlistSummary).
          returnedTotal: invoices.returnedTotal,
          status: invoices.status,
          paymentMethod: invoices.paymentMethod,
          notes: invoices.notes,
          createdBy: invoices.createdBy,
          salespersonName: sql<string | null>`COALESCE(${invoices.salespersonNameSnapshot}, ${users.name})`,
          shiftId: invoices.shiftId,
          shiftType: shifts.shiftType,
          shiftOpenedAt: shifts.openedAt,
          deviceId: invoices.posDeviceId,
          cancelledByName: invoices.cancelledByNameSnapshot,
          cancelledAt: invoices.cancelledAt,
          // إفصاح التوصيل (0152): الأجرة المقبوضة، وهل أُهديت، وقيمة ما تُنوزِل عنه — تُعرَض
          // في الشاشة وتُطبَع، فيميّز الزبون «توصيل مجّاني» عن «بلا توصيل».
          deliveryFee: invoices.deliveryFee,
          deliveryFree: invoices.deliveryFree,
          deliveryWaivedAmount: invoices.deliveryWaivedAmount,
          // إفصاح توصيل الاستقبال (COURIER/COD): الأجرة على الإرسالية لا على الفاتورة (تمريرٌ
          // لا إيراد) — نُرجعها للعرض/الطباعة فقط كي تُظهر الفاتورة «يدفع الزبون شاملاً التوصيل».
          courierName: deliveryParties.name,
          courierFee: deliveryConsignments.deliveryFee,
          courierFeeCollection: deliveryConsignments.feeCollection,
          consignmentNumber: deliveryConsignments.consignmentNumber,
          workOrderCreatedBy: workOrders.createdBy,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
        .leftJoin(workOrderInvoiceCustomer, eq(workOrders.customerId, workOrderInvoiceCustomer.id))
        .leftJoin(users, eq(invoices.createdBy, users.id))
        .leftJoin(shifts, eq(invoices.shiftId, shifts.id))
        .leftJoin(deliveryConsignments, eq(deliveryConsignments.invoiceId, invoices.id))
        .leftJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
        .where(eq(invoices.id, input.invoiceId))
        .limit(1)
    )[0];
    if (!inv) return null;
    // عزل الفرع: لا تكشف وجود فاتورة فرع آخر لغير المدير.
    if (ctx.scopedBranchId && inv.branchId !== ctx.scopedBranchId) return null;
    // لا يفتح الكاشير فاتورة زميل عبر رابط مباشر، لكنه يفتح الفاتورة الناتجة من
    // أمر خدمة العملاء الذي أنشأه حتى إن قام موظف آخر بالإرسال أو التسليم.
    if (
      ctx.scopedOwnerId != null
      && Number(inv.createdBy) !== ctx.scopedOwnerId
      && Number(inv.workOrderCreatedBy) !== ctx.scopedOwnerId
    ) return null;
    const items = await db
      .select({
        id: invoiceItems.id,
        variantId: invoiceItems.variantId,
        productUnitId: invoiceItems.productUnitId,
        quantity: invoiceItems.quantity,
        baseQuantity: invoiceItems.baseQuantity,
        returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
        unitPrice: invoiceItems.unitPrice,
        unitCost: invoiceItems.unitCost,
        discountAmount: invoiceItems.discountAmount,
        total: invoiceItems.total,
        // هدايا الفاتورة (0149): تُوسَم في شاشة الفاتورة وطباعتها — «مجاناً» لا «صفر» (الصفر
        // يُقرأ خطأَ إدخالٍ، والوسم يُثبت أنّ المجّانيّة قرارٌ مسجَّلٌ بتكلفةٍ مُرحَّلة في الدفتر).
        isGift: invoiceItems.isGift,
        productId: products.id,

        productName: products.name,
        sku: productVariants.sku,
        variantName: productVariants.variantName,
        unitName: productUnits.unitName,
      })
      .from(invoiceItems)
      .leftJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(productUnits, eq(invoiceItems.productUnitId, productUnits.id))
      .where(eq(invoiceItems.invoiceId, input.invoiceId));
    const payments = await db
      .select({
        id: receipts.id,
        direction: receipts.direction,
        amount: receipts.amount,
        paymentMethod: receipts.paymentMethod,
        status: receipts.status,
        createdAt: receipts.createdAt,
        referenceNumber: receipts.referenceNumber,
        // attachment-upload (٥/٧): سند مربوط بهذه الفاتورة (اختياري) — رقمه + مرفقه إن وُجدا.
        voucherNumber: receipts.voucherNumber,
        attachmentUrl: receipts.attachmentUrl,
      })
      .from(receipts)
      .where(eq(receipts.invoiceId, input.invoiceId))
      .orderBy(asc(receipts.id));
    const returns = await db
      .select({
        id: accountingEntries.id,
        amount: accountingEntries.amount,
        performedBy: accountingEntries.createdBy,
        performedByName: accountingEntries.createdByNameSnapshot,
        createdAt: accountingEntries.createdAt,
      })
      .from(accountingEntries)
      .where(and(eq(accountingEntries.invoiceId, input.invoiceId), eq(accountingEntries.entryType, "RETURN")))
      .orderBy(asc(accountingEntries.id));

    // توليد qrPayload موقَّعة بـ HMAC من الخادم — الواجهة تعرضها فقط
    const qrPayload = invoiceBarcodeSet({
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: String(inv.invoiceDate),
      total: inv.total,
      branchId: inv.branchId,
    }).qrPayload;
    // حقل تفويض داخلي للاستعلام فقط؛ لا يكون جزءاً من عقد تفاصيل الفاتورة.
    const { workOrderCreatedBy: _workOrderCreatedBy, ...invoiceForView } = inv;

    // حجب التكلفة عن غير المدير (منع كشف هامش الربح).
    if (!canSeeCostForUser(ctx.user)) {
      const { costTotal: _c, ...invNoCost } = invoiceForView;
      const itemsNoCost = items.map(({ unitCost: _u, ...rest }) => rest);
      return { ...invNoCost, items: itemsNoCost, payments, returns, qrPayload };
    }
    return { ...invoiceForView, items, payments, returns, qrPayload };
  }),
});
