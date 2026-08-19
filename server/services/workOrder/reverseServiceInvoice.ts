/**
 * **عكس فاتورة خدمةٍ صفريّة البنود** (١٩/٨) — آخر فاتورةٍ في المنظومة بلا مخرج.
 *
 * الحالة: أمرُ تخصيصٍ خالصٍ بلا منتجٍ كتالوجيّ (`baseVariantId = null`) — وهو واقعُ المطبعة:
 * درعٌ أو تصميمٌ لا يقابله صنفٌ في المخزون. فاتورتُه تُنشأ **بصفر `invoiceItems`** لأنّ
 * `invoiceItems.variantId` مفتاحٌ أجنبيّ لا يقبل NULL.
 *
 * وأثرُ ذلك أنّها كانت مسدودةً من كل جهة:
 *  · `returnSaleInTx` يرفض `lines` فارغة، وكلُّ حسابه مقودٌ بالأسطر (الإيراد يُوزَّع عليها).
 *  · `correctSale` يرفض «الفاتورة بلا بنودٍ لتصحيحها».
 *  · `sales.cancel` يرفض منشأ WORKORDER أصلاً.
 * فيقف الموظّف أمام فاتورةٍ حيّةٍ لا تُلغى ولا تُصحَّح ولا تُرجَع.
 *
 * هذا العكس **رأسيّ**: لا أسطرَ ولا مخزون (المواد استُهلكت عند البدء ولا تعود بحكم قرار
 * المالك)، بل مرآةٌ سالبة لقيد البيع نفسه (`SALE_SERVICE_FLEX`) — بما فيه سطرُ العربون،
 * فتُعاد فتحُ الأمانة ثمّ يُبرئها الردّ، محافظاً على الثابت `Σ(قيود الاحتجاز) = 0 ⇔ أُبرئت`.
 *
 * ⛔ **ليس مساراً عامّاً**: يرفض أيّ فاتورةٍ لها بنود — تلك مخرجها `returns.create` المُختبَر.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { invoiceItems, invoices, workOrders } from "../../../drizzle/schema";
import { isDeadInvoiceStatus, invoiceStatusLabel } from "@shared/invoiceStatus";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { adjustCustomerBalance, postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { logAuditTx } from "../auditService";
import { money, round2, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { assertWorkOrderBranch, loadWorkOrder } from "./helpers";

export interface ReverseServiceInvoiceInput {
  workOrderId: number;
  /** سببٌ إلزاميّ — يظهر في سجلّ التدقيق وملاحظات الفاتورة. */
  reason: string;
  clientRequestId?: string | null;
}

export async function reverseServiceInvoice(
  input: ReverseServiceInvoiceInput,
  actor: Actor & { role?: string },
) {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب العكس مطلوب" });
  }
  return withTx(async (tx) => {
    const payloadHash = idempotencyHash({ workOrderId: Number(input.workOrderId) });
    if (input.clientRequestId) {
      const replay = await checkIdempotency(tx, "workOrder.reverseServiceInvoice", input.clientRequestId, payloadHash);
      if (replay != null) {
        return { workOrderId: Number(input.workOrderId), invoiceId: replay, idempotentReplay: true as const };
      }
    }

    const wo = await loadWorkOrder(tx, input.workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.invoiceId == null) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا فاتورة لهذا الأمر لتُعكَس" });
    }
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, Number(wo.invoiceId))).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الأمر غير موجودة" });
    if (isDeadInvoiceStatus(inv.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الفاتورة ${invoiceStatusLabel(inv.status)} سلفاً — لا تُعكَس مرّتين`,
      });
    }

    // ⛔ الحصر البنيويّ: هذا المسار **للفاتورة الصفريّة وحدها**. وجودُ بندٍ واحد يعني أنّ
    // `returnSaleInTx` قادرٌ عليها بحسابه المُختبَر، فلا يُستبدَل بحسابٍ رأسيٍّ أبسط.
    const items = await tx.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.invoiceId, Number(inv.id)));
    if (items.length > 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "للفاتورة بنودٌ — أرجِعها من شاشة المرتجعات (هذا المسار للخدمة الخالصة بلا بنود)",
      });
    }
    // فصل المهام: مُصدر الفاتورة لا يعكسها (admin مستثنى للتصحيح الإداريّ — نفس قاعدة الإلغاء).
    if (actor.role !== "admin" && inv.createdBy != null && Number(inv.createdBy) === Number(actor.userId)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا تعكس فاتورةً أصدرتها بنفسك — يعكسها مديرٌ آخر (فصل المهام)",
      });
    }

    const total = round2(money(inv.total));
    const paid = round2(money(inv.paidAmount ?? "0"));
    const unpaid = round2(total.minus(paid));
    const materialsCost = round2(money(wo.materialsCost ?? "0"));

    // ── القيد: مرآةٌ سالبة لقيد البيع (SALE_SERVICE_FLEX) بالحرف ──
    // العربون يعود التزاماً (OTHER_LIABILITY دائن) كي يجد الردُّ ما يُبرئه؛ والمواد تعود
    // إلى WIP لأنّ عكس البيع لا يعني استهلاكاً (والتصرّف بها قرارُ جردٍ منفصل بقرار المالك).
    await postEntry(tx, {
      entryType: "RETURN",
      dedupeKey: `RETURN:SERVICE_REVERSE:${Number(inv.id)}`,
      branchId: Number(inv.branchId),
      invoiceId: Number(inv.id),
      customerId: inv.customerId != null ? Number(inv.customerId) : null,
      revenue: total.neg(),
      cost: materialsCost.neg(),
      profit: round2(total.minus(materialsCost)).neg(),
      amount: total.neg(),
      notes: `عكس تسليم أمر خدمة ${wo.orderNumber}: ${reason}`,
      postingIntent: createPostingIntent(
        "RETURN_SALE_FLEX",
        "RETURN",
        [
          debitLine("SALES_FLEX", total),
          creditLine("AR", total),
          ...(materialsCost.isZero() ? [] : [debitLine("WORK_IN_PROGRESS", materialsCost), creditLine("COGS", materialsCost)]),
          ...(paid.isZero() ? [] : [debitLine("AR", paid), creditLine("OTHER_LIABILITY", paid)]),
        ],
        {
          roleDebits: { SALES_FLEX: total, WORK_IN_PROGRESS: materialsCost, AR: paid },
          roleCredits: { AR: total, COGS: materialsCost, OTHER_LIABILITY: paid },
        },
      ),
      postingSourceComponents: {
        roleDebits: { SALES_FLEX: total, WORK_IN_PROGRESS: materialsCost, AR: paid },
        roleCredits: { AR: total, COGS: materialsCost, OTHER_LIABILITY: paid },
      },
    });

    // ذمّة العميل: يسقط عنها الجزءُ الآجل وحده (المقبوض ليس ذمّةً — مساره الردّ).
    if (inv.customerId != null && unpaid.gt(0)) {
      await adjustCustomerBalance(tx, Number(inv.customerId), unpaid.neg());
    }

    await tx
      .update(invoices)
      .set({
        status: "RETURNED",
        returnedTotal: toDbMoney(total),
        notes: `${inv.notes ? `${inv.notes} · ` : ""}عُكس التسليم: ${reason}`,
      })
      .where(eq(invoices.id, Number(inv.id)));

    // الأمر يعود «مُلغى»: بضاعتُه لم تُسلَّم فعلياً وقد رجعت، ولا يجوز أن يبقى «مُسلَّماً».
    await tx.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, Number(wo.id)));

    await logAuditTx(
      tx,
      { user: { id: actor.userId, branchId: actor.branchId ?? null } as never, req: undefined as never },
      {
        action: "workOrder.reverseServiceInvoice",
        entityType: "invoice",
        entityId: Number(inv.id),
        newValue: { workOrderId: Number(wo.id), reason, total: toDbMoney(total), paid: toDbMoney(paid) },
      },
    );

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "workOrder.reverseServiceInvoice", input.clientRequestId, Number(inv.id), payloadHash);
    }

    return {
      workOrderId: Number(wo.id),
      invoiceId: Number(inv.id),
      reversedTotal: toDbMoney(total),
      /** المقبوض يبقى **أمانةً مفتوحة** يردّها سندُ صرفٍ موثَّق — لا يُصرَف صامتاً من هنا. */
      refundableAmount: toDbMoney(paid),
    };
  });
}
