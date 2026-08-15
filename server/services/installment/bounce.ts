// ارتجاع شيك (bounceCheck) — عكسٌ محاسبيّ متماثل مع تحصيل القسط (AR-BOUNCE).
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { installmentLines, installmentPlans, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import {
  createPostingIntent,
  signedPostingLines,
} from "../accounting/postingEngine";
import { adjustCustomerBalance, postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { assertNonPhysicalOutReceipt } from "../cash/cashAvailability";
import { assertPlanBranch, type BranchRestriction } from "./types";

/** Posting contract for a collected cheque that was subsequently dishonoured. */
export function bouncedCheckPosting(amount: ReturnType<typeof money>) {
  const postingSourceComponents = {
    roleDebits: { AR: amount },
    roleCredits: { CHECKS_RECEIVABLE: amount },
  } as const;
  return {
    postingIntent: createPostingIntent(
      "PAYMENT_OUT_CUSTOMER_REFUND",
      "PAYMENT_OUT",
      signedPostingLines("AR", "CHECKS_RECEIVABLE", amount),
      postingSourceComponents,
    ),
    postingSourceComponents,
  };
}

/**
 * ارتجاع شيك: قسط CHECK ⇒ BOUNCED.
 * - PENDING (الشيك لم يُحصَّل أصلاً) ⇒ تغيير حالة فقط، لا حركة مالية.
 * - PAID  (#installments-4 — تدقيق التثبيت): كان يُحجَب مطلقاً ⇒ الشيك يرتدّ في البنك بعد وسم القسط
 *   مدفوعاً فيبقى العميل «مدفوع» ورصيده منقوصاً بلا نقد فعلي (خسارة تتبُّع). نُنفّذ عكساً محاسبيّاً:
 *   receipt الأصل ⇒ REVERSED؛ قيد PAYMENT_OUT معاكس بمبلغ موجب؛ استعادة رصيد العميل (+amount).
 *   ذرّي داخل tx واحد؛ إن كان القسط مرتبطاً بفاتورة (voucher.invoiceId) نُعكِّس أثره على AR فيها أيضاً.
 */
export async function bounceCheck(
  input: { lineId: number; note?: string | null },
  actor: Actor,
  restrictToBranchId: BranchRestriction = null,
): Promise<{ lineId: number; reversed: boolean }> {
  return withTx(async (tx) => {
    const row = (
      await tx
        .select({ line: installmentLines, plan: installmentPlans })
        .from(installmentLines)
        .innerJoin(installmentPlans, eq(installmentLines.planId, installmentPlans.id))
        .where(eq(installmentLines.id, input.lineId))
        .for("update")
        .limit(1)
    )[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "القسط غير موجود" });
    assertPlanBranch(Number(row.plan.branchId), restrictToBranchId);
    if (row.line.kind !== "CHECK") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الارتجاع للشيكات فقط — هذا القسط نقدي" });
    }
    if (row.line.status !== "PENDING" && row.line.status !== "PAID") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الارتجاع متاح لشيك معلَّق أو محصَّل فقط" });
    }

    let reversed = false;
    if (row.line.status === "PAID" && row.line.receiptId != null) {
      const [rec] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, Number(row.line.receiptId)))
        .for("update")
        .limit(1);
      if (!rec || rec.status !== "COMPLETED" || rec.approvalStatus !== "APPROVED") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يمكن ارتداد القسط: سند التحصيل المرتبط غير مكتمل أو غير معتمد",
        });
      }
      if (rec.paymentMethod !== "CHECK") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "لا يمكن ارتداد القسط: التحصيل الفعلي لم يكن بشيك",
        });
      }
      if (rec.status === "COMPLETED") {
        const amount = money(rec.amount);
        const branchId = rec.branchId != null ? Number(rec.branchId) : Number(row.plan.branchId);
        // AR-BOUNCE (تدقيق ١٧/٧): كان يُعلَّم الإيصال الأصل REVERSED ⇒ إبطال إيصال وردية سابقة
        // (غالباً مغلقة) يغيّر مجاميع Z-report/الدرج بأثر رجعي، والقيد المعاكس بلا إيصال OUT فعليّ.
        // بدلاً منه: نُبقي الأصل (حدثٌ وقع فعلاً) ونُصدر إيصال عكسٍ **أماميّ** مكتمل — شيفت-محايد
        // (TREASURY، لا درج): ارتداد الشيك حدثٌ خزينيّ/ذمميّ لا سحبَ نقدٍ من درج الوردية الجارية،
        // فلا يشوّه أيّ Z-report ويسمح بارتداد شيكٍ حُصِّل في وردية مغلقة (الحالة الأشيع).
        assertNonPhysicalOutReceipt({
          classification: "NON_CASH_METHOD", paymentMethod: rec.paymentMethod,
          cashBucket: "TREASURY", operation: "عكس شيك مرتد",
        });
        const compRes = await tx.insert(receipts).values({
          invoiceId: rec.invoiceId ?? null,
          branchId,
          shiftId: null,
          cashBucket: "TREASURY",
          direction: "OUT",
          amount: toDbMoney(amount),
          paymentMethod: rec.paymentMethod,
          status: "COMPLETED",
          referenceNumber: `BOUNCE-CHK-${input.lineId}`,
          partyType: "CUSTOMER",
          partyId: Number(row.plan.customerId),
          description: `ارتداد شيك — القسط #${row.line.seq} من خطة #${row.plan.id}`,
          createdBy: actor.userId,
          approvalStatus: "APPROVED",
        });
        const compReceiptId = extractInsertId(compRes);
        const { postingIntent, postingSourceComponents } =
          bouncedCheckPosting(amount);
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId,
          receiptId: compReceiptId,
          customerId: Number(row.plan.customerId),
          amount,
          revenue: money(0),
          paymentMethod: rec.paymentMethod,
          postingIntent,
          postingSourceComponents,
          notes: `ارتداد شيك — القسط #${row.line.seq} من خطة #${row.plan.id}`,
        });
        // استعادة AR: التحصيل خفّض currentBalance بمقدار amount ⇒ نعيدها بإضافة +amount.
        await adjustCustomerBalance(tx, Number(row.plan.customerId), amount);
        reversed = true;
      }
      // تماثُل الارتداد مع التحصيل: لا نمسّ invoices.paidAmount هنا. تحصيل القسط يمرّ عبر createVoucher
      // (سند «على الحساب») فيخفّض customers.currentBalance فقط ولا يزيد invoices.paidAmount أبداً — الذمّة
      // تُتابَع على مستوى العميل لا الفاتورة (راجع arRemindersService). كان العكس يطرح rec.amount من
      // paidAmount التي لم يَزِدها التحصيل قطّ ⇒ يمحو دفعاتٍ مباشرةً مشروعةً على الفاتورة (عربون/سداد مباشر)
      // ويقلب حالتها خطأً. الاستعادة الصحيحة والمتماثلة جرت أعلاه: adjustCustomerBalance(+amount) فقط.
    } else if (row.line.status === "PAID") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "لا يمكن ارتداد قسط مدفوع بلا سند تحصيل مرتبط",
      });
    }

    // مفتاح محاولة التحصيل السابقة immutable. payLine يشتق محاولة A<n> جديدة مرتبطة
    // بالسند السابق عند BOUNCED؛ حذف المفتاح القديم يسمح لمحاولة شبكة متأخرة بإحياء أثره.

    await tx
      .update(installmentLines)
      .set({
        status: "BOUNCED",
        receiptId: null,
        paidAt: null,
        note: input.note?.trim() ? input.note.trim().slice(0, 255) : row.line.note,
      })
      .where(eq(installmentLines.id, input.lineId));
    // خطة مكتملة سابقاً؟ نُعيدها لـACTIVE لأن هناك قسطاً مرتدّاً يحتاج تحصيلاً جديداً.
    if (row.plan.status === "COMPLETED") {
      await tx.update(installmentPlans).set({ status: "ACTIVE" }).where(eq(installmentPlans.id, Number(row.plan.id)));
    }
    return { lineId: input.lineId, reversed };
  });
}
