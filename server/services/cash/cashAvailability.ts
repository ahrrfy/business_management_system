import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { branches, receipts, shifts, users } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, toDbMoney, type DecimalInput } from "../money";
import type { Actor } from "../tx";

export type CashBucket = "DRAWER" | "TREASURY";

/** حدث receipt مادي: REVERSED يبقى الحدث الأصلي وترافقه حركة تعويضية مستقلة. */
export const MATERIALIZED_RECEIPT_STATUSES = ["COMPLETED", "REVERSED"] as const;
export const MATERIALIZED_RECEIPT_STATUS_SQL = sql.raw("IN ('COMPLETED','REVERSED')");

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

export interface CashAccountRef {
  branchId: number;
  cashBucket: CashBucket;
  shiftId?: number | null;
}

export interface CashTransferAvailabilityInput {
  source: CashAccountRef;
  destination: CashAccountRef;
  amount: DecimalInput;
  operation: string;
  /** تسليم الإغلاق يفرّغ الدرج كله؛ السحب الجزئي والتحويل بين الفروع لا يشترطان ذلك. */
  requireFullSourceBalance?: boolean;
}

/**
 * إثبات سلطوي غير قابل للإنشاء خارج هذه الوحدة. وجود الرصيد وحده لا يجيز صرفاً
 * خارجياً من الخزينة؛ يجب أن يثبت المسار، داخل المعاملة نفسها، مالكاً نشطاً
 * مختلفاً عن كل صانعي الطلب ثم يمرر هذا الإثبات إلى الحارس المالي.
 */
export interface ExternalTreasuryDisbursementApproval {
  readonly kind: "EXTERNAL_DISBURSEMENT";
  readonly approverId: number;
  readonly branchIds: readonly number[];
}

const externalTreasuryApprovals = new WeakSet<object>();
const approvalTransactions = new WeakMap<object, Tx>();

export interface AuthorizeExternalTreasuryDisbursementInput {
  actor: Actor;
  makerUserIds: Array<number | null | undefined>;
  branchIds: number[];
  operation: string;
}

/**
 * يقفل مصادر الخزينة أولاً بترتيب ثابت، ثم يقرأ حساب المالك FOR SHARE كي تبقى
 * isActive/isOwner ثابتة حتى COMMIT. الناتج مربوط بهوية tx ولا يعمل في معاملة أخرى.
 */
export async function authorizeExternalTreasuryDisbursement(
  tx: Tx,
  input: AuthorizeExternalTreasuryDisbursementInput,
): Promise<ExternalTreasuryDisbursementApproval> {
  const branchIds = Array.from(new Set(input.branchIds.map(Number))).sort((a, b) => a - b);
  if (branchIds.length === 0 || branchIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `${input.operation}: لا يوجد مصدر خزينة صالح للاعتماد`,
    });
  }
  for (const branchId of branchIds) {
    await lockCashSourceForUpdate(tx, { branchId, cashBucket: "TREASURY", shiftId: null });
  }

  const [owner] = await tx
    .select({ id: users.id, isActive: users.isActive, isOwner: users.isOwner })
    .from(users)
    .where(eq(users.id, input.actor.userId))
    .for("share")
    .limit(1);
  if (!owner?.isActive || !owner.isOwner) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${input.operation}: التنفيذ النقدي من الخزينة محصور بحساب مالك نشط`,
    });
  }
  const makers = new Set(
    input.makerUserIds
      .filter((id): id is number => id != null)
      .map(Number),
  );
  if (makers.has(Number(owner.id))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${input.operation}: لا يجوز لصانع الطلب تنفيذ صرفه — يلزم مالك آخر`,
    });
  }

  const approval = Object.freeze({
    kind: "EXTERNAL_DISBURSEMENT" as const,
    approverId: Number(owner.id),
    branchIds: Object.freeze(branchIds),
  });
  externalTreasuryApprovals.add(approval);
  approvalTransactions.set(approval, tx);
  return approval;
}

/** الحارس الوحيد لصرف خارجي نافذ من TREASURY بعد إثبات المالك/Four-eyes. */
export async function assertApprovedTreasuryOutAvailable(
  tx: Tx,
  input: Omit<CashOutAvailabilityInput, "cashBucket" | "shiftId"> & { branchId: number },
  approval: ExternalTreasuryDisbursementApproval,
): Promise<CashOutAvailabilityResult> {
  if (
    !externalTreasuryApprovals.has(approval) ||
    approvalTransactions.get(approval) !== tx ||
    !approval.branchIds.includes(Number(input.branchId))
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `${input.operation}: إثبات اعتماد الصرف الخارجي مفقود أو لا يخص هذه المعاملة/الخزينة`,
    });
  }
  return assertCashOutAvailable(tx, {
    ...input,
    cashBucket: "TREASURY",
    shiftId: null,
  });
}

export type NonPhysicalOutClassification =
  | "DEFERRED_APPROVAL"
  | "NON_CASH_METHOD";

/** الاستثناءات المادية الوحيدة من طابور مالك الصرف الخارجي؛ كلها نقل أصل داخلي أو تعويض مقيد بمصدر. */
export const TREASURY_OUT_EXCEPTION_POLICY = Object.freeze({
  CASH_TRANSFER_INTERNAL: "INTERNAL_TRANSFER",
  CASH_DROP_INTERNAL: "INTERNAL_TRANSFER",
  CASH_HANDOVER_INTERNAL: "INTERNAL_TRANSFER",
  SHIFT_FLOAT_INTERNAL: "INTERNAL_TRANSFER",
  // تصحيح append-only محصور بورديات سالبة فُتحت قبل تفعيل الحارس الإنتاجي؛ خزينة→درج
  // بالقيمة الدقيقة ثم إغلاق بصفر، بلا إيراد/مصروف وبلا تعديل أي إيصال تاريخي.
  LEGACY_SHIFT_REMEDIATION_INTERNAL: "INTERNAL_TRANSFER",
  DELIVERY_REMITTANCE_CLEARING: "INTERNAL_TRANSFER",
  SALE_CANCELLATION_COMPENSATION: "REVERSAL_COMPENSATION",
  SALE_RETURN_COMPENSATION: "REVERSAL_COMPENSATION",
  DIGITAL_CARD_REVERSAL_COMPENSATION: "REVERSAL_COMPENSATION",
  EXCHANGE_REVERSAL_COMPENSATION: "REVERSAL_COMPENSATION",
} as const);

export type TreasuryOutExceptionOperation = keyof typeof TREASURY_OUT_EXCEPTION_POLICY;

/** وسم تدقيقي fail-closed: العملية يجب أن تكون مفتاحاً موجوداً حرفياً في السياسة المغلقة أعلاه. */
export function assertTreasuryOutException(operation: TreasuryOutExceptionOperation): void {
  if (!(operation in TREASURY_OUT_EXCEPTION_POLICY)) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تصنيف استثناء صرف الخزينة غير معروف" });
  }
}

/**
 * استثناء مغلق لإيصال OUT لا يمثّل خروج نقد مادي الآن.
 * لا تُضاف فئة جديدة هنا إلا بعقد محاسبي صريح واختبار جرد fail-closed.
 */
export function assertNonPhysicalOutReceipt(input: {
  classification: NonPhysicalOutClassification;
  paymentMethod: string;
  cashBucket: CashBucket | null;
  approvalStatus?: string | null;
  operation?: string;
}): void {
  if (input.classification === "DEFERRED_APPROVAL") {
    if (
      input.cashBucket !== null ||
      input.approvalStatus !== "PENDING_APPROVAL"
    ) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "تصنيف OUT المؤجل غير متسق: يجب أن يبقى بلا دلو حتى الاعتماد",
      });
    }
    return;
  }

  if (input.paymentMethod === "CASH" || input.cashBucket === "DRAWER") {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "تصنيف OUT غير النقدي غير متسق مع طريقة الدفع أو درج الوردية",
    });
  }
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
        inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
        eq(receipts.approvalStatus, "APPROVED"),
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

/**
 * **الشروط الوحيدة** التي تجعل إيصالاً «نقداً فعلياً في درج وردية» (المسار ز، ١٦/٨).
 *
 * كانت مكرّرةً نصّياً في ثلاثة مواضع بتعليقاتٍ تدّعي التطابق — والقياس أثبت أنّها تفترق:
 * على وردية بأربعة إيصالات أعطى الحارس ١٤٠٬٠٠٠ وتقرير إقفال اليوم ٢٢٣٬٠٠٠ وبطاقة الوردية
 * ٢٤٨٬٠٠٠ (فرق ١٠٨٬٠٠٠ د.ع)، لأنّ الأخيرَين يُغفلان الحالة والاعتماد، والبطاقةُ تُغفل شرط
 * النقد أيضاً. الثمن العمليّ: تقريرٌ يتّهم كاشيراً بعجزٍ لا وجود له أو يُبرّئه من عجزٍ حقيقيّ.
 *
 * ⇒ الاتّساق صار **بالبناء لا بالتعليق**: كل قارئٍ لنقد الدرج يستدعي هذه، ولا يُعيد كتابتها.
 */
export function materializedDrawerCashConditions() {
  return [
    eq(receipts.cashBucket, "DRAWER"),
    eq(receipts.paymentMethod, "CASH"),
    // PENDING/FAILED لم يتحوّلا نقداً بعد؛ وREVERSED حدثٌ تاريخيّ يرافقه تعويضيّ معاكس.
    inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
    eq(receipts.approvalStatus, "APPROVED"),
  ];
}

/**
 * نظيرها لمستهلكي SQL الخام (بطاقات الورديات المفتوحة) — بأسماء الأعمدة **الفعلية** في
 * القاعدة (`receiptStatus`/`receiptApprovalStatus`) لا بأسماء drizzle، وبادئة الجدول `r`.
 */
export const MATERIALIZED_DRAWER_CASH_RAW_SQL = sql.raw(
  "r.cashBucket = 'DRAWER' AND r.paymentMethod = 'CASH' " +
    "AND r.receiptStatus IN ('COMPLETED','REVERSED') AND r.receiptApprovalStatus = 'APPROVED'",
);

/** الصيغة الوحيدة لرصيد درج الوردية؛ يستعملها الحارس وإقفال الوردية معاً. */
export async function computeDrawerCashBalance(
  tx: Tx,
  shiftId: number,
  openingBalance: DecimalInput,
): Promise<Decimal> {
  const receiptBalance = await computeLockedCashReceiptsBalance(
    tx,
    and(eq(receipts.shiftId, shiftId), ...materializedDrawerCashConditions()),
  );
  return money(openingBalance).plus(receiptBalance);
}

/** الصيغة الوحيدة لرصيد خزينة الفرع؛ CASH فعلي فقط وبنفس دلالة العكس المركزية. */
export async function computeTreasuryCashBalance(
  tx: Tx,
  branchId: number,
): Promise<Decimal> {
  return computeLockedCashReceiptsBalance(
    tx,
    and(
      eq(receipts.branchId, branchId),
      eq(receipts.cashBucket, "TREASURY"),
      eq(receipts.paymentMethod, "CASH"),
    ),
  );
}

export interface LockedCashSource {
  cashBucket: CashBucket;
  branchId: number;
  shiftId: number | null;
  openingBalance: string | null;
}

function cashAccountLockOrder(input: CashAccountRef): string {
  // ترتيب كلي واحد بين جدولي الحسابات يمنع A→B / B→A من امتلاك كل معاملة
  // قفل المصدر ثم انتظار FK الوجهة. الأدراج (shifts) تسبق الخزائن (branches)
  // لأن closeShift/cashDrop يملكان قفل الوردية أصلاً قبل تسليمها، وداخل الجدول
  // يكون الترتيب بالهوية الرقمية.
  return input.cashBucket === "TREASURY"
    ? `1:${String(input.branchId).padStart(12, "0")}`
    : `0:${String(input.shiftId ?? 0).padStart(12, "0")}`;
}

async function lockCashTransferAccounts(
  tx: Tx,
  source: CashAccountRef,
  destination: CashAccountRef,
): Promise<void> {
  const ordered = [source, destination].sort((a, b) =>
    cashAccountLockOrder(a).localeCompare(cashAccountLockOrder(b)),
  );
  for (const account of ordered) {
    await lockCashSourceForUpdate(tx, account);
  }
}

/**
 * يقفل صف مصدر النقد فقط وفق الترتيب الحاكم: source row → business document → receipt rows.
 * تستعمله المسارات التي تحتاج قفل مستند قائم (اعتماد/إلغاء) قبل استدعاء الحارس الكامل،
 * كي لا تنشأ دورة أقفال receipt → source مقابل source → receipts.
 */
export async function lockCashSourceForUpdate(
  tx: Tx,
  input: CashAccountRef,
): Promise<LockedCashSource> {
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
    if (!shift) throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
    if (shift.status !== "OPEN") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا يمكن الصرف النقدي من وردية مغلقة" });
    }
    if (Number(shift.branchId) !== input.branchId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "وردية مصدر النقد لا تطابق الفرع" });
    }
    return {
      cashBucket: "DRAWER",
      branchId: input.branchId,
      shiftId: Number(shift.id),
      openingBalance: String(shift.openingBalance),
    };
  }

  const branch = (
    await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.id, input.branchId))
      .for("update")
      .limit(1)
  )[0];
  if (!branch) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });
  return {
    cashBucket: "TREASURY",
    branchId: input.branchId,
    shiftId: null,
    openingBalance: null,
  };
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
  const source = await lockCashSourceForUpdate(tx, input);
  if (source.cashBucket === "DRAWER") {
    available = await computeDrawerCashBalance(
      tx,
      source.shiftId!,
      source.openingBalance!,
    );
  } else {
    available = await computeTreasuryCashBalance(tx, input.branchId);
  }

  if (requested.gt(available)) {
    insufficientCash(input, available, requested);
  }

  return {
    cashBucket: input.cashBucket,
    shiftId: source.shiftId,
    availableBefore: toDbMoney(available),
    availableAfter: toDbMoney(available.minus(requested)),
  };
}

/**
 * حارس نقل داخلي: يثبت اختلاف حسابَي المصدر والوجهة، ثم يطبّق حارس المصدر نفسه.
 * إيصال الوجهة المقابل يجب أن يُكتب في المعاملة ذاتها؛ هذه الدالة لا تنشئ نقوداً ولا تحجزها.
 */
export async function assertCashTransferAvailable(
  tx: Tx,
  input: CashTransferAvailabilityInput,
): Promise<CashOutAvailabilityResult> {
  const sameAccount =
    input.source.branchId === input.destination.branchId &&
    input.source.cashBucket === input.destination.cashBucket &&
    (input.source.shiftId ?? null) === (input.destination.shiftId ?? null);
  if (sameAccount) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مصدر النقل النقدي ووجهته حساب واحد",
    });
  }

  // يجب أن يسبق القفلان أي قراءة رصيد أو INSERT يحمل FK للحساب المقابل.
  // كل النقلات تستعمل الترتيب نفسه بصرف النظر عن اتجاه الحركة.
  await lockCashTransferAccounts(tx, input.source, input.destination);

  const result = await assertCashOutAvailable(tx, {
    branchId: input.source.branchId,
    cashBucket: input.source.cashBucket,
    shiftId: input.source.shiftId,
    amount: input.amount,
    operation: input.operation,
  });
  if (
    input.requireFullSourceBalance &&
    !money(result.availableBefore).eq(money(input.amount))
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        `${input.operation} مرفوض: النقل الكامل يجب أن يساوي رصيد المصدر ` +
        `${result.availableBefore} د.ع، والمطلوب ${money(input.amount).toFixed(2)} د.ع.`,
    });
  }
  return result;
}
