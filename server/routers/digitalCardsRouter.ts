import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "../db";
import type { DB } from "../db";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import {
  dashboardService,
  finalizeService,
  intentService,
  offeringService,
  posCardsService,
  reversalService,
  pricingService,
  providerService,
  studentService,
  walletOpsService,
  walletService,
} from "../services/digitalCards";
import { withTx } from "../services/tx";
import type { Actor } from "../services/tx";
import {
  canSeeCostForUser,
  digitalCardsAdminReadProcedure,
  digitalCardsManagerProcedure,
  digitalCardsPosProcedure,
  router,
} from "../trpc";

/* ─── البطاقات الرقمية والاشتراكات — الإعداد الإداري (ش٣) ────────────────────
 * الأسماء المتشعّبة تتبع عقد وثيقة التصميم §٩.٣: providers.* / wallets.* / offerings.*
 * (ويلحق بها لاحقاً pos.* و students.* و sales.* و pricing.* و dashboard.*).
 * القراءة إدارية (تكشف الهوامش وأرصدة المحافظ) ⇒ محجوبة عن الكاشير رغم قالبه READ:
 * قالبه يمنحه READ لأجل شبكة بطاقات نقطة البيع (pos.* — بلا تكلفة)، لا لشاشة الإعداد.
 * التدقيق يُكتب داخل المعاملة في طبقة الخدمة (ذرّي مع التغيير) لا في الراوتر. */

function requireDb(): DB {
  const db = getDb();
  if (!db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير مهيّأة" });
  }
  return db;
}

type Ctx = { user: { id: number; role: string; branchId?: number | null } };

function actorOf(ctx: Ctx): Actor {
  return { userId: ctx.user.id, branchId: Number(ctx.user.branchId ?? 0), role: ctx.user.role };
}

/** نفس تعريف `branchScopedProcedure`: admin/manager يعبُران الفروع، وغيرهما محبوسٌ بفرعه.
 *  محسوبٌ محلياً لأن `moduleProcedure` (بوّابات الكتابة) لا تحقن scopedBranchId في السياق. */
function scopedBranchOf(ctx: Ctx): number | null {
  const elevated = ctx.user.role === "admin" || ctx.user.role === "manager";
  return elevated ? null : Number(ctx.user.branchId);
}

/* ─── مخططات المدخلات ──────────────────────────────────────────────────── */

const providerTypeEnum = z.enum(["TELECOM", "GLOBAL_CARDS", "EDUCATIONAL", "OTHER"]);
const settlementModeEnum = z.enum(["PREPAID", "POSTPAID"]);
const recognitionModeEnum = z.enum(["PRINCIPAL_GROSS"]);
const referencePolicyEnum = z.enum(["REQUIRED", "OPTIONAL", "NONE"]);
const settlementCycleEnum = z.enum(["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "ON_DEMAND"]);
const offeringTypeEnum = z.enum(["TELECOM_CARD", "GLOBAL_CARD", "EDUCATIONAL_SUBSCRIPTION", "OTHER"]);
const pricingModeEnum = z.enum(["FIXED_MARGIN", "PERCENT_MARGIN", "FIXED_PLUS_PERCENT", "FIXED_SELL_PRICE"]);

const idInput = z.object({ id: z.number().int().positive() });

const offeringBranchSchema = z.object({
  branchId: z.number().int().positive(),
  walletId: z.number().int().positive().nullish(),
  isFavorite: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});

/* ─── المزوّدون ─────────────────────────────────────────────────────────── */

const providersRouter = router({
  list: digitalCardsAdminReadProcedure.query(async () => providerService.listProviders(requireDb())),

  get: digitalCardsAdminReadProcedure
    .input(idInput)
    .query(async ({ input }) => providerService.getProvider(requireDb(), input.id)),

  create: digitalCardsManagerProcedure
    .input(
      z.object({
        supplierId: z.number().int().positive(),
        providerType: providerTypeEnum,
        settlementMode: settlementModeEnum,
        recognitionMode: recognitionModeEnum.default("PRINCIPAL_GROSS"),
        referencePolicy: referencePolicyEnum.default("OPTIONAL"),
        settlementCycle: settlementCycleEnum.default("ON_DEMAND"),
        lowBalanceThreshold: nonNegMoneyString.optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => providerService.createProvider(tx, input, actorOf(ctx))),
    ),

  update: digitalCardsManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        providerType: providerTypeEnum.optional(),
        settlementMode: settlementModeEnum.optional(),
        recognitionMode: recognitionModeEnum.optional(),
        referencePolicy: referencePolicyEnum.optional(),
        settlementCycle: settlementCycleEnum.optional(),
        lowBalanceThreshold: nonNegMoneyString.optional(),
        notes: z.string().max(2000).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => providerService.updateProvider(tx, input, actorOf(ctx))),
    ),

  toggle: digitalCardsManagerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => providerService.updateProvider(tx, input, actorOf(ctx))),
    ),
});

/* ─── المحافظ (بلا إيداع/سحب — تلك ش٩) ─────────────────────────────────── */

const walletsRouter = router({
  list: digitalCardsAdminReadProcedure
    .input(
      z
        .object({
          providerId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          isActive: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      // عزل الفرع: غير المرتفعين يرون محافظ فرعهم فقط مهما أرسلوا.
      const scoped = scopedBranchOf(ctx);
      return walletService.listWallets(requireDb(), {
        ...(input ?? {}),
        ...(scoped != null ? { branchId: scoped } : {}),
      });
    }),

  get: digitalCardsAdminReadProcedure.input(idInput).query(async ({ input, ctx }) => {
    const wallet = await walletService.getWallet(requireDb(), input.id);
    const scoped = scopedBranchOf(ctx);
    if (scoped != null && Number(wallet.branchId) !== scoped) {
      throw new TRPCError({ code: "FORBIDDEN", message: "المحفظة تخصّ فرعاً آخر" });
    }
    return wallet;
  }),

  create: digitalCardsManagerProcedure
    .input(
      z.object({
        providerId: z.number().int().positive(),
        branchId: z.number().int().positive(),
        code: z.string().min(1).max(40),
        name: z.string().min(1).max(120),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (scopedBranchOf(ctx) != null && input.branchId !== scopedBranchOf(ctx)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إنشاء محفظة لفرع آخر" });
      }
      return withTx((tx) => walletService.createWallet(tx, input, actorOf(ctx)));
    }),

  update: digitalCardsManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(120).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletService.updateWallet(tx, input, actorOf(ctx))),
    ),

  /* ─── عمليات الرصيد (ش٩) ─────────────────────────────────────────────── */

  deposit: digitalCardsManagerProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        amount: positiveMoneyString,
        paymentMethod: z.enum(["CASH", "TRANSFER"]),
        clientRequestId: z.string().min(8).max(80),
        notes: z.string().max(300).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.deposit(tx, input, actorOf(ctx))),
    ),

  withdraw: digitalCardsManagerProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        amount: positiveMoneyString,
        paymentMethod: z.enum(["CASH", "TRANSFER"]),
        clientRequestId: z.string().min(8).max(80),
        notes: z.string().max(300).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.withdraw(tx, input, actorOf(ctx))),
    ),

  /** طلب تعديل — لا يمسّ الرصيد؛ يعتمده مديرٌ **آخر** (SOD). */
  requestAdjustment: digitalCardsManagerProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        amount: positiveMoneyString,
        direction: z.enum(["IN", "OUT"]),
        reason: z.string().min(3).max(300),
        clientRequestId: z.string().min(8).max(80),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.requestAdjustment(tx, input, actorOf(ctx))),
    ),

  approveAdjustment: digitalCardsManagerProcedure
    .input(z.object({ transactionId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.approveAdjustment(tx, input, actorOf(ctx))),
    ),

  rejectAdjustment: digitalCardsManagerProcedure
    .input(z.object({ transactionId: z.number().int().positive(), reason: z.string().max(300).nullish() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.rejectAdjustment(tx, input, actorOf(ctx))),
    ),

  statement: digitalCardsAdminReadProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const wallet = await walletService.getWallet(requireDb(), input.walletId);
      const scoped = scopedBranchOf(ctx);
      if (scoped != null && Number(wallet.branchId) !== scoped) {
        throw new TRPCError({ code: "FORBIDDEN", message: "المحفظة تخصّ فرعاً آخر" });
      }
      return walletOpsService.statement(requireDb(), input);
    }),

  /** المطابقة اليومية: تسجّل الفرق ولا تعدّل الرصيد. */
  reconcile: digitalCardsManagerProcedure
    .input(
      z.object({
        walletId: z.number().int().positive(),
        businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        actualBalance: nonNegMoneyString,
        notes: z.string().max(300).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.reconcile(tx, input, actorOf(ctx))),
    ),

  reconciliations: digitalCardsAdminReadProcedure
    .input(
      z
        .object({
          walletId: z.number().int().positive().optional(),
          status: z.enum(["MATCHED", "VARIANCE_OPEN", "RESOLVED"]).optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) =>
      walletOpsService.listReconciliations(requireDb(), {
        walletId: input?.walletId,
        status: input?.status,
        branchId: scopedBranchOf(ctx),
      }),
    ),

  resolveVariance: digitalCardsManagerProcedure
    .input(
      z.object({
        reconciliationId: z.number().int().positive(),
        adjustmentTransactionId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => walletOpsService.resolveVariance(tx, input, actorOf(ctx))),
    ),

  lowBalance: digitalCardsAdminReadProcedure.query(async ({ ctx }) =>
    walletOpsService.lowBalanceWallets(requireDb(), scopedBranchOf(ctx)),
  ),
});

/* ─── العروض (البطاقات/الاشتراكات) ─────────────────────────────────────── */

const offeringsRouter = router({
  list: digitalCardsAdminReadProcedure
    .input(
      z
        .object({
          providerId: z.number().int().positive().optional(),
          offeringType: offeringTypeEnum.optional(),
          isActive: z.boolean().optional(),
          branchId: z.number().int().positive().optional(),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const scoped = scopedBranchOf(ctx);
      return offeringService.listOfferings(requireDb(), {
        ...(input ?? {}),
        ...(scoped != null ? { branchId: scoped } : {}),
      });
    }),

  get: digitalCardsAdminReadProcedure
    .input(idInput)
    .query(async ({ input }) => offeringService.getOffering(requireDb(), input.id)),

  create: digitalCardsManagerProcedure
    .input(
      z.object({
        providerId: z.number().int().positive(),
        offeringType: offeringTypeEnum,
        name: z.string().min(1).max(200),
        requiresStudentData: z.boolean().optional(),
        faceValue: nonNegMoneyString.nullish(),
        faceCurrency: z.string().length(3).nullish(),
        pricingMode: pricingModeEnum,
        fixedMargin: nonNegMoneyString.optional(),
        marginPercent: nonNegMoneyString.optional(),
        minimumMargin: nonNegMoneyString.optional(),
        roundingStep: nonNegMoneyString.optional(),
        priceValidityHours: z.number().int().positive().max(8760).nullish(),
        cardColorToken: z.string().max(30).nullish(),
        categoryId: z.number().int().positive().nullish(),
        productId: z.number().int().positive().nullish(),
        branches: z.array(offeringBranchSchema).min(1),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => offeringService.createOffering(tx, input, actorOf(ctx))),
    ),

  update: digitalCardsManagerProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(200).optional(),
        offeringType: offeringTypeEnum.optional(),
        requiresStudentData: z.boolean().optional(),
        faceValue: nonNegMoneyString.nullish(),
        faceCurrency: z.string().length(3).nullish(),
        pricingMode: pricingModeEnum.optional(),
        fixedMargin: nonNegMoneyString.optional(),
        marginPercent: nonNegMoneyString.optional(),
        minimumMargin: nonNegMoneyString.optional(),
        roundingStep: nonNegMoneyString.optional(),
        priceValidityHours: z.number().int().positive().max(8760).nullish(),
        cardColorToken: z.string().max(30).nullish(),
        branches: z.array(offeringBranchSchema).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => offeringService.updateOffering(tx, input, actorOf(ctx))),
    ),

  toggle: digitalCardsManagerProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => offeringService.updateOffering(tx, input, actorOf(ctx))),
    ),

  reorder: digitalCardsManagerProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        order: z
          .array(
            z.object({
              offeringId: z.number().int().positive(),
              displayOrder: z.number().int().min(0).max(9999),
            }),
          )
          .min(1)
          .max(500),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (scopedBranchOf(ctx) != null && input.branchId !== scopedBranchOf(ctx)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إعادة ترتيب بطاقات فرع آخر" });
      }
      return withTx((tx) => offeringService.reorderOfferings(tx, input, actorOf(ctx)));
    }),
});

/* ─── أسعار اليوم (ش٤) ──────────────────────────────────────────────────── */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

const scopeInput = z.object({
  branchId: z.number().int().positive(),
  providerId: z.number().int().positive(),
  businessDate: ymd,
});

const lineInput = z.object({
  offeringId: z.number().int().positive(),
  providerShare: nonNegMoneyString,
});

/** يفرض فرع المستخدم على أي نطاق قادم من العميل (منع IDOR عبر branchId). */
function assertBranch(ctx: Ctx, branchId: number) {
  const scoped = scopedBranchOf(ctx);
  if (scoped != null && branchId !== scoped) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا صلاحية على فرع آخر" });
  }
}

const pricingRouter = router({
  getMorningSheet: digitalCardsAdminReadProcedure.input(scopeInput).query(async ({ input, ctx }) => {
    assertBranch(ctx, input.branchId);
    return pricingService.getMorningSheet(requireDb(), input);
  }),

  /** معاينة السعر خادمياً — الواجهة لا تعيد بناء معادلة التقريب (§٧.٣). */
  preview: digitalCardsAdminReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        providerId: z.number().int().positive(),
        lines: z.array(lineInput).max(500),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertBranch(ctx, input.branchId);
      return pricingService.previewPrices(requireDb(), input);
    }),

  copyPrevious: digitalCardsManagerProcedure.input(scopeInput).mutation(async ({ input, ctx }) => {
    assertBranch(ctx, input.branchId);
    return withTx((tx) => pricingService.copyPrevious(tx, input, actorOf(ctx)));
  }),

  saveDraft: digitalCardsManagerProcedure
    .input(scopeInput.extend({ lines: z.array(lineInput).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      assertBranch(ctx, input.branchId);
      const actor = actorOf(ctx);
      return withTx(async (tx) => {
        const { batchId } = await pricingService.createOrGetDraft(tx, input, actor);
        return pricingService.saveDraft(tx, { batchId, lines: input.lines }, actor);
      });
    }),

  /** الحفظ والنشر في معاملة واحدة — لا حالة وسطية بين مسودّة مكتوبة ودُفعة منشورة. */
  publish: digitalCardsManagerProcedure
    .input(scopeInput.extend({ lines: z.array(lineInput).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      assertBranch(ctx, input.branchId);
      const actor = actorOf(ctx);
      return withTx(async (tx) => {
        const { batchId } = await pricingService.createOrGetDraft(tx, input, actor);
        await pricingService.saveDraft(tx, { batchId, lines: input.lines }, actor);
        return pricingService.publish(tx, { batchId }, actor);
      });
    }),

  cancelDraft: digitalCardsManagerProcedure
    .input(z.object({ batchId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => pricingService.cancelDraft(tx, input, actorOf(ctx))),
    ),

  /** بلاغ الكاشير «السعر لدى الجهاز مختلف» — لا يغيّر سعراً بذاته (§٧.٥). */
  reportMismatch: digitalCardsPosProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        offeringId: z.number().int().positive(),
        reportedProviderShare: nonNegMoneyString,
        notes: z.string().max(500).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertBranch(ctx, input.branchId);
      return withTx((tx) => pricingService.reportMismatch(tx, input, actorOf(ctx)));
    }),

  mismatchReports: digitalCardsAdminReadProcedure
    .input(
      z.object({
        branchId: z.number().int().positive().optional(),
        status: z.enum(["OPEN", "APPROVED", "REJECTED", "RESOLVED"]).optional(),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const scoped = scopedBranchOf(ctx);
      return pricingService.listMismatchReports(requireDb(), {
        status: input?.status,
        branchId: scoped ?? input?.branchId ?? null,
      });
    }),

  approveMismatch: digitalCardsManagerProcedure
    .input(
      z.object({
        reportId: z.number().int().positive(),
        businessDate: ymd,
        notes: z.string().max(500).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => pricingService.approveMismatch(tx, input, actorOf(ctx))),
    ),

  rejectMismatch: digitalCardsManagerProcedure
    .input(z.object({ reportId: z.number().int().positive(), notes: z.string().max(500).nullish() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => pricingService.rejectMismatch(tx, input, actorOf(ctx))),
    ),
});

/* ─── شبكة بطاقات نقطة البيع (ش٥) ───────────────────────────────────────────
 * البوّابة الوحيدة المتاحة للكاشير على هذه الوحدة. المخرَج بلا تكلفة/هامش/رصيد —
 * محجوبةٌ في طبقة الاستعلام نفسها (posCards.ts) لا في العرض. */

const posRouter = router({
  listCards: digitalCardsPosProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        category: z.enum(["FAVORITES", "TELECOM", "GLOBAL", "EDUCATIONAL", "ALL"]).optional(),
        providerId: z.number().int().positive().optional(),
        q: z.string().max(120).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // الفرع يُفرَض خادمياً: غير المرتفع يقرأ فرعه مهما أرسل (منع IDOR عبر branchId).
      const scoped = scopedBranchOf(ctx);
      return posCardsService.listCards(requireDb(), { ...input, branchId: scoped ?? input.branchId });
    }),

  /** تأكيد السعر قبل إضافة البطاقة للسلة — لا يُنشئ أثراً مالياً، فقط يُثبّت سعر الخادم. */
  confirmCard: digitalCardsPosProcedure
    .input(z.object({ branchId: z.number().int().positive(), offeringId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const scoped = scopedBranchOf(ctx);
      return posCardsService.confirmCard(requireDb(), {
        branchId: scoped ?? input.branchId,
        offeringId: input.offeringId,
      });
    }),
});

/* ─── الطلاب (ش٦) ───────────────────────────────────────────────────────────
 * بحثٌ للكاشير بالحدّ الأدنى من البيانات — بلا أرقام مالية للعميل، ولا PII في الأخطاء.
 * لا إنشاء ولا تعديل هنا: ملفّ الطالب يُثبَّت داخل معاملة تثبيت البيع (شريحة لاحقة)،
 * فلا يبقى في القاعدة طالبٌ لبيعٍ لم يكتمل. */

const studentsRouter = router({
  search: digitalCardsPosProcedure
    .input(
      z.object({
        studentPhone: z.string().max(25).optional(),
        guardianPhone: z.string().max(25).optional(),
        q: z.string().max(80).optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    )
    .query(async ({ input }) => studentService.searchStudents(requireDb(), input)),

  get: digitalCardsPosProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => studentService.getStudent(requireDb(), input.customerId)),

  /** تلميح «لهذا الوليّ N أبناء» — يذكّر الكاشير بألّا يدمج الإخوة في ملفٍّ واحد. */
  siblingCount: digitalCardsPosProcedure
    .input(z.object({ guardianPhone: z.string().min(1).max(25) }))
    .query(async ({ input }) => ({
      count: await studentService.countSiblings(requireDb(), input.guardianPhone),
    })),

  /** فحص الهاتف قبل الإضافة للسلة: جديد أم مرتبطٌ بملفّ واحد أم ملتبسٌ يحتاج اختياراً. */
  resolveByPhone: digitalCardsPosProcedure
    .input(z.object({ studentPhone: z.string().min(1).max(25) }))
    .query(async ({ input }) => studentService.resolveStudentByPhone(requireDb(), input.studentPhone)),
});

/* ─── نيّة البيع والتنفيذ الخارجيّ (ش٧) ──────────────────────────────────────
 * `prepare` يحجز رصيد المحفظة ويسجّل النيّة **قبل** لمس جهاز المزوّد — بلا فاتورة ولا خصم رصيد.
 * `markExecution` يسجّل نجاح كل كرت لحظةَ إصداره، فيبقى أثره حتى لو أُغلق المتصفّح بعدها. */

const studentSnapshotSchema = z.object({
  customerId: z.number().int().positive().nullish(),
  studentName: z.string().min(1).max(200),
  studentPhone: z.string().min(1).max(25),
  guardianPhone: z.string().min(1).max(25),
  address: z.string().min(1).max(500),
  mode: z.enum(["UPDATE_PROFILE", "INVOICE_ONLY"]),
});

const salesRouter = router({
  prepare: digitalCardsPosProcedure
    .input(
      z.object({
        clientRequestId: z.string().min(8).max(80),
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive(),
        paymentMethod: z.string().min(1).max(20),
        cartFingerprint: z.string().min(1).max(64),
        lines: z
          .array(
            z.object({
              lineKey: z.string().min(1).max(64),
              offeringId: z.number().int().positive(),
              priceVersionId: z.number().int().positive(),
              expectedSellPrice: nonNegMoneyString,
              student: studentSnapshotSchema.nullish(),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      assertBranch(ctx, input.branchId);
      return withTx((tx) => intentService.prepare(tx, input, actorOf(ctx)));
    }),

  markExecution: digitalCardsPosProcedure
    .input(
      z.object({
        intentId: z.number().int().positive(),
        intentItemId: z.number().int().positive(),
        status: z.enum(["SUCCESS", "FAILED", "UNKNOWN"]),
        providerReference: z.string().max(120).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => intentService.markExecution(tx, input, actorOf(ctx))),
    ),

  getIntent: digitalCardsPosProcedure
    .input(z.object({ intentId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const res = await intentService.getIntent(requireDb(), input.intentId);
      if (!res) throw new TRPCError({ code: "NOT_FOUND", message: "النيّة غير موجودة" });
      const scoped = scopedBranchOf(ctx);
      if (scoped != null && Number(res.intent.branchId) !== scoped) {
        throw new TRPCError({ code: "FORBIDDEN", message: "النيّة تخصّ فرعاً آخر" });
      }
      return res;
    }),

  cancelIntent: digitalCardsPosProcedure
    .input(z.object({ intentId: z.number().int().positive(), reason: z.string().max(300).nullish() }))
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => intentService.cancelIntent(tx, input, actorOf(ctx))),
    ),

  /** طابور المراجعة — إشرافيّ: كروتٌ صدرت ولم تُثبَّت بفاتورة. */
  needsReview: digitalCardsAdminReadProcedure
    .input(z.object({ branchId: z.number().int().positive().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const scoped = scopedBranchOf(ctx);
      return intentService.listNeedsReview(requireDb(), { branchId: scoped ?? input?.branchId ?? null });
    }),

  /** كنّاس النيّات المهجورة — يُشغّله المدير يدوياً حتى تُجدوَل مهمّة دورية. */
  expireStale: digitalCardsManagerProcedure.mutation(async () =>
    withTx((tx) => intentService.expireStaleIntents(tx)),
  ),

  /** التثبيت المالي (ش٨): الفاتورة والقبض والتسوية والتفاصيل في معاملة واحدة — أو لا شيء. */
  finalize: digitalCardsPosProcedure
    .input(
      z.object({
        intentId: z.number().int().positive(),
        clientRequestId: z.string().min(8).max(80),
        paymentAmount: nonNegMoneyString,
        paymentMethod: z.enum(["CASH", "CARD"]),
        customerId: z.number().int().positive().nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => finalizeService.finalize(tx, input, actorOf(ctx))),
    ),

  saleDetails: digitalCardsAdminReadProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .query(async ({ input }) => finalizeService.getSaleDetails(requireDb(), input.invoiceId)),

  /** إعادة طباعة (§١٢.١-٤): لقطات الكرت من الخادم — بلا حصة مزوّد ولا ربح، فالكاشير يراها. */
  printDetails: digitalCardsPosProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .query(async ({ input }) => finalizeService.reprintDetails(requireDb(), input.invoiceId)),
});

/* ─── الداشبورد (ش١١) ────────────────────────────────────────────────────────
 * كل النقاط: فترة **نصف مفتوحة** [from, to)، عزل فرع مفروض خادمياً، تجميع في القاعدة،
 * وحجب الحصة/الربح عمّن لا يملك رؤية التكلفة (`canSeeCostForUser`) — حجبٌ في الخدمة لا في العرض. */

const periodInput = z.object({
  from: ymd,
  /** النهاية **حصرية** — يومٌ واحد = from=D, to=D+1. */
  to: ymd,
  branchId: z.number().int().positive().optional(),
});

function scopeOf(ctx: Ctx & { user: { permissionsOverride?: unknown } }, input: z.infer<typeof periodInput>) {
  const scoped = scopedBranchOf(ctx);
  return {
    from: input.from,
    to: input.to,
    branchId: scoped ?? input.branchId ?? null,
    includeCost: canSeeCostForUser(ctx.user),
  };
}

const dashboardRouter = router({
  summary: digitalCardsAdminReadProcedure
    .input(periodInput)
    .query(async ({ input, ctx }) => dashboardService.summary(requireDb(), scopeOf(ctx, input))),

  providerBalances: digitalCardsAdminReadProcedure.query(async ({ ctx }) =>
    dashboardService.providerBalances(requireDb(), scopedBranchOf(ctx)),
  ),

  postpaidDues: digitalCardsAdminReadProcedure.query(async () => dashboardService.postpaidDues(requireDb())),

  priceHealth: digitalCardsAdminReadProcedure.query(async ({ ctx }) =>
    dashboardService.priceHealth(requireDb(), scopedBranchOf(ctx)),
  ),

  pendingExecutions: digitalCardsAdminReadProcedure.query(async ({ ctx }) =>
    dashboardService.pendingExecutions(requireDb(), scopedBranchOf(ctx)),
  ),

  topOfferings: digitalCardsAdminReadProcedure
    .input(periodInput.extend({ limit: z.number().int().positive().max(50).optional() }))
    .query(async ({ input, ctx }) =>
      dashboardService.topOfferings(requireDb(), scopeOf(ctx, input), input.limit ?? 10),
    ),

  reconciliationStatus: digitalCardsAdminReadProcedure
    .input(periodInput)
    .query(async ({ input, ctx }) => dashboardService.reconciliationStatus(requireDb(), scopeOf(ctx, input))),
});

/* ─── العكس والاستثناءات (ش١٢) ───────────────────────────────────────────────
 * المسار الوحيد لإرجاع كرتٍ رقميّ — المرتجع العام يرفضه (حارس في returnService).
 * قرارٌ مديريّ بحالتين: عكسٌ مؤكَّد (المزوّد أعاد الحصة) أو ردّ خسارة (لم يُعِدها). */

const reversalRouter = router({
  reversible: digitalCardsAdminReadProcedure
    .input(z.object({ invoiceId: z.number().int().positive() }))
    .query(async ({ input }) => reversalService.reversibleDetails(requireDb(), input.invoiceId)),

  approve: digitalCardsManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        detailIds: z.array(z.number().int().positive()).min(1).max(50),
        reason: z.string().min(3).max(300),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reversalService.approveReversal(tx, input, actorOf(ctx))),
    ),

  lossRefund: digitalCardsManagerProcedure
    .input(
      z.object({
        invoiceId: z.number().int().positive(),
        detailIds: z.array(z.number().int().positive()).min(1).max(50),
        reason: z.string().min(3).max(300),
      }),
    )
    .mutation(async ({ input, ctx }) =>
      withTx((tx) => reversalService.lossRefund(tx, input, actorOf(ctx))),
    ),
});

export const digitalCardsRouter = router({
  dashboard: dashboardRouter,
  reversal: reversalRouter,
  providers: providersRouter,
  wallets: walletsRouter,
  offerings: offeringsRouter,
  pricing: pricingRouter,
  pos: posRouter,
  students: studentsRouter,
  sales: salesRouter,
});
