import { z } from "zod";
import {
  activateCustomer,
  createCustomer,
  deactivateCustomer,
  deleteCustomer,
  findSimilarCustomers,
  getCustomer,
  listCustomers,
  resolveReceptionCustomerByPhone,
  smartSearchCustomers,
  updateCustomer,
} from "../services/customerService";
import {
  listContractPricesForCustomer,
  listContractPricesForCustomerPage,
  removeContractPrice,
  setContractPriceActive,
  upsertContractPrice,
} from "../services/contractPriceService";
import { logAudit } from "../services/auditService";
import { customerBarcodeSet } from "../services/barcodeService";
import { maskCustomerSensitive } from "../lib/redact";
import { positiveMoneyString } from "../lib/schemas";
import { customersCashierProcedure, customersManagerProcedure, customersReadProcedure, customersReceptionCreateProcedure, managerProcedure, router, userHasCrmWriteAccess } from "../trpc";
import { getCustomerOperations } from "../services/customerOperationsService";

const priceTier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const customerType = z.enum(["فرد", "تاجر", "مؤسسة", "شركة", "حكومي"]);
const operationsInput = z.object({
  q: z.string().max(200).optional(),
  customerType: customerType.optional(),
  priceTier: priceTier.optional(),
  includeInactive: z.boolean().default(false),
  balance: z.enum(["RECEIVABLE", "CREDIT", "ZERO"]).optional(),
  collection: z.enum(["OVERDUE", "PROMISE_DUE", "PROMISE_FUTURE", "NO_FOLLOWUP"]).optional(),
  credit: z.enum(["CASH_ONLY", "NEAR_LIMIT", "OVER_LIMIT", "UNLIMITED"]).optional(),
  inactivityDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional(),
  sort: z.enum(["NAME", "BALANCE_DESC", "OLDEST_DUE", "LAST_PURCHASE"]).optional(),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().min(0).default(0),
});

/**
 * العملاء — شريحة كاملة:
 * list (بحث+فلاتر+تقسيم صفحات) / get / create / update / deactivate / activate / smartSearch.
 * `list` تبقى متوافقة مع شاشات الكاشير والقوائم المنسدلة (تعرض المفعّلين فقط بحدّ 500).
 *
 * v3-add-screens:
 *  - create: نقلناها لـ cashierProcedure لأن الكاشير قد يُنشئ زبوناً جديداً أثناء أمر شغل/بيع.
 *  - phone2/phone3 مضافان في input.
 *  - smartSearch: بحث مع إحصاءات (عدد طلبات/آخر طلب) لمكوّن `SmartCustomerInput`.
 */
export const customerRouter = router({
  /**
   * مركز العملاء والتحصيل: صفوف تشغيلية + ملخص جميع النتائج المطابقة.
   * محصور بالمدير لأن الحمولة تجمع الذمم والحدود الائتمانية ومؤشرات المخاطر.
   */
  operations: managerProcedure
    .input(operationsInput.optional())
    .query(({ input }) => getCustomerOperations(input ?? {})),

  /** قائمة بسيطة سريعة — يحتاجها الكاشير وأوامر الشغل والبيع الآجل. */
  list: customersReadProcedure.query(async ({ ctx }) => {
    const { rows } = await listCustomers({ includeInactive: false, limit: 500 });
    return rows.map((r) => maskCustomerSensitive(r, ctx.user.role));
  }),

  /** قائمة كاملة مع بحث وفلاتر وتقسيم صفحات — لشاشة الإدارة. */
  search: customersReadProcedure
    .input(
      z
        .object({
          q: z.string().optional(),
          customerType: customerType.optional(),
          priceTier: priceTier.optional(),
          // فلتر مدينة (نصّ حرّ — الحقل مُدخَل يدوياً في بطاقة العميل، بلا قاموس ثابت).
          city: z.string().max(100).optional(),
          includeInactive: z.boolean().default(false),
          // الفجوة ١٦: الحد الأعلى ٢٠٠٠ مطابقاً للخدمة (افتراضي ١٠٠).
          limit: z.number().int().positive().max(2000).default(100),
          offset: z.number().int().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const city = input?.city?.trim();
      if (!city) {
        const res = await listCustomers(input ?? {});
        return { ...res, rows: res.rows.map((r) => maskCustomerSensitive(r, ctx.user.role)) };
      }
      // فلترة المدينة غير مدعومة في listCustomers (خدمة عملاء لا تخصّ هذه الشريحة) — نجلب حتى سقف
      // الخدمة الأقصى (٢٠٠٠، محدود أصلاً) ونُصفّي/نُرقّم يدوياً هنا كي لا نمسّ customerService.ts.
      // city مستبعَدة صراحةً (destructure) لا `city: undefined` — الأخيرة إبقاءٌ للمفتاح يفشل فحص
      // TypeScript الزائد (listCustomers لا تعرف city) رغم أن القيمة undefined غير مؤذية وقت التشغيل.
      const cityNeedle = city.toLowerCase();
      const { city: _cityIgnored, ...listInput } = input ?? {};
      const superset = await listCustomers({ ...listInput, limit: 2000, offset: 0 });
      const filtered = superset.rows.filter((r) => (r.city ?? "").toLowerCase().includes(cityNeedle));
      const limit = input?.limit ?? 100;
      const offset = input?.offset ?? 0;
      const page = filtered.slice(offset, offset + limit);
      return { rows: page.map((r) => maskCustomerSensitive(r, ctx.user.role)), total: filtered.length };
    }),

  /** بحث ذكي بإحصاءات — لإدخال أمر شغل سريع. */
  smartSearch: customersReadProcedure
    .input(z.object({
      q: z.string().min(1).max(120),
      limit: z.number().int().min(1).max(20).optional(),
    }))
    // IDOR-REDACT (تدقيق ٢/٧): smartSearch كان يُعيد currentBalance خاماً لكل الأدوار متجاوزاً
    // maskCustomerSensitive المطبَّق في list/get ⇒ تسريب رصيد العميل للكاشير. نطبّق نفس الحجب.
    .query(async ({ input, ctx }) => {
      const rows = await smartSearchCustomers(input);
      return rows.map((r) => maskCustomerSensitive(r, ctx.user.role));
    }),

  /** dup-detect (٦/٧): مرشّحو تكرار محتمَل لشاشة الإضافة — تحذير حيّ قبل الحفظ (لا حجب).
   *  الاسم مطبَّع عربياً + الهواتف بمطابقة لاحقة، ويشمل المعطَّلين. الرصيد يُحجب لغير المدير. */
  findSimilar: customersReadProcedure
    .input(
      z.object({
        name: z.string().max(255).optional(),
        phones: z.array(z.string().max(25)).max(4).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const rows = await findSimilarCustomers(input);
      return rows.map((r) => maskCustomerSensitive(r, ctx.user.role));
    }),

  get: customersReadProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const c = await getCustomer(input.customerId);
      if (!c) return null;
      const qrPayload = customerBarcodeSet({ id: c.id, name: c.name }).qrPayload;
      const masked = maskCustomerSensitive(c, ctx.user.role);
      return { ...masked, qrPayload };
    }),

  /**
   * هوية عميل الاستقبال: بحثٌ ضيّق برقم عراقي كامل ثم إنشاءٌ اختياري بالاسم.
   * يعمل عبر بوابة محطة الاستقبال نفسها حتى لو كان الدور المخصّص بلا CRM READ، ولا يكشف قائمة
   * العملاء أو الأرصدة أو أي حقول مالية.
   */
  receptionResolveByPhone: customersReceptionCreateProcedure
    .input(z.object({
      phone: z.string().trim().min(1).max(32),
      name: z.string().trim().min(2).max(255).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await resolveReceptionCustomerByPhone(input, {
        userId: ctx.user.id,
        branchId: ctx.user.branchId ?? 1,
        role: ctx.user.role,
      });
      if (result.created && result.customerId != null) {
        await logAudit(ctx, {
          action: "customer.receptionResolveCreate",
          entityType: "customer",
          entityId: result.customerId,
          newValue: { name: result.name, phone: result.phone, deferredEligible: true },
        });
      }
      return result;
    }),

  // (١٢/٨، اصلاح عاجل بطلب المالك): استُبدلت customersCashierProcedure بـcustomersReceptionCreateProcedure
  // كي يُقبل من يملك crm=FULL **أو** workorders=FULL (كاشير الاستقبال بدور مخصّص حُدَّت فيه crm يدوياً).
  // بقيّة عمليات CRM (notes/update/delete) تبقى محكومة ببوّاباتها الأضيق — التغيير محصور بإنشاء العميل
  // (أساس ربط الطلب بالسجل الدائم) لا بإدارة العملاء بأكملها.
  create: customersReceptionCreateProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        phone3: z.string().max(20).nullish(),
        whatsapp: z.string().max(20).nullish(),
        address: z.string().nullish(),
        city: z.string().max(100).nullish(),
        district: z.string().max(100).nullish(),
        customerType: customerType.default("فرد"),
        defaultPriceTier: priceTier.default("RETAIL"),
        creditLimit: z.string().nullish(),
        notes: z.string().nullish(),
        // رصيد افتتاحي (حقل مالي مدير فقط — يُجرّد للكاشير أدناه).
        openingBalance: z.string().nullish(),
        openingBalanceDirection: z.enum(["OWED_TO_US", "OWED_BY_US"]).optional(),
        // dup-detect (٦/٧): مفتاح idempotency من النموذج (UUID لكل فتح) — إعادة الإرسال تعيد نفس العميل.
        clientRequestId: z.string().min(8).max(64).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // سياسة المالك (٢٥/٧): مَن يملك crm=FULL (كاشير/مندوب/مدير + منح صريح) يُسجّل الرصيد
      // الافتتاحي لحظة الإضافة. كان يُجرَّد صامتاً لغير الأدمن/المدير ⇒ **خسارة مالية صامتة**
      // (العميل يُنشأ برصيد صفر بلا قيد OPENING فلا يظهر في الكشف/الأعمار). سقف الائتمان يبقى
      // حقلاً إدارياً للأدمن/المدير وحدهما — قرارُ ائتمانٍ مستقبليّ لا قيمةٌ تاريخية — فنُثبّته "0"
      // (نقدي فقط) لغير المرتفعين، بينما نُبقي الرصيد الافتتاحي كما أُدخِل.
      //
      // (١٢/٨، مراجعة Codex P1): بعد فتح البوّابة لـworkorders=FULL بلا crm=FULL، وجب تجريد
      // الحقول المالية عن هذا المسار الجديد. كاشير الاستقبال لا يملك سلطة إدخال رصيد افتتاحي
      // عبر بوّابة workorders — سيكشف باباً ماليّاً غير مقصود. نجرّد openingBalance/Direction
      // لكل مَن لا يملك crm=FULL كذلك (المدير/الأدمن كما كان).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      const hasCrmWrite = userHasCrmWriteAccess(ctx.user);
      const safeInput = elevated
        ? input
        : hasCrmWrite
          ? { ...input, creditLimit: "0" }
          : { ...input, creditLimit: "0", openingBalance: undefined, openingBalanceDirection: undefined };
      const r = await createCustomer(safeInput, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      // إعادة تشغيل idempotent = لا كتابة جديدة ⇒ لا نكرّر سجلّ التدقيق.
      if (!r.idempotentReplay) {
        await logAudit(ctx, { action: "customer.create", entityType: "customer", entityId: r.customerId, newValue: { name: input.name, creditLimitSet: elevated && input.creditLimit != null, openingBalanceSet: hasCrmWrite && !!input.openingBalance } });
      }
      // التوافق: المستهلكون القدامى يقرؤون `.id` (مثل WorkOrderNew)؛ نُبقي الكليهما.
      return { id: r.customerId, customerId: r.customerId, idempotentReplay: !!r.idempotentReplay };
    }),

  update: customersManagerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        phone: z.string().max(20).nullish(),
        phone2: z.string().max(20).nullish(),
        phone3: z.string().max(20).nullish(),
        whatsapp: z.string().max(20).nullish(),
        address: z.string().nullish(),
        city: z.string().max(100).nullish(),
        district: z.string().max(100).nullish(),
        customerType: customerType.optional(),
        defaultPriceTier: priceTier.optional(),
        creditLimit: z.string().nullish(),
        notes: z.string().nullish(),
        // تصحيح الرصيد الافتتاحي (إدخال أوّليّ خاطئ) — حقلٌ ماليّ للأدمن/المدير وحدهما (يُجرَّد أدناه).
        openingBalance: z.string().nullish(),
        openingBalanceDirection: z.enum(["OWED_TO_US", "OWED_BY_US"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // §٧ audit oldValue: نلتقط لقطة قبل التحديث لمسار تدقيق فروقات حقيقي.
      const before = await getCustomer(input.customerId);
      // تعديل رصيدٍ افتتاحيٍّ قائم (يُزيح الرصيد الجاري) للأدمن/المدير وحدهما — غير المرتفعين يعدّلون
      // بقية الحقول بلا مسّ الرصيد (openingBalance=undefined ⇒ يتخطّاه updateCustomer).
      const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
      const safeInput = elevated ? input : { ...input, openingBalance: undefined, openingBalanceDirection: undefined };
      const res = await updateCustomer(safeInput, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "customer.update",
        entityType: "customer",
        entityId: input.customerId,
        oldValue: before ? {
          name: before.name, phone: before.phone, phone2: before.phone2, phone3: before.phone3, whatsapp: before.whatsapp,
          address: before.address, city: before.city, district: before.district,
          customerType: before.customerType, defaultPriceTier: before.defaultPriceTier,
          creditLimit: before.creditLimit, notes: before.notes,
        } : null,
        newValue: {
          name: input.name, phone: input.phone, phone2: input.phone2, phone3: input.phone3, whatsapp: input.whatsapp,
          address: input.address, city: input.city, district: input.district,
          customerType: input.customerType, defaultPriceTier: input.defaultPriceTier,
          creditLimit: input.creditLimit, notes: input.notes,
        },
      });
      return res;
    }),

  deactivate: customersManagerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await deactivateCustomer(input.customerId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "customer.deactivate", entityType: "customer", entityId: input.customerId });
      return res;
    }),

  activate: customersManagerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await activateCustomer(input.customerId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, { action: "customer.activate", entityType: "customer", entityId: input.customerId });
      return res;
    }),

  /** حذف نهائيّ لعميلٍ بلا نشاط — تنظيفُ أخطاء الإدخال الأوّليّ فقط. للأدمن/المدير (لا رجعة فيه).
   *  الحارس البنيويّ في deleteCustomer يرفض أيّ عميلٍ له نشاط (يوجّه للتعطيل بدلاً منه). */
  delete: managerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const before = await getCustomer(input.customerId);
      const res = await deleteCustomer(input.customerId, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 });
      await logAudit(ctx, {
        action: "customer.delete",
        entityType: "customer",
        entityId: input.customerId,
        oldValue: before ? { name: before.name, currentBalance: before.currentBalance, openingBalance: before.openingBalance } : null,
      });
      return res;
    }),

  // ─── بند 12ب (٧/٧): التسعير التعاقدي الخاص بعميل (عقود الدوائر الحكومية) — إدارة بمدير ───

  /** كل الأسعار التعاقدية لعميل (نشطة + معطَّلة) لشاشة الإدارة. */
  contractPricesList: customersManagerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(({ input }) => listContractPricesForCustomer(input.customerId)),

  /** Cursor-paginated contract prices; the legacy array endpoint remains compatible. */
  contractPricesPage: customersManagerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        limit: z.number().int().positive().max(100).default(50),
        cursor: z.string().max(1000).nullish(),
      }),
    )
    .query(({ input }) => listContractPricesForCustomerPage(input)),

  /** إضافة/تحديث سعر تعاقدي (UNIQUE عميل×وحدة يحسم السباق — التحديث لا يُنشئ صفاً ثانياً). */
  contractPriceUpsert: customersManagerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        productUnitId: z.number().int().positive(),
        price: positiveMoneyString,
        note: z.string().max(255).nullish(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const res = await upsertContractPrice(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, {
        action: res.updated ? "customer.contractPrice.update" : "customer.contractPrice.create",
        entityType: "customerContractPrice",
        entityId: res.id,
        newValue: { customerId: input.customerId, productUnitId: input.productUnitId, price: input.price, note: input.note ?? null },
      });
      return res;
    }),

  /** تعطيل/تفعيل سعر تعاقدي — المعطَّل لا يسري على البيع ويبقى ظاهراً لإعادة التفعيل. */
  contractPriceSetActive: customersManagerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const res = await setContractPriceActive(input.id, input.isActive);
      await logAudit(ctx, {
        action: input.isActive ? "customer.contractPrice.activate" : "customer.contractPrice.deactivate",
        entityType: "customerContractPrice",
        entityId: input.id,
        newValue: { isActive: input.isActive },
      });
      return res;
    }),

  /** حذف سعر تعاقدي (بنود الفواتير تُخزّن unitPrice لقطةً — لا مرجعية تاريخية تُكسر). */
  contractPriceRemove: customersManagerProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const res = await removeContractPrice(input.id);
      await logAudit(ctx, { action: "customer.contractPrice.remove", entityType: "customerContractPrice", entityId: input.id });
      return res;
    }),
});
