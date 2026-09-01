// خدمة إرجاع نقد الوردية إلى الخزينة عند الإغلاق.
// الإغلاق ينقل كامل النقد DRAWER -> TREASURY فوراً داخل المعاملة نفسها، بلا مستلم مسمّى
// وبلا قبول لاحق. cash drop أثناء الوردية يبقى مساراً مستقلاً ومحكوماً.

import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, inArray, like, sql } from "drizzle-orm";
import { accountingEntries, receipts } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "./accounting/postingEngine";
import { assertCashTransferAvailable, assertTreasuryOutException } from "./cash/cashAvailability";
import { postEntry } from "./ledgerService";
import { money, toDateStr, toDbMoney } from "./money";
import { requireDb, withTx, type Actor } from "./tx";

export interface HandoverResult {
  handoverNumber: string;
  outReceiptId: number;
  inReceiptId: number;
}

async function nextHandoverNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `CH-${branchId}-${ymd}-`;
  const lockName = `cash_handover:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`handover numbering lock timeout for ${lockName}`);
  }
  try {
    const rows = await tx
      .select({ n: receipts.referenceNumber })
      .from(receipts)
      .where(like(receipts.referenceNumber, `${prefix}%`));
    let maxSeq = 0;
    for (const row of rows) {
      const suffix = String(row.n ?? "").slice(prefix.length);
      if (!/^\d+$/.test(suffix)) continue;
      maxSeq = Math.max(maxSeq, Number.parseInt(suffix, 10));
    }
    return prefix + String(maxSeq + 1).padStart(4, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/** إرجاع كامل نقد الدرج إلى الخزينة فور إغلاق الوردية. */
export async function settleShiftReturnTx(
  tx: Tx,
  input: { shiftId: number; branchId: number; amount: string; notes?: string | null },
  actor: Actor,
): Promise<HandoverResult> {
  const amount = money(input.amount);
  if (amount.isZero() || amount.isNegative()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يوجد نقد لإرجاعه للخزينة" });
  }

  const branchId = input.branchId;
  assertTreasuryOutException("CASH_HANDOVER_INTERNAL");
  await assertCashTransferAvailable(tx, {
    source: { branchId, cashBucket: "DRAWER", shiftId: input.shiftId },
    destination: { branchId, cashBucket: "TREASURY" },
    amount,
    operation: "إرجاع كامل نقد الوردية إلى الخزينة",
  });
  const handoverNumber = await nextHandoverNumber(tx, branchId);

  const outRes = await tx.insert(receipts).values({
    branchId,
    shiftId: input.shiftId,
    direction: "OUT",
    amount: toDbMoney(amount),
    paymentMethod: "CASH",
    cashBucket: "DRAWER",
    referenceNumber: handoverNumber,
    status: "COMPLETED",
    partyType: "OTHER",
    description: `إرجاع كامل نقد وردية #${input.shiftId} إلى الخزينة تلقائياً${input.notes ? " — " + input.notes : ""}`,
    createdBy: actor.userId,
  });
  const outReceiptId = extractInsertId(outRes);

  const inRes = await tx.insert(receipts).values({
    branchId,
    shiftId: null,
    direction: "IN",
    amount: toDbMoney(amount),
    paymentMethod: "CASH",
    cashBucket: "TREASURY",
    referenceNumber: handoverNumber,
    status: "COMPLETED",
    partyType: "OTHER",
    description: `ترحيل تلقائي لنقد وردية #${input.shiftId} إلى الخزينة`,
    createdBy: actor.userId,
  });
  const inReceiptId = extractInsertId(inRes);

  await postEntry(tx, {
    entryType: "CASH_HANDOVER",
    postingIntent: createPostingIntent("CASH_HANDOVER_TO_TREASURY", "CASH_HANDOVER", [
      debitLine("TREASURY_CASH", amount),
      creditLine("CASH", amount),
    ]),
    branchId,
    receiptId: outReceiptId,
    amount,
    dedupeKey: `CASH_HANDOVER:${handoverNumber}`,
    notes: input.notes ?? undefined,
  });

  return { handoverNumber, outReceiptId, inReceiptId };
}

/**
 * تسوية عقود إغلاق الوردية القديمة التي بقيت معلّقة قبل تبسيط المسار.
 * كل إيصال يُقفل في معاملة مستقلة، ويُقبل فقط إن وُجد زوج DRAWER مكتمل وقيد transit صحيح.
 */
export async function settlePendingShiftCloseHandovers(): Promise<{
  updated: number;
  skipped: number;
}> {
  const db = requireDb();
  let cursor = 0;
  let updated = 0;
  let skipped = 0;

  for (;;) {
    const candidates = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          gt(receipts.id, cursor),
          eq(receipts.direction, "IN"),
          eq(receipts.paymentMethod, "CASH"),
          eq(receipts.cashBucket, "TREASURY"),
          eq(receipts.status, "PENDING"),
          eq(receipts.approvalStatus, "APPROVED"),
          like(receipts.referenceNumber, "CH-%"),
        ),
      )
      .orderBy(asc(receipts.id))
      .limit(250);
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      cursor = Number(candidate.id);
      const result = await withTx(async (tx) => {
        const [pending] = await tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, cursor))
          .for("update")
          .limit(1);
        if (
          !pending ||
          pending.status !== "PENDING" ||
          pending.direction !== "IN" ||
          pending.paymentMethod !== "CASH" ||
          pending.cashBucket !== "TREASURY" ||
          !pending.referenceNumber?.startsWith("CH-")
        ) {
          return false;
        }

        const sourceReceipts = await tx
          .select({ id: receipts.id, amount: receipts.amount, shiftId: receipts.shiftId })
          .from(receipts)
          .where(
            and(
              eq(receipts.branchId, Number(pending.branchId)),
              eq(receipts.referenceNumber, pending.referenceNumber),
              eq(receipts.direction, "OUT"),
              eq(receipts.paymentMethod, "CASH"),
              eq(receipts.cashBucket, "DRAWER"),
              eq(receipts.status, "COMPLETED"),
            ),
          )
          .limit(2);
        const source = sourceReceipts[0];
        if (
          sourceReceipts.length !== 1 ||
          !source ||
          source.shiftId == null ||
          !money(source.amount).eq(money(pending.amount))
        ) {
          return false;
        }

        const sourceEntries = await tx
          .select({ entryType: accountingEntries.entryType })
          .from(accountingEntries)
          .where(
            and(
              eq(accountingEntries.receiptId, Number(source.id)),
              inArray(accountingEntries.entryType, ["CASH_TRANSFER_OUT", "CASH_HANDOVER"]),
            ),
          );
        if (
          sourceEntries.filter((entry) => entry.entryType === "CASH_TRANSFER_OUT").length !== 1 ||
          sourceEntries.some((entry) => entry.entryType === "CASH_HANDOVER")
        ) {
          return false;
        }

        const amount = money(pending.amount);
        await tx
          .update(receipts)
          .set({
            status: "COMPLETED",
            approvedAt: new Date(),
            description: `ترحيل تلقائي لعهدة إغلاق وردية #${source.shiftId} إلى الخزينة بعد إلغاء خطوة الاستلام`,
          })
          .where(and(eq(receipts.id, Number(pending.id)), eq(receipts.status, "PENDING")));

        await postEntry(tx, {
          entryType: "CASH_TRANSFER_IN",
          postingIntent: createPostingIntent(
            "CASH_TRANSFER_IN_FROM_TRANSIT",
            "CASH_TRANSFER_IN",
            [debitLine("TREASURY_CASH", amount), creditLine("CASH_IN_TRANSIT", amount)],
          ),
          branchId: Number(pending.branchId),
          receiptId: Number(pending.id),
          amount,
          dedupeKey: `CASH_CUSTODY_ACCEPT:${pending.id}`,
          notes: `تسوية تلقائية لعهدة الإغلاق ${pending.referenceNumber}`,
        });
        return true;
      });
      if (result) updated += 1;
      else skipped += 1;
    }
  }

  return { updated, skipped };
}
