import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { branches, receipts, shifts } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, toDbMoney, type DecimalInput } from "../money";

export type CashBucket = "DRAWER" | "TREASURY";

export interface CashOutAvailabilityInput {
  branchId: number;
  cashBucket: CashBucket;
  shiftId?: number | null;
  amount: DecimalInput;
  operation: string;
}

export interface CashOutAvailabilityResult {
  cashBucket: CashBucket;
  shiftId: number | null;
  availableBefore: string;
  availableAfter: string;
}

async function computeLockedCashReceiptsBalance(
  tx: Tx,
  predicate: ReturnType<typeof and>,
): Promise<Decimal> {
  // A locking read is intentional here. Under MySQL REPEATABLE READ, a plain
  // aggregate could reuse a snapshot established before waiting on the source
  // row and let two queued spenders observe the same balance. Reading the
  // receipt rows FOR UPDATE is a current read and the Decimal reduction keeps
  // the monetary calculation exact.
  const rows = await tx
    .select({ direction: receipts.direction, amount: receipts.amount })
    .from(receipts)
    // REVERSED يبقى حدثاً نقدياً تاريخياً وترافقه حركة تعويضية معاكسة، لذلك يدخل
    // الطرفان. أمّا PENDING/FAILED فلم يتحولا إلى نقد فعلي ولا يجوز أن يموّلا OUT.
    .where(
      and(
        predicate,
        inArray(receipts.status, ["COMPLETED", "REVERSED"]),
      ),
    )
    .for("update");

  return rows.reduce(
    (balance, row) =>
      row.direction === "IN"
        ? balance.plus(money(row.amount))
        : balance.minus(money(row.amount)),
    money(0),
  );
}

/** الصيغة الوحيدة لرصيد درج الوردية؛ يستعملها الحارس وإقفال الوردية معاً. */
export async function computeDrawerCashBalance(
  tx: Tx,
  shiftId: number,
  openingBalance: DecimalInput,
): Promise<Decimal> {
  const receiptBalance = await computeLockedCashReceiptsBalance(
    tx,
    and(
      eq(receipts.shiftId, shiftId),
      eq(receipts.cashBucket, "DRAWER"),
      eq(receipts.paymentMethod, "CASH"),
    ),
  );
  return money(openingBalance).plus(receiptBalance);
}

function insufficientCash(
  input: CashOutAvailabilityInput,
  available: Decimal,
  requested: Decimal,
): never {
  const source = input.cashBucket === "DRAWER" ? "الدرج" : "الخزينة";
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      `${input.operation} مرفوض: رصيد ${source} المتاح ` +
      `${available.toFixed(2)} د.ع أقل من المطلوب ${requested.toFixed(2)} د.ع. ` +
      "لا يجوز تسجيل صرف نقدي غير ممول.",
    cause: {
      cashAvailability: {
        cashBucket: input.cashBucket,
        shiftId: input.shiftId ?? null,
        branchId: input.branchId,
        available: available.toFixed(2),
        requested: requested.toFixed(2),
      },
    } as never,
  });
}

/**
 * الحارس المركزي لكل CASH OUT.
 *
 * يجب استدعاؤه داخل نفس withTx التي ستكتب إيصال OUT، وبعد تحديد المصدر النهائي مباشرةً:
 * - DRAWER: يقفل صف الوردية ثم يعيد بناء الرصيد من الافتتاح وكل إيصالات الدرج.
 * - TREASURY: يقفل صف الفرع (القفل التسلسلي المستقر نفسه المستعمل في التحويلات النقدية)
 *   ثم يعيد بناء رصيد الخزينة من إيصالاتها.
 *
 * لا يخصم الحارس ولا يحجز مبلغاً؛ الكتابة اللاحقة داخل المعاملة نفسها هي الخصم. قفل المصدر
 * يبقى حتى COMMIT/ROLLBACK، ولذلك لا يستطيع اعتمادان يمران بالحارس نفسه إنفاق الرصيد ذاته.
 */
export async function assertCashOutAvailable(
  tx: Tx,
  input: CashOutAvailabilityInput,
): Promise<CashOutAvailabilityResult> {
  const requested = money(input.amount);
  if (!requested.isFinite() || requested.lte(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مبلغ الصرف النقدي يجب أن يكون موجباً وصالحاً",
    });
  }

  let available: Decimal;
  let lockedShiftId: number | null = null;

  if (input.cashBucket === "DRAWER") {
    if (input.shiftId == null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "الصرف من DRAWER يتطلب وردية مفتوحة محددة",
      });
    }

    const shift = (
      await tx
        .select({
          id: shifts.id,
          branchId: shifts.branchId,
          status: shifts.status,
          openingBalance: shifts.openingBalance,
        })
        .from(shifts)
        .where(eq(shifts.id, input.shiftId))
        .for("update")
        .limit(1)
    )[0];
    if (!shift) {
      throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
    }
    if (shift.status !== "OPEN") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يمكن الصرف النقدي من وردية مغلقة",
      });
    }
    if (Number(shift.branchId) !== input.branchId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "وردية مصدر النقد لا تطابق الفرع",
      });
    }

    available = await computeDrawerCashBalance(
      tx,
      input.shiftId,
      shift.openingBalance,
    );
    lockedShiftId = Number(shift.id);
  } else {
    const branch = (
      await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, input.branchId))
        .for("update")
        .limit(1)
    )[0];
    if (!branch) {
      throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
    }

    available = await computeLockedCashReceiptsBalance(
      tx,
      and(
        eq(receipts.branchId, input.branchId),
        eq(receipts.cashBucket, "TREASURY"),
        eq(receipts.paymentMethod, "CASH"),
      ),
    );
  }

  if (requested.gt(available)) {
    insufficientCash(input, available, requested);
  }

  return {
    cashBucket: input.cashBucket,
    shiftId: lockedShiftId,
    availableBefore: toDbMoney(available),
    availableAfter: toDbMoney(available.minus(requested)),
  };
}
