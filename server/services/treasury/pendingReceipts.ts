import { TRPCError } from "@trpc/server";
import { and, asc, eq, or, like } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import {
  accountingEntries,
  receipts,
  shifts,
  users,
} from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import {
  createPostingIntent,
  creditLine,
  debitLine,
} from "../accounting/postingEngine";
import { logAuditTx } from "../auditService";
import { postEntry } from "../ledgerService";
import { money } from "../money";
import { requireDb, withTx, type Actor } from "../tx";

export interface PendingTreasuryReceipt {
  id: number;
  branchId: number;
  amount: string;
  referenceNumber: string;
  description: string | null;
  createdAt: Date;
  source: "CASH_DROP" | "CASH_HANDOVER";
  /** مالك الدرج الذي خرج منه النقد، لا الموظف المعيّن لاستلامه. */
  sourceEmployeeName: string | null;
  sourceShiftId: number | null;
}

type AuditContext = Pick<TrpcContext, "user" | "req">;

function contractSource(
  referenceNumber: string,
): PendingTreasuryReceipt["source"] | null {
  if (referenceNumber.startsWith("CD-")) return "CASH_DROP";
  if (referenceNumber.startsWith("CH-")) return "CASH_HANDOVER";
  return null;
}

/**
 * عهد الاستلام المسندة للمستخدم الحالي فقط. لا تعرض أي سند PENDING عام:
 * المرجع CD/CH + نقد وارد للخزينة + createdBy هو عقد الحيازة.
 */
export async function listMyPendingTreasuryReceipts(
  actor: Actor,
): Promise<PendingTreasuryReceipt[]> {
  // السند الوارد المعلّق يحمل createdBy للمستلم. أمّا مصدر النقد الحقيقي فهو
  // السند الصادر المقابل (DRAWER) ثمّ صاحب الوردية المرتبطة به.
  const sourceReceipt = alias(receipts, "pendingTreasurySourceReceipt");
  const sourceEmployee = alias(users, "pendingTreasurySourceEmployee");
  const rows = await requireDb()
    .select({
      id: receipts.id,
      branchId: receipts.branchId,
      amount: receipts.amount,
      referenceNumber: receipts.referenceNumber,
      description: receipts.description,
      createdAt: receipts.createdAt,
      sourceShiftId: sourceReceipt.shiftId,
      sourceEmployeeName: sourceEmployee.name,
    })
    .from(receipts)
    .leftJoin(
      sourceReceipt,
      and(
        eq(sourceReceipt.referenceNumber, receipts.referenceNumber),
        eq(sourceReceipt.branchId, receipts.branchId),
        eq(sourceReceipt.direction, "OUT"),
        eq(sourceReceipt.paymentMethod, "CASH"),
        eq(sourceReceipt.cashBucket, "DRAWER"),
      ),
    )
    .leftJoin(shifts, eq(sourceReceipt.shiftId, shifts.id))
    .leftJoin(sourceEmployee, eq(shifts.userId, sourceEmployee.id))
    .where(
      and(
        eq(receipts.createdBy, actor.userId),
        eq(receipts.direction, "IN"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.cashBucket, "TREASURY"),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "APPROVED"),
        or(
          like(receipts.referenceNumber, "CD-%"),
          like(receipts.referenceNumber, "CH-%"),
        ),
      ),
    )
    .orderBy(asc(receipts.createdAt));

  return rows.flatMap((row) => {
    if (row.branchId == null || row.referenceNumber == null) return [];
    const source = contractSource(row.referenceNumber);
    if (!source) return [];
    return [
      {
        id: Number(row.id),
        branchId: Number(row.branchId),
        amount: String(row.amount),
        referenceNumber: row.referenceNumber,
        description: row.description,
        createdAt: row.createdAt,
        source,
        sourceEmployeeName: row.sourceEmployeeName,
        sourceShiftId:
          row.sourceShiftId == null ? null : Number(row.sourceShiftId),
      },
    ];
  });
}

export interface PendingTreasuryQueueRow extends PendingTreasuryReceipt {
  /** المستلم المُسنَد إليه العقد حالياً — عمود الرؤية الذي كان غائباً. */
  assignedToId: number;
  assignedToName: string | null;
  assignedToActive: boolean;
  /** عمر العهدة بالأيام — «قديمة» تعني نقداً خارج رصيد الخزينة منذ ذلك الحين. */
  ageDays: number;
}

/**
 * طابور العهد المعلّقة **كلّها** في نطاق المدير — لا المسندة إليه وحده.
 *
 * العلّة التي يسدّها (المسار أ، ورقة ١٦/٨): `listMyPendingTreasuryReceipts` تُظهر العهدة
 * للمستلم المُسنَد إليه فقط، فإن عُطّل أو غادر بقي النقد خارج رصيد الخزينة **بلا أن يراه أحد**
 * — لا شاشة ولا تقرير. ما لا يظهر لا يُكتشَف.
 */
export async function listPendingTreasuryQueue(actor: Actor): Promise<PendingTreasuryQueueRow[]> {
  const sourceReceipt = alias(receipts, "queueSourceReceipt");
  const sourceEmployee = alias(users, "queueSourceEmployee");
  const holder = alias(users, "queueHolder");
  const elevated = actor.role === "admin";
  const rows = await requireDb()
    .select({
      id: receipts.id,
      branchId: receipts.branchId,
      amount: receipts.amount,
      referenceNumber: receipts.referenceNumber,
      description: receipts.description,
      createdAt: receipts.createdAt,
      assignedToId: receipts.createdBy,
      assignedToName: holder.name,
      assignedToActive: holder.isActive,
      sourceShiftId: sourceReceipt.shiftId,
      sourceEmployeeName: sourceEmployee.name,
    })
    .from(receipts)
    .leftJoin(holder, eq(receipts.createdBy, holder.id))
    .leftJoin(
      sourceReceipt,
      and(
        eq(sourceReceipt.referenceNumber, receipts.referenceNumber),
        eq(sourceReceipt.branchId, receipts.branchId),
        eq(sourceReceipt.direction, "OUT"),
        eq(sourceReceipt.paymentMethod, "CASH"),
        eq(sourceReceipt.cashBucket, "DRAWER"),
      ),
    )
    .leftJoin(shifts, eq(sourceReceipt.shiftId, shifts.id))
    .leftJoin(sourceEmployee, eq(shifts.userId, sourceEmployee.id))
    .where(
      and(
        eq(receipts.direction, "IN"),
        eq(receipts.paymentMethod, "CASH"),
        eq(receipts.cashBucket, "TREASURY"),
        eq(receipts.status, "PENDING"),
        eq(receipts.approvalStatus, "APPROVED"),
        or(like(receipts.referenceNumber, "CD-%"), like(receipts.referenceNumber, "CH-%")),
        // عزل الفرع: admin يعبُر؛ غيره يرى فرعه وحده (نمط branchScopedProcedure).
        ...(elevated ? [] : [eq(receipts.branchId, actor.branchId)]),
      ),
    )
    .orderBy(asc(receipts.createdAt));

  const now = Date.now();
  return rows.flatMap((row) => {
    if (row.branchId == null || row.referenceNumber == null || row.assignedToId == null) return [];
    const source = contractSource(row.referenceNumber);
    if (!source) return [];
    const created = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime();
    return [{
      id: Number(row.id),
      branchId: Number(row.branchId),
      amount: String(row.amount),
      referenceNumber: row.referenceNumber,
      description: row.description,
      createdAt: row.createdAt,
      source,
      sourceEmployeeName: row.sourceEmployeeName,
      sourceShiftId: row.sourceShiftId == null ? null : Number(row.sourceShiftId),
      assignedToId: Number(row.assignedToId),
      assignedToName: row.assignedToName,
      assignedToActive: row.assignedToActive !== false,
      ageDays: Math.max(0, Math.floor((now - created) / 86_400_000)),
    }];
  });
}

/**
 * إعادة إسناد عهدةٍ معلّقة إلى مستلمٍ آخر — **مخرج النقد المحبوس**.
 *
 * لا تُحرّك ديناراً ولا تُنشئ قيداً: النقد غادر الدرج فعلاً وقت السحب، وهذه العملية
 * تُغيّر **من يملك قبوله** فقط. القبول يبقى فعلاً صريحاً من المستلم الجديد بهويته
 * (سلسلة الحيازة محفوظة)، والأثر التدقيقيّ يحمل الطرفين فلا تضيع المسؤولية.
 *
 * الشروط مرآةٌ لِـ`createCashDrop`: المستلم مديرٌ أو إداريّ، نشط، من فرع العهدة نفسه.
 */
export async function reassignPendingTreasuryReceipt(
  receiptId: number,
  toUserId: number,
  actor: Actor,
  auditCtx?: AuditContext,
) {
  // ⛔ لا فحص دورٍ خام هنا: التفويض عند الحدّ عبر `treasuryManagerProcedure` (بوّابة وحدة
  // treasury=FULL تحترم المنح الصريح). فحصٌ خامّ في الخدمة كان يُبطل ما تُعلنه البوّابة —
  // محاسبٌ قالبه treasury=FULL يعبُر الحدّ ثم يُصَدّ هنا: عيب «مُنِحت الصلاحية ولم تُطبَّق» نفسه.
  return withTx(async (tx) => {
    const row = (
      await tx.select().from(receipts).where(eq(receipts.id, receiptId)).for("update").limit(1)
    )[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "عهدة الاستلام غير موجودة" });

    const referenceNumber = row.referenceNumber ?? "";
    const source = contractSource(referenceNumber);
    const isTreasuryContract =
      source != null &&
      row.direction === "IN" &&
      row.paymentMethod === "CASH" &&
      row.cashBucket === "TREASURY" &&
      row.approvalStatus === "APPROVED";
    if (!isTreasuryContract) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "السند ليس عقد تسليم نقد معلقاً" });
    }
    if (row.status !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: "العهدة لم تعد معلّقة — لا تُعاد إسناداً" });
    }
    if (actor.role !== "admin" && (row.branchId == null || Number(row.branchId) !== actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "هذه العهدة لا تخص فرعك" });
    }
    const previousHolder = row.createdBy == null ? null : Number(row.createdBy);
    if (previousHolder === toUserId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "العهدة مسندة إليه أصلاً" });
    }

    const target = (await tx.select().from(users).where(eq(users.id, toUserId)).limit(1))[0];
    if (!target || !target.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المستلِم غير موجود أو معطّل" });
    }
    if (target.role !== "admin" && target.role !== "manager") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مستلِم النقد يجب أن يكون مديراً أو إدارياً" });
    }
    if (target.branchId == null || Number(target.branchId) !== Number(row.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مستلِم النقد يجب أن يكون من فرع العهدة نفسه" });
    }
    // فصل المُسلِّم عن المستلم — الثابت الذي يفرضه `createCashDrop` عند الإنشاء
    // («لا يجوز أن يكون مُسلِّم النقد هو المستلم نفسه»). بدون هذا الفحص كانت إعادة الإسناد
    // **باباً خلفياً يطويه**: يكفي أن يكون مُسلِّم السحب مديراً فيُسنِد العهدة لنفسه ثمّ يقبلها
    // بيده ⇒ سلسلة حيازة بشخصٍ واحد. المُسلِّم = مُنشئ سند الدرج المقابل (OUT).
    const sourceOut = (
      await tx
        .select({ createdBy: receipts.createdBy })
        .from(receipts)
        .where(
          and(
            eq(receipts.referenceNumber, referenceNumber),
            eq(receipts.branchId, Number(row.branchId)),
            eq(receipts.direction, "OUT"),
            eq(receipts.cashBucket, "DRAWER"),
          ),
        )
        .limit(1)
    )[0];
    if (sourceOut?.createdBy != null && Number(sourceOut.createdBy) === toUserId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يجوز إسناد العهدة إلى مُسلِّم النقد نفسه — الاستلام يلزمه شخصٌ ثانٍ",
      });
    }

    await tx
      .update(receipts)
      .set({ createdBy: toUserId })
      .where(and(eq(receipts.id, receiptId), eq(receipts.status, "PENDING")));

    if (auditCtx) {
      await logAuditTx(tx, auditCtx, {
        action: "treasury.handover.reassign",
        entityType: "receipt",
        entityId: receiptId,
        oldValue: { assignedToId: previousHolder, referenceNumber },
        newValue: {
          assignedToId: toUserId,
          referenceNumber,
          amount: String(row.amount),
          branchId: row.branchId == null ? null : Number(row.branchId),
          source,
        },
      });
    }

    return {
      receiptId: Number(row.id),
      referenceNumber,
      amount: String(row.amount),
      previousHolderId: previousHolder,
      assignedToId: toUserId,
    };
  });
}

/**
 * قبول ثنائي للحيازة. يقفل الصف لمنع قبولين متزامنين، ويقبل فقط المستلم
 * المسند إليه العقد ومن فرعه. إعادة الطلب بعد النجاح آمنة ولا تضاعف الرصيد.
 */
export async function acceptPendingTreasuryReceipt(
  receiptId: number,
  actor: Actor,
  auditCtx?: AuditContext,
) {
  return withTx(async (tx) => {
    const row = (
      await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, receiptId))
        .for("update")
        .limit(1)
    )[0];
    if (!row) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "عهدة الاستلام غير موجودة",
      });
    }

    const referenceNumber = row.referenceNumber ?? "";
    const source = contractSource(referenceNumber);
    const isTreasuryContract =
      source != null &&
      row.direction === "IN" &&
      row.paymentMethod === "CASH" &&
      row.cashBucket === "TREASURY" &&
      row.approvalStatus === "APPROVED";
    if (!isTreasuryContract) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "السند ليس عقد تسليم نقد معلقاً",
      });
    }
    if (row.createdBy == null || Number(row.createdBy) !== actor.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "هذه العهدة مسندة إلى مستلم آخر",
      });
    }
    if (row.branchId == null || Number(row.branchId) !== actor.branchId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "هذه العهدة لا تخص فرعك",
      });
    }

    if (row.status === "COMPLETED") {
      return {
        receiptId: Number(row.id),
        referenceNumber,
        amount: String(row.amount),
        branchId: Number(row.branchId),
        idempotent: true,
      };
    }
    if (row.status !== "PENDING") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "عهدة الاستلام ليست قابلة للقبول",
      });
    }

    // CD يخرج من الدرج إلى CASH_IN_TRANSIT عند التسليم. لا نُثبت الخزينة إلا إذا وجدنا
    // سند الخروج المكتمل وقيد المرحلة الأولى نفسه؛ بادئة المرجع وحدها لا تصنع أصلاً نقدياً.
    let stagedCashDrop = false;
    if (source === "CASH_DROP") {
      const sourceRows = await tx
        .select({ id: receipts.id, amount: receipts.amount })
        .from(receipts)
        .where(
          and(
            eq(receipts.branchId, Number(row.branchId)),
            eq(receipts.referenceNumber, referenceNumber),
            eq(receipts.direction, "OUT"),
            eq(receipts.paymentMethod, "CASH"),
            eq(receipts.cashBucket, "DRAWER"),
            eq(receipts.status, "COMPLETED"),
            eq(receipts.approvalStatus, "APPROVED"),
          ),
        )
        .for("update");
      const matchingSources = sourceRows.filter((candidate) =>
        money(candidate.amount).eq(money(row.amount)),
      );
      if (matchingSources.length !== 1) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "عقد سحب النقد لا يملك سند خروج مطابقاً وفريداً",
        });
      }

      const sourceEntries = await tx
        .select({
          entryType: accountingEntries.entryType,
          amount: accountingEntries.amount,
        })
        .from(accountingEntries)
        .where(eq(accountingEntries.receiptId, Number(matchingSources[0].id)));
      stagedCashDrop = sourceEntries.some(
        (entry) =>
          entry.entryType === "CASH_TRANSFER_OUT" &&
          money(entry.amount).eq(money(row.amount)),
      );
      const legacyRecognized = sourceEntries.some(
        (entry) =>
          entry.entryType === "CASH_HANDOVER" &&
          money(entry.amount).eq(money(row.amount)),
      );
      if (stagedCashDrop === legacyRecognized) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "دليل قيد سحب النقد مفقود أو متعارض",
        });
      }
    }

    await tx
      .update(receipts)
      .set({
        status: "COMPLETED",
        approvedBy: actor.userId,
        approvedAt: new Date(),
      })
      .where(and(eq(receipts.id, receiptId), eq(receipts.status, "PENDING")));

    if (source === "CASH_DROP" && stagedCashDrop) {
      const amount = money(row.amount);
      await postEntry(tx, {
        entryType: "CASH_TRANSFER_IN",
        postingIntent: createPostingIntent(
          "CASH_TRANSFER_IN_FROM_TRANSIT",
          "CASH_TRANSFER_IN",
          [
            debitLine("TREASURY_CASH", amount),
            creditLine("CASH_IN_TRANSIT", amount),
          ],
        ),
        branchId: Number(row.branchId),
        receiptId: Number(row.id),
        amount,
        dedupeKey: `CASH_DROP_ACCEPT:${row.id}`,
        createdBy: actor.userId,
        notes: `قبول استلام السحب النقدي ${referenceNumber}`,
      });
    }

    if (auditCtx) {
      await logAuditTx(tx, auditCtx, {
        action: "treasury.handover.accept",
        entityType: "receipt",
        entityId: receiptId,
        oldValue: { status: "PENDING", referenceNumber },
        newValue: {
          status: "COMPLETED",
          referenceNumber,
          amount: String(row.amount),
          branchId: Number(row.branchId),
          source,
        },
      });
    }

    return {
      receiptId: Number(row.id),
      referenceNumber,
      amount: String(row.amount),
      branchId: Number(row.branchId),
      idempotent: false,
    };
  });
}
