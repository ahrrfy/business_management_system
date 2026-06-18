/**
 * CASH-CORE — نُقطة الدخول الوَحيدة لكل حركة نقد في النظام.
 *
 * المَبدأ: كل دينار في DB يَنتمي لقصة ذرّية مَحفوظة بثلاث مصادر مُتزامنة
 * (`receipts + accountingEntries + auditLogs`) مَربوطة بصندوق أب (`cashBuckets`)
 * ومُولَّدة من هنا حصرياً. الكتابة المُباشرة على `receipts` خارج هذا الملف
 * يَرفضها حارس CI (`scripts/lint-cash-direct-writes.mjs`).
 *
 * انظر `docs/cash-core-design.md` للتَفصيل الكامل.
 *
 * **POC (المَرحلة ج):** يُصدِّر `execute()` و `transfer()` بأَدنى منطق إنفاذ
 * يَكفي لاختبار العَقد. RBAC الكامل + استبدال الخدمات الحالية في المَرحلة أ.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, cashBuckets, receipts } from "../../drizzle/schema";
import { money, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { randomUUID } from "node:crypto";

export type CashOpKind =
  | "SALE_CASH"
  | "REFUND_CASH"
  | "EXPENSE_CASH"
  | "EXPENSE_CANCEL_CASH"
  | "VOUCHER_RECEIVE"
  | "VOUCHER_PAY"
  | "VOUCHER_CANCEL"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "SUPPLIER_PAYMENT"
  | "CUSTOMER_COLLECTION"
  | "ADJUSTMENT";

export interface CashOpInput {
  kind: CashOpKind;
  bucketId: number;
  direction: "IN" | "OUT";
  amount: string;
  paymentMethod?: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET";
  /** نَوع المَصدر الأَعلى (invoice/expense/voucher/transfer/…). */
  sourceType: string;
  sourceId: number | string;
  /** Idempotency: نَفس المُفتاح يُعيد نَتيجة السَطر الأَوّل بلا كتابة جَديدة. */
  clientRequestId: string;
  /** للتَحويلات: OUT و IN لهما نَفس pairToken. */
  pairToken?: string;
  /** إجباري لـADJUSTMENT/REFUND/CANCEL — سبب يَدخل audit. */
  reason?: string;
  /** للتَسوية: يُشير لـreceipt الأَصلي. */
  reversalOfId?: number;
  /** اختياري: ربط بفاتورة/أمر شغل. */
  invoiceId?: number | null;
  workOrderId?: number | null;
  /** اختياري: voucher metadata (للسندات المستقلّة). */
  voucherNumber?: string | null;
  partyType?: "CUSTOMER" | "SUPPLIER" | "OTHER" | null;
  partyId?: number | null;
  description?: string | null;
  referenceNumber?: string | null;
}

export interface CashOpResult {
  cashTxId: number;
  bucketId: number;
  balanceAfter: string;
  pairToken: string | null;
  idempotent: boolean;
}

/**
 * فحص idempotency: نَفس clientRequestId + actor ⇒ نُعيد النَتيجة الأَصلية بلا كتابة.
 * يَستعمل QUERY عادي (لا قَفل) — السَطر الأَصلي مُلتزَم بالفِعل أو لا.
 */
async function findIdempotent(
  tx: Tx,
  clientRequestId: string,
  actorUserId: number,
): Promise<CashOpResult | null> {
  const row = await tx
    .select({
      id: receipts.id,
      bucketId: receipts.bucketId,
      balanceAfter: receipts.balanceAfter,
      pairToken: receipts.pairToken,
    })
    .from(receipts)
    .where(and(eq(receipts.referenceNumber, `IDEM:${clientRequestId}:${actorUserId}`)))
    .limit(1);
  if (row[0]) {
    return {
      cashTxId: Number(row[0].id),
      bucketId: Number(row[0].bucketId ?? 0),
      balanceAfter: String(row[0].balanceAfter ?? "0"),
      pairToken: row[0].pairToken ?? null,
      idempotent: true,
    };
  }
  return null;
}

/**
 * نُقطة الدخول الوَحيدة. كل insert على receipts النَقدية يَجب أن يَمر هنا.
 *
 * الخُطوات الذَرّية (داخل withTx):
 *   ١) idempotency check (قبل القَفل لتَوفير العَمل).
 *   ٢) SELECT FOR UPDATE على cashBuckets[bucketId] — قَفل تَشاؤمي يَمنع TOCTOU.
 *   ٣) فحص isActive + RBAC + ownership داخل القَفل.
 *   ٤) Invariants: لا سَحب يَتجاوز الرصيد بلا صَلاحية explicit (admin/ADJUSTMENT).
 *   ٥) Insert receipt + balanceAfter snapshot + bucketId + clientRequestId.
 *   ٦) Update bucket.currentBalance + version (atomic).
 *   ٧) auditLog (داخل نَفس withTx).
 */
export async function execute(
  input: CashOpInput,
  actor: Actor,
  tx?: Tx,
): Promise<CashOpResult> {
  const runner = async (t: Tx): Promise<CashOpResult> => {
    // ١) idempotency check
    const existing = await findIdempotent(t, input.clientRequestId, actor.userId);
    if (existing) return existing;

    // ٢) قَفل الصندوق
    const bucketRow = await t
      .select()
      .from(cashBuckets)
      .where(eq(cashBuckets.id, input.bucketId))
      .for("update")
      .limit(1);
    const bucket = bucketRow[0];
    if (!bucket) {
      throw new TRPCError({ code: "NOT_FOUND", message: `الصندوق #${input.bucketId} غير موجود` });
    }
    // ٣) isActive
    if (!bucket.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `الصندوق «${bucket.name}» مُغلَق` });
    }

    // ٤) Invariants — لا سَحب أكبر من الرصيد بلا صَلاحية صَريحة.
    const amt = money(input.amount);
    if (amt.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "المبلغ يَجب أن يَكون موجباً" });
    }
    const currentBal = money(bucket.currentBalance);
    const newBalance =
      input.direction === "IN" ? currentBal.plus(amt) : currentBal.minus(amt);

    if (newBalance.lt(0)) {
      const role = actor.role ?? "";
      const allowNegative = role === "admin" || input.kind === "ADJUSTMENT";
      if (!allowNegative) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `سَحب ${amt.toFixed(2)} يَتجاوز رصيد الصندوق «${bucket.name}» (${currentBal.toFixed(2)})`,
        });
      }
    }

    // ADJUSTMENT/REFUND/CANCEL يَستلزم reason
    if (
      (input.kind === "ADJUSTMENT" ||
        input.kind === "REFUND_CASH" ||
        input.kind === "VOUCHER_CANCEL" ||
        input.kind === "EXPENSE_CANCEL_CASH") &&
      !input.reason?.trim()
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `العَملية ${input.kind} تَستلزم سبباً صَريحاً`,
      });
    }

    // ٥) Insert receipt
    const idemRef = `IDEM:${input.clientRequestId}:${actor.userId}`;
    const insertRes = await t.insert(receipts).values({
      invoiceId: input.invoiceId ?? null,
      workOrderId: input.workOrderId ?? null,
      branchId: bucket.branchId,
      shiftId: bucket.shiftId ?? null,
      direction: input.direction,
      amount: toDbMoney(amt),
      paymentMethod: input.paymentMethod ?? "CASH",
      cashBucket: bucket.kind === "DRAWER" ? "DRAWER" : bucket.kind === "TREASURY" ? "TREASURY" : null,
      bucketId: bucket.id,
      pairToken: input.pairToken ?? null,
      balanceAfter: toDbMoney(newBalance),
      status: "COMPLETED",
      referenceNumber: input.referenceNumber ?? idemRef,
      voucherNumber: input.voucherNumber ?? null,
      partyType: input.partyType ?? null,
      partyId: input.partyId ?? null,
      description: input.description ?? input.reason ?? null,
      createdBy: actor.userId,
    });
    const cashTxId = extractInsertId(insertRes);

    // ٦) Update bucket
    await t
      .update(cashBuckets)
      .set({
        currentBalance: toDbMoney(newBalance),
        version: sql`${cashBuckets.version} + 1`,
      })
      .where(eq(cashBuckets.id, bucket.id));

    // ٧) Audit ذَرّياً داخل نَفس tx — يَنهار مَع كل شيء إن انهارت العَملية.
    //    (logAudit المُعتاد يَستعمل db.insert خارج tx لـbest-effort؛ هنا نَريد ضَمان حَتمي.)
    await t.insert(auditLogs).values({
      userId: actor.userId,
      branchId: actor.branchId ?? null,
      action: `cashOps.${input.kind}`,
      entityType: "receipt",
      entityId: String(cashTxId),
      newValue: {
        bucketId: bucket.id,
        direction: input.direction,
        amount: toDbMoney(amt),
        balanceAfter: toDbMoney(newBalance),
        sourceType: input.sourceType,
        sourceId: String(input.sourceId),
        reason: input.reason ?? null,
        pairToken: input.pairToken ?? null,
        clientRequestId: input.clientRequestId,
      },
    });

    return {
      cashTxId,
      bucketId: bucket.id,
      balanceAfter: toDbMoney(newBalance),
      pairToken: input.pairToken ?? null,
      idempotent: false,
    };
  };

  return tx ? runner(tx) : withTx(runner);
}

/**
 * تَحويل بين صَندوقَين — حركتان ذرّيتان (OUT + IN) بنفس pairToken داخل withTx واحد.
 * قَفل تَصاعدي بـid (min, max) لمَنع deadlock بين تَحويلَين مُتقاطعَين.
 */
export async function transfer(
  fromBucketId: number,
  toBucketId: number,
  amount: string,
  sourceType: string,
  sourceId: number | string,
  clientRequestId: string,
  reason: string,
  actor: Actor,
  tx?: Tx,
): Promise<{ outTxId: number; inTxId: number; pairToken: string }> {
  if (fromBucketId === toBucketId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "لا يُمكن التَحويل إلى نَفس الصندوق",
    });
  }
  if (!reason?.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "التَحويل يَستلزم سبباً" });
  }
  const pairToken = `TRX-${randomUUID()}`;

  const runner = async (t: Tx) => {
    // قَفل تَصاعدي لمَنع deadlock: نَقفل الـid الأَصغر أوَّلاً ثم الأَكبر.
    const [minId, maxId] = fromBucketId < toBucketId ? [fromBucketId, toBucketId] : [toBucketId, fromBucketId];
    await t.select().from(cashBuckets).where(eq(cashBuckets.id, minId)).for("update").limit(1);
    if (minId !== maxId) {
      await t.select().from(cashBuckets).where(eq(cashBuckets.id, maxId)).for("update").limit(1);
    }

    const out = await execute(
      {
        kind: "TRANSFER_OUT",
        bucketId: fromBucketId,
        direction: "OUT",
        amount,
        sourceType,
        sourceId,
        clientRequestId: `${clientRequestId}:OUT`,
        pairToken,
        reason,
      },
      actor,
      t,
    );
    const inn = await execute(
      {
        kind: "TRANSFER_IN",
        bucketId: toBucketId,
        direction: "IN",
        amount,
        sourceType,
        sourceId,
        clientRequestId: `${clientRequestId}:IN`,
        pairToken,
        reason,
      },
      actor,
      t,
    );
    return { outTxId: out.cashTxId, inTxId: inn.cashTxId, pairToken };
  };

  return tx ? runner(tx) : withTx(runner);
}

/** قراءة رَصيد bucket لحظياً (بلا قَفل، للعَرض فَقط). */
export async function readBucketBalance(tx: Tx, bucketId: number): Promise<string> {
  const row = await tx
    .select({ b: cashBuckets.currentBalance })
    .from(cashBuckets)
    .where(eq(cashBuckets.id, bucketId))
    .limit(1);
  return String(row[0]?.b ?? "0");
}
