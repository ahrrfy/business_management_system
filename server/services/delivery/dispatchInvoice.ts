// ٥/٨ — إسناد **فاتورةٍ قائمة** للتوصيل (لا أمر شغل).
//
// الفجوة التي يعالجها: مسار الإرسال الوحيد كان dispatchToDelivery المفتاحُ فيه workOrderId، وهو
// **يُنشئ الفاتورة بنفسه**. فالبيع المباشر في الاستقبال (منتجات جاهزة/خدمات طباعة بلا تخصيص)
// يُنتج فاتورةً بلا أيّ أمر شغل ⇒ لا صفَّ له في الطابور ولا طريقةَ لإسناده لمندوب إطلاقاً.
// هنا نربط فاتورةً موجودةً بإرسالية: نفس محاسبة العهدة، بلا إنشاء فاتورةٍ ثانية وبلا لمس قيد
// SALE الأصليّ (الإيراد اعتُرف به لحظة البيع؛ التوصيل تسليمٌ لا بيع).
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryParties,
  deliveryPartyMembers,
  invoices,
  receipts,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { withTx } from "../tx";
import { nextConsignmentNumber } from "./numbering";
import { assertFloatLimitTx } from "./parties";
import type { DeliveryTxActor } from "./types";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";

export interface DispatchInvoiceInput {
  invoiceId: number;
  partyId: number;
  deliveryFee?: string | null;
  /** مَن يقبض الأجرة (تمريرٌ لا إيراد): COURIER افتراضاً. COUNTER يعني أنّها في الدرج الآن. */
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  clientRequestId?: string | null;
  /** Internal bridge used by store fulfillment while onlineOrders is retired. */
  onlineOrderId?: number | null;
  assignedUserId?: number | null;
}

export async function dispatchInvoiceToDelivery(input: DispatchInvoiceInput, actor: DeliveryTxActor) {
  return withTx((tx) => dispatchInvoiceInTx(tx, input, actor));
}

/**
 * ش٧ — الجسم داخل معاملةٍ قائمة (استخراجٌ ميكانيكيّ بصفر تغيير سلوكيّ، نمط checkoutReceptionInTx).
 *
 * **لماذا يلزم داخل المعاملة:** طلب توصيلٍ بالدفع عند الاستلام يُنشئ فاتورةً **غير مدفوعة**
 * (النقد ليس في الدرج — الزبون سيدفع للمندوب). لو وقع الإسناد في معاملةٍ تالية لكانت هناك
 * نافذةٌ تكون فيها الفاتورة بلا دافعٍ ولا حاملٍ للعهدة = **مالٌ بلا مالك** (نصّ المالك: لا
 * دينار بلا مسار). داخل نفس المعاملة: إمّا فاتورةٌ وعهدةُ مندوبٍ معاً، أو لا شيء.
 */
export async function dispatchInvoiceInTx(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  input: DispatchInvoiceInput,
  actor: DeliveryTxActor,
) {
  {
    const feeCollection = input.feeCollection ?? "COURIER";
    // ش٦ (V15) — رُفع حظر COUNTER **مشروطاً**: يُقبل فقط إن سبق قبضُ الأمانة فعلاً (إيصال IN
    // بمرجع DLV-FEE-INV-{الفاتورة} يكتبه checkoutReception عبر deliveryFeeHeld) وبما يغطّي
    // الأجرة — وإلا بقي الرفض: OUT للمندوب بلا IN يقابله = عجز درجٍ يمنع إغلاق الوردية.
    if (feeCollection === "COUNTER") {
      const feeD = round2(money(input.deliveryFee ?? "0"));
      const heldRow = (
        await tx
          .select({ v: sql<string>`COALESCE(SUM(CASE WHEN ${receipts.direction} = 'IN' THEN ${receipts.amount} ELSE -${receipts.amount} END), 0)` })
          .from(receipts)
          .where(and(
            eq(receipts.invoiceId, input.invoiceId),
            eq(receipts.referenceNumber, `DLV-FEE-INV-${input.invoiceId}`),
            eq(receipts.status, "COMPLETED"),
          ))
      )[0];
      const heldD = round2(money(heldRow?.v ?? "0"));
      // مراجعة عدائية ٩/٨ — **مساواة** لا سقفاً أدنى: أجرةٌ أقل من الأمانة (heldD > feeD) كانت
      // تمرّ فتُبرَّأ الأمانة جزئياً ويبقى الفرق دنانير زبونٍ عالقة في الدرج بلا مسار للأبد
      // (Σ FEE_HELD موجبة، التوريد لا يخصمها بعد ختم feeSettledAt والإرجاع يتخطّاها).
      if (feeD.lte(0) || !heldD.eq(feeD)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: heldD.gt(0)
            ? `أمانة الأجرة المقبوضة (${heldD.toFixed(2)}) يجب أن تساوي الأجرة (${feeD.toFixed(2)}) — اجعل الأجرة ${heldD.toFixed(2)} أو صحّح المقبوض`
            : "«مقبوضة في الاستقبال» تتطلّب قبض الأجرة مع الطلب نفسه (خانة أجرة التوصيل في السلّة) — أو اختر «المندوب يقبضها من الزبون» / «على المكتبة»",
        });
      }
    }
    const payloadHash = idempotencyHash({
      invoiceId: Number(input.invoiceId),
      partyId: Number(input.partyId),
      deliveryFee: input.deliveryFee == null ? null : toDbMoney(round2(money(input.deliveryFee))),
      feeCollection,
      recipientName: input.recipientName ?? null,
      recipientPhone: input.recipientPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? null,
      onlineOrderId: input.onlineOrderId ?? null,
      assignedUserId: input.assignedUserId ?? null,
    });
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(tx, "delivery.dispatchInvoice", input.clientRequestId, payloadHash);
      if (existingId != null) {
        const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, existingId)).limit(1))[0];
        return {
          consignmentId: existingId,
          consignmentNumber: cn?.consignmentNumber ?? "",
          invoiceId: Number(cn?.invoiceId ?? 0),
          codAmount: String(cn?.codAmount ?? "0"),
          deliveryFee: String(cn?.deliveryFee ?? "0"),
          idempotentReplay: true as const,
        };
      }
    }

    // ترتيب أقفال موحّد مع dispatchToDelivery: الجهة ← الفاتورة (لا جمود متبادل).
    const party = (await tx.select().from(deliveryParties).where(eq(deliveryParties.id, input.partyId)).for("update").limit(1))[0];
    if (!party || !party.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل غير متاحة" });
    let assignedUserId = input.assignedUserId ?? null;
    if (assignedUserId == null && party.partyType === "INDIVIDUAL") {
      assignedUserId = party.userId != null ? Number(party.userId) : null;
      if (assignedUserId == null) {
        const driver = (await tx.select({ userId: deliveryPartyMembers.userId }).from(deliveryPartyMembers).where(and(
          eq(deliveryPartyMembers.partyId, input.partyId),
          eq(deliveryPartyMembers.memberRole, "DRIVER"),
          eq(deliveryPartyMembers.isActive, true),
        )).limit(1))[0];
        assignedUserId = driver?.userId != null ? Number(driver.userId) : null;
      }
    }
    if (assignedUserId != null) {
      const driver = (await tx.select({ id: deliveryPartyMembers.id }).from(deliveryPartyMembers).where(and(
        eq(deliveryPartyMembers.partyId, input.partyId),
        eq(deliveryPartyMembers.userId, assignedUserId),
        eq(deliveryPartyMembers.memberRole, "DRIVER"),
        eq(deliveryPartyMembers.isActive, true),
      )).limit(1))[0];
      if (!driver && Number(party.userId) !== assignedUserId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "السائق المختار ليس عضواً نشطاً في جهة التوصيل" });
      }
    }

    const inv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
    // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران الفروع (owner مُطبَّع ⇒ admin)؛
    // المدير صار مقيَّداً بفرعه فيَخضع لفحص المطابقة أدناه (كان `|| manager` يُعفيه).
    const elevated = actor.role === "admin";
    if (!elevated && actor.branchId != null && Number(inv.branchId) !== actor.branchId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك إسناد فاتورة فرعٍ آخر" });
    }
    if (party.branchId != null && Number(party.branchId) !== Number(inv.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "جهة التوصيل لا تخصّ فرع الفاتورة" });
    }
    if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُسنَد فاتورة ملغاة أو مرتجعة للتوصيل" });
    }
    // مراجعة عدائية ٩/٨ — ازدواج عهدة عبر القناتين: فاتورة طلب متجر (ONLINE) عهدتها تُدار من
    // مسار المتجر (تأكيد المندوب في «توصيلاتي» يرفعها بمفتاح ONLINE_COD_CUSTODY) — إسنادُها
    // إرساليةً هنا يرفعها **ثانيةً** بمفتاح dedupe مختلف ⇒ رصيد المندوب ضعف النقد الذي بيده،
    // وإرسالية لا تُسوَّى أبداً (متبقّي الفاتورة يصفر من الجهة الأخرى).
    if (inv.sourceType === "ONLINE" && input.onlineOrderId == null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "فاتورة طلب متجر إلكتروني — إسناد المندوب من شاشة طلبات المتجر لا من هنا (عهدتها تُدار هناك)" });
    }
    // حارس بنيويّ مساند لقيد uq_consignment_invoice: رسالةٌ مفهومة بدل خطأ قاعدة بيانات.
    const already = (await tx.select({ id: deliveryConsignments.id, n: deliveryConsignments.consignmentNumber })
      .from(deliveryConsignments).where(eq(deliveryConsignments.invoiceId, input.invoiceId)).limit(1))[0];
    if (already) {
      throw new TRPCError({ code: "CONFLICT", message: `الفاتورة مُسنَدة أصلاً للإرسالية ${already.n}` });
    }

    const fee = round2(money(input.deliveryFee ?? party.defaultFee ?? "0"));
    if (fee.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "أجرة التوصيل لا تصحّ أن تكون سالبة" });

    // COD = ما تبقّى على الفاتورة فقط (مالُنا). الأجرة **ليست** جزءاً منه — تمريرٌ للمندوب.
    // مراجعة عدائية ٩/٨: يُطرح returnedTotal أيضاً — مرتجعٌ جزئي قبل الإسناد كان يُنتج codAmount
    // منتفخاً بقيمته ⇒ عهدة وهمية على المندوب لا يمكن توريدها (حزام التوريد يسقفها بمتبقّي
    // الفاتورة الحيّ) فتعلق PARTIAL للأبد.
    const codAmount = round2(money(inv.total).minus(money(inv.returnedTotal ?? "0")).minus(money(inv.paidAmount ?? "0")));
    if (codAmount.lt(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة مدفوعةٌ بأكثر من قيمتها — راجعها قبل الإسناد" });
    const codPositive = codAmount.gt(0);
    // الأجرة تُصرَف الآن حين لا توريدَ يُنتظَر (نفس قاعدة dispatch.ts). بعد حظر COUNTER (ش٠)
    // بقي مسارٌ واحد للصرف الفوريّ: SHOP بفاتورةٍ مدفوعة كاملاً (codAmount=0) — لا توريد يُخصم منه.
    // تدقيق ٦/٨ (ث١): الشرط القديم `SHOP && !codPositive` كان يستثني COUNTER تماماً — وفاتورة
    // الاستقبال المدفوعة كاملاً تُنتج codAmount=0 فتولد الإرسالية DELIVERED ولا يراها التوريد
    // أبداً ⇒ أجرةٌ قبضناها من الزبون أمانةً **لا تصل المندوب إطلاقاً** وتبقى في الدرج بلا
    // مالك. مطابقةٌ الآن لمسار أمر الشغل (dispatch.ts): COUNTER تُصرف فوراً دائماً (قبضناها
    // بالفعل)، وSHOP تُصرف حين لا توريدَ يُخصم منه.
    const consignmentNumber = await nextConsignmentNumber(tx, Number(inv.branchId));
    const cnRes = await tx.insert(deliveryConsignments).values({
      consignmentNumber,
      branchId: Number(inv.branchId),
      partyId: input.partyId,
      invoiceId: Number(inv.id),
      workOrderId: null,
      sourceType: input.onlineOrderId != null ? "ONLINE_ORDER" : "INVOICE",
      sourceId: input.onlineOrderId != null ? Number(input.onlineOrderId) : Number(inv.id),
      assignedUserId,
      endCustomerId: inv.customerId ?? null,
      codAmount: toDbMoney(codAmount),
      collectedAmount: "0",
      deliveryFee: toDbMoney(fee),
      feeCollection,
      feeSettledAt: null,
      recipientName: input.recipientName ?? inv.contactName ?? null,
      recipientPhone: input.recipientPhone ?? inv.contactPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? null,
      parcelStatus: "ASSIGNED",
      moneyStatus: codPositive ? "UNSETTLED" : "NOT_APPLICABLE",
      // اكتمال الدفع لا يثبت وصول الطرد؛ أبقه تشغيلياً مع المندوب حتى ختم التسليم.
      status: "DISPATCHED",
      settledAt: codPositive ? null : new Date(),
      dispatchedBy: actor.userId,
    });
    const consignmentId = extractInsertId(cnRes);

    if (codPositive) {
      // تدقيق ٦/٨ (ث٧): `floatLimit` كان يُدخَل في شاشة الجهة ولا يقرؤه أيّ مسار إسناد ⇒ سقفٌ
      // مسرحيّ. يُنفَّذ الآن: عهدةٌ تتجاوز السقف تُرفض (تراكمُ نقدٍ بيد مندوبٍ بلا حدّ = خطر).
      // مراجعة PR #495: الحارس صار **مشتركاً** (parties.assertFloatLimit) فلا ينحرف مساران.
      await assertFloatLimitTx(tx, party, codAmount);
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${consignmentId}:COD_ASSIGNED`,
        partyId: input.partyId,
        consignmentId,
        branchId: Number(inv.branchId),
        entryType: "COD_ASSIGNED",
        amount: toDbMoney(codAmount),
        actorUserId: actor.userId,
      });
    }

    await appendDeliveryEvent(tx, {
      eventKey: `CN:${consignmentId}:ASSIGNED`,
      consignmentId,
      eventType: "ASSIGNED",
      toParcelStatus: "ASSIGNED",
      toMoneyStatus: codPositive ? "UNSETTLED" : "NOT_APPLICABLE",
      actorUserId: actor.userId,
      payload: {
        partyId: input.partyId,
        sourceType: input.onlineOrderId != null ? "ONLINE_ORDER" : "INVOICE",
        sourceId: input.onlineOrderId != null ? Number(input.onlineOrderId) : Number(inv.id),
      },
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(tx, "delivery.dispatchInvoice", input.clientRequestId, consignmentId, payloadHash);
    }
    return {
      consignmentId,
      consignmentNumber,
      invoiceId: Number(inv.id),
      invoiceNumber: inv.invoiceNumber,
      codAmount: codAmount.toFixed(2),
      deliveryFee: fee.toFixed(2),
    };
  }
}
