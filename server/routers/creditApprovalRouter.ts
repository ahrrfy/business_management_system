/**
 * راوتر موافقات الائتمان — managerProcedure (المدير يُصدر؛ الكاشير لا يُصدر لنفسه).
 *
 * create(customerId, maxAmount, ttlMinutes) ⇒ يعيد approvalId يستعمله الكاشير في sale.create.
 * listForCustomer(customerId) ⇒ يعرض الموافقات النشِطة لعميل واحد (يستهلكه نموذج الإنشاء).
 * list(...) ⇒ سجلّ عامّ لكل الموافقات (كل الحالات/العملاء) — لشاشة السجل.
 * cancel(id) ⇒ يُلغي موافقة قائمة لم تُستهلَك بعد.
 */
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNotNull, isNull, like, sql } from "drizzle-orm";
import { z } from "zod";
import { managerProcedure, requireModule, router } from "../trpc";
import { withTx } from "../services/tx";
import { getDb } from "../db";
import { branches, creditApprovals, customers, invoices, users } from "../../drizzle/schema";
import { createApproval, getActiveApprovalsForCustomer } from "../services/creditApprovalService";
import { logAudit } from "../services/auditService";
import { withIdempotency } from "../services/idempotency";
import { retryOnDup } from "../lib/retryDup";
import { getCurrentCompanyId } from "../tenancy/context";
import { money } from "../services/money";
import { escLike } from "../lib/sqlLike";

const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (موجب، منزلتان عشريتان كحدّ أقصى)");
const creditManagerProcedure = managerProcedure.use(requireModule("collections", "FULL"));
// حالة مُشتقّة من الأعمدة القائمة (creditApprovalService.ts خارج نطاق هذه الشريحة — لا عمود حالة
// صريح في المخطّط): ACTIVE = غير مُستهلَكة + لم تنتهِ؛ EXPIRED = غير مُستهلَكة + انتهت؛
// CONSUMED = استُهلِكت بفاتورة فعلية (consumedByInvoiceId)؛ CANCELLED = أُلغيت يدوياً (consumedAt
// بلا consumedByInvoiceId — نفس أثر «مُستهلَكة» أمنياً: single-use تحترمه validateApproval).
const approvalStatusFilter = z.enum(["ACTIVE", "EXPIRED", "CONSUMED", "CANCELLED"]).optional();

type ApprovalActor = { id: number; role: string; branchId: number | null };

/** نطاق الفرع مصدره الجلسة للمدير؛ الأدمن يختاره صراحة عند الكتابة. */
export function resolveCreditApprovalBranch(
  actor: ApprovalActor,
  requestedBranchId: number | undefined,
  required: boolean,
): number | undefined {
  if (actor.role === "admin") {
    if (required && requestedBranchId == null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "اختر الفرع الذي سيُستخدم فيه قرار الائتمان" });
    }
    return requestedBranchId;
  }
  if (actor.branchId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا فرع مُسنَد لهذا المدير" });
  }
  if (requestedBranchId != null && Number(requestedBranchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكن إدارة قرار ائتمان لفرع آخر" });
  }
  return Number(actor.branchId);
}

/** idempotency معزول بالشركة + المستخدم + الفرع، مع إبقاء العمود ضمن سقف 64 محرفاً. */
export function scopedCreditApprovalRequestId(args: {
  companyId: number | null;
  userId: number;
  branchId: number;
  clientRequestId: string;
}): string {
  return createHash("sha256")
    .update(`${args.companyId ?? 0}:${args.userId}:${args.branchId}:${args.clientRequestId}`)
    .digest("hex");
}

export const creditApprovalRouter = router({
  create: creditManagerProcedure
    .input(
      z.object({
        customerId: z.number().int().positive(),
        branchId: z.number().int().positive().optional(),
        maxAmount: moneyStr,
        ttlMinutes: z.number().int().min(1).max(1440).optional(), // ≤ 24h
        notes: z.string().max(255).optional(),
        clientRequestId: z.string().uuid(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const branchId = resolveCreditApprovalBranch(ctx.user, input.branchId, true)!;
      const normalized = {
        customerId: input.customerId,
        branchId,
        maxAmount: money(input.maxAmount).toFixed(2),
        ttlMinutes: input.ttlMinutes ?? 60,
        notes: input.notes?.trim() || null,
      };
      const scopedRequestId = scopedCreditApprovalRequestId({
        companyId: getCurrentCompanyId(),
        userId: ctx.user.id,
        branchId,
        clientRequestId: input.clientRequestId,
      });
      const result = await retryOnDup(() =>
        withTx(async (tx) => {
          const idem = await withIdempotency(
            tx,
            { operation: "creditApproval.create", clientRequestId: scopedRequestId, payload: normalized },
            async () => {
              const created = await createApproval(tx, {
                ...normalized,
                approvedBy: ctx.user.id,
              });
              return { refId: created.id, result: created };
            },
          );
          const [row] = await tx
            .select({
              id: creditApprovals.id,
              customerId: creditApprovals.customerId,
              customerName: customers.name,
              customerPhone: sql<string | null>`COALESCE(${customers.whatsapp}, ${customers.phone}, ${customers.phone2}, ${customers.phone3})`,
              branchId: creditApprovals.branchId,
              branchName: branches.name,
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
            .innerJoin(branches, eq(branches.id, creditApprovals.branchId))
            .leftJoin(users, eq(users.id, creditApprovals.approvedBy))
            .where(and(
              eq(creditApprovals.id, idem.refId),
              eq(creditApprovals.approvedBy, ctx.user.id),
              eq(creditApprovals.branchId, branchId),
            ))
            .limit(1);
          if (!row) throw new TRPCError({ code: "CONFLICT", message: "تعذر مطابقة نتيجة طلب إنشاء قرار الائتمان" });
          return { ...row, idempotentReplay: idem.replay };
        }),
      );
      if (!result.idempotentReplay) {
        await logAudit(ctx, {
          action: "creditApproval.create",
          entityType: "creditApproval",
          entityId: result.id,
          newValue: {
            customerId: result.customerId,
            branchId: result.branchId,
            maxAmount: result.maxAmount,
            expiresAt: result.expiresAt.toISOString(),
          },
        });
      }
      return result;
    }),

  /** عملاء مؤهلون للقرار في الفرع: جدد بلا تاريخ مالي، أو لهم فاتورة واحدة على الأقل في الفرع نفسه. */
  customerOptions: creditManagerProcedure
    .input(z.object({
      branchId: z.number().int().positive().optional(),
      q: z.string().trim().max(120).optional(),
      limit: z.number().int().positive().max(50).default(20),
    }))
    .query(async ({ input, ctx }) => {
      const branchId = resolveCreditApprovalBranch(ctx.user, input.branchId, true)!;
      const db = getDb();
      if (!db) return { branchId, rows: [] };
      const conditions = [eq(customers.isActive, true)];
      if (input.q) {
        const q = `%${escLike(input.q)}%`;
        conditions.push(sql`(${customers.name} LIKE ${q} ESCAPE '!' OR COALESCE(${customers.phone}, '') LIKE ${q} ESCAPE '!' OR COALESCE(${customers.whatsapp}, '') LIKE ${q} ESCAPE '!')` as any);
      }
      // لا توجد ملكية فرع مباشرة على customers؛ نعدّ العميل جديداً إن لم يملك أي فاتورة،
      // وإلا لا يظهر لمدير الفرع إلا إن كانت له معاملة في الفرع المطلوب.
      conditions.push(sql`(
        NOT EXISTS (SELECT 1 FROM ${invoices} ia WHERE ia.customerId = ${customers.id})
        OR EXISTS (SELECT 1 FROM ${invoices} ib WHERE ib.customerId = ${customers.id} AND ib.branchId = ${branchId})
      )` as any);
      const rows = await db
        .select({
          id: customers.id,
          name: customers.name,
          phone: sql<string | null>`COALESCE(${customers.whatsapp}, ${customers.phone}, ${customers.phone2}, ${customers.phone3})`,
          currentBalance: customers.currentBalance,
        })
        .from(customers)
        .where(and(...conditions as any))
        .orderBy(asc(customers.name), asc(customers.id))
        .limit(input.limit);
      return { branchId, rows };
    }),

  listForCustomer: creditManagerProcedure
    .input(z.object({ customerId: z.number().int().positive(), branchId: z.number().int().positive().optional() }))
    .query(async ({ input, ctx }) => {
      const branchId = resolveCreditApprovalBranch(ctx.user, input.branchId, true)!;
      const rows = await withTx(async (tx) => getActiveApprovalsForCustomer(tx, input.customerId, branchId));
      return { rows };
    }),

  /** سجلّ عامّ لكل الموافقات (كل العملاء/الحالات) — لشاشة السجل، لا طابور «النشِطة لعميل واحد» فقط. */
  list: creditManagerProcedure
    .input(
      z
        .object({
          customerId: z.number().int().positive().optional(),
          branchId: z.number().int().positive().optional(),
          status: approvalStatusFilter,
          limit: z.number().int().positive().max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();
      if (!db) return { rows: [], total: 0 };
      const branchId = resolveCreditApprovalBranch(ctx.user, input?.branchId, false);
      const now = new Date();
      const conds = [];
      if (branchId != null) conds.push(eq(creditApprovals.branchId, branchId));
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
          branchId: creditApprovals.branchId,
          branchName: branches.name,
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
        .leftJoin(branches, eq(branches.id, creditApprovals.branchId))
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
  cancel: creditManagerProcedure
    .input(z.object({ id: z.number().int().positive(), reason: z.string().max(255).nullish() }))
    .mutation(async ({ input, ctx }) => {
      const branchId = resolveCreditApprovalBranch(ctx.user, undefined, false);
      const res = await withTx(async (tx) => {
        const [row] = await tx
          .select()
          .from(creditApprovals)
          .where(and(
            eq(creditApprovals.id, input.id),
            ...(branchId == null ? [] : [eq(creditApprovals.branchId, branchId)]),
          ))
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
