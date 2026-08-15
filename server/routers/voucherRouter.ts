// راوتر سندات القبض/الصرف المستقلّة. managerProcedure (تأثير مالي مباشر على الذمم + الصندوق).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
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
import { adminProcedure, router, treasuryManagerProcedure, treasuryManagerReadProcedure } from "../trpc";
import { isDupEntry } from "@shared/errorMap.ar";
import { withTx } from "../services/tx";

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
        newValue: { voucherNumber: res.voucherNumber, status: res.status },
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
  list: treasuryManagerReadProcedure
    .input(z.object({ includeInactive: z.boolean().default(false) }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return [];
      const wheres: any[] = [];
      if (!input?.includeInactive) wheres.push(eq(voucherCategories.isActive, true));
      return db.select().from(voucherCategories)
        .where(wheres.length ? and(...wheres) : undefined)
        .orderBy(asc(voucherCategories.sortOrder), asc(voucherCategories.id));
    }),

  create: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      direction: z.enum(["IN", "OUT", "BOTH"]).default("BOTH"),
      description: z.string().max(300).nullish(),
      sortOrder: z.number().int().default(0),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB غير مهيّأة" });
      try {
        const ins = await db.insert(voucherCategories).values({
          name: input.name.trim(),
          direction: input.direction,
          description: input.description?.trim() || null,
          sortOrder: input.sortOrder,
          isActive: true,
        });
        const id = (ins as any)?.[0]?.insertId ?? (ins as any)?.insertId;
        await logAudit(ctx, { action: "voucherCategory.create", entityType: "voucherCategory", entityId: Number(id), newValue: input });
        return { id: Number(id) };
      } catch (e: any) {
        if (isDupEntry(e)) {
          throw new TRPCError({ code: "CONFLICT", message: "اسم الفئة مُكرَّر" });
        }
        throw e;
      }
    }),

  update: adminProcedure
    .input(z.object({
      id: z.number().int().positive(),
      name: z.string().min(1).max(100).optional(),
      direction: z.enum(["IN", "OUT", "BOTH"]).optional(),
      description: z.string().max(300).nullish(),
      sortOrder: z.number().int().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB غير مهيّأة" });
      const patch: any = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.direction !== undefined) patch.direction = input.direction;
      if (input.description !== undefined) patch.description = input.description?.trim() || null;
      if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
      if (Object.keys(patch).length === 0) return { ok: true };
      try {
        await db.update(voucherCategories).set(patch).where(eq(voucherCategories.id, input.id));
        await logAudit(ctx, { action: "voucherCategory.update", entityType: "voucherCategory", entityId: input.id, newValue: patch });
        return { ok: true };
      } catch (e: any) {
        if (isDupEntry(e)) {
          throw new TRPCError({ code: "CONFLICT", message: "اسم الفئة مُكرَّر" });
        }
        throw e;
      }
    }),

  setActive: adminProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB غير مهيّأة" });
      // عند التَعطيل: نَتحقّق أنّ لا سند نَشِط مَربوط بها — إن وُجد، تَعطيل سَلِس (الفئة تَختفي من
      // المُنتقيات الجَديدة لكن السندات القديمة تَحتفظ بربطها للتاريخ التَدقيقي).
      await db.update(voucherCategories).set({ isActive: input.isActive }).where(eq(voucherCategories.id, input.id));
      await logAudit(ctx, {
        action: input.isActive ? "voucherCategory.activate" : "voucherCategory.deactivate",
        entityType: "voucherCategory",
        entityId: input.id,
      });
      return { ok: true };
    }),

  /** دَمج فئة في أخرى (للتنظيف): ينقل سندات A إلى B ثم يُعطّل A. */
  merge: adminProcedure
    .input(z.object({ fromId: z.number().int().positive(), toId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      if (input.fromId === input.toId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن دَمج فئة في نفسها" });
      }
      const db = getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB غير مهيّأة" });
      // MERGE-TX (تدقيق ٢/٧): الكتابتان (نقل السندات + تعطيل الفئة) مترابطتان — كانتا على db الخام
      // بلا معاملة ⇒ فشلٌ بينهما يترك سندات منقولة وفئةً ما تزال مفعَّلة. نلفّهما في withTx ذرّية.
      await withTx(async (tx) => {
        await tx.update(receipts).set({ voucherCategoryId: input.toId }).where(eq(receipts.voucherCategoryId, input.fromId));
        await tx.update(voucherCategories).set({ isActive: false }).where(eq(voucherCategories.id, input.fromId));
      });
      await logAudit(ctx, {
        action: "voucherCategory.merge",
        entityType: "voucherCategory",
        entityId: input.fromId,
        newValue: { mergedInto: input.toId },
      });
      return { ok: true };
    }),
});

// تَجنّب «var لم تُستعمل» — placeholder ne (مَستعمل في recentVouchersForParty عبر إعادة-تَصدير لاحقاً).
void ne;
