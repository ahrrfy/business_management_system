// خدمة إرجاع نقد الوردية → الخزينة عند الإغلاق (العهدة الوسيطة / imprest، قرار المالك ٢٨/٧/٢٦).
// نمط: نقل بين دلوَي DRAWER → TREASURY داخل نفس الفرع. لا يَمسّ AR/AP.
// تُستدعى من داخل withTx لـcloseShift (لا nested tx). القيد CASH_HANDOVER لا يَدخل الإيراد (revenue=cost=0).
//
// تاريخيّاً حَوى هذا الملف createHandover (تسليم SOD اختياريّ معلَّق يقبله مديرٌ آخر) الذي كان يُستدعى من
// closeShift. أُزيل مع اعتماد النموذج التلقائيّ: يعود **كامل** نقد الدرج إلى الخزينة فوراً عند الإغلاق بلا
// اختيار مستلِمٍ ولا قبول معلَّق (settleShiftReturnTx). التسليم اليدويّ للخزينة أثناء الوردية يُغطّيه
// cash drop (createCashDrop، معلَّق بقبول SOD). أرقام CH-... موحّدة بين المسارين.

import { TRPCError } from "@trpc/server";
import { like, sql } from "drizzle-orm";
import { receipts } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { createPostingIntent, creditLine, debitLine } from "./accounting/postingEngine";
import { postEntry } from "./ledgerService";
import { money, toDateStr, toDbMoney } from "./money";
import { assertCashTransferAvailable, assertTreasuryOutException } from "./cash/cashAvailability";
import type { Actor } from "./tx";

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
    // نأخذ أعلى **لاحقة رقمية بحتة** لا أعلى id: مرجعٌ حرّ (دفعة مورّد/سند) أُدخِل كـ«CH-فرع-تاريخ-ABC»
    // قد يحمل id أعلى ولاحقةً غير رقمية ⇒ parseInt=NaN ⇒ «CH-…-NaN» وتصادم dedupe يعطّل كلّ إغلاقٍ تالٍ
    // (retryOnDup تُعيد نفس الرقم المسموم فتفشل). نتجاهل غير الرقميّ — نمط nextDropNumber المُصلَح.
    const rows = await tx
      .select({ n: receipts.referenceNumber })
      .from(receipts)
      .where(like(receipts.referenceNumber, `${prefix}%`));
    let maxSeq = 0;
    for (const r of rows) {
      const suffix = String(r.n ?? "").slice(prefix.length);
      if (/^\d+$/.test(suffix)) {
        const n = parseInt(suffix, 10);
        if (n > maxSeq) maxSeq = n;
      }
    }
    return prefix + String(maxSeq + 1).padStart(4, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/**
 * إرجاع كامل نقد الدرج المعدود إلى الخزينة عند إغلاق الوردية — **تلقائيّ فوريّ** (قرار المالك ٢٨/٧/٢٦،
 * نموذج العهدة الوسيطة/imprest). كل وردية تُغلق بتسليم درجها **كاملاً** للخزينة (drawer→0)، والوردية
 * التالية تسحب عهدةً جديدة من الخزينة عند فتحها (openShift ⇒ TREASURY OUT). هذا يُصلح فكّ لوحة الخزينة
 * الذي كشفه Codex على #377: بلا حركة خزينة عند الفتح/الإغلاق يُحسَب نقد العهدة مرّتين (ازدواج) أو يتبخّر.
 *
 * الإرجاع يدخل رصيد الخزينة **فوراً** (status=COMPLETED) بلا خطوة قبول — قرار المالك «تلقائيّ فوريّ»
 * (يُسقط ضبط الحيازة لصالح البساطة، ويتجنّب قفل فرعٍ بمديرٍ واحد). المعدود = المتوقَّع دائماً (closeShift
 * يحظر الإغلاق بأيّ فرق عبر enforceCashGovernance) ⇒ لا يستطيع الكاشير تضخيم الخزينة بعدٍّ زائد. يُستدعى
 * من closeShift داخل نفس الـtx **بعد** computeExpectedCash (وإلّا طُرح إيصال الإرجاع OUT من المتوقَّع).
 */
export async function settleShiftReturnTx(
  tx: Tx,
  input: { shiftId: number; branchId: number; amount: string; notes?: string | null },
  actor: Actor,
): Promise<HandoverResult> {
  const amount = money(input.amount);
  if (amount.isZero() || amount.isNegative()) {
    // درجٌ فارغ عند الإغلاق (كل النقد خرج بـcash drop مثلاً) ⇒ لا شيء يُرجَع — لا يُستدعى أصلاً من closeShift.
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

  // receipt #1: OUT من DRAWER (الوردية المُغلَقة) — سجلّ تفريغ الدرج.
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
    description: `إرجاع كامل نقد وردية #${input.shiftId} إلى الخزينة (تسليم تلقائيّ عند الإغلاق)${input.notes ? " — " + input.notes : ""}`,
    createdBy: actor.userId,
  });
  const outReceiptId = extractInsertId(outRes);

  // receipt #2: IN إلى TREASURY — **مكتمل فوراً** (لا قبول SOD معلّق؛ قرار المالك «تلقائيّ فوريّ»).
  // COMPLETED + APPROVED (الافتراضي) ⇒ يدخل رصيد الخزينة مباشرةً في getDashboard/getTreasuryBalance.
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
    description: `استلام إرجاع وردية #${input.shiftId} في الخزينة (تلقائيّ)`,
    createdBy: actor.userId,
  });
  const inReceiptId = extractInsertId(inRes);

  // قيد CASH_HANDOVER واحد (نقلٌ بين دلوَين، revenue/cost=0).
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
