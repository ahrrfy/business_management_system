// راوتر سندات القبض/الصرف المستقلّة. managerProcedure (تأثير مالي مباشر على الذمم + الصندوق).
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  approveVoucher,
  cancelVoucher,
  createVoucher,
  getApprovalThreshold,
  getAttachmentThreshold,
  getVoucher,
  listVouchers,
  recentVouchersForParty,
  rejectVoucher,
} from "../services/voucherService";
import { adminProcedure, managerProcedure, router } from "../trpc";
import { isDupEntry } from "@shared/errorMap.ar";

const partyType = z.enum(["CUSTOMER", "SUPPLIER", "OTHER"]);
const method = z.enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET"]);
const voucherType = z.enum(["RECEIPT", "PAYMENT"]);
const approvalStatus = z.enum(["APPROVED", "PENDING_APPROVAL", "REJECTED"]);
const moneyStr = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح (YYYY-MM-DD)");

export const voucherRouter = router({
  /** عَتبات النظام (للتعرّض في الواجهة: تَلميحات «هذا المبلغ يَحتاج اعتماد/مرفق»). */
  thresholds: managerProcedure.query(() => ({
    approval: getApprovalThreshold(),
    attachment: getAttachmentThreshold(),
  })),

  create: managerProcedure
    .input(
      z.object({
        voucherType,
        branchId: z.number().int().positive(),
        amount: moneyStr,
        paymentMethod: method,
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
        attachmentUrl: z.string().max(1000).nullish(),
        internalNote: z.string().max(2000).nullish(),
        clientRequestId: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.branchId == null) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المستخدم — لا يمكن إصدار سند" });
      }
      const actorBranchId = Number(ctx.user.branchId);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await createVoucher(input, { userId: ctx.user.id, branchId: actorBranchId, role: ctx.user.role });
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
  approve: managerProcedure
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
      await logAudit(ctx, {
        action: "voucher.approve",
        entityType: "receipt",
        entityId: input.receiptId,
        newValue: { voucherNumber: res.voucherNumber, signatureHash: res.signatureHash },
      });
      return res;
    }),

  /** رفض سند مُعلَّق — يَبقى في السجل ولا أثَر مالي (لم يُسجَّل أصلاً). */
  reject: managerProcedure
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
  cancel: managerProcedure
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

  list: managerProcedure
    .input(
      z
        .object({
          branchId: z.number().int().positive().optional(),
          voucherType: voucherType.optional(),
          partyType: partyType.optional(),
          partyId: z.number().int().positive().optional(),
          status: z.enum(["COMPLETED", "REVERSED"]).optional(),
          approvalStatus: approvalStatus.optional(),
          voucherCategoryId: z.number().int().positive().optional(),
          paymentMethod: method.optional(),
          from: ymd.optional(),
          to: ymd.optional(),
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

  get: managerProcedure
    .input(z.object({ receiptId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const voucher = await getVoucher(input.receiptId);
      if (voucher && ctx.user.role !== "admin" && ctx.user.branchId != null && Number(voucher.branchId) !== Number(ctx.user.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "هذا السند لفرع آخر" });
      }
      return voucher;
    }),

  /** السندات الأخيرة لنفس الطرف خلال نافذة (افتراضي ٧ أيام، ٥ سندات) — للتحذير من الازدواج. */
  recentForParty: managerProcedure
    .input(z.object({
      partyType,
      partyId: z.number().int().positive().nullish(),
      counterpartyName: z.string().max(200).nullish(),
      branchId: z.number().int().positive().optional(),
      windowDays: z.number().int().positive().max(90).default(7),
      limit: z.number().int().positive().max(20).default(5),
    }))
    .query(async ({ input, ctx }) => recentVouchersForParty({
      partyType: input.partyType,
      partyId: input.partyId ?? null,
      counterpartyName: input.counterpartyName ?? null,
      branchId: input.branchId ?? (ctx.user.branchId != null ? Number(ctx.user.branchId) : null),
      windowDays: input.windowDays,
      limit: input.limit,
    })),
});

/* ============================ فئات السندات (admin CRUD) ============================ */
import { and, asc, eq, ne } from "drizzle-orm";
import { receipts, voucherCategories } from "../../drizzle/schema";
import { getDb } from "../db";

export const voucherCategoryRouter = router({
  list: managerProcedure
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
      // نَقل السندات
      await db.update(receipts).set({ voucherCategoryId: input.toId }).where(eq(receipts.voucherCategoryId, input.fromId));
      // تَعطيل المصدر (لا حَذف ⇒ نُحافظ على المرجع التاريخي)
      await db.update(voucherCategories).set({ isActive: false }).where(eq(voucherCategories.id, input.fromId));
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
