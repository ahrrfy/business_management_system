// تمويل الخزينة (إيداع رأس مال / رصيد افتتاحيّ للخزينة) — العهدة الوسيطة (imprest، ٢٨/٧/٢٦).
//
// لماذا: نموذج العهدة الوسيطة يسحب عهدة كل وردية **من الخزينة** (openShift ⇒ TREASURY OUT). فإن لم
// تُموَّل الخزينة أولاً بمصدرٍ خارجيّ (رأس مال المالك) يصير رصيدها سالباً. هذه الخدمة هي البوّابة الوحيدة
// لضخّ نقدٍ خارجيّ في الخزينة: تُنشئ إيصال TREASURY IN + قيد TREASURY_FUNDING (revenue=cost=0). تُقصَر
// على admin/manager (فعلٌ ماديّ: وضع نقدٍ في الخزنة)، مقيّدة بفرع المدير، وidempotent (نقرٌ مزدوج لا
// يضاعف رأس المال). التبرير (الوصف) إلزاميّ للسجلّ التدقيقي. — راجع getTreasuryBalance/sendTransfer للنمط.
//
// ملاحظة حوكمة (مؤجَّلة بقرار المالك): التمويل حاليّاً فعلٌ مباشرٌ بمدير واحد + سجلّ تدقيق. يمكن رفعه إلى
// اعتمادٍ ثنائيّ (maker-checker) لاحقاً إن أراد المالك ضبطاً أشدّ ضدّ «تمويلٍ وهميّ يُخفي عجزاً».

import { TRPCError } from "@trpc/server";
import { desc, eq, like, sql } from "drizzle-orm";
import { branches, receipts } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { getTreasuryBalance } from "./cashTransferService";
import { findIdempotentRefId, recordIdempotencyKey } from "./idempotency";
import { postEntry } from "./ledgerService";
import { money, toDateStr, toDbMoney } from "./money";
import { withTx, type Actor } from "./tx";

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

/** رقم إيداع خزينة TF-<فرع>-YYYYMMDD-NNNN (idempotent على مستوى الفرع/اليوم عبر GET_LOCK). */
async function nextFundingNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `TF-${branchId}-${ymd}-`;
  const lockName = `treasury_funding:${branchId}:${ymd}`;
  const lockRes: any = await tx.execute(sql`SELECT GET_LOCK(${lockName}, 5) AS locked`);
  const lockedRow = Array.isArray(lockRes) ? lockRes[0]?.[0] : lockRes?.rows?.[0];
  if (!lockedRow || Number(lockedRow.locked) !== 1) {
    throw new Error(`treasury funding numbering lock timeout for ${lockName}`);
  }
  try {
    const rows = await tx
      .select({ n: receipts.referenceNumber })
      .from(receipts)
      .where(like(receipts.referenceNumber, `${prefix}%`))
      .orderBy(desc(receipts.id))
      .limit(1);
    const last = rows[0]?.n;
    const seq = last ? parseInt(String(last).slice(prefix.length), 10) + 1 : 1;
    return prefix + String(seq).padStart(4, "0");
  } finally {
    await tx.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
}

/** يضخّ نقداً خارجياً في خزينة فرعٍ (TREASURY IN مكتمل + قيد TREASURY_FUNDING). */
export async function fundTreasury(
  input: FundTreasuryInput,
  actor: Actor,
): Promise<FundTreasuryResult> {
  return withTx(async (tx) => {
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

    // الفرع موجود + صلاحية الفاعل: admin (أيّ فرع) أو manager (فرعه فقط) — فعلٌ ماديّ (وضع نقدٍ في الخزنة).
    const branch = (await tx.select().from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!branch) throw new TRPCError({ code: "BAD_REQUEST", message: "فرع غير موجود" });
    if (actor.role !== "admin") {
      if (actor.role !== "manager") {
        throw new TRPCError({ code: "FORBIDDEN", message: "تمويل الخزينة للمدير فأعلى" });
      }
      if (Number(actor.branchId) !== Number(input.branchId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك تمويل خزينة فرعٍ غير فرعك" });
      }
    }

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
