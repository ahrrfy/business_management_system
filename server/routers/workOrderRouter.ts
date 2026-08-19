import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { z } from "zod";
import {
  auditLogs,
  customers,
  deliveryConsignments,
  deliveryParties,
  productVariants,
  products,
  users,
  serviceTypes,
  tasks,
  workOrderImages,
  workOrderMaterials,
  workOrders,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  cancelWorkOrder,
  reverseServiceInvoice,
  claimWorkOrder,
  createWorkOrder,
  deliverWorkOrder,
  markWorkOrderReady,
  setWorkOrderMaterials,
  startWorkOrder,
  updateWorkOrder,
  updateWorkOrderDeliveryMethod,
} from "../services/workOrderService";
import {
  approveWorkOrderCancellationRefund,
  getWorkOrderCancellationRefundStatus,
  listPendingWorkOrderCancellationRefunds,
} from "../services/workOrder/cancel";
import { logAudit } from "../services/auditService";
import { verifyManagerApproval } from "./saleRouter";
import { requestDesignApproval } from "../services/workOrder/approval";
import { setWorkOrderDesign } from "../services/workOrder/design";
import { canSeeCostForUser, ownerProcedure, protectedProcedure, router, workordersCashierProcedure, workordersExecProcedure, workordersManagerProcedure, workordersReadProcedure } from "../trpc";
import { hasModuleAccess } from "@shared/permissions";
import { workOrderBarcodeSet } from "../services/barcodeService";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { assertValidImageDataUrl } from "../lib/imageValidation";
import { isDupEntry } from "@shared/errorMap.ar";
import { money } from "../services/money";
import { retryOnDeadlock } from "../lib/retryDeadlock";
import { withTx } from "../services/tx";
import { workOrderFeeHeldNet } from "../services/workOrder/deliveryFeeRefund";
import { checkoutReception } from "../services/receptionCheckoutService";
import { logger } from "../logger";
import { upsertConversation } from "../services/conversationService";
import { normalizeIraqPhoneE164 } from "../lib/phone";
import { POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE, isPosPaymentMethodEnabled } from "@shared/posPaymentPolicy";

const workOrderCreatorUser = alias(users, "workOrderCreatorUser");
/** محرّر البنود الأخير (0199) — اسمٌ يُعرَض بجانب وسم «مُعدَّل» فيُعرَف من غيّر ماذا. */
const materialsEditorUser = alias(users, "materialsEditorUser");
const workOrderCreatorDisplayName = sql<string | null>`COALESCE(
  NULLIF(TRIM(${workOrderCreatorUser.name}), ''),
  NULLIF(TRIM(${workOrderCreatorUser.username}), ''),
  NULLIF(TRIM(${workOrderCreatorUser.email}), ''),
  CONCAT('مستخدم #', ${workOrders.createdBy})
)`;

// سطوح نقطة البيع/الاستقبال نقدية فقط حتى يوجد مزوّد وتسوية موثوقان.
const receptionPaymentMethod = z
  .enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM"])
  .refine(isPosPaymentMethodEnabled, { message: POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE })
  .transform((value) => value as "CASH");
const priceTierEnum = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const quantityString = z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة");
const receptionWorkOrderSchema = z.object({
  baseVariantId: z.number().int().positive().nullish(),
  title: z.string().trim().min(1),
  customizationText: z.string().nullish(),
  quantity: z.number().int().positive().default(1),
  materials: z.array(z.object({ variantId: z.number().int().positive(), baseQuantity: z.number().int().positive() })).default([]),
  laborCost: nonNegMoneyString.default("0"),
  salePrice: positiveMoneyString,
  dueDate: z.string().nullish(),
  notes: z.string().nullish(),
  assignedTo: z.number().int().positive().nullish(),
  receptionChannel: z.enum(["WALK_IN", "WHATSAPP", "INSTAGRAM", "TIKTOK", "PHONE", "OTHER"]).nullish(),
  channelHandle: z.string().max(120).nullish(),
  priority: z.enum(["LOW", "NORMAL", "URGENT"]).nullish(),
  deposit: nonNegMoneyString.nullish(),
  paymentMethod: receptionPaymentMethod.nullish(),
  paymentReference: z.string().max(100).nullish(),
  paymentReceiptUrl: z.string().nullish(),
  hasDelivery: z.boolean().nullish(),
  deliveryAddress: z.string().nullish(),
  deliveryCost: nonNegMoneyString.nullish(),
  deliveryPhone: z.string().max(20).nullish(),
  // ٥/٨ — مَن يقبض أجرة التوصيل (الأجرة تمريرٌ لا إيراد، خارج salePrice دائماً).
  deliveryFeeCollection: z.enum(["COURIER", "COUNTER", "SHOP"]).nullish(),
  // زبون عابر بلا سجلّ عميل: مرجعٌ للطلب فقط (لا عميل ولا ذمّة).
  contactName: z.string().trim().max(255).nullish(),
  contactPhone: z.string().trim().max(32).nullish(),
  designImages: z.array(z.object({
    url: z.string().min(1),
    caption: z.string().max(255).nullish(),
    sortOrder: z.number().int().min(0).nullish(),
  })).max(10).default([]),
});

const receptionCheckoutSchema = z.object({
  branchId: z.number().int().positive(),
  shiftId: z.number().int().positive(),
  customerId: z.number().int().positive().nullish(),
  // صدق طريقة الدفع (١٨/٨): تلزم فقط حين يُقبض مالٌ الآن (حارس superRefine أدناه). سلّةٌ
  // آجلة/COD/مموَّلة بعربون محتجَز تمرّ بلا طريقة فتُختَم الفاتورة NULL = «آجل» بالاشتقاق.
  paymentMethod: receptionPaymentMethod.nullish(),
  paymentReference: z.string().trim().max(100).nullish(),
  paidAmount: nonNegMoneyString.nullish(),
  clientRequestId: z.string().min(1).max(60),
  // فئة سعر صريحة لكامل سلة الاستقبال (غيابها ⇒ فئة العميل الافتراضية ثم RETAIL، نمط resolveTier).
  priceTier: priceTierEnum.nullish(),
  // كوبون CRM — على البيع المباشر فقط (لا خدمات طباعة).
  couponCode: z.string().trim().min(1).max(64).nullish(),
  // ش٠ (٥/٨، V1): تقريب نقدي IQD — يسري خادمياً على البيع المباشر الخالص النقديّ فقط
  // (الحارس في receptionCheckoutService يُسقطه عن السلة المختلطة/غير النقدية حتى لو أُرسل).
  cashRoundIQD: z.boolean().optional(),
  // ش٦ — تقريب السلّة المختلطة: الواجهة تبيّت فرق السلّة كلّها في مبلغ الفاتورة الحاملة
  // وتسمّيها هنا؛ الخادم يقيّد الفرق ADJUST عليها (محروس: نقديّ + |الفرق| < ٢٥٠ + ناتجٌ موجب).
  cashRoundingOverride: z.enum(["SALE", "PRINT"]).nullish(),
  // ش٦ (V15): أجرة توصيل الطلب المقبوضة الآن أمانةً للمندوب — نقداً في الدرج حتماً.
  deliveryFeeHeld: positiveMoneyString.nullish(),
  // ش٧: إسناد الطلب لمندوبٍ داخل نفس المعاملة — المتبقّي عهدةٌ عليه لا نقدٌ في الدرج.
  delivery: z.object({
    partyId: z.number().int().positive(),
    fee: nonNegMoneyString.nullish(),
    feeCollection: z.enum(["COURIER", "COUNTER", "SHOP"]).nullish(),
    recipientName: z.string().trim().max(255).nullish(),
    recipientPhone: z.string().trim().max(32).nullish(),
    address: z.string().trim().max(500).nullish(),
  }).nullish(),
  // الاستقبال (٨/٨): تأكيد الموظّف توفّر الأصناف غير المجرودة فيزيائياً (بيع بالسالب لطلب COD في وضع الافتتاح).
  openingSellUnavailableConfirmed: z.boolean().optional(),
  // بيع مباشر بدون عربون: المقبوض أقلّ من إجمالي البضاعة/الطباعة بلا توصيل ⇒ المتبقّي ذمّةٌ على
  // عميل استقبال فعّال بهوية مكتملة (اسم + هاتف عراقي). التفويض الخادمي محصور في checkoutReception.
  deferredDirect: z.boolean().optional(),
  // ش١ (م٦): اعتماد مديرٍ للخصم اليدويّ >١٠٪ (بريد+كلمة مرور، verifyManagerApproval نفسها) —
  // يمنح priceOverrideApproved للكاشير كما يمنحه sales.create تماماً.
  managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
  // ٥/٨ — زبونٌ عابر: اسمٌ وهاتفٌ مرجعيّان يُكتبان على الفاتورة نفسها بلا إنشاء عميل ولا ذمّة.
  // يحلّان محلّ إجبار الكاشير على إنشاء عميلٍ لكل بيعٍ نقديّ (وكان يفشل بـFORBIDDEN لأدوارٍ
  // تفتح محطة الاستقبال بلا صلاحية crm=FULL، فيسقط الاسم والهاتف بعد الطباعة تماماً).
  contactName: z.string().trim().max(255).nullish(),
  contactPhone: z.string().trim().max(32).nullish(),
  regularSale: z.object({
    lines: z.array(z.object({
      variantId: z.number().int().positive(),
      productUnitId: z.number().int().positive(),
      quantity: quantityString,
      discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
      // ترويج/كوبون (نمط POS.tsx buildSaleLine): سعر قائمة صحيح الدينار + خصم صريح، يتحقّق منه
      // الخادم مقابل العرض الفعلي (sale/create.ts) بلا رفضٍ لو تغيّر العرض بين العرض والحفظ.
      unitPriceOverride: nonNegMoneyString.optional(),
      discountAmount: nonNegMoneyString.optional(),
      promotionId: z.number().int().positive().nullish(),
    })).min(1),
    amount: positiveMoneyString,
  }).nullish(),
  printSale: z.object({
    lines: z.array(z.object({
      variantId: z.number().int().positive(),
      productUnitId: z.number().int().positive(),
      quantity: quantityString,
      unitPriceOverride: nonNegMoneyString.optional(),
    })).min(1),
    amount: positiveMoneyString,
  }).nullish(),
  workOrders: z.array(receptionWorkOrderSchema).max(50).default([]),
}).superRefine((input, ctx) => {
  if (!input.regularSale && !input.printSale && input.workOrders.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "السلة فارغة" });
  }
  if (input.workOrders.length > 0 && input.customerId == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customerId"],
      message: "أوامر الشغل تتطلب عميلاً محفوظاً مع اسم ورقم هاتف",
    });
  }
  // صدق طريقة الدفع: قبضٌ موجب بلا طريقة = إدخالٌ ناقص (والعكس — طريقةٌ بلا قبض — تُهمَل
  // في الخدمة بدل أن تُختَم كذباً على الفاتورة).
  if (money(input.paidAmount ?? "0").gt(0) && !input.paymentMethod) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["paymentMethod"],
      message: "حدّد طريقة القبض للمبلغ المستلم",
    });
  }
  for (let index = 0; index < input.workOrders.length; index += 1) {
    const order = input.workOrders[index];
    if (money(order.deposit ?? "0").gt(0) && (order.paymentMethod ?? null) !== (input.paymentMethod ?? null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workOrders", index, "paymentMethod"], message: "طريقة دفع العربون لا تطابق طريقة دفع العملية" });
    }
  }
});

/**
 * يربط عميل أمر الشغل بمحادثة واتساب جاهزة في صندوق القنوات. الربط أثر تشغيلي لاحق
 * للالتزام المالي؛ فشله لا يُرجع أمراً/فاتورة التزما فعلاً، لذلك يستعمله المستهلكون best-effort.
 */
async function ensureWorkOrderWhatsAppConversation(input: {
  branchId: number;
  customerId: number | null | undefined;
  receptionChannel?: string | null;
  channelHandle?: string | null;
}) {
  if (input.customerId == null) return;
  const db = getDb();
  if (!db) return;
  const customer = (await db.select({
    name: customers.name,
    phone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
  }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
  if (!customer) return;
  const rawPhone = input.receptionChannel === "WHATSAPP" && input.channelHandle?.trim()
    ? input.channelHandle.trim()
    : customer.phone;
  if (!rawPhone || rawPhone.replace(/\D/g, "").length < 6) return;
  const handle = normalizeIraqPhoneE164(rawPhone).replace(/^\+/, "");
  if (!handle) return;
  await upsertConversation({
    branchId: input.branchId,
    channel: "WHATSAPP",
    channelHandle: handle,
    customerId: input.customerId,
    displayName: customer.name,
  });
}

/** حاجز خادمي: المعرّف وحده لا يكفي؛ أمر الشغل يجب أن يبقى قابلاً للاتصال حتى مع عميل قديم. */
async function assertWorkOrderCustomerReady(customerId: number) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  const customer = (await db.select({
    id: customers.id,
    isActive: customers.isActive,
    phone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
  }).from(customers).where(eq(customers.id, customerId)).limit(1))[0];
  if (!customer || !customer.isActive) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "العميل غير موجود أو معطّل" });
  }
  if (!customer.phone || customer.phone.replace(/\D/g, "").length < 6) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "رقم هاتف العميل مطلوب قبل حفظ أمر الشغل",
    });
  }
}

/** حالات أمر الشغل — مطابقة حرفياً لـmysqlEnum("workOrderStatus") في drizzle/schema.ts:1443. */
const woStatus = z.enum(["RECEIVED", "IN_PROGRESS", "READY", "DELIVERED", "CANCELLED"]);
/** الحالات النشطة (غير النهائية) — ما يعنى به الفنّي في محطة التنفيذ. */
export const WO_ACTIVE_STATUSES = ["RECEIVED", "IN_PROGRESS", "READY"] as const;

// استخدام ! كحرف هروب بـ ESCAPE '!' — بديل آمن عن \ (لا يُصاب بـNO_BACKSLASH_ESCAPES MySQL mode). نمط inventoryRouter.
const escLike = (s: string) => s.replace(/[!%_]/g, "!$&");

/** فلاتر القائمة/العدّادات المشتركة — تُبنى شروطاً واحدة كي لا تنحرف البطاقات عن الجدول. */
const woListFilters = {
  q: z.string().trim().max(120).optional(),
  /** نطاق تاريخ الإنشاء YYYY-MM-DD (شامل لليوم بحدود UTC — إطار businessDay). */
  from: z.string().optional(),
  to: z.string().optional(),
  // اِستقبال (٤/٨): نطاق تاريخ **التسليم الفعلي** — مستقلّ عن from/to (تاريخ الإنشاء). قسم «سُلِّمت
  // اليوم» في ReceptionOrderQueue يحتاج أوامر سُلِّمت اليوم بصرف النظر عن تاريخ إنشائها (قد يكون
  // الأمر أُنشئ أمس وسُلِّم اليوم) — from/to كانا سيُخفيانه صامتاً لو استُعملا هنا.
  deliveredFrom: z.string().optional(),
  deliveredTo: z.string().optional(),
  /** فلتر الفنّي المسؤول — لا يوسّع النطاق: عزل الفرع/الموظف القائم يبقى حاكماً فوقه. */
  assignedTo: z.number().int().positive().optional(),
};

/** يحوّل فلاتر q/from/to/deliveredFrom/deliveredTo/assignedTo إلى شروط SQL — q على رقم الأمر/العنوان/اسم العميل (join العملاء قائم). */
function buildWoFilterConds(input: { q?: string; from?: string; to?: string; deliveredFrom?: string; deliveredTo?: string; assignedTo?: number } | undefined): SQL[] {
  const conds: SQL[] = [];
  const search = input?.q?.trim();
  if (search) {
    const pat = `%${escLike(search)}%`;
    conds.push(
      sql`(${workOrders.orderNumber} LIKE ${pat} ESCAPE '!' OR ${workOrders.title} LIKE ${pat} ESCAPE '!' OR ${customers.name} LIKE ${pat} ESCAPE '!')`,
    );
  }
  if (input?.from) {
    const from = new Date(input.from);
    if (!isNaN(from.getTime())) conds.push(gte(workOrders.createdAt, from));
  }
  if (input?.to) {
    // شامل لليوم: < بداية اليوم التالي بـUTC (نمط movementsRich — حتميّ مهما كانت منطقة عملية Node).
    const to = new Date(input.to);
    if (!isNaN(to.getTime())) {
      const next = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
      conds.push(lt(workOrders.createdAt, next));
    }
  }
  if (input?.deliveredFrom) {
    const from = new Date(input.deliveredFrom);
    if (!isNaN(from.getTime())) conds.push(gte(workOrders.deliveredAt, from));
  }
  if (input?.deliveredTo) {
    const to = new Date(input.deliveredTo);
    if (!isNaN(to.getTime())) {
      const next = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
      conds.push(lt(workOrders.deliveredAt, next));
    }
  }
  if (input?.assignedTo != null) conds.push(eq(workOrders.assignedTo, input.assignedTo));
  return conds;
}

/**
 * اِستقبال (تكامل التوصيل، ٤/٨): رؤية حالة الإرسالية/الجهة داخل قوائم أوامر الشغل — **نفس بوّابة**
 * `deliveryReadProcedure` بالضبط (`requireModule("store","READ")`) كي لا ينحرف من يرى DeliveryHub
 * عمّن يرى نفس المعلومة مضمّنةً في شاشة الاستقبال (defense-in-depth، نمط canSeeCostForUser).
 */
function canSeeDeliveryForUser(user: { role: string; permissionsOverride?: unknown }): boolean {
  if (user.role === "admin") return true;
  const override = (user.permissionsOverride as any) ?? null;
  if (hasModuleAccess(user.role, override, "store", "READ")) return true;
  // ١٨/٨ (بلاغ المالك: «لا تظهر… ولا حتى لفنّي المطبعة»): **مشغّل المحطة** (`workorders:FULL`)
  // هو من يُسنِد الطلب للمندوب فعلاً؛ إخفاءُ حالةِ ما أسنده عنه ليس تشديداً بل عمًى تشغيليّ —
  // يرى الأمر «جاهز» ولا يعلم أنّه خرج، فيسحبه في الكانبان أو يحاول إسناده ثانيةً.
  // النطاق هنا **معلومةٌ مضمّنة** (حالة/جهة/رقم الإرسالية) لا شاشةُ DeliveryHub وتسوياتها؛
  // فتحُها لمن يشغّل الإسناد يوافق الحاجة بلا توسيع وحدة المتجر. قالب `print_operator` بلا
  // مفتاح `store` إطلاقاً وكان يسقط إلى NONE صامتاً.
  return hasModuleAccess(user.role, override, "workorders", "FULL");
}

/**
 * مشغّلُ المحطّة فعلاً (`workorders:FULL`) — بوّابةُ «طابور الفرع». دالّةٌ مستقلّة عن
 * `canSeeDeliveryForUser` عمداً رغم تطابقهما اليوم: هذه تُجيب «هل يعمل في المحطّة؟»
 * وتلك تُجيب «هل يرى حالة التوصيل؟» — ودمجُهما يجعل توسيعَ إحداهما يفتح الأخرى صامتاً.
 */
function workOrdersFullAccess(user: { role: string; permissionsOverride?: unknown }): boolean {
  if (user.role === "admin") return true;
  return hasModuleAccess(user.role, (user.permissionsOverride as never) ?? null, "workorders", "FULL");
}

export const workOrderRouter = router({
  // §٧ IDOR: الكاشير لا يجب أن يرى أوامر فروع أخرى. branchScopedProcedure يحقن
  // scopedBranchId=null للأدمن، ورقم الفرع للمدير وغيره.
  list: workordersReadProcedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(500).default(100), // تدقيق ٣/٨: سقف صريح ضدّ DoS الذاكرة.
          branchId: z.number().int().positive().optional(),
          // ترشيح خادميّ بالحالة — لمحطة التنفيذ ولأي شاشة تريد «العمل النشط» وحده.
          // ⚠️ لماذا: القائمة تُرتَّب desc(id) وتُقتطع بـlimit، والحالات النهائية (DELIVERED/
          // CANCELLED) تتراكم بلا سقف ⇒ نافذة الـN الأحدث تمتلئ بالتاريخ فيسقط **عملٌ نشط**
          // من الشاشة بصمت (أمرٌ في الطابور لا يظهر للفنّي = ضرر تشغيليّ لا مجرّد بطء).
          // الترشيح خادمياً يجعل مجموعة العمل النشط صغيرةً بطبيعتها وكاملةً دائماً.
          statuses: z.array(woStatus).min(1).optional(),
          /** أوامر مُسنَدة للمستخدم الحالي فقط (هوية من ctx — لا تُقبل من العميل: منع IDOR). */
          assignedToMe: z.boolean().optional(),
          /** أوامر غير مُسنَدة لأحد (الطابور العام المشترك). */
          unassignedOnly: z.boolean().optional(),
          /**
           * **طابور الفرع** (قرار المالك ١٩/٨): الشاشات التشغيلية — الكانبان وطابور المحطّة —
           * تعرض أوامر الفرع كلّها لا ما أنشأه الموظّف وحده. موظّفةُ استقبالٍ لا ترى طلبات
           * زميلتها كانت تعجز عن الردّ على زبونٍ سألها عن طلبٍ استقبلته الوردية السابقة.
           *
           * يُسقط **عزل الموظّف وحده**؛ وعزلُ الفرع يبقى حاكماً دائماً (`scopedBranchId`).
           * وبوّابته `workorders:FULL` — أي مَن يعمل في المحطّة فعلاً، لا كل من يقرأ الوحدة.
           * والعزل الماليّ (فواتيره/مبيعاته/تقاريره) **لا يتأثّر**: مسارُه `sales` لا هذا.
           */
          branchQueue: z.boolean().optional(),
          ...woListFilters,
          // keyset للتصدير الكامل: id < cursor مع الحفاظ على الشكل المُعاد مصفوفةً صرفة
          // (WorkOrderStation وشاشات أخرى تعتمد RouterOutputs["workOrders"]["list"] مصفوفة).
          // صفحة أقصر من limit = النهاية؛ آخر id في الصفحة = cursor التالي.
          cursor: z.number().int().positive().optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      // إن كان للمستخدم نطاق فرع ⇒ نُجبره ولا نسمح بالمرور حوله. للمرتفعين يطبَّق الفلتر إن أُعطي.
      const effectiveBranchId = ctx.scopedBranchId ?? input?.branchId;
      const branchCond = effectiveBranchId != null ? eq(workOrders.branchId, effectiveBranchId) : undefined;
      // عزل الموظف: غير المرتفعين يرون أوامرهم فقط — ما أنشأوه (الكاشير) أو المُسنَد إليهم (الفني).
      // admin/manager (scopedOwnerId=null) يرون كل أوامر النطاق.
      // ⚠️ استثناء الطابور غير المُسنَد من **عزل الموظف** (عزل الفرع يبقى ساريًا دائماً):
      // «الطابور العام» في محطة التنفيذ أوامرُ **لا مالك لها بعد** (assignedTo IS NULL)، ينشئها
      // الكاشير ليسحبها أيّ فنّي. عزل الموظف (PR #57، ٢٤/٦) طُبّق على workOrders.list في نفس يوم
      // إطلاق المحطة فصار الشرط `createdBy=me OR assignedTo=me` يُخفي هذا الطابور عن الفنّيين
      // كلياً — بينما `claim` يسمح لهم بسحبه (workordersExecProcedure) ⇒ زرُّ سحبٍ لعملٍ لا يُرى.
      // العطل صامت (طابور فارغ يبدو «لا عمل» لا «عملٌ محجوب»). الاستثناء ضيّق عمداً: يسري فقط
      // حين unassignedOnly=true ⇒ لا يكشف سجلَّ أيّ موظفٍ آخر (الأمر بلا مالك بحكم التعريف).
      // سياسة عزل سجلّات الموظف (٢٤/٦) تبقى كما هي لكل ما عداه.
      const sharedQueue = input?.unassignedOnly === true;
      // طابور الفرع: يلزمه `workorders:FULL` صراحةً — لا يكفي أن يطلبه العميل.
      const branchQueue = input?.branchQueue === true && workOrdersFullAccess(ctx.user);
      const ownerCond =
        ctx.scopedOwnerId != null && !sharedQueue && !branchQueue
          ? or(eq(workOrders.createdBy, ctx.scopedOwnerId), eq(workOrders.assignedTo, ctx.scopedOwnerId))
          : undefined;
      const extra = [
        input?.statuses?.length ? inArray(workOrders.status, input.statuses) : undefined,
        // الهوية من ctx حصراً — لا userId من العميل (وإلا قرأ فنّيٌّ أوامر غيره).
        input?.assignedToMe ? eq(workOrders.assignedTo, Number(ctx.user!.id)) : undefined,
        sharedQueue ? isNull(workOrders.assignedTo) : undefined,
        input?.cursor != null ? lt(workOrders.id, input.cursor) : undefined,
      ].filter(Boolean) as SQL[];
      const allConds = [branchCond, ownerCond, ...extra, ...buildWoFilterConds(input)].filter(Boolean) as SQL[];
      const whereCond = allConds.length ? and(...allConds) : undefined;
      // لوحة الكانبان: نُرجع كل ما تحتاجه البطاقة (أولوية/قناة/مسؤول/هاتف العميل/عربون).
      const rows = await db
        .select({
          id: workOrders.id,
          customerId: workOrders.customerId,
          orderNumber: workOrders.orderNumber,
          title: workOrders.title,
          customizationText: workOrders.customizationText,
          quantity: workOrders.quantity,
          status: workOrders.status,
          priority: workOrders.priority,
          receptionChannel: workOrders.receptionChannel,
          salePrice: workOrders.salePrice,
          deposit: workOrders.deposit,
          dueDate: workOrders.dueDate,
          createdAt: workOrders.createdAt,
          createdBy: workOrders.createdBy,
          createdByName: workOrderCreatorDisplayName,
          assignedTo: workOrders.assignedTo,
          assigneeName: users.name,
          customerName: customers.name,
          customerPhone: sql<string | null>`COALESCE(NULLIF(${workOrders.deliveryPhone}, ''), NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
          // لملصق الشحن من بطاقة اللوحة (طباعة عنوان التوصيل بلا فتح التفاصيل).
          hasDelivery: workOrders.hasDelivery,
          deliveryAddress: workOrders.deliveryAddress,
          deliveryPhone: workOrders.deliveryPhone,
          deliveryCost: workOrders.deliveryCost,
          // اِستقبال (٤/٨): حالة الإرسالية إن وُجدت — لطابور الاستقبال («جاهز» ⇐ تحت التسليم/الإرسال
          // ⇐ مُرسَل لجهة X). NULL طبيعي لأغلب الصفوف (لم تُرسَل بعد). تُحجب أدناه بحسب canSeeDeliveryForUser.
          consignmentId: deliveryConsignments.id,
          consignmentStatus: deliveryConsignments.status,
          // ١٨/٨: حالةُ **الطرد** — بها وحدها يُعرَف «مُسنَد لم يخرج» من «بالطريق» من «تعذّر»
          // (`deriveWoDeliveryState`). كانت الشاشة ترى حالة الإغلاق فقط فتقول «مُرسَل» لكلّها.
          parcelStatus: deliveryConsignments.parcelStatus,
          consignmentNumber: deliveryConsignments.consignmentNumber,
          courierDeliveredAt: deliveryConsignments.courierDeliveredAt,
          deliveryPartyId: deliveryConsignments.partyId,
          deliveryPartyName: deliveryParties.name,
        })
        .from(workOrders)
        .leftJoin(customers, eq(workOrders.customerId, customers.id))
        .leftJoin(workOrderCreatorUser, eq(workOrders.createdBy, workOrderCreatorUser.id))
        .leftJoin(users, eq(workOrders.assignedTo, users.id))
        .leftJoin(deliveryConsignments, eq(deliveryConsignments.workOrderId, workOrders.id))
        .leftJoin(deliveryParties, eq(deliveryConsignments.partyId, deliveryParties.id))
        .where(whereCond)
        .orderBy(desc(workOrders.id))
        .limit(input?.limit ?? 100);

      // صورة مصغّرة لكل أمر = أوّل صورة (حسب sortOrder) — استعلام واحد لكل الصفحة.
      const ids = rows.map((r) => Number(r.id));
      const thumbs = new Map<number, string>();
      if (ids.length) {
        const imgs = await db
          .select({ workOrderId: workOrderImages.workOrderId, url: workOrderImages.url })
          .from(workOrderImages)
          .where(inArray(workOrderImages.workOrderId, ids))
          .orderBy(
            asc(workOrderImages.workOrderId),
            // ش٢ (0218): **النسخةُ العليا أوّلاً** — وليس تخفيفاً للحجم بل **صحّةَ عرض**:
            // بلا هذا الترتيب تعرض بطاقةُ الأمر تصميماً **مهجوراً** أبطلته نسخةٌ أحدث،
            // فيبني الفنّيّ على صورةٍ لم يوافق عليها العميل.
            desc(workOrderImages.revision),
            asc(workOrderImages.sortOrder),
            asc(workOrderImages.id),
          );
        for (const im of imgs) {
          const k = Number(im.workOrderId);
          if (!thumbs.has(k)) thumbs.set(k, im.url);
        }
      }
      // §٧ defense-in-depth: معلومة الإرسالية/الجهة تُحجب عمّن لا يرى «store» READ (نفس بوّابة DeliveryHub).
      const seeDelivery = canSeeDeliveryForUser(ctx.user);
      return rows.map((r) => ({
        ...r,
        thumbnailUrl: thumbs.get(Number(r.id)) ?? null,
        consignmentId: seeDelivery ? r.consignmentId : null,
        consignmentStatus: seeDelivery ? r.consignmentStatus : null,
        parcelStatus: seeDelivery ? r.parcelStatus : null,
        consignmentNumber: seeDelivery ? r.consignmentNumber : null,
        courierDeliveredAt: seeDelivery ? r.courierDeliveredAt : null,
        deliveryPartyId: seeDelivery ? r.deliveryPartyId : null,
        deliveryPartyName: seeDelivery ? r.deliveryPartyName : null,
      }));
    }),

  /**
   * عدّ خفيف لكل حالة (+ المتأخّرة عن الاستحقاق) ضمن نفس نطاق/فلاتر القائمة — لبطاقات الإحصاءات.
   * لماذا: القائمة صارت تجلب النشطة كاملةً وDELIVERED محدودةً، فبطاقة «مُسلَّم» من صفوف الشاشة
   * كانت ستعدّ النافذة المعروضة فقط. العدّ خادمياً = أرقام صحيحة مهما اقتُطع العرض.
   */
  counts: workordersReadProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          /** مرآةُ `list.branchQueue` — وإلّا كذبت العدّادات على الشاشة التي تعرض الصفوف. */
          branchQueue: z.boolean().optional(),
          ...woListFilters,
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { received: 0, inProgress: 0, ready: 0, delivered: 0, cancelled: 0, late: 0 };
      // نفس عزل list حرفياً: الفرع مُجبَر لغير المرتفعين، وعزل الموظف (منشئ/مُسنَد) لغير المدير.
      const effectiveBranchId = ctx.scopedBranchId ?? input?.branchId;
      const branchCond = effectiveBranchId != null ? eq(workOrders.branchId, effectiveBranchId) : undefined;
      const ownerCond =
        ctx.scopedOwnerId != null && !(input?.branchQueue === true && workOrdersFullAccess(ctx.user))
          ? or(eq(workOrders.createdBy, ctx.scopedOwnerId), eq(workOrders.assignedTo, ctx.scopedOwnerId))
          : undefined;
      const allConds = [branchCond, ownerCond, ...buildWoFilterConds(input)].filter(Boolean) as SQL[];
      const whereCond = allConds.length ? and(...allConds) : undefined;
      // «اليوم» بحدود UTC (إطار businessDay) — dueDate عمود DATE فتصلح مقارنته نصّياً بحتمية.
      const todayUtc = new Date().toISOString().slice(0, 10);
      const rows = await db
        .select({
          status: workOrders.status,
          c: sql<number>`count(*)`,
          lateC: sql<number>`sum(case when ${workOrders.dueDate} is not null and ${workOrders.dueDate} < ${todayUtc} then 1 else 0 end)`,
        })
        .from(workOrders)
        .leftJoin(customers, eq(workOrders.customerId, customers.id))
        .where(whereCond)
        .groupBy(workOrders.status);
      const by = new Map(rows.map((r) => [String(r.status), r]));
      const num = (s: string) => Number(by.get(s)?.c ?? 0);
      // «متأخّرة» = استحقاق فائت وحالة نشطة (المُسلَّم/الملغى ليسا متأخّرين بحكم التعريف).
      const late = (WO_ACTIVE_STATUSES as readonly string[]).reduce((acc, s) => acc + Number(by.get(s)?.lateC ?? 0), 0);
      return {
        received: num("RECEIVED"),
        inProgress: num("IN_PROGRESS"),
        ready: num("READY"),
        delivered: num("DELIVERED"),
        cancelled: num("CANCELLED"),
        late,
      };
    }),

  get: workordersReadProcedure.input(z.object({ workOrderId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return null;
    const wo = (
      await db
        .select({
          id: workOrders.id,
          orderNumber: workOrders.orderNumber,
          title: workOrders.title,
          customizationText: workOrders.customizationText,
          quantity: workOrders.quantity,
          status: workOrders.status,
          priority: workOrders.priority,
          receptionChannel: workOrders.receptionChannel,
          channelHandle: workOrders.channelHandle,
          branchId: workOrders.branchId,
          customerId: workOrders.customerId,
          customerName: customers.name,
          customerPhone: sql<string | null>`COALESCE(NULLIF(${workOrders.deliveryPhone}, ''), NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
          // زبون عابر بلا سجلّ عميل — مرجعٌ نصّيّ فقط (يلزم شاشة التعديل لعرضه/تصحيحه).
          contactName: workOrders.contactName,
          contactPhone: workOrders.contactPhone,
          baseVariantId: workOrders.baseVariantId,
          materialsCost: workOrders.materialsCost,
          laborCost: workOrders.laborCost,
          salePrice: workOrders.salePrice,
          deposit: workOrders.deposit,
          paymentMethod: workOrders.paymentMethod,
          paymentReference: workOrders.paymentReference,
          paymentReceiptUrl: workOrders.paymentReceiptUrl,
          dueDate: workOrders.dueDate,
          invoiceId: workOrders.invoiceId,
          hasDelivery: workOrders.hasDelivery,
          deliveryAddress: workOrders.deliveryAddress,
          deliveryPhone: workOrders.deliveryPhone,
          deliveryCost: workOrders.deliveryCost,
          assignedTo: workOrders.assignedTo,
          assigneeName: users.name,
          createdBy: workOrders.createdBy,
          createdByName: workOrderCreatorDisplayName,
          // شَريحة #4: مؤقّت تَنفيذ حَقيقي بَدل اشتقاق من auditLogs.
          workStartedAt: workOrders.workStartedAt,
          workSeconds: workOrders.workSeconds,
          deliveredAt: workOrders.deliveredAt,
          createdAt: workOrders.createdAt,
          updatedAt: workOrders.updatedAt,
          // وسم «عُدِّلت بنوده» (0199) — التمييز البصريّ الذي طلبه المالك. مستقلٌّ عن
          // `updatedAt` عمداً: ذاك يتحرّك مع كل كتابة فيفقد الوسم معناه.
          materialsEditedAt: workOrders.materialsEditedAt,
          materialsEditCount: workOrders.materialsEditCount,
          materialsEditedByName: materialsEditorUser.name,
          // اِستقبال (٤/٨): حالة الإرسالية إن وُجدت — تُحجب أدناه بحسب canSeeDeliveryForUser.
          consignmentId: deliveryConsignments.id,
          consignmentStatus: deliveryConsignments.status,
          // ١٨/٨: حالةُ **الطرد** — بها وحدها يُعرَف «مُسنَد لم يخرج» من «بالطريق» من «تعذّر»
          // (`deriveWoDeliveryState`). كانت الشاشة ترى حالة الإغلاق فقط فتقول «مُرسَل» لكلّها.
          parcelStatus: deliveryConsignments.parcelStatus,
          consignmentNumber: deliveryConsignments.consignmentNumber,
          courierDeliveredAt: deliveryConsignments.courierDeliveredAt,
          deliveryPartyId: deliveryConsignments.partyId,
          deliveryPartyName: deliveryParties.name,
        })
        .from(workOrders)
        .leftJoin(customers, eq(workOrders.customerId, customers.id))
        .leftJoin(workOrderCreatorUser, eq(workOrders.createdBy, workOrderCreatorUser.id))
        .leftJoin(users, eq(workOrders.assignedTo, users.id))
        .leftJoin(deliveryConsignments, eq(deliveryConsignments.workOrderId, workOrders.id))
        .leftJoin(deliveryParties, eq(deliveryConsignments.partyId, deliveryParties.id))
        .leftJoin(materialsEditorUser, eq(workOrders.materialsEditedBy, materialsEditorUser.id))
        .where(eq(workOrders.id, input.workOrderId))
        .limit(1)
    )[0];
    if (!wo) return null;
    // §٧ IDOR: لا تكشف وجود أمر فرع آخر لغير المدير.
    if (ctx.scopedBranchId != null && Number(wo.branchId) !== ctx.scopedBranchId) return null;
    // §٧ defense-in-depth: نفس حجب list — تُصفَّر معلومة الإرسالية/الجهة عمّن لا يرى «store» READ.
    const seeDelivery = canSeeDeliveryForUser(ctx.user);
    const deliveryInfo = seeDelivery
      ? {
          consignmentId: wo.consignmentId,
          consignmentStatus: wo.consignmentStatus,
          consignmentNumber: wo.consignmentNumber,
          courierDeliveredAt: wo.courierDeliveredAt,
          deliveryPartyId: wo.deliveryPartyId,
          deliveryPartyName: wo.deliveryPartyName,
        }
      : { consignmentId: null, consignmentStatus: null, consignmentNumber: null, courierDeliveredAt: null, deliveryPartyId: null, deliveryPartyName: null };
    const materials = await db
      .select({
        id: workOrderMaterials.id,
        variantId: workOrderMaterials.variantId,
        baseQuantity: workOrderMaterials.baseQuantity,
        unitCost: workOrderMaterials.unitCost,
        productName: products.name,
        sku: productVariants.sku,
        variantName: productVariants.variantName,
      })
      .from(workOrderMaterials)
      .leftJoin(productVariants, eq(workOrderMaterials.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.productId, products.id))
      .where(eq(workOrderMaterials.workOrderId, input.workOrderId));
    // صور نموذج العمل (مرفقات) — للوحة التفاصيل.
    const images = await db
      .select({
        id: workOrderImages.id,
        url: workOrderImages.url,
        caption: workOrderImages.caption,
        // ش٢ (0218): النسخة — تُغذّي شارة «نسخة ٣ من ٣» ومبدّل النسخ السابقة.
        revision: workOrderImages.revision,
      })
      .from(workOrderImages)
      .where(eq(workOrderImages.workOrderId, input.workOrderId))
      .orderBy(desc(workOrderImages.revision), asc(workOrderImages.sortOrder), asc(workOrderImages.id));
    /**
     * ش٢ — **الأمر يقول حالة حجزه بنفسه**: مهمّةٌ مفتوحةٌ نوعُها حاجز. استعلامٌ واحد بدل
     * إجراءٍ جديد أو فلترةٍ في الواجهة، والحالةُ مشتقّةٌ من الواقع فلا تكذب البطاقة حين
     * تُفتَح نسخةٌ جديدة (تعود «بانتظار الموافقة» تلقائياً).
     */
    const blockingRows = await db
      .select({
        id: tasks.id,
        taskNumber: tasks.taskNumber,
        title: tasks.title,
        status: tasks.taskStatus,
        dueAt: tasks.dueAt,
      })
      .from(tasks)
      .innerJoin(serviceTypes, eq(serviceTypes.id, tasks.serviceTypeId))
      .where(
        and(
          eq(tasks.linkedWorkOrderId, input.workOrderId),
          inArray(tasks.taskStatus, ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER"]),
          eq(serviceTypes.blocksExecution, true),
        ),
      )
      .limit(1);
    const blockingTask = blockingRows[0] ?? null;
    const qrPayload = workOrderBarcodeSet({
      orderNumber: wo.orderNumber,
      createdAt: wo.createdAt instanceof Date ? wo.createdAt : new Date(wo.createdAt),
      branchId: wo.branchId,
    }).qrPayload;
    // §٧ تكلفة: نُخفي materialsCost/laborCost/unitCost عن غير المرتفعين (defense-in-depth).
    // نُبقي شكل الـtype ثابتاً (null بدلاً من حذف الحقول) لئلا تنكسر شاشة التفاصيل.
    if (!canSeeCostForUser(ctx.user)) {
      const safeMaterials = materials.map((m) => ({ ...m, unitCost: null as unknown as string }));
      return {
        ...wo,
        ...deliveryInfo,
        materialsCost: null as unknown as string,
        laborCost: null as unknown as string,
        materials: safeMaterials,
        images,
        blockingTask,
        qrPayload,
      };
    }
    return { ...wo, ...deliveryInfo, materials, images, blockingTask, qrPayload };
  }),

  /**
   * الموظفون المتاحون للإسناد (أسماء+أدوار فقط) — لاختيار المنفّذ عند إنشاء الأمر وللوحة التفاصيل.
   * cashierProcedure: الكاشير ينشئ أوامر الشغل ويحتاج اختيار المنفّذ؛ القائمة أسماء فقط (لا بيانات حسّاسة).
   * إعادة الإسناد نفسها (mutation `assign`) تبقى managerProcedure — قرار إشرافي.
   */
  assignableStaff: workordersCashierProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return [];
    const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يختاران فرعاً
    let targetBranch: number | null = null;
    if (elevated && input?.branchId != null) targetBranch = Number(input.branchId);
    else if (ctx.user.branchId != null) targetBranch = Number(ctx.user.branchId);
    else if (!elevated) throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مسند لهذا المستخدم" });
    const branchCondition = targetBranch == null
      ? undefined
      : or(eq(users.branchId, targetBranch), isNull(users.branchId));
    return db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(and(
        eq(users.isActive, true),
        eq(users.role, "print_operator"),
        branchCondition,
      ))
      .orderBy(asc(users.name));
  }),

  /** إسناد/إعادة إسناد المنفّذ المسؤول عن طلب الخدمة (null = إلغاء الإسناد). مدير فأعلى + تدقيق. */
  assign: workordersManagerProcedure
    .input(z.object({ workOrderId: z.number().int().positive(), assignedTo: z.number().int().positive().nullable() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
      const wo = (
        await db.select({ id: workOrders.id, branchId: workOrders.branchId, status: workOrders.status }).from(workOrders).where(eq(workOrders.id, input.workOrderId)).limit(1)
      )[0];
      if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
      // عزل مدير الفرع (قرار المالك ١٢/٨): لا يُسنِد مديرٌ طلبَ فرعٍ آخر (المالك/الأدمن يعبُران الفروع).
      if (ctx.user.role !== "admin" && Number(wo.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "طلب الخدمة لا يخصّ فرعك" });
      }
      if (wo.status === "DELIVERED" || wo.status === "CANCELLED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تغيير فني أمر منتهٍ" });
      }
      if (input.assignedTo != null) {
        const u = (
          await db.select({ id: users.id, isActive: users.isActive, branchId: users.branchId, role: users.role }).from(users).where(eq(users.id, input.assignedTo)).limit(1)
        )[0];
        if (!u || !u.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "الموظف غير موجود أو معطّل" });
        if (u.role !== "print_operator") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "إسناد أمر الشغل مخصص لفني تنفيذ بدور «فني طباعة»" });
        }
        // منع إسناد الطلب لموظفٍ من فرعٍ آخر لا يستطيع تنفيذه (تدقيق ٢٥/٧). الموظف بلا فرع (مشترك) مسموح.
        if (u.branchId != null && Number(u.branchId) !== Number(wo.branchId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إسناد الطلب لموظفٍ من فرعٍ آخر" });
        }
      }
      await db.update(workOrders).set({ assignedTo: input.assignedTo }).where(eq(workOrders.id, input.workOrderId));
      await logAudit(ctx, {
        action: "workOrder.assign",
        entityType: "workOrder",
        entityId: input.workOrderId,
        newValue: { assignedTo: input.assignedTo },
      });
      return { ok: true };
    }),

  /**
   * الخط الزمني للأمر — أحداث حقيقية من سجلّ التدقيق (استلام/بدء/جاهز/تسليم/إلغاء/إسناد).
   * شفافية: من فعل ماذا ومتى. branch-scoped (IDOR) كـget.
   */
  timeline: workordersReadProcedure.input(z.object({ workOrderId: z.number().int().positive() })).query(async ({ input, ctx }) => {
    const db = getDb();
    if (!db) return [];
    const wo = (
      await db.select({ branchId: workOrders.branchId }).from(workOrders).where(eq(workOrders.id, input.workOrderId)).limit(1)
    )[0];
    if (!wo) return [];
    if (ctx.scopedBranchId != null && Number(wo.branchId) !== ctx.scopedBranchId) return [];
    const rows = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        createdAt: auditLogs.createdAt,
        userName: users.name,
        newValue: auditLogs.newValue,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(and(eq(auditLogs.entityType, "workOrder"), eq(auditLogs.entityId, String(input.workOrderId))))
      .orderBy(asc(auditLogs.id));
    return rows;
  }),

  /** نقطة الالتزام الوحيدة لشاشة الاستقبال: كل مستندات السلة المختلطة في معاملة واحدة. */
  receptionCheckout: workordersCashierProcedure
    .input(receptionCheckoutSchema)
    .mutation(async ({ input, ctx }) => {
      for (const order of input.workOrders) {
        for (const img of order.designImages ?? []) assertValidImageDataUrl(img.url);
        if (order.paymentReceiptUrl) assertValidImageDataUrl(order.paymentReceiptUrl);
      }

      // عزل مدير الفرع (قرار المالك ١٢/٨): عبور الفروع للمالك/الأدمن فقط. **فصلٌ عن السلطة**: سلطة تكلفة
      // العمالة تبقى للمدير (لا الفرع) — نمط create (P1، مراجعة Codex).
      const crossBranch = ctx.user.role === "admin";
      if (!crossBranch && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مسند لهذا المستخدم" });
      }
      if (!crossBranch && Number(ctx.user.branchId) !== input.branchId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع تنفيذ استقبال لفرع آخر" });
      }
      // سلطة مديرية (لا فرع): تحديد تكلفة العمالة + اعتماد التسعير تحت التكلفة ذاتياً — تبقى للمدير/الأدمن.
      const managerial = ctx.user.role === "admin" || ctx.user.role === "manager";
      if (!managerial && input.workOrders.some((order) => money(order.laborCost ?? "0").gt(0))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "تكلفة العمالة يحددها المدير فقط" });
      }

      const effectiveBranchId = crossBranch ? input.branchId : Number(ctx.user.branchId);
      if (input.customerId != null && input.workOrders.length > 0) {
        await assertWorkOrderCustomerReady(input.customerId);
      }
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role };
      const { branchId: _branchId, managerApproval, ...checkoutInput } = input;
      // ش١ (م٦): كاشير بخصمٍ >١٠٪ يلتقط اعتماد المدير استباقياً في الواجهة ويُتحقَّق منه هنا —
      // نفس verifyManagerApproval (قفل تخمين + تدقيق) التي يستعملها sales.create حرفياً.
      let approvedBy: number | null = null;
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);

      let result: Awaited<ReturnType<typeof checkoutReception>> | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          // ش٥: retryOnDeadlock لتصادم قفل فجوة نطاق TELECOM (سلّتا زين متزامنتان) — حلقة
          // isDupEntry الخارجية تبقى لسباق أرقام المستندات كما هي.
          result = await retryOnDeadlock(() => checkoutReception({
            ...checkoutInput,
            branchId: effectiveBranchId,
            priceOverrideApproved: managerial || approvedBy != null,
            // ش٦ (§٩.٣): هويّة المُقِرّ — المدير المصادِق، أو الفاعل المرتفع نفسه.
            priceApprovedBy: approvedBy ?? (managerial ? ctx.user.id : null),
          }, actor));
          break;
        } catch (error: any) {
          if (isDupEntry(error) && attempt < 2) continue;
          if (error instanceof TRPCError) throw error;
          logger.error(
            {
              error,
              clientRequestId: input.clientRequestId,
              branchId: effectiveBranchId,
              actorUserId: ctx.user.id,
              attempt: attempt + 1,
            },
            "reception checkout transaction failed and rolled back",
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `تعذّر إتمام عملية الاستقبال؛ لم يُحفظ أي جزء منها. مرجع المحاولة: ${input.clientRequestId}`,
            cause: error,
          });
        }
      }
      if (!result) throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد أرقام مستندات فريدة" });

      if (input.customerId != null && input.workOrders.length > 0) {
        const source = input.workOrders.find((order) => order.receptionChannel === "WHATSAPP") ?? input.workOrders[0];
        try {
          await ensureWorkOrderWhatsAppConversation({
            branchId: effectiveBranchId,
            customerId: input.customerId,
            receptionChannel: source.receptionChannel,
            channelHandle: source.channelHandle,
          });
        } catch (error) {
          logger.error({ error, customerId: input.customerId }, "work order WhatsApp conversation link failed after reception commit");
        }
      }

      // التدقيق أثرٌ لاحق، وليس جزءاً من نتيجة الالتزام المالي. فشله لا يجوز أن يوهم الكاشير
      // بأن المعاملة تراجعت فيعيد قبضها؛ نسجّل العطل تشغيلياً ونُرجع النجاح الملتزم.
      try {
        await logAudit(ctx, {
          action: "workOrder.receptionCheckout",
          entityType: "receptionCheckout",
          entityId: input.clientRequestId,
          newValue: {
            regularInvoiceId: result.regularSale?.invoiceId ?? null,
            printInvoiceId: result.printSale?.invoiceId ?? null,
            workOrderIds: result.workOrders.map((order) => order.workOrderId),
            paymentMethod: input.paymentMethod,
            // م٦ (§٨.٤): الرقابة اللاحقة مستحيلة بلا سجلّ — كل خصم سطرٍ >=١٠٪ يُدوَّن حتى وهو
            // مسموح، ومعه هوية المدير المُعتمِد إن وُجد.
            ...(approvedBy != null ? { discountApprovedBy: approvedBy } : {}),
            highDiscountLines: (input.regularSale?.lines ?? [])
              .filter((line) => Number(line.discountPercent ?? 0) >= 10)
              .map((line) => ({ variantId: line.variantId, pct: Number(line.discountPercent) })),
          },
        });
      } catch (error) {
        logger.error({ error, clientRequestId: input.clientRequestId }, "reception checkout audit failed after commit");
      }
      return result;
    }),

  create: workordersCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        customerId: z.number().int().positive().nullish(),
        // v3-add-screens(100%): اختياري لخدمة تخصيص خالصة بلا منتج خام.
        baseVariantId: z.number().int().positive().nullish(),
        title: z.string().min(1),
        customizationText: z.string().nullish(),
        quantity: z.number().int().positive().default(1),
        materials: z
          .array(z.object({ variantId: z.number().int().positive(), baseQuantity: z.number().int().positive() }))
          .default([]),
        // تدقيق ١٧/٧: تحقّق مالي خادميّ — كانت سلاسل حرّة تقبل السالب (عربون/عمالة سالبان يشوّهان الذمم/الربح).
        laborCost: nonNegMoneyString.default("0"),
        salePrice: positiveMoneyString,
        dueDate: z.string().nullish(), // YYYY-MM-DD
        notes: z.string().nullish(),
        // المنفّذ المسؤول عند الإنشاء (workOrders.assignedTo).
        assignedTo: z.number().int().positive().nullish(),
        // v3-add-screens(100%): قنوات استلام.
        receptionChannel: z.enum(["WALK_IN", "WHATSAPP", "INSTAGRAM", "TIKTOK", "PHONE", "OTHER"]).nullish(),
        channelHandle: z.string().max(120).nullish(),
        // v3-add-screens(100%): أولوية + دفع + توصيل.
        priority: z.enum(["LOW", "NORMAL", "URGENT"]).nullish(),
        deposit: nonNegMoneyString.nullish(),
        paymentMethod: receptionPaymentMethod.nullish(),
        paymentReference: z.string().max(100).nullish(),
        paymentReceiptUrl: z.string().nullish(),
        hasDelivery: z.boolean().nullish(),
        deliveryAddress: z.string().nullish(),
        deliveryCost: nonNegMoneyString.nullish(),
        deliveryPhone: z.string().max(20).nullish(),
        // ملاحظة سلامة (٢١/٦/٢٦): أُزيل `items` (أصناف البيع المصغّرة) — كانت تُخزَّن بلا خصم
        // مخزون ولا COGS. الأصناف الجاهزة تُباع الآن بفاتورة مستقلّة عبر saleRouter (القرار أ).
        // v3-add-screens(100%): صور نموذج العمل.
        designImages: z.array(z.object({
          url: z.string().min(1),
          caption: z.string().max(255).nullish(),
          sortOrder: z.number().int().min(0).nullish(),
        })).max(10).default([]),
        // idempotency: نقرة مزدوجة عند الإنشاء (عربون نقدي) ⇒ أمر شغل واحد.
        clientRequestId: z.string().min(1).max(80).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      for (const img of input.designImages ?? []) assertValidImageDataUrl(img.url);
      if (input.paymentReceiptUrl) assertValidImageDataUrl(input.paymentReceiptUrl);

      // عزل الفرع (تدقيق ٢٣/٦/٢٦): قبل الإصلاح كان input.branchId يُمرَّر خاماً للخدمة ⇒ كاشير
      // يُنشئ أمر شغل + يَقبض عربون نقدي في فرع آخر (نقدُه يَدخل وردية لا يَملكها، وفاتورة
      // التسليم باسم فرعٍ خاطئ). نَمنع غير-elevated من خَلق أمرٍ خارج فرعهم بـFORBIDDEN صريح
      // (نمط inventoryRouter.transferBatch وsaleRouter G1).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      if (!elevated && money(input.laborCost ?? "0").gt(0)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "تكلفة العمالة قيمة إدارية موثّقة وليست مدخلاً للكاشير — يحددها المدير من مسار التكلفة",
        });
      }
      // عزل مدير الفرع (قرار المالك ١٢/٨): إنشاء الأمر/قبض العربون بفرع المستخدم؛ المالك/الأدمن وحدهما
      // يعبُران الفروع. (elevated أعلاه يبقى لسلطة تكلفة العمالة — المدير يحدّدها — لا للفرع.)
      const crossBranch = ctx.user.role === "admin";
      let effectiveBranchId = input.branchId;
      if (!crossBranch) {
        if (ctx.user.branchId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        if (Number(ctx.user.branchId) !== input.branchId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع إنشاء أمر شغل لفرع آخر" });
        }
        effectiveBranchId = Number(ctx.user.branchId);
      }
      if (input.customerId == null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "أمر الشغل يتطلب عميلاً محفوظاً مع اسم ورقم هاتف",
        });
      }
      await assertWorkOrderCustomerReady(input.customerId);
      const enforcedInput = { ...input, branchId: effectiveBranchId };

      // أعد المحاولة على سباق idempotency (طلبان متزامنان بنفس المفتاح ⇒ الثاني يُعيد الأول).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createWorkOrder(enforcedInput, {
            userId: ctx.user.id,
            branchId: effectiveBranchId,
            role: ctx.user.role,
          });
          try {
            await ensureWorkOrderWhatsAppConversation({
              branchId: effectiveBranchId,
              customerId: input.customerId,
              receptionChannel: input.receptionChannel,
              channelHandle: input.channelHandle,
            });
          } catch (error) {
            logger.error({ error, customerId: input.customerId }, "work order WhatsApp conversation link failed after create commit");
          }
          if (!(res as { idempotent?: boolean }).idempotent) {
            await logAudit(ctx, {
              action: "workOrder.create",
              entityType: "workOrder",
              entityId: (res as { workOrderId?: number })?.workOrderId,
              newValue: {
                title: input.title, qty: input.quantity,
                channel: input.receptionChannel ?? null,
                priority: input.priority ?? null,
                paymentMethod: input.paymentMethod ?? null,
                hasDelivery: !!input.hasDelivery,
                imagesCount: input.designImages?.length ?? 0,
              },
            });
          }
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إنشاء طلب الخدمة" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إنشاء طلب الخدمة" });
    }),

  /**
   * اِستقبال (تكامل التوصيل، ٤/٨): تصنيف/إعادة تصنيف طريقة التسليم لأمرٍ قائم (استلام مباشر ⇄
   * توصيل) — السيناريو (ج): زبون قال «آتي أستلم» ثم غيّر رأيه (أو العكس)، في أيّ وقتٍ قبل
   * التسليم/الإرسال الفعلي (الخدمة ترفض بعد DELIVERED/CANCELLED). لا تُعدَّل salePrice هنا أبداً —
   * فرق التسعير عند إعادة التصنيف تنبيهٌ واجهيٌّ للموظف فقط (قرار المالك)، لا تعديل تلقائي.
   */
  /** أمانة أجرة التوصيل (COUNTER) المحتجزة غير المصروفة لأمر شغل — يقرؤها حوار إعادة التصنيف
   *  ليُظهر مبلغ الردّ ويطلب تأكيد صرفه للزبون قبل التحويل لاستلامٍ مباشر (لا حركة نقدٍ صامتة). */
  deliveryFeeHeld: workordersReadProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      return withTx(async (tx) => {
        const wo = (await tx.select({ branchId: workOrders.branchId }).from(workOrders).where(eq(workOrders.id, input.workOrderId)).limit(1))[0];
        if (!wo) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الخدمة غير موجود" });
        const elevated = ctx.user.role === "admin"; // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط
        if (!elevated && Number(wo.branchId) !== ctx.user.branchId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "طلب الخدمة لا يخصّ فرعك" });
        }
        const net = await workOrderFeeHeldNet(tx, input.workOrderId);
        return { net: net.toFixed(2), branchId: Number(wo.branchId) };
      });
    }),

  setDeliveryMethod: workordersCashierProcedure
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        hasDelivery: z.boolean(),
        deliveryAddress: z.string().nullish(),
        deliveryPhone: z.string().max(20).nullish(),
        deliveryCost: nonNegMoneyString.nullish(),
        // درج ردّ أمانة الأجرة عند التحوّل لاستلام مباشر (يُلزَم فقط حين يتعدّد الدرج المفتوح).
        refundShiftId: z.number().int().positive().nullish(),
        // تأكيد الكاشير صرفَ أمانة الأجرة نقداً للزبون — إلزاميّ خادمياً حين توجد أمانةٌ تُردّ.
        confirmFeeRefund: z.boolean().optional(),
        // اعتماد مدير لردّ الأمانة عبر ورديةٍ غير وردية القبض (بريد+كلمة مرور، نفس verifyManagerApproval).
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { managerApproval, ...rest } = input;
      // اعتماد مدير (اختياريّ) — يُجيز ردّ الأمانة عبر ورديةٍ غير وردية القبض؛ نفس قفل التخمين
      // والتدقيق اللذين يستعملهما sales.create/reception حرفياً. غيابه ⇒ الحوكمة داخل المساعد تقرّر.
      let authorizedByManager = false;
      if (managerApproval) {
        await verifyManagerApproval(managerApproval, ctx, ctx.user.branchId ?? 1);
        authorizedByManager = true;
      }
      const res = await updateWorkOrderDeliveryMethod(
        { ...rest, authorizedByManager },
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role },
      );
      await logAudit(ctx, {
        action: "workOrder.setDeliveryMethod",
        entityType: "workOrder",
        entityId: input.workOrderId,
        newValue: { hasDelivery: input.hasDelivery, refundedFee: res.refundedFee },
      });
      return res;
    }),

  /**
   * تصحيح تفاصيل طلبٍ لم يُسلَّم بعد (سعر/عنوان/تخصيص/عميل/موعد/أولوية/قناة) — مديرٌ فأعلى فقط
   * (نمط cancel/assign: أثرٌ مالي يستحقّ نفس مستوى الثقة). الكمية والمواد خارج النطاق عمداً —
   * تغييرها بعد بدء التنفيذ يستلزم عكس حركة مخزون. الخدمة ترفض تحت DELIVERED/CANCELLED وتمنع
   * خفض السعر دون العربون المقبوض سلفاً.
   */
  /**
   * تحرير **بنود** أمر الشغل (إضافة/حذف/تغيير كمّية) — الفجوة التي اشتكاها المالك (١٧/٨/٢٦):
   * «الكاشير لا يستطيع أن يضيف إليها منتجات أو يحذف منها ويحفظها ويعتمدها».
   *
   * الصلاحية `workordersCashierProcedure` بقرار المالك: التعديل روتينٌ يوميّ («الزبائن مزاجهم
   * متقلّب ويطلبون مرتجع كثيراً أو يعدّلون طلباتهم») فلا يُعقَل أن يستدعي مديراً في كل مرّة.
   * الحرّاس الحقيقية في الخدمة لا في الدور: الفرع مُلزِم، والأمر المُسلَّم/الملغى مرفوض،
   * وبعد بدء التنفيذ يقابل كلَّ فرقٍ حركةُ مخزونٍ وقيدُ WIP مُكمِّل (لا تعديل صامت).
   *
   * العقد **تصريحيّ**: تُرسَل القائمة المطلوبة كاملةً ⇒ idempotent بطبيعته (إعادة الإرسال
   * تُنتج فرقاً صفراً). لذلك لا يحتاج `clientRequestId`.
   */
  setMaterials: workordersCashierProcedure
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        materials: z
          .array(
            z.object({
              variantId: z.number().int().positive(),
              baseQuantity: z.number().int().positive(),
            }),
          )
          .max(200),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const res = await setWorkOrderMaterials(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId != null ? Number(ctx.user.branchId) : 0,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "workOrder.setMaterials",
        entityType: "workOrder",
        entityId: input.workOrderId,
        newValue: {
          added: res.added,
          removed: res.removed,
          changed: res.changed,
          stockAdjusted: res.stockAdjusted,
          materialsCost: res.materialsCost,
        },
      });
      return res;
    }),

  update: workordersManagerProcedure
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        title: z.string().trim().min(1).max(255).optional(),
        customizationText: z.string().max(5000).nullish(),
        salePrice: positiveMoneyString.optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        priority: z.enum(["LOW", "NORMAL", "URGENT"]).nullish(),
        customerId: z.number().int().positive().nullish(),
        contactName: z.string().trim().max(255).nullish(),
        contactPhone: z.string().trim().max(32).nullish(),
        receptionChannel: z.enum(["WALK_IN", "WHATSAPP", "INSTAGRAM", "TIKTOK", "PHONE", "OTHER"]).nullish(),
        channelHandle: z.string().max(120).nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { workOrderId, ...fields } = input;
      const res = await updateWorkOrder(
        { workOrderId, ...fields },
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role }
      );
      await logAudit(ctx, {
        action: "workOrder.update",
        entityType: "workOrder",
        entityId: workOrderId,
        oldValue: res.before,
        newValue: res.patch,
      });
      return { ok: true, workOrderId };
    }),

  /**
   * السحب الذاتي للفني (محطة التنفيذ): يُسنِد الأمر الوارد لنفسه ليظهر في «أوامري».
   * workOrderExecProcedure = كاشير/مدير/فني مطبعة + فرع مُسنَد. الخدمة تمنع سحب أمر زميل.
   */
  /**
   * ش٢ — طلبُ موافقة العميل على التصميم. `workordersExecProcedure`: **مَن ينفّذ هو من يطلب**
   * (رأى التصميم وعرف أنّه يحتاج إقراراً)، والتسجيلُ والإغلاق يبقيان في شاشة المهام بمفرداتها.
   */
  requestDesignApproval: workordersExecProcedure
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        note: z.string().trim().max(2000).nullish(),
        assignedTo: z.number().int().positive().nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await requestDesignApproval(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "workOrder.requestDesignApproval",
        entityType: "workOrder",
        entityId: input.workOrderId,
        newValue: { taskNumber: res.taskNumber, created: res.created },
      });
      return res;
    }),

  /**
   * ش٢ — حفظُ نسخةِ تصميم. `workordersCashierProcedure` لا `Manager`: **الكاشير الذي كتب
   * المواصفة هو من يصحّحها** (اليوم `update` مديريّ حصراً، فالتصحيح يمرّ بالمدير بلا سبب).
   * والعقد تصريحيّ: القائمة الكاملة تُرسَل ويُشتقّ الفرق.
   */
  setDesign: workordersCashierProcedure
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        images: z
          .array(
            z.object({
              url: z.string().min(1),
              caption: z.string().trim().max(255).nullish(),
              sortOrder: z.number().int().min(0).max(99).nullish(),
            }),
          )
          .max(10),
        customizationText: z.string().max(5000).nullish(),
        note: z.string().trim().max(500).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const res = await setWorkOrderDesign(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      // سجلُّ التدقيق يُكتب داخل المعاملة (`design.ts`) — لا تكرار هنا.
      return res;
    }),

  claim: workordersExecProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await claimWorkOrder(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, {
        action: "workOrder.claim",
        entityType: "workOrder",
        entityId: input.workOrderId,
        newValue: { assignedTo: ctx.user.id },
      });
      return res;
    }),

  // التنفيذ (بدء/تجهيز) متاح لفني المطبعة على أوامره المسحوبة + الكاشير/المدير. التسليم/الفوترة
  // يبقيان cashierProcedure (مالٌ ونقد) — لا يُسلّم الفني ولا يُصدر فاتورة.
  start: workordersExecProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await startWorkOrder(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "workOrder.start", entityType: "workOrder", entityId: input.workOrderId });
      return res;
    }),

  markReady: workordersExecProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await markWorkOrderReady(input.workOrderId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "workOrder.markReady", entityType: "workOrder", entityId: input.workOrderId });
      return res;
    }),

  deliver: workordersCashierProcedure
    .input(
      z.object({
        workOrderId: z.number().int().positive(),
        payment: z.object({
          amount: positiveMoneyString,
          method: receptionPaymentMethod,
          reference: z.string().trim().max(100).nullish(),
        }).optional(),
        clientRequestId: z.string().optional().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // ER_DUP_ENTRY على invoiceNumber ممكن تحت تزامن POS+WO ⇒ أعد المحاولة ٣ مرات كـsaleRouter.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await deliverWorkOrder(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
          await logAudit(ctx, { action: "workOrder.deliver", entityType: "workOrder", entityId: input.workOrderId });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر تسليم طلب الخدمة" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),

  // الإلغاء يعكس مخزوناً/قيوداً ⇒ مدير فأعلى.
  /**
   * **عكس فاتورة خدمةٍ صفريّة البنود** (١٩/٨) — المخرج الأخير الناقص.
   *
   * أمرُ تخصيصٍ خالصٍ بلا منتجٍ كتالوجيّ تُنشأ فاتورتُه بصفر بنود (قيد FK)، فتُرفَض من
   * المرتجع (يشترط أسطراً) ومن التصحيح (يشترط بنوداً) ومن الإلغاء (يرفض منشأ WORKORDER)
   * ⇒ فاتورةٌ حيّةٌ بلا فعلٍ واحد. الخدمة تحصر نفسها بنيوياً في هذه الحالة وحدها.
   */
  reverseServiceInvoice: workordersManagerProcedure
    .input(z.object({
      workOrderId: z.number().int().positive(),
      reason: z.string().trim().min(3).max(500),
      clientRequestId: z.string().trim().min(1).max(100).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const res = await reverseServiceInvoice(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "workOrder.reverseServiceInvoice",
        entityType: "workOrder",
        entityId: input.workOrderId,
        newValue: { reason: input.reason, invoiceId: (res as { invoiceId?: number }).invoiceId },
      });
      return res;
    }),

  cancel: workordersManagerProcedure
    .input(z.object({
      workOrderId: z.number().int().positive(),
      // اختياري: يُلزَم فقط حين يتعدّد الدرج المفتوح بالفرع (resolveBranchCashShiftTx يرمي طالباً
      // التحديد حينها) — يختار المستخدم أيّ درجٍ سيخرج منه استرداد العربون فعلياً.
      refundShiftId: z.number().int().positive().optional(),
      clientRequestId: z.string().trim().min(1).max(100).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const res = await cancelWorkOrder(
        input.workOrderId,
        { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role },
        {
          refundShiftId: input.refundShiftId ?? null,
          clientRequestId: input.clientRequestId ?? null,
        },
      );
      await logAudit(ctx, { action: "workOrder.cancel", entityType: "workOrder", entityId: input.workOrderId });
      return res;
    }),

  approveCancellationRefund: ownerProcedure
    .input(z.object({
      receiptId: z.number().int().positive(),
      confirmationReference: z.string().trim().min(3).max(100),
    }))
    .mutation(async ({ input, ctx }) => {
      const res = await approveWorkOrderCancellationRefund(input.receiptId, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
        isOwner: ctx.user.isOwner,
      }, input.confirmationReference, ctx);
      return res;
    }),

  pendingCancellationRefunds: ownerProcedure.query(({ ctx }) =>
    listPendingWorkOrderCancellationRefunds({
      userId: ctx.user.id,
      branchId: ctx.user.branchId ?? 1,
      role: ctx.user.role,
      isOwner: ctx.user.isOwner,
    })),

  cancellationRefundStatus: workordersReadProcedure
    .input(z.object({ workOrderId: z.number().int().positive() }))
    .query(({ input, ctx }) => getWorkOrderCancellationRefundStatus(
      input.workOrderId,
      { branchId: ctx.scopedBranchId, ownerId: ctx.scopedOwnerId },
    )),
});
