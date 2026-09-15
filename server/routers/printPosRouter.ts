import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { z } from "zod";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { customers, invoiceItems, invoices } from "../../drizzle/schema";
import { logger } from "../logger";
import { logAudit } from "../services/auditService";
import { listPrintServices } from "../services/catalogService";
import { createPrintSale } from "../services/printSaleService";
import { cancelSale } from "../services/sale/cancel";
import { correctSale } from "../services/sale/correct";
import { money, round2 } from "../services/money";
import { verifyManagerApproval } from "./saleRouter";
import { posCashierProcedure, router } from "../trpc";
import { nonNegMoneyString, positiveMoneyString } from "../lib/schemas";
import { pauseIfRetryableDbError } from "../lib/retryDup";
import { confirmExternalPaymentAttempt, initiateExternalPaymentAttempt, type PosExternalPaymentMethod } from "../services/posExternalPayment";
import { POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE } from "@shared/posPaymentPolicy";

const tier = z.enum(["RETAIL", "WHOLESALE", "GOVERNMENT"]);
const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM"]);
const externalMethod = z.enum(["CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM"]);
const lineSchema = z.object({
  variantId: z.number().int().positive(),
  productUnitId: z.number().int().positive(),
  // كمية الخدمة (صفحات/صور/خدمات) — عدد صحيح موجب.
  quantity: z.string().regex(/^\d+(\.\d{1,3})?$/, "كمية غير صالحة"),
  // السعر اليدوي (سعر الخدمة قابل للتعديل من الكاشير) — nonNegMoneyString المركزية.
  unitPriceOverride: nonNegMoneyString.optional(),
});

export const printPosRouter = router({
  /** بلاطات الخدمات (مبوّبة بالفئة) — للكاشير فأعلى، بلا كلفة/مواد. */
  services: posCashierProcedure
    .input(z.object({ tier: tier.default("RETAIL") }).optional())
    .query(({ input }) => listPrintServices(input?.tier ?? "RETAIL")),

  /** يسجّل محاولة مستقلة أولاً؛ لا فاتورة/إيصال/ذمّة قبل تأكيدها واستهلاكها. */
  initiateExternalPayment: posCashierProcedure
    .input(z.object({
      branchId: z.number().int().positive(),
      method: externalMethod,
      amount: positiveMoneyString,
      reference: z.string().trim().min(1).max(100),
      requestId: z.string().trim().min(1).max(80),
      deviceId: z.string().trim().min(1).max(64),
    }))
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا الكاشير" });
      }
      const branchId = elevated ? input.branchId : Number(ctx.user.branchId);
      return initiateExternalPaymentAttempt(
        { ...input, method: input.method as PosExternalPaymentMethod, branchId, channel: "PRINT_POS" },
        { userId: ctx.user.id, branchId, role: ctx.user.role },
      );
    }),

  confirmExternalPayment: posCashierProcedure
    .input(z.object({ branchId: z.number().int().positive(), attemptId: z.number().int().positive(), deviceId: z.string().trim().min(1).max(64) }))
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا الكاشير" });
      }
      const branchId = elevated ? input.branchId : Number(ctx.user.branchId);
      return confirmExternalPaymentAttempt(
        { attemptId: input.attemptId, branchId, channel: "PRINT_POS", deviceId: input.deviceId },
        { userId: ctx.user.id, branchId, role: ctx.user.role },
      );
    }),

  /** بيع خدمات الطباعة: فاتورة + خصم مواد بصمت + قيد + ذمم — ذرّياً (createPrintSale). */
  createSale: posCashierProcedure
    .input(
      z.object({
        branchId: z.number().int().positive(),
        shiftId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        contactName: z.string().trim().max(255).optional(),
        contactPhone: z.string().trim().max(32).optional(),
        channel: z.enum(["WALK_IN", "WHATSAPP", "TELEGRAM", "PHONE"]).optional(),
        isReservation: z.boolean().optional(),
        priceTier: tier.optional(),
        lines: z.array(lineSchema).min(1),
        payment: z.object({
          amount: nonNegMoneyString,
          method,
          externalPaymentAttemptId: z.number().int().positive().optional(),
        }).optional(),
        deviceId: z.string().trim().min(1).max(64).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)").optional(),
        cashRoundIQD: z.boolean().optional(),
        clientRequestId: z.string().optional(),
        notes: z.string().optional(),
        // موافقة مدير لتجاوز حدّ الائتمان (بريد+كلمة مرور، تُتحقَّق خادمياً).
        managerApproval: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
      }).superRefine((input, ctx) => {
        // الإثبات = محاولة دفع خارجية مؤكَّدة خادمياً، لا نصٌّ يكتبه الكاشير. (الإقفال الشامل
        // للطرق غير النقدية أُلغي في ١٦/٨/٢٦ — كان يعطّل بيع البطاقة كلّياً بلا مقابل نزاهةٍ إضافيّ.)
        const payAmt = Number(input.payment?.amount || 0);
        if (input.payment && payAmt > 0 && input.payment.method !== "CASH" && !input.payment.externalPaymentAttemptId) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payment", "externalPaymentAttemptId"], message: "أكّد الدفع الخارجي قبل إتمام البيع" });
        }
        if (input.payment?.method === "CASH" && input.payment.externalPaymentAttemptId != null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payment", "externalPaymentAttemptId"], message: "الدفع النقدي لا يحمل محاولة دفع خارجية" });
        }
      })
    )
    .mutation(async ({ input, ctx }) => {
      // عزل الفرع: غير المدير يُجبَر على فرعه (لا يُصدَّق branchId القادم من العميل — منع IDOR).
      // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران؛ المدير يبيع بفرعه المُسنَد فقط.
      const elevated = ctx.user.role === "admin";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا الكاشير" });
      }
      const effectiveBranchId = elevated ? input.branchId : Number(ctx.user.branchId);
      // role إلزامي: createPrintSale تفحص ملكية الوردية (SHIFT-OWN) وتُعفي admin/manager.
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role };
      let approvedBy: number | null = null;
      const { managerApproval, ...saleInput } = input;
      // AUTHZ-1: مرّر effectiveBranchId لـverifyManagerApproval ⇒ مدير فرع آخر لا يَعتمد بيع هذا الفرع
      // (كان يُستدعى بلا branchId ⇒ IDOR اعتماد عبر الفروع على قناة الطباعة — كان مُصلَحاً في saleRouter فقط).
      if (managerApproval) approvedBy = await verifyManagerApproval(managerApproval, ctx, effectiveBranchId);
      // SALES-01/02: سلطة البيع تحت التكلفة (مدير/أدمن ذاتياً، الكاشير بموافقة مدير مُتحقَّقة).
      const priceOverrideApprovedBy: number | null = approvedBy ?? (elevated ? ctx.user.id : null);
      // B5: مرّر managerOverrideByUserId مع creditApproved ⇒ printSaleService ينشئ approval ذرّياً.
      const effectiveInput = {
        ...saleInput,
        branchId: effectiveBranchId,
        creditApproved: approvedBy != null,
        managerOverrideByUserId: approvedBy ?? undefined,
        priceOverrideApproved: priceOverrideApprovedBy != null,
        requireExternalPaymentAttempt: true,
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createPrintSale(effectiveInput, actor);
          await logAudit(ctx, { action: "printPos.sale", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { lines: input.lines.length, creditApprovedBy: approvedBy } });
          if (approvedBy != null) await logAudit(ctx, { action: "printPos.creditOverride", entityType: "invoice", entityId: (res as { invoiceId?: number })?.invoiceId, newValue: { approvedByManagerId: approvedBy } });
          // SALES-01/02: أثر تدقيقي صريح للبيع تحت التكلفة على قناة الطباعة.
          if (res.priceOverride) await logAudit(ctx, { action: "printPos.priceOverride", entityType: "invoice", entityId: res.invoiceId, newValue: { approvedByUserId: priceOverrideApprovedBy, byRole: ctx.user.role } });
          return res;
        } catch (e: any) {
          if (attempt < 2 && (await pauseIfRetryableDbError(e, attempt))) continue;
          if (e instanceof TRPCError) throw e;
          // لا نبتلع السبب الجذري — نُسجّله كاملاً قبل رسالة عامة (درس ١٢/٦).
          logger.error(
            { err: { message: e?.message, code: e?.code, sqlMessage: e?.sqlMessage, sql: e?.sql }, userId: actor.userId, branchId: actor.branchId, lines: input.lines.length },
            "printPos.createSale فشل بخطأ غير متوقّع (السبب الجذري أدناه)"
          );
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إتمام البيع" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر توليد رقم فاتورة فريد" });
    }),

  /** فواتير الطباعة المحجوزة/المعلقة للفرع الحالي (status IN ('PENDING', 'PARTIALLY_PAID')). */
  listHeldSales: posCashierProcedure
    .input(z.object({
      branchId: z.number().int().positive().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return [];
      const elevated = ctx.user.role === "admin";
      if (!elevated && ctx.user.branchId == null) return [];
      const effectiveBranchId = elevated
        ? (input?.branchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : null))
        : Number(ctx.user.branchId);

      const rows = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          status: invoices.status,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          createdAt: invoices.createdAt,
          notes: invoices.notes,
          contactName: invoices.contactName,
          contactPhone: invoices.contactPhone,
          customerId: invoices.customerId,
          customerName: customers.name,
          customerPhone: sql<string | null>`COALESCE(${customers.phone}, ${customers.whatsapp})`,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(
          and(
            effectiveBranchId != null ? eq(invoices.branchId, effectiveBranchId) : sql`1=1`,
            inArray(invoices.status, ["PENDING", "PARTIALLY_PAID"]),
            eq(invoices.sourceType, "POS"),
          ),
        )
        .orderBy(desc(invoices.id))
        .limit(50);

      if (rows.length === 0) return [];

      const invIds = rows.map((r) => r.id);
      const items = await db
        .select({
          invoiceId: invoiceItems.invoiceId,
          id: invoiceItems.id,
          variantId: invoiceItems.variantId,
          productUnitId: invoiceItems.productUnitId,
          quantity: invoiceItems.quantity,
          unitPrice: invoiceItems.unitPrice,
          total: invoiceItems.total,
          itemNameSnapshot: invoiceItems.itemNameSnapshot,
        })
        .from(invoiceItems)
        .where(inArray(invoiceItems.invoiceId, invIds));

      const itemsByInv = new Map<number, typeof items>();
      for (const it of items) {
        const arr = itemsByInv.get(it.invoiceId) ?? [];
        arr.push(it);
        itemsByInv.set(it.invoiceId, arr);
      }

      return rows.map((r) => {
        const remainingD = round2(money(r.total).minus(money(r.paidAmount)));
        return {
          ...r,
          customerDisplayName: r.customerName || r.contactName || "زبون عابر",
          customerDisplayPhone: r.customerPhone || r.contactPhone || "",
          remainingAmount: remainingD.gt(0) ? remainingD.toFixed(2) : "0.00",
          lines: itemsByInv.get(r.id) ?? [],
        };
      });
    }),

  /** جلب فاتورة برقمها أو بالباركود للبحث أو التسليم/التعديل السريع. */
  getSaleByNumber: posCashierProcedure
    .input(z.object({ orderNumber: z.string().trim().min(1) }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return null;
      const elevated = ctx.user.role === "admin";
      const branchId = elevated ? null : (ctx.user.branchId != null ? Number(ctx.user.branchId) : null);
      const raw = input.orderNumber.trim();
      const stripped = raw.replace(/^INV-/i, "");
      const isNumeric = /^\d+$/.test(raw);

      const [inv] = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          status: invoices.status,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          branchId: invoices.branchId,
          shiftId: invoices.shiftId,
          customerId: invoices.customerId,
          contactName: invoices.contactName,
          contactPhone: invoices.contactPhone,
          notes: invoices.notes,
          priceTier: invoices.priceTier,
          createdAt: invoices.createdAt,
          customerName: customers.name,
          customerPhone: sql<string | null>`COALESCE(${customers.phone}, ${customers.whatsapp})`,
        })
        .from(invoices)
        .leftJoin(customers, eq(invoices.customerId, customers.id))
        .where(
          and(
            branchId != null ? eq(invoices.branchId, branchId) : sql`1=1`,
            or(
              eq(invoices.invoiceNumber, raw),
              eq(invoices.invoiceNumber, `INV-${stripped}`),
              eq(invoices.invoiceNumber, stripped),
              isNumeric ? eq(invoices.id, Number(raw)) : sql`0=1`,
            ),
          ),
        )
        .limit(1);

      if (!inv) return null;

      const lines = await db
        .select({
          id: invoiceItems.id,
          variantId: invoiceItems.variantId,
          productUnitId: invoiceItems.productUnitId,
          quantity: invoiceItems.quantity,
          unitPrice: invoiceItems.unitPrice,
          total: invoiceItems.total,
          itemNameSnapshot: invoiceItems.itemNameSnapshot,
        })
        .from(invoiceItems)
        .where(eq(invoiceItems.invoiceId, inv.id));

      const remainingD = round2(money(inv.total).minus(money(inv.paidAmount)));

      return {
        ...inv,
        customerDisplayName: inv.customerName || inv.contactName || "زبون عابر",
        customerDisplayPhone: inv.customerPhone || inv.contactPhone || "",
        remainingAmount: remainingD.gt(0) ? remainingD.toFixed(2) : "0.00",
        lines,
      };
    }),

  /** إلغاء فاتورة محجوزة/معلقة: إرجاع المخزون ورد العربون إن وُجد بسند صرف رسمي من الدرج. */
  cancelHeldSale: posCashierProcedure
    .input(z.object({
      invoiceId: z.number().int().positive(),
      reason: z.string().trim().min(3, "اكتب سبب الإلغاء").max(500),
      refundPaymentMethod: z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]).default("CASH"),
      clientRequestId: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر إلغاء الفاتورة",
            why: "لا يوجد فرع مُسنَد لحساب الكاشير الحالي",
            doThis: "تأكّد من تسجيل الدخول بحساب كاشير مرتبط بفرع",
          }),
        });
      }
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير مهيأة" });

      const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
      if (!inv) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر العثور على الفاتورة",
            why: "معرّف الفاتورة المطلوب إلغاؤها غير موجود",
            doThis: "تحقّق من صحة رقم الفاتورة أو امسح الباركود مجدداً",
          }),
        });
      }
      if (!elevated && Number(inv.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر إلغاء الفاتورة",
            why: "الفاتورة تتبع فرعاً آخر لا يطابق فرعك الحالي",
            doThis: "سجّل الدخول إلى الفرع المعني لإلغاء الفاتورة",
          }),
        });
      }
      if (inv.status !== "PENDING" && inv.status !== "PARTIALLY_PAID") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر إلغاء الفاتورة من شاشة الكاشير",
            why: "الإلغاء السريع محصور بالطلبات المحجوزة والمعلقة غير المكتملة",
            doThis: "استخدم شاشة المرتجعات لمعالجة الفواتير المسددة بالكامل",
          }),
        });
      }

      const effectiveBranchId = Number(inv.branchId);
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role };

      const res = await cancelSale({
        invoiceId: input.invoiceId,
        refundPaymentMethod: input.refundPaymentMethod,
        reason: input.reason,
        clientRequestId: input.clientRequestId,
      }, actor);

      await logAudit(ctx, {
        action: "printPos.cancelHeldSale",
        entityType: "invoice",
        entityId: input.invoiceId,
        newValue: { refundAmount: res.refundAmount, reason: input.reason },
      });

      return res;
    }),

  /** تعديل فاتورة محجوزة/معلقة: عكس الأصل، ترحيل العربون سلفاً، إصدار فاتورة جديدة معتمدة (SUPERSEDED). */
  correctHeldSale: posCashierProcedure
    .input(z.object({
      originalInvoiceId: z.number().int().positive(),
      customerId: z.number().int().positive().nullish(),
      contactName: z.string().trim().max(255).nullish(),
      contactPhone: z.string().trim().max(32).nullish(),
      priceTier: tier.nullish(),
      lines: z.array(lineSchema).min(1),
      notes: z.string().max(5000).nullish(),
      reason: z.string().trim().min(3, "اكتب سبب التعديل").max(500),
      additionalPayment: z.object({
        amount: positiveMoneyString,
        method: z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]),
        reference: z.string().trim().min(1).max(100).nullish(),
        externalPaymentAttemptId: z.number().int().positive().nullish(),
        externalPaymentDeviceId: z.string().trim().min(1).max(64).nullish(),
      }).nullish(),
      overpayHandling: z.enum(["CREDIT", "CASH_REFUND"]).optional(),
      clientRequestId: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const elevated = ctx.user.role === "admin";
      if (!elevated && ctx.user.branchId == null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر تعديل الفاتورة",
            why: "لا يوجد فرع مُسنَد لحساب الكاشير الحالي",
            doThis: "تأكّد من تسجيل الدخول بحساب كاشير مرتبط بفرع",
          }),
        });
      }
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير مهيأة" });

      const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.originalInvoiceId)).limit(1);
      if (!inv) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: "تعذّر العثور على الفاتورة الأصلية",
            why: "معرّف الفاتورة المطلوب تعديلها غير موجود",
            doThis: "تحقّق من رقم الفاتورة وحاول مجدداً",
          }),
        });
      }
      if (!elevated && Number(inv.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: appErrorMessage({
            what: "تعذّر تعديل الفاتورة",
            why: "الفاتورة تتبع فرعاً آخر لا يطابق فرعك الحالي",
            doThis: "سجّل الدخول إلى الفرع المعني لتعديل الفاتورة",
          }),
        });
      }
      if (inv.status !== "PENDING" && inv.status !== "PARTIALLY_PAID") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: "تعذّر التعديل المباشر للفاتورة",
            why: "التعديل السريع في كاشير الطباعة محصور بالطلبات المحجوزة والمعلقة",
            doThis: "الفواتير المسددة بالكامل تخضع للتعديل أو المرتجع من شاشة الفواتير",
          }),
        });
      }

      const effectiveBranchId = Number(inv.branchId);
      const actor = { userId: ctx.user.id, branchId: effectiveBranchId, role: ctx.user.role };

      const res = await correctSale({
        originalInvoiceId: input.originalInvoiceId,
        customerId: input.customerId ?? inv.customerId ?? undefined,
        contactName: input.contactName ?? inv.contactName ?? undefined,
        contactPhone: input.contactPhone ?? inv.contactPhone ?? undefined,
        priceTier: input.priceTier ?? (inv.priceTier as any) ?? "RETAIL",
        lines: input.lines.map((l) => ({
          variantId: l.variantId,
          productUnitId: l.productUnitId,
          quantity: l.quantity,
          unitPriceOverride: l.unitPriceOverride,
        })),
        notes: [input.reason ? `[سبب التعديل: ${input.reason}]` : null, input.notes?.trim() ?? inv.notes ?? null].filter(Boolean).join(" - ") || undefined,
        additionalPayment: input.additionalPayment,
        overpayHandling: input.overpayHandling,
        clientRequestId: input.clientRequestId,
      }, actor);

      await logAudit(ctx, {
        action: "printPos.correctHeldSale",
        entityType: "invoice",
        entityId: input.originalInvoiceId,
        newValue: { correctedInvoiceId: res.correctedInvoiceId, correctedInvoiceNumber: res.correctedInvoiceNumber, reason: input.reason },
      });

      return res;
    }),
});
