// راوتر سندات القبض/الصرف المستقلّة. managerProcedure (تأثير مالي مباشر على الذمم + الصندوق).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit, logAuditTx } from "../services/auditService";
import {
  approveVoucher,
  cancelVoucher,
  createVoucher,
  getApprovalThreshold,
  getVoucher,
  listVouchers,
  recentVouchersForParty,
  rejectVoucher,
} from "../services/voucherService";
import {
  router,
  treasuryGlobalProcedure,
  treasuryGlobalReadProcedure,
  treasuryManagerProcedure,
  treasuryManagerReadProcedure,
} from "../trpc";
import { isDupEntry } from "@shared/errorMap.ar";
import { withTx } from "../services/tx";
import { resubmitRejectedExpensePayment } from "../services/voucher/approval";
import {
  VOUCHER_CATEGORY_POSTING_ROLES,
  isVoucherCategoryRoleCompatible,
} from "../../shared/voucherCategoryAccounting";
import { assertVoucherCategoryDefinition } from "../services/voucher/categoryAccounting";
import { ensureDefaultVoucherCategories } from "../services/voucher/defaults";
import { extractInsertId } from "../lib/insertId";
import { assertBranchOwnership } from "../services/voucher/helpers";
import {
  hasSystemPaymentRequestEnvelope,
  isCanonicalSystemPaymentRequest,
  isSystemPaymentReference,
  parseSystemPaymentRequest,
} from "../services/voucher/create";
import { withMysqlDeadlockRetry } from "../services/voucher/deadlockRetry";

const partyType = z.enum(["CUSTOMER", "SUPPLIER", "OTHER"]);
// قرار المالك (٢٢/٧): لا تعامل بالصكوك — CHECK محذوف من طرق الإنشاء، ويبقى في reportableMethod
// وفي المخطط للسجلات التاريخية فقط (فلترة/عرض السندات القديمة).
const creatableMethod = z.enum(["CASH", "CARD", "TRANSFER", "WALLET"]);
const reportableMethod = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "EXCHANGE"]);
const voucherType = z.enum(["RECEIPT", "PAYMENT"]);
const approvalStatus = z.enum(["APPROVED", "PENDING_APPROVAL", "REJECTED"]);
const moneyStr = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");
const voucherCategoryDirection = z.enum(["IN", "OUT", "BOTH"]);
const voucherCategoryPostingRole = z.enum(VOUCHER_CATEGORY_POSTING_ROLES);

// فلاتر القائمة والمجاميع — schema واحد يضمن تطابق شروط list وaggregate للأبد.
const voucherListFilters = z.object({
  branchId: z.number().int().positive().optional(),
  voucherType: voucherType.optional(),
  partyType: partyType.optional(),
  partyId: z.number().int().positive().optional(),
  status: z.enum(["COMPLETED", "REVERSED"]).optional(),
  approvalStatus: approvalStatus.optional(),
  voucherCategoryId: z.number().int().positive().optional(),
  paymentMethod: reportableMethod.optional(),
  q: z.string().trim().max(100).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
});
type VoucherListFilters = z.infer<typeof voucherListFilters>;

export const voucherRouter = router({
  /** معلومات حوكمة الواجهة. العتبة تخص سياسة القبض القائمة؛ كل سند صرف يحتاج اعتماداً. */
  thresholds: treasuryManagerReadProcedure.query(() => ({
    approval: getApprovalThreshold(),
    allPaymentsRequireApproval: true,
  })),

  create: treasuryManagerProcedure
    .input(
      z.object({
        voucherType,
        branchId: z.number().int().positive(),
        amount: moneyStr,
        paymentMethod: creatableMethod,
        partyType,
        partyId: z.number().int().positive().nullish(),
        description: z.string().min(1, "الوصف مطلوب").max(500),
        referenceNumber: z.string().max(100).nullish(),
        checkNumber: z.string().max(50).nullish(),
        cardLastFour: z.string().max(4).nullish(),
        // vouchers-pro:
        voucherCategoryId: z.number().int().positive().nullish(),
        counterpartyName: z.string().max(200).nullish(),
        voucherDate: ymd.nullish(),
        // حدّ zod أعلى من سقف assertValidImageDataUrl (٢م بايت مُفكّكة ≈ ٢.٧م نصّاً) عمداً —
        // كي تكون رسالة الخطأ الودودة (PAYLOAD_TOO_LARGE بالعربية) هي ما يَظهر، لا خطأ zod الخام.
        attachmentUrl: z.string().max(4_000_000).nullish(),
        internalNote: z.string().max(2000).nullish(),
        // attachment-upload (٥/٧): ربط سند العميل بفاتورة بيع مُحدَّدة (اختياري).
        invoiceId: z.number().int().positive().nullish(),
        clientRequestId: z.string().min(1).max(80),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إصدار سند" });
      }
      const actorBranchId = Number(ctx.user.branchId);
      // #3 (تدقيق التثبيت): كان input.branchId من العميل يمرّ كما هو لـcreateVoucher ⇒ محاسب/مدير
      // فرع A يُصدر سنداً على خزينة فرع B (تلويث تسوية/Z-report فرع لا ينتمي إليه، ويُخفى عنه في
      // القراءة المعزولة). نثبّت الفرع على فرع الفاعل لغير الأدمن (مرآة sale.create/expense.create).
      const scopedInput = ctx.user.role === "admin" ? input : { ...input, branchId: actorBranchId };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createVoucher(scopedInput, { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role, isOwner: !!(ctx.user as any).isOwner });
          await logAudit(ctx, {
            action: input.voucherType === "RECEIPT" ? "voucher.receipt.create" : "voucher.payment.create",
            entityType: "receipt",
            entityId: res.receiptId,
            newValue: {
              voucherNumber: res.voucherNumber,
              amount: input.amount,
              partyType: input.partyType,
              partyId: input.partyId ?? null,
              approvalStatus: res.approvalStatus,
              voucherCategoryId: input.voucherCategoryId ?? null,
              invoiceId: input.invoiceId ?? null,
            },
          });
          return res;
        } catch (e: any) {
          if (isDupEntry(e) && attempt < 2) continue;
          if (e instanceof TRPCError) throw e;
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذّر إنشاء السند" });
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "تعذّر إنشاء السند (تكرار)" });
    }),

  /** اعتماد سند مُعلَّق (Maker-Checker) — مدير ثانٍ غير المُنشئ. */
  approve: treasuryManagerProcedure
    .input(z.object({ receiptId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن اعتماد سند" });
      }
      const res = await approveVoucher(input.receiptId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId),
        role: ctx.user.role,
      });
      if (!res.replayed) {
        await logAudit(ctx, {
          action: "voucher.approve",
          entityType: "receipt",
          entityId: input.receiptId,
          newValue: { voucherNumber: res.voucherNumber, signatureHash: res.signatureHash, approvalAuthority: "OWNER" },
        });
      }
      return res;
    }),

  /** رفض سند مُعلَّق — يَبقى في السجل ولا أثَر مالي (لم يُسجَّل أصلاً). */
  reject: treasuryManagerProcedure
    .input(z.object({ receiptId: z.number().int().positive(), reason: z.string().min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن رفض سند" });
      }
      const res = await rejectVoucher(input.receiptId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId),
        role: ctx.user.role,
      }, input.reason);
      await logAudit(ctx, {
        action: "voucher.reject",
        entityType: "receipt",
        entityId: input.receiptId,
        newValue: { voucherNumber: res.voucherNumber, reason: input.reason.slice(0, 200) },
      });
      return res;
    }),

  /** إعادة إصدار محاولة تسوية استحقاق مرفوضة مع سبب وسلسلة A<n> ثابتة، دون تكرار الاعتراف. */
  resubmitExpensePayment: treasuryManagerProcedure
    .input(z.object({
      receiptId: z.number().int().positive(),
      priorReceiptId: z.number().int().positive(),
      reissueReason: z.string().trim().min(5).max(500),
      attachmentUrl: z.string().max(4_000_000).nullish(),
      note: z.string().trim().max(500).nullish(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
      }
      const res = await resubmitRejectedExpensePayment(input.receiptId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId),
        role: ctx.user.role,
        isOwner: !!(ctx.user as { isOwner?: boolean }).isOwner,
      }, {
        attachmentUrl: input.attachmentUrl,
        note: input.note,
        priorReceiptId: input.priorReceiptId,
        reissueReason: input.reissueReason,
      });
      if (!res.replayed) {
        await logAudit(ctx, {
          action: "voucher.systemPayment.resubmit",
          entityType: "receipt",
          entityId: res.receiptId,
          newValue: {
            rejectedReceiptId: input.receiptId,
            priorReceiptId: input.priorReceiptId,
            reissueReason: input.reissueReason,
            voucherNumber: res.voucherNumber,
            rootReceiptId: res.rootReceiptId,
            attempt: res.attempt,
          },
        });
      }
      return res;
    }),

  // إلغاء سند مستقلّ: الأصل REVERSED + إيصال تعويضي معاكس + قيد معاكس + عكس رصيد الطرف.
  cancel: treasuryManagerProcedure
    .input(z.object({ receiptId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إلغاء سند" });
      }
      const res = await cancelVoucher(input.receiptId, {
        userId: ctx.user.id,
        branchId: Number(ctx.user.branchId),
        role: ctx.user.role,
      });
      await logAudit(ctx, {
        action: "voucher.cancel",
        entityType: "receipt",
        entityId: input.receiptId,
        newValue: {
          voucherNumber: res.voucherNumber,
          status: res.status,
          approvalReceiptId: res.approvalReceiptId ?? null,
        },
      });
      return res;
    }),

  list: treasuryManagerReadProcedure
    .input(
      voucherListFilters
        .extend({
          limit: z.number().int().positive().max(500).default(100),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      // IDOR (تدقيق ٢/٧): list كان يمرّر branchId العميل بلا عزل ⇒ مدير فرع يقرأ سندات كل الفروع
      // (بخلاف get الذي يفرض العزل). نُقيّد المدير المُسنَد لفرع بفرعه؛ الأدمن ومدير بلا فرع (عابر
      // الفروع) يمرّان كما هما — مطابقٌ لمنطق get.
      const restrict = ctx.user.role !== "admin" && ctx.user.branchId != null;
      const scoped = restrict ? { ...(input ?? {}), branchId: Number(ctx.user.branchId) } : (input ?? {});
      return listVouchers(scoped);
    }),

  /** مجاميع كامل النطاق المفلتر + count للترقيم — بطاقات الإجماليات كانت تجمع صفوف الصفحة
   *  الحالية فقط (مضلّلة فوق ١٠٠ سند). نفس عزل الفرع المطبَّق في list حرفياً. */
  aggregate: treasuryManagerReadProcedure
    .input(voucherListFilters.optional())
    .query(async ({ input, ctx }) => {
      const restrict = ctx.user.role !== "admin" && ctx.user.branchId != null;
      const scoped = restrict ? { ...(input ?? {}), branchId: Number(ctx.user.branchId) } : (input ?? {});
      return aggregateVouchers(scoped);
    }),

  get: treasuryManagerReadProcedure
    .input(z.object({ receiptId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const voucher = await getVoucher(input.receiptId);
      if (voucher && ctx.user.role !== "admin" && ctx.user.branchId != null && Number(voucher.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "هذا السند لفرع آخر" });
      }
      return voucher;
    }),

  /** السندات الأخيرة لنفس الطرف خلال نافذة (افتراضي ٧ أيام، ٥ سندات) — للتحذير من الازدواج. */
  recentForParty: treasuryManagerReadProcedure
    .input(z.object({
      partyType,
      partyId: z.number().int().positive().nullish(),
      counterpartyName: z.string().max(200).nullish(),
      branchId: z.number().int().positive().optional(),
      windowDays: z.number().int().positive().max(90).default(7),
      limit: z.number().int().positive().max(20).default(5),
    }))
    .query(async ({ input, ctx }) => {
      // IDOR (مراجعة أمنية): كان يمرّر input.branchId بلا عزل ⇒ مدير فرع يقرأ سندات فرع آخر
      // (بخلاف list/get اللذين يفرضان العزل). نُطبّق نفس منطق list: نُقيّد المدير المُسنَد لفرع
      // بفرعه (نتجاهل input.branchId)؛ الأدمن ومدير بلا فرع (عابر الفروع) يمرّان كما هما.
      const restrict = ctx.user.role !== "admin" && ctx.user.branchId != null;
      const branchId = restrict ? Number(ctx.user.branchId) : (input.branchId ?? null);
      return recentVouchersForParty({
        partyType: input.partyType,
        partyId: input.partyId ?? null,
        counterpartyName: input.counterpartyName ?? null,
        branchId,
        windowDays: input.windowDays,
        limit: input.limit,
      });
    }),
});

/* ============================ فئات السندات (admin CRUD) ============================ */
import { and, asc, eq, gte, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { invoices, receipts, voucherCategories } from "../../drizzle/schema";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import { localDayStart, localNextDayStart } from "../services/dateRange";

/** مجاميع السندات بSQL (SUM/COUNT على كامل النطاق المفلتر — لا جمع صفوف صفحة).
 *  ⚠️ شروط الفلترة مرآةُ listVouchers (services/voucher/queries.ts) حرفياً — أي فلتر جديد هناك
 *  يُضاف هنا وإلا انحرفت البطاقات عن الجدول. القبض/الصرف من المُعتمَد غير الملغى فقط
 *  (المعلّق والمرفوض بلا أثر مالي — لم يُسجَّل قيد أصلاً، والملغى عُكس أثره). */
async function aggregateVouchers(input: VoucherListFilters) {
  const empty = { count: 0, totalIn: "0.00", totalOut: "0.00", pendingTotal: "0.00", pendingCount: 0, reversedCount: 0 };
  const db = getDb();
  if (!db) return empty;
  const wheres: any[] = [isNotNull(receipts.voucherNumber)];
  if (input.status) wheres.push(eq(receipts.status, input.status));
  if (input.branchId) wheres.push(eq(receipts.branchId, input.branchId));
  if (input.voucherType) wheres.push(eq(receipts.direction, input.voucherType === "RECEIPT" ? "IN" : "OUT"));
  if (input.partyType) wheres.push(eq(receipts.partyType, input.partyType));
  if (input.partyId) wheres.push(eq(receipts.partyId, input.partyId));
  if (input.approvalStatus) wheres.push(eq(receipts.approvalStatus, input.approvalStatus));
  if (input.voucherCategoryId) wheres.push(eq(receipts.voucherCategoryId, input.voucherCategoryId));
  if (input.paymentMethod) wheres.push(eq(receipts.paymentMethod, input.paymentMethod));
  if (input.q?.trim()) {
    const like = `%${escLike(input.q.trim())}%`;
    wheres.push(or(
      sql`coalesce(${receipts.voucherNumber}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${receipts.description}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${receipts.counterpartyName}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${receipts.referenceNumber}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${receipts.checkNumber}, '') LIKE ${like} ESCAPE '!'`,
      sql`coalesce(${invoices.invoiceNumber}, '') LIKE ${like} ESCAPE '!'`,
    ));
  }
  if (input.from) wheres.push(gte(receipts.createdAt, localDayStart(input.from)));
  if (input.to) wheres.push(lt(receipts.createdAt, localNextDayStart(input.to)));

  // leftJoin الفواتير لا يُضاعف الصفوف (invoiceId → فاتورة واحدة)، وهو لازم لبحث q برقم الفاتورة.
  const row = (
    await db
      .select({
        count: sql<number>`COUNT(*)`,
        totalIn: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.status} <> 'REVERSED' AND ${receipts.approvalStatus} = 'APPROVED' AND ${receipts.direction} = 'IN' THEN CAST(${receipts.amount} AS DECIMAL(15,2)) ELSE 0 END), 0)`,
        totalOut: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.status} <> 'REVERSED' AND ${receipts.approvalStatus} = 'APPROVED' AND ${receipts.direction} = 'OUT' THEN CAST(${receipts.amount} AS DECIMAL(15,2)) ELSE 0 END), 0)`,
        pendingTotal: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.status} <> 'REVERSED' AND ${receipts.approvalStatus} = 'PENDING_APPROVAL' THEN CAST(${receipts.amount} AS DECIMAL(15,2)) ELSE 0 END), 0)`,
        pendingCount: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} <> 'REVERSED' AND ${receipts.approvalStatus} = 'PENDING_APPROVAL' THEN 1 ELSE 0 END), 0)`,
        reversedCount: sql<number>`COALESCE(SUM(CASE WHEN ${receipts.status} = 'REVERSED' THEN 1 ELSE 0 END), 0)`,
      })
      .from(receipts)
      .leftJoin(invoices, eq(receipts.invoiceId, invoices.id))
      .where(and(...wheres))
  )[0];
  if (!row) return empty;
  return {
    count: Number(row.count ?? 0),
    totalIn: String(row.totalIn ?? "0.00"),
    totalOut: String(row.totalOut ?? "0.00"),
    pendingTotal: String(row.pendingTotal ?? "0.00"),
    pendingCount: Number(row.pendingCount ?? 0),
    reversedCount: Number(row.reversedCount ?? 0),
  };
}

export const voucherCategoryRouter = router({
  list: treasuryGlobalReadProcedure
    .input(z.object({ includeInactive: z.boolean().default(false) }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return [];
      const wheres: any[] = [];
      if (!input?.includeInactive) wheres.push(eq(voucherCategories.isActive, true));
      const [rows, counts] = await Promise.all([
        db.select().from(voucherCategories)
        .where(wheres.length ? and(...wheres) : undefined)
        .orderBy(asc(voucherCategories.sortOrder), asc(voucherCategories.id)),
        db
          .select({
            categoryId: receipts.voucherCategoryId,
            count: sql<number>`COUNT(*)`,
          })
          .from(receipts)
          .where(isNotNull(receipts.voucherCategoryId))
          .groupBy(receipts.voucherCategoryId),
      ]);
      const countById = new Map(
        counts.map((row) => [Number(row.categoryId), Number(row.count ?? 0)]),
      );
      return rows.map((row) => ({
        ...row,
        usedReceiptCount: countById.get(Number(row.id)) ?? 0,
      }));
    }),

  create: treasuryGlobalProcedure
    .input(z.object({
      name: z.string().trim().min(1, "اسم الفئة مطلوب").max(100),
      direction: voucherCategoryDirection.default("BOTH"),
      postingRole: voucherCategoryPostingRole,
      description: z.string().max(300).nullish(),
      sortOrder: z.number().int().default(0),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB غير مهيّأة" });
      const name = input.name.trim();
      assertVoucherCategoryDefinition({
        direction: input.direction,
        postingRole: input.postingRole,
        isActive: true,
        name,
      });
      try {
        // extractInsertId بدل الالتقاط اليدويّ: كان `Number(undefined)` يُنتج NaN بصمت فيعود
        // للواجهة معرّفٌ باطل (فتعذّر انتقاء الفئة المُنشأة فوراً) ويُكتب سجلّ تدقيق بلا كيان.
        const id = extractInsertId(
          await db.insert(voucherCategories).values({
            name,
            direction: input.direction,
            postingRole: input.postingRole,
            description: input.description?.trim() || null,
            sortOrder: input.sortOrder,
            isActive: true,
          }),
        );
        await logAudit(ctx, { action: "voucherCategory.create", entityType: "voucherCategory", entityId: id, newValue: { ...input, name } });
        // نُعيد الصفّ كاملاً كي تنتقيه شاشة السند فوراً بلا جولةِ قراءةٍ ثانية.
        return {
          id,
          name,
          direction: input.direction,
          postingRole: input.postingRole,
          isActive: true,
        };
      } catch (e: any) {
        if (isDupEntry(e)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `الفئة «${name}» موجودة مسبقاً — قد تكون معطّلة، فعّلها من قائمة الفئات بدل إنشاء نسخة ثانية.`,
          });
        }
        throw e;
      }
    }),

  /**
   * استعادة كتالوج الفئات الافتراضية — مخرج تشغيليّ حين تكون القائمة فارغة أو ناقصة (قاعدةٌ
   * بُنيت بـ`db:push`، أو فئاتٌ عُطّلت جماعياً) فيصير الحقل الإلزاميّ في سند «أخرى» بلا خيارات.
   * idempotent تماماً: يُدخل الناقص ويملأ الحساب المقابل الفارغ فقط، ولا يمسّ ما عيّنه المالك.
   */
  restoreDefaults: treasuryGlobalProcedure.mutation(async ({ ctx }) => {
    const result = await ensureDefaultVoucherCategories();
    if (result.inserted.length || result.mapped.length) {
      await logAudit(ctx, {
        action: "voucherCategory.restoreDefaults",
        entityType: "voucherCategory",
        newValue: {
          inserted: result.inserted,
          mapped: result.mapped,
          skipped: result.skipped,
        },
      });
    }
    return result;
  }),

  update: treasuryGlobalProcedure
    .input(z.object({
      id: z.number().int().positive(),
      name: z.string().min(1).max(100).optional(),
      direction: voucherCategoryDirection.optional(),
      postingRole: voucherCategoryPostingRole.optional(),
      description: z.string().max(300).nullish(),
      sortOrder: z.number().int().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB غير مهيّأة" });
      try {
        const patch = await withTx(async (tx) => {
          const [current] = await tx
            .select()
            .from(voucherCategories)
            .where(eq(voucherCategories.id, input.id))
            .for("update")
            .limit(1);
          if (!current) {
            throw new TRPCError({ code: "NOT_FOUND", message: "فئة السند غير موجودة" });
          }
          const effectiveDirection = input.direction ?? current.direction;
          const effectiveRole = input.postingRole ?? current.postingRole;
          if (current.isActive) {
            assertVoucherCategoryDefinition({
              direction: effectiveDirection,
              postingRole: effectiveRole,
              isActive: true,
              name: input.name ?? current.name,
            });
          } else if (
            effectiveRole &&
            !isVoucherCategoryRoleCompatible(effectiveDirection, effectiveRole)
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "الحساب المقابل لا يتوافق مع اتجاه الفئة",
            });
          }

          const directionChanged =
            input.direction != null && input.direction !== current.direction;
          const roleChanged =
            input.postingRole != null && input.postingRole !== current.postingRole;
          if (directionChanged || roleChanged) {
            const [used] = await tx
              .select({ id: receipts.id })
              .from(receipts)
              .where(eq(receipts.voucherCategoryId, input.id))
              .limit(1);
            if (used) {
              throw new TRPCError({
                code: "CONFLICT",
                message: directionChanged
                  ? "لا يمكن تغيير اتجاه فئة مرتبطة بسندات؛ أنشئ فئة جديدة ثم ادمج المتوافق فقط"
                  : "لا يمكن تغيير الحساب المقابل لفئة مرتبطة بأي سند؛ أنشئ فئة جديدة ثم ادمجها حفاظاً على أثر التدقيق",
              });
            }
          }

          const next: Record<string, unknown> = {};
          if (input.name !== undefined) next.name = input.name.trim();
          if (input.direction !== undefined) next.direction = input.direction;
          if (input.postingRole !== undefined) next.postingRole = input.postingRole;
          if (input.description !== undefined) next.description = input.description?.trim() || null;
          if (input.sortOrder !== undefined) next.sortOrder = input.sortOrder;
          if (Object.keys(next).length > 0) {
            await tx.update(voucherCategories).set(next).where(eq(voucherCategories.id, input.id));
          }
          return next;
        });
        await logAudit(ctx, { action: "voucherCategory.update", entityType: "voucherCategory", entityId: input.id, newValue: patch });
        return { ok: true };
      } catch (e: any) {
        if (isDupEntry(e)) {
          throw new TRPCError({ code: "CONFLICT", message: "اسم الفئة مُكرَّر" });
        }
        throw e;
      }
    }),

  setActive: treasuryGlobalProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB غير مهيّأة" });
      // عند التَعطيل: نَتحقّق أنّ لا سند نَشِط مَربوط بها — إن وُجد، تَعطيل سَلِس (الفئة تَختفي من
      // المُنتقيات الجَديدة لكن السندات القديمة تَحتفظ بربطها للتاريخ التَدقيقي).
      await withMysqlDeadlockRetry(() => withTx(async (tx) => {
        const [category] = await tx
          .select()
          .from(voucherCategories)
          .where(eq(voucherCategories.id, input.id))
          .for("update")
          .limit(1);
        if (!category) {
          throw new TRPCError({ code: "NOT_FOUND", message: "فئة السند غير موجودة" });
        }
        if (input.isActive) {
          assertVoucherCategoryDefinition({
            direction: category.direction,
            postingRole: category.postingRole,
            isActive: true,
            name: category.name,
          });
        }
        await tx
          .update(voucherCategories)
          .set({ isActive: input.isActive })
          .where(eq(voucherCategories.id, input.id));
      }));
      await logAudit(ctx, {
        action: input.isActive ? "voucherCategory.activate" : "voucherCategory.deactivate",
        entityType: "voucherCategory",
        entityId: input.id,
      });
      return { ok: true };
    }),

  /** دَمج فئة في أخرى (للتنظيف): ينقل سندات A إلى B ثم يُعطّل A. */
  merge: treasuryManagerProcedure
    .input(z.object({ fromId: z.number().int().positive(), toId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (input.fromId === input.toId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن دَمج فئة في نفسها" });
      }
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB غير مهيّأة" });
      // MERGE-TX (تدقيق ٢/٧): الكتابتان (نقل السندات + تعطيل الفئة) مترابطتان — كانتا على db الخام
      // بلا معاملة ⇒ فشلٌ بينهما يترك سندات منقولة وفئةً ما تزال مفعَّلة. نلفّهما في withTx ذرّية.
      await withMysqlDeadlockRetry(() => withTx(async (tx) => {
        // الترتيب موحّد مع اعتماد السند: receipt أولاً ثم category. قفل الصفوف
        // بترتيب id يجعل merge متزامنين serializable ويمنع دورة category→receipt.
        await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(eq(receipts.voucherCategoryId, input.fromId))
          .orderBy(asc(receipts.id))
          .for("update");
        const lockedCategories = await tx
          .select()
          .from(voucherCategories)
          .where(
            or(
              eq(voucherCategories.id, input.fromId),
              eq(voucherCategories.id, input.toId),
            ),
          )
          .orderBy(asc(voucherCategories.id))
          .for("update");
        const source = lockedCategories.find(
          (category) => Number(category.id) === input.fromId,
        );
        const target = lockedCategories.find(
          (category) => Number(category.id) === input.toId,
        );
        if (!source || !target) {
          throw new TRPCError({ code: "NOT_FOUND", message: "إحدى فئتي الدمج غير موجودة" });
        }
        if (!target.isActive) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "الفئة الهدف معطّلة" });
        }
        assertVoucherCategoryDefinition({
          direction: target.direction,
          postingRole: target.postingRole,
          isActive: true,
          name: target.name,
        });
        const targetSupportsSource =
          target.direction === "BOTH" || target.direction === source.direction;
        const roleCompatible =
          source.postingRole == null || source.postingRole === target.postingRole;
        if (!targetSupportsSource || !roleCompatible) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "الدمج المحاسبي يتطلب فئة هدف بنفس الحساب المقابل واتجاه يغطي الفئة المصدر",
          });
        }
        await tx.update(receipts).set({ voucherCategoryId: input.toId }).where(eq(receipts.voucherCategoryId, input.fromId));
        await tx.update(voucherCategories).set({ isActive: false }).where(eq(voucherCategories.id, input.fromId));
      }));
      await logAudit(ctx, {
        action: "voucherCategory.merge",
        entityType: "voucherCategory",
        entityId: input.fromId,
        newValue: { mergedInto: input.toId },
      });
      return { ok: true };
    }),

  /** قائمة معالجة صريحة للسندات اليدوية التاريخية التي سبقت إلزام التصنيف. */
  unclassifiedOther: treasuryManagerReadProcedure.query(async ({ ctx }) => {
    const db = getDb();
    if (!db) return [];
    const scope = [
      eq(receipts.partyType, "OTHER"),
      sql`${receipts.voucherCategoryId} IS NULL`,
      isNotNull(receipts.voucherNumber),
    ];
    if (ctx.user.role !== "admin") {
      if (ctx.user.branchId == null) return [];
      scope.push(eq(receipts.branchId, Number(ctx.user.branchId)));
    }
    const rows = await db
      .select({
        id: receipts.id,
        voucherNumber: receipts.voucherNumber,
        voucherDate: receipts.voucherDate,
        direction: receipts.direction,
        amount: receipts.amount,
        counterpartyName: receipts.counterpartyName,
        description: receipts.description,
        status: receipts.status,
        approvalStatus: receipts.approvalStatus,
        referenceNumber: receipts.referenceNumber,
        internalNote: receipts.internalNote,
      })
      .from(receipts)
      .where(and(...scope))
      .orderBy(sql`${receipts.id} DESC`)
      .limit(500);
    return rows.map((row) => {
      const request = parseSystemPaymentRequest(row.internalNote);
      const canonicalSpecialized =
        request != null &&
        isCanonicalSystemPaymentRequest(request, row.referenceNumber);
      const reservedSystemEnvelope = hasSystemPaymentRequestEnvelope(
        row.internalNote,
      );
      const reservedSystemSource =
        reservedSystemEnvelope || isSystemPaymentReference(row.referenceNumber);
      return {
        ...row,
        specialized: reservedSystemSource,
        remediationMessage: canonicalSpecialized
          ? "يحتاج مساراً تخصصياً من الوحدة المصدرية"
          : reservedSystemSource
            ? "طلب نظامي غير canonical؛ يحتاج مراجعة تدقيق ولا يُصنّف يدوياً"
          : "يحتاج تعيين فئة وحساب مقابل",
      };
    });
  }),

  assignHistoricalCategory: treasuryManagerProcedure
    .input(
      z.object({
        receiptId: z.number().int().positive(),
        voucherCategoryId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const changed = await withTx(async (tx) => {
        const [receipt] = await tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, input.receiptId))
          .for("update")
          .limit(1);
        if (!receipt || receipt.voucherNumber == null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "السند التاريخي غير موجود" });
        }
        if (receipt.partyType !== "OTHER") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "المعالجة مخصصة لسندات OTHER فقط" });
        }
        if (ctx.user.branchId == null && ctx.user.role !== "admin") {
          throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم" });
        }
        await assertBranchOwnership(
          tx,
          {
            userId: ctx.user.id,
            branchId: Number(ctx.user.branchId ?? receipt.branchId ?? 0),
            role: ctx.user.role,
          },
          receipt.branchId != null ? Number(receipt.branchId) : null,
          "سند تاريخي",
        );
        if (receipt.voucherCategoryId != null) {
          if (Number(receipt.voucherCategoryId) === input.voucherCategoryId) {
            return false;
          }
          throw new TRPCError({ code: "CONFLICT", message: "صُنّف السند بالفعل؛ لا يُعاد تصنيفه بعد الحفظ" });
        }
        if (
          hasSystemPaymentRequestEnvelope(receipt.internalNote) ||
          isSystemPaymentReference(receipt.referenceNumber)
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "هذا سند نظامي يحتاج مساراً تخصصياً من وحدته المصدرية، ولا يُصنّف يدوياً",
          });
        }
        const [category] = await tx
          .select()
          .from(voucherCategories)
          .where(eq(voucherCategories.id, input.voucherCategoryId))
          .for("update")
          .limit(1);
        if (!category) {
          throw new TRPCError({ code: "NOT_FOUND", message: "فئة السند غير موجودة" });
        }
        assertVoucherCategoryDefinition({
          direction: category.direction,
          postingRole: category.postingRole,
          isActive: category.isActive,
          name: category.name,
        });
        if (
          receipt.direction !== "IN" &&
          receipt.direction !== "OUT"
        ) {
          throw new TRPCError({ code: "CONFLICT", message: "اتجاه السند التاريخي غير صالح" });
        }
        if (
          category.direction !== "BOTH" &&
          category.direction !== receipt.direction
        ) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "اتجاه الفئة لا يطابق اتجاه السند" });
        }
        await tx
          .update(receipts)
          .set({ voucherCategoryId: input.voucherCategoryId })
          .where(eq(receipts.id, input.receiptId));
        await logAuditTx(tx, ctx, {
          action: "voucherCategory.remediateHistorical",
          entityType: "receipt",
          entityId: input.receiptId,
          newValue: { voucherCategoryId: input.voucherCategoryId },
        });
        return true;
      });
      return { ok: true, changed };
    }),
});

// تَجنّب «var لم تُستعمل» — placeholder ne (مَستعمل في recentVouchersForParty عبر إعادة-تَصدير لاحقاً).
void ne;
