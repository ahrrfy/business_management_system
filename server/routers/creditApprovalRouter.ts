/**
 * راوتر موافقات الائتمان — managerProcedure (المدير يُصدر؛ الكاشير لا يُصدر لنفسه).
 *
 * create(customerId, maxAmount, ttlMinutes) ⇒ يعيد approvalId يستعمله الكاشير في sale.create.
 * listForCustomer(customerId) ⇒ يعرض الموافقات النشِطة لعميل واحد (يستهلكه نموذج الإنشاء).
 * list(...) ⇒ سجلّ عامّ لكل الموافقات (كل الحالات/العملاء) — لشاشة السجل.
 * cancel(id) ⇒ يُلغي موافقة قائمة لم تُستهلَك بعد.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { managerProcedure, router } from "../trpc";
import { withTx } from "../services/tx";
import { getDb } from "../db";
import { creditApprovals, customers, users } from "../../drizzle/schema";
import { createApproval, getActiveApprovalsForCustomer } from "../services/creditApprovalService";
import { logAudit } from "../services/auditService";

const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");
// حالة مُشتقّة من الأعمدة القائمة (creditApprovalService.ts خارج نطاق هذه الشريحة — لا عمود حالة
// صريح في المخطّط): ACTIVE = غير مُستهلَكة + لم تنتهِ؛ EXPIRED = غير مُستهلَكة + انتهت؛
// CONSUMED = استُهلِكت بفاتورة فعلية (consumedByInvoiceId)؛ CANCELLED = أُلغيت يدوياً (consumedAt
// بلا consumedByInvoiceId — نفس أثر «مُستهلَكة» أمنياً: single-use تحترمه validateApproval).
const approvalStatusFilter = z.enum(["ACTIVE", "EXPIRED", "CONSUMED", "CANCELLED"]).optional();

export const creditApprovalRouter = router({
  create: managerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        maxAmount: moneyStr,
        ttlMinutes: z.number().int().min(1).max(1440).optional(), // ≤ 24h
        notes: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const r = await withTx(async (tx) =>
        createApproval(tx, {
          customerId: input.customerId,
          maxAmount: input.maxAmount,
          approvedBy: ctx.user.id,
          ttlMinutes: input.ttlMinutes,
          notes: input.notes ?? null,
        }),
      );
      await logAudit(ctx, {
        action: "creditApproval.create",
        entityType: "creditApproval",
        entityId: r.id,
        newValue: { customerId: input.customerId, maxAmount: input.maxAmount, expiresAt: r.expiresAt.toISOString() },
      });
      return r;
    }),

  listForCustomer: managerProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const rows = await withTx(async (tx) => getActiveApprovalsForCustomer(tx, input.customerId));
      return { rows };
    }),

  /** سجلّ عامّ لكل الموافقات (كل العملاء/الحالات) — لشاشة السجل، لا طابور «النشِطة لعميل واحد» فقط. */
  list: managerProcedure
    .input(
      z
        .object({
          customerId: z.number().int().positive().optional(),
          status: approvalStatusFilter,
          limit: z.number().int().positive().max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      if (!db) return { rows: [], total: 0 };
      const now = new Date();
      const conds = [];
      if (input?.customerId) conds.push(eq(creditApprovals.customerId, input.customerId));
      if (input?.status === "ACTIVE") conds.push(isNull(creditApprovals.consumedAt), gt(creditApprovals.expiresAt, now));
      else if (input?.status === "EXPIRED") conds.push(isNull(creditApprovals.consumedAt), sql`${creditApprovals.expiresAt} <= ${now}`);
      else if (input?.status === "CONSUMED") conds.push(isNotNull(creditApprovals.consumedByInvoiceId));
      else if (input?.status === "CANCELLED")
        conds.push(isNotNull(creditApprovals.consumedAt), isNull(creditApprovals.consumedByInvoiceId));
      const where = conds.length ? and(...conds) : undefined;
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const rows = await db
        .select({
          id: creditApprovals.id,
          customerId: creditApprovals.customerId,
          customerName: customers.name,
          customerPhone: sql<string | null>`COALESCE(${customers.whatsapp}, ${customers.phone}, ${customers.phone2}, ${customers.phone3})`,
          maxAmount: creditApprovals.maxAmount,
          approvedBy: creditApprovals.approvedBy,
          approvedByName: users.name,
          approvedAt: creditApprovals.approvedAt,
          expiresAt: creditApprovals.expiresAt,
          consumedAt: creditApprovals.consumedAt,
          consumedByInvoiceId: creditApprovals.consumedByInvoiceId,
          notes: creditApprovals.notes,
        })
        .from(creditApprovals)
        .innerJoin(customers, eq(customers.id, creditApprovals.customerId))
        .leftJoin(users, eq(users.id, creditApprovals.approvedBy))
        .where(where as any)
        .orderBy(desc(creditApprovals.id))
        .limit(limit)
        .offset(offset);

      const totalRow = (
        await db.select({ n: sql<number>`COUNT(*)` }).from(creditApprovals).where(where as any)
      )[0];
      return { rows, total: Number(totalRow?.n ?? 0) };
    }),

  /** إلغاء موافقة قائمة لم تُستهلَك بعد — تُوسَم بنفس آلية الاستهلاك (consumedAt) بلا
   *  consumedByInvoiceId، فتُصبح غير قابلة للاستعمال (single-use يحترمه validateApproval) دون
   *  الإيحاء بأنها اقترنت بفاتورة فعلية. */
  cancel: managerProcedure
    .input(z.object({ id: z.number().int().positive(), reason: z.string().max(255).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const res = await withTx(async (tx) => {
        const [row] = await tx
          .select()
          .from(creditApprovals)
          .where(eq(creditApprovals.id, input.id))
          .for("update")
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "الموافقة غير موجودة" });
        if (row.consumedAt) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: row.consumedByInvoiceId
              ? "الموافقة مُستهلَكة بفاتورة فعلية بالفعل — لا يمكن إلغاؤها"
              : "الموافقة مُلغاة بالفعل",
          });
        }
        const reason = input.reason?.trim();
        const notes = reason ? `${row.notes ? `${row.notes}\n` : ""}أُلغيت: ${reason}` : row.notes;
        await tx.update(creditApprovals).set({ consumedAt: new Date(), notes }).where(eq(creditApprovals.id, input.id));
        return { id: input.id };
      });
      await logAudit(ctx, {
        action: "creditApproval.cancel",
        entityType: "creditApproval",
        entityId: input.id,
        newValue: { reason: input.reason ?? null },
      });
      return res;
    }),
});
