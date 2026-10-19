// تمويل الخزينة (إيداع رأس مال / رصيد افتتاحيّ للخزينة) — العهدة الوسيطة (imprest، ٢٨/٧/٢٦).
//
// لماذا: نموذج العهدة الوسيطة يسحب عهدة كل وردية **من الخزينة** (openShift ⇒ TREASURY OUT). فإن لم
// تُموَّل الخزينة أولاً بمصدرٍ خارجيّ (رأس مال المالك) يصير رصيدها سالباً. هذه الخدمة هي البوّابة الوحيدة
// لضخّ نقدٍ خارجيّ في الخزينة: تُنشئ إيصال TREASURY IN + قيد TREASURY_FUNDING (revenue=cost=0). تُقصَر
// على admin/manager قديماً أو مفوّض بالإجراء حالياً (وضع نقدٍ في الخزنة)، مقيّدة بفرع المنفذ، وidempotent (نقرٌ مزدوج لا
// يضاعف رأس المال). التبرير (الوصف) إلزاميّ للسجلّ التدقيقي. — راجع getTreasuryBalance/sendTransfer للنمط.
//
// ملاحظة حوكمة (مؤجَّلة بقرار المالك): التمويل حاليّاً فعلٌ مباشرٌ بمدير واحد + سجلّ تدقيق. يمكن رفعه إلى
// اعتمادٍ ثنائيّ (maker-checker) لاحقاً إن أراد المالك ضبطاً أشدّ ضدّ «تمويلٍ وهميّ يُخفي عجزاً».

import { TRPCError } from "@trpc/server";
import { eq, like, sql } from "drizzle-orm";
import { branches, receipts } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { getTreasuryBalance } from "./cashTransferService";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { createPostingIntent, creditLine, debitLine } from "./accounting/postingEngine";
import { postEntry } from "./ledgerService";
import { money, toDateStr, toDbMoney } from "./money";
import { nextCounterValue } from "./numbering";
import { withTx, type Actor } from "./tx";
import { lockCashSourceForUpdate } from "./cash/cashAvailability";
import { assertOperationAuthorityTx } from "./authorization/operationAuthority";

export interface FundTreasuryInput {
  branchId: number;
  amount: string; // > 0
  description: string; // تبرير إلزاميّ (مصدر رأس المال/القرار)
  notes?: string | null;
  clientRequestId: string; // idempotency
}

export interface FundTreasuryResult {
  receiptId: number;
  referenceNumber: string;
  treasuryBalanceAfter: string;
}

/** رقم إيداع خزينة TF-<فرع>-YYYYMMDD-NNNN عبر عدّاد documentCounters الذرّي. */
async function nextFundingNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `TF-${branchId}-${ymd}-`;
  const counterKey = `treasury_funding_${branchId}_${ymd}`;
  const seq = await nextCounterValue(tx, counterKey);
  return prefix + String(seq).padStart(4, "0");
}

/** يضخّ نقداً خارجياً في خزينة فرعٍ (TREASURY IN مكتمل + قيد TREASURY_FUNDING). */
export async function fundTreasury(
  input: FundTreasuryInput,
  actor: Actor,
): Promise<FundTreasuryResult> {
  return withTx(async (tx) => {
    const canonicalAuthorized = await assertOperationAuthorityTx(tx, actor, "treasury.fundTreasury", true);
    if (actor.role !== "admin" && actor.role !== "manager" && !canonicalAuthorized) {
      throw new TRPCError({ code: "FORBIDDEN", message: "تمويل الخزينة للمدير فأعلى" });
    }
    if (actor.role !== "admin" && Number(actor.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك تمويل خزينة فرعٍ غير فرعك" });
    }
    if (!input.clientRequestId?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مفتاح idempotency إلزامي لتمويل الخزينة" });
    }
    // Idempotency: تكرار نفس المفتاح يُعيد نتيجة الإيداع الأول (لا رأس مال مزدوج).
    const existingRefId = await findIdempotentRefId(tx, "treasury.fund", input.clientRequestId);
    if (existingRefId != null) {
      const r = (await tx.select().from(receipts).where(eq(receipts.id, existingRefId)).limit(1))[0];
      if (!r) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "سند تمويل idempotency مفقود" });
      }
      if (Number(r.branchId) !== Number(input.branchId) || money(r.amount).toFixed(2) !== money(input.amount).toFixed(2)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تعارض idempotency: المفتاح مستعمَل لتمويلٍ بفرع/مبلغ مختلف",
        });
      }
      const balAfter = await getTreasuryBalance(tx, Number(input.branchId));
      return {
        receiptId: existingRefId,
        referenceNumber: r.referenceNumber ?? "",
        treasuryBalanceAfter: toDbMoney(balAfter),
      };
    }

    const amount = money(input.amount);
    if (amount.lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ التمويل يجب أن يكون موجباً" });
    }
    const description = input.description?.trim();
    if (!description) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "تبرير التمويل مطلوب (مصدر رأس المال/القرار) للسجل التدقيقي" });
    }

    // وجود الفرع مستقل عن التفويض المثبّت قبل idempotency وأي حركة مالية.
    const branch = (await tx.select().from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!branch) throw new TRPCError({ code: "BAD_REQUEST", message: "فرع غير موجود" });
    // القفل يسبق الترقيم والإيصال: تمويلان متزامنان لا يملكان FK/S على الفرع
    // ثم يحاولان ترقية القفل إلى X عبر قارئ الرصيد، كما يضمن رقمين متسلسلين مرئيين.
    await lockCashSourceForUpdate(tx, {
      branchId: input.branchId,
      cashBucket: "TREASURY",
    });

    const referenceNumber = await nextFundingNumber(tx, input.branchId);

    const rRes = await tx.insert(receipts).values({
      branchId: input.branchId,
      shiftId: null, // حركة خزينة (لا درج)
      direction: "IN",
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      cashBucket: "TREASURY",
      referenceNumber,
      status: "COMPLETED",
      approvalStatus: "APPROVED",
      partyType: "OTHER",
      description: `تمويل الخزينة (رأس مال/رصيد افتتاحيّ): ${description}${input.notes ? " — " + input.notes.trim() : ""}`,
      createdBy: actor.userId,
    });
    const receiptId = extractInsertId(rRes);

    // قيد TREASURY_FUNDING (مصدر خارجيّ → خزينة، revenue/cost=0). dedupeKey فريد لكل إيداع.
    await postEntry(tx, {
      entryType: "TREASURY_FUNDING",
      postingIntent: createPostingIntent("TREASURY_FUNDING_CAPITAL", "TREASURY_FUNDING", [
        debitLine("TREASURY_CASH", amount),
        creditLine("CAPITAL", amount),
      ]),
      branchId: input.branchId,
      receiptId,
      amount,
      dedupeKey: `TREASURY_FUNDING:${referenceNumber}`,
      notes: input.notes ?? undefined,
    });

    await recordIdempotencyKey(tx, "treasury.fund", input.clientRequestId, receiptId);

    const balAfter = await getTreasuryBalance(tx, input.branchId);
    return { receiptId, referenceNumber, treasuryBalanceAfter: toDbMoney(balAfter) };
  });
}
