import { returnFulfillmentRequestConsignmentTx } from "../fulfillment/requestSources";
import { routeAftercareDeliveryResultTx } from "../fulfillment/aftercareDelivery";
import { loadRefundCaps } from "../returns/refundCaps";
import { createPendingDeliveryRefundTx, deliveryRefundError } from "./paymentRefunds";
// إرجاع إرسالية (البضاعة عادت): عكس SALE + إعادة مخزون + عكس العهدة + رد العربون.
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import type Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { deliveryConsignments, deliveryParties, inventoryMovements, invoiceItemBundleComponents, invoiceItems, invoices, onlineOrders, productVariants, products, receipts, workOrders } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { applyValuedInboundMovement } from "../inventoryService";
import { classifyVariants } from "../bundleService";
import { createPostingIntent, signedPostingLines, type AccountRole, type PostingSourceComponents } from "../accounting/postingEngine";
import { adjustCustomerBalance, adjustDeliveryBalance, adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { classifyGiftPosting } from "../sale/giftPosting";
import { resolveBranchCashShiftTx } from "../shiftService";
import {
  assertCashOutAvailable,
  lockCashSourceForUpdate,
  MATERIALIZED_RECEIPT_STATUSES,
} from "../cash/cashAvailability";
import { withTx } from "../tx";
import { appendDeliveryEvent, appendDeliveryLedgerEntry, assertConsignmentStatusTransition } from "./lifecycle";
import { deliveryCustomerRefundIntent, deliveryFeeHeldPayoutIntent, deliveryReturnSaleIntent, type DeliveryReturnSaleKind } from "./posting";
import type { DeliveryTxActor } from "./types";
import type { Tx } from "../../db";
import { assertStandaloneConsignmentTx } from "./shipments";
import { physicalReturnReceiptTx } from "./workflow/returnReceipt";

/** Existing held-fee refund, shared when the original fee invoice has left a shipment. Caller prelocks cash source then party/CNs. */
export async function refundHeldDeliveryFeeForReturnTx(
  tx: Tx,
  cn: typeof deliveryConsignments.$inferSelect,
  actor: DeliveryTxActor,
  prelockedReturnShift: { shiftId: number } | null,
) {
  if (cn.invoiceId==null)
    throw deliveryRefundError(
      "مصدر الإرسالية لا يحمل فاتورة؛ استخدم مسار المصدر المخصص",
    );
  return refundHeldInvoiceFeeTx(
    tx,
    {
      invoiceId: Number(cn.invoiceId),
      branchId: Number(cn.branchId),
      consignmentId: Number(cn.id),
      consignmentNumber: cn.consignmentNumber,
      feeSettledAt: cn.feeSettledAt,
      consignment: cn,
    },
    actor,
    prelockedReturnShift,
  );
}

/** Actual invoice-fee writer shared by a return and an explicit pre-dispatch excess refund. */
export async function refundHeldInvoiceFeeTx(
  tx: Tx,
  source: {
    invoiceId: number;
    branchId: number;
    consignmentId?: number;
    consignmentNumber?: string;
    feeSettledAt?: Date | null;
    sourceNumber?: string;
    reason?: string;
    purpose?: "CONSOLIDATION";
    approvedByManagerId?: number | null;
    consignment?: typeof deliveryConsignments.$inferSelect;
  },
  actor: DeliveryTxActor,
  prelockedReturnShift: { shiftId: number } | null,
) {
  if (source.invoiceId == null)
    throw deliveryRefundError("مصدر الإرسالية لا يحمل فاتورة؛ استخدم مسار رد مصدر المعالجة المخصص");
  const heldRef = `DLV-FEE-INV-${Number(source.invoiceId)}`;
    const feeHeldRows = await tx
      .select({ id:receipts.id,direction: receipts.direction, amount: receipts.amount, referenceNumber: receipts.referenceNumber,paymentMethod:receipts.paymentMethod })
      .from(receipts)
      .where(
      and(
        eq(receipts.invoiceId, Number(source.invoiceId)),
        inArray(
          receipts.referenceNumber,
          source.consignmentNumber == null
            ? [heldRef]
            : [heldRef, source.consignmentNumber],
        ),
        inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
        eq(receipts.approvalStatus, "APPROVED"),
      ),
    )
      // current read after the source mutex: a stale snapshot must never authorize a refund.
      .for("update");
    const feeHeldNet = round2(feeHeldRows.reduce(
      (sum, receipt) => receipt.direction === "IN"
        ? sum.plus(money(receipt.amount))
        : sum.minus(money(receipt.amount)),
      money(0),
    ));
    // الإفصاح: أمانةٌ قُبضت فعلاً (وارِدٌ موجب) ثم غادرت الدرج إلى المندوب ⇒ لا التزامَ باقياً
    // نُحرّره، لكن الكاشير يجب أن يعلم (ردُّها للزبون قرارُ إدارةٍ يُسجَّل مصروفاً).
    const feeCollected = round2(feeHeldRows.reduce(
      (sum, receipt) => receipt.direction === "IN" && receipt.referenceNumber === heldRef
        ? sum.plus(money(receipt.amount))
        : sum,
      money(0),
    ));
  const feeAlreadyPaidToCourier =
    source.feeSettledAt != null && feeCollected.gt(0);
    let pendingFeeRefundReceiptId:number|null=null;
  if (feeHeldNet.gt(0) && source.feeSettledAt == null) {
      const sources=feeHeldRows.filter(r=>r.direction==="IN"&&r.referenceNumber===heldRef);
      if(sources.length!==1)throw deliveryRefundError("إيصال أمانة الأجرة الأصلي غير محدد؛ راجع مصادر القبض قبل الرد");
    const original = sources[0];
    if (original.paymentMethod !== "CASH") {
      if (
        !["CARD","TRANSFER","WALLET","CHECK"].includes(
          original.paymentMethod,
        )
      )
        throw deliveryRefundError("وسيلة قبض الأجرة القديمة تحتاج مسار تسوية متخصص");
      const invoice = (
        await tx.select({customerId:invoices.customerId}).from(invoices).where(eq(invoices.id, Number(source.invoiceId)))
          .limit(1)
      )[0];
      pendingFeeRefundReceiptId = await createPendingDeliveryRefundTx(
        tx,
        {
          ...(source.consignmentId == null
            ? {
                invoiceSource: {
                  invoiceId: source.invoiceId,
                  branchId: source.branchId,
                  sourceNumber: source.sourceNumber ?? String(source.invoiceId),
                },
              }
            : { cn: source.consignment! }),
          kind: "FEE",
          method: original.paymentMethod as
            "CARD"|"TRANSFER"|"WALLET"|"CHECK",
          amount: toDbMoney(feeHeldNet),
          sourceReceiptIds: [Number(original.id)],
          customerId:invoice?.customerId??null,
        },
        actor,
      );
    } else {
      const feeShift = prelockedReturnShift;
      if (!feeShift) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "تغيّرت أمانة أجرة التوصيل أثناء الإرجاع؛ أعد المحاولة",
        });
      }
      await assertCashOutAvailable(tx, {
        branchId: Number(source.branchId),
        cashBucket: "DRAWER",
        shiftId: feeShift.shiftId,
        amount: feeHeldNet,
        operation: "رد أمانة أجرة التوصيل",
      });
      const feeOut = await tx.insert(receipts).values({
        branchId: Number(source.branchId),
        shiftId: feeShift.shiftId,
        invoiceId: Number(source.invoiceId),
        direction: "OUT",
        amount: toDbMoney(feeHeldNet),
        paymentMethod: "CASH",
        cashBucket: "DRAWER",
        status: "COMPLETED",
        partyType: "OTHER",
        referenceNumber: `DLV-FEE-INV-${Number(source.invoiceId)}`,
        description:
          source.reason ??
          `ردّ أمانة أجرة توصيل — إرجاع ${source.consignmentNumber}`,
        createdBy: actor.userId,
        ...(source.approvedByManagerId == null
          ? {}
          : { approvedBy: source.approvedByManagerId, approvedAt: new Date() }),
      });
      await postEntry(tx, {
        entryType: "DELIVERY_FEE_HELD",
        postingIntent: deliveryFeeHeldPayoutIntent(feeHeldNet.neg(), "DRAWER"),
        postingSourceComponents: {
          roleDebits: { COURIER_PAYABLE: feeHeldNet },
          roleCredits: { CASH: feeHeldNet },
        },
        dedupeKey:
          source.consignmentId == null
            ? `DELIVERY_FEE_HELD_REFUND:INV:${source.invoiceId}`
            : `DELIVERY_FEE_HELD_REFUND:${source.consignmentId}`,
        branchId: Number(source.branchId),
        invoiceId: Number(source.invoiceId),
        receiptId: extractInsertId(feeOut),
        amount: feeHeldNet.neg(),
        notes:
          source.reason ??
          `ردّ أمانة أجرة توصيل — إرجاع ${source.consignmentNumber}`,
      });
    }
  }
  return { feeAlreadyPaidToCourier,pendingFeeRefundReceiptId };
}

/** إرجاع إرسالية (البضاعة عادت): عكس SALE + إعادة مخزون + عكس العهدة + رد العربون. مقيَّد بـDISPATCHED (collected==0). */
export async function returnConsignment(
  consignmentId: number,
  actor: DeliveryTxActor & {
    clientRequestId?: string | null;
    refundShiftId?: number | null;
    /**
     * سببُ رجوع الطرد — **إلزاميّ عملياً حين يكون الطرد بيد السائق** (١٨/٨): عندئذٍ يُوسَم
     * متعذّراً داخل نفس المعاملة قبل إرجاعه، والسببُ هو ما يميّز «العميل رفض» من «العنوان
     * خاطئ» من «تعذّر الوصول» في تقارير المتابعة. غيابه على طردٍ لم يخرج بعد لا يضرّ.
     */
    returnReason?: string | null;
  },
  existingTx?: Tx,
  options: { shipmentMember?: boolean } = {},
) {
  const run = async (tx: Tx) => {
    const sourcePreview=(await tx.select({sourceType:deliveryConsignments.sourceType,invoiceId:deliveryConsignments.invoiceId}).from(deliveryConsignments).where(eq(deliveryConsignments.id,consignmentId)).limit(1))[0];
    if(sourcePreview?.sourceType==="AFTERCARE_EXECUTION"){
    const sourceResult=await routeAftercareDeliveryResultTx(tx,{consignmentId,result:"RETURNED",proof:actor.returnReason??"",clientRequestId:actor.clientRequestId??`aftercare-return:${consignmentId}`,
      authorization:{kind:"STAFF",operationPath:"delivery.returnConsignment",operationAuthority:actor.operationAuthority}},actor);
    if(sourceResult.handled)return{consignmentId,reversed:true as const,idempotentReplay:sourceResult.replay,invoiceId:null,feeAlreadyPaidToCourier:false,pendingFeeRefundReceiptId:null,pendingGoodsRefundReceiptIds:[] as number[],deliveryFee:"0.00"};
    }
    if(sourcePreview?.sourceType==="FULFILLMENT_REQUEST"&&sourcePreview.invoiceId==null){
    const requestSource=await returnFulfillmentRequestConsignmentTx(tx,{consignmentId,reason:actor.returnReason??"",clientRequestId:actor.clientRequestId??`request-return:${consignmentId}`},actor);
    if(requestSource.handled)return{consignmentId,reversed:true as const,idempotentReplay:false,invoiceId:null,feeAlreadyPaidToCourier:false,pendingFeeRefundReceiptId:null,pendingGoodsRefundReceiptIds:[] as number[],deliveryFee:"0.00"};
    }
    const payloadHash = idempotencyHash({ consignmentId, refundShiftId: actor.refundShiftId ?? null });
    // مراجعة PR #495 (عزل الفرع) — الإرجاع صار `cashierProcedure` بقرار المالك ٦/٨، وبخلاف
    // remit/settle لا يمرّ بـassertPartyInScope في الراوتر (الجهة تُعرَف من الإرسالية لا من
    // المدخل) ⇒ كاشير فرعٍ كان يعكس فاتورة فرعٍ آخر ومخزونَه ويُنقص عهدة مندوبه ويردّ عربوناً
    // من أحد أدراجه بمجرّد تمرير مُعرّف إرسالية. الحارس **قبل** إعادة التشغيل idempotent وقبل
    // أيّ كتابة (قراءة خفيفة بلا قفل — القفل الحقيقيّ أدناه يعيد قراءة الصفّ كاملاً).
    // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران الفروع (owner مُطبَّع ⇒ admin)؛
    // المدير صار مقيَّداً بفرعه (كان `|| manager` يعكس إرسالية فرعٍ آخر ويردّ عربوناً من أدراجه).
    const cnPreview = (
      await tx
        .select({
          id: deliveryConsignments.id,
          branchId: deliveryConsignments.branchId,
          partyId: deliveryConsignments.partyId,
          invoiceId: deliveryConsignments.invoiceId,
          consignmentNumber: deliveryConsignments.consignmentNumber,
          feeSettledAt: deliveryConsignments.feeSettledAt,
        })
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, consignmentId))
        .limit(1)
    )[0];
    if (!cnPreview) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    if(cnPreview.invoiceId==null)throw deliveryRefundError("مصدر الإرسالية لا يحمل فاتورة صالحة لمسار مرتجع البيع؛ استخدم مسار المصدر المخصص");
    const scopedBranch = actor.role === "admin" ? null : (actor.branchId ?? null);
    if (scopedBranch != null && Number(cnPreview.branchId) !== scopedBranch) {
      throw new TRPCError({ code: "FORBIDDEN", message: "الإرسالية تخصّ فرعاً آخر" });
    }
    if (actor.clientRequestId) {
      const existingId = await checkIdempotency(tx, "delivery.return", actor.clientRequestId, payloadHash);
      if (existingId != null) {
        if (Number(existingId) !== Number(consignmentId)) throw new TRPCError({ code: "CONFLICT", message: "مفتاح الإرجاع مرتبط بإرسالية أخرى" });
        return { consignmentId, reversed: true as const, idempotentReplay: true as const };
      }
    }
    const invPreview = (
      await tx.select({ paidAmount: invoices.paidAmount }).from(invoices)
        .where(eq(invoices.id, Number(cnPreview.invoiceId))).limit(1)
    )[0];
    if (!invPreview) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الإرسالية غير موجودة" });
    const feeRefs = [`DLV-FEE-INV-${Number(cnPreview.invoiceId)}`, String(cnPreview.consignmentNumber)];
    const previewFeeRows = cnPreview.feeSettledAt == null
      ? await tx.select({ direction: receipts.direction, amount: receipts.amount,paymentMethod:receipts.paymentMethod }).from(receipts).where(and(
          eq(receipts.invoiceId, Number(cnPreview.invoiceId)),
          inArray(receipts.referenceNumber, [...feeRefs]),
          inArray(receipts.status, [...MATERIALIZED_RECEIPT_STATUSES]),
          eq(receipts.approvalStatus, "APPROVED"),
        ))
      : [];
    const previewFeeNet = previewFeeRows.reduce(
      (sum, receipt) => receipt.paymentMethod!=="CASH"?sum:receipt.direction === "IN" ? sum.plus(money(receipt.amount)) : sum.minus(money(receipt.amount)),
      money(0),
    );
    const previewGoodsCap=money(invPreview.paidAmount).gt(0)?await loadRefundCaps(tx,Number(cnPreview.invoiceId)):null;
    const previewNeedsCash = (previewGoodsCap?.netByMethod.get("CASH")??money(0)).gt(0) || previewFeeNet.gt(0);
    let prelockedReturnShift: { shiftId: number; openingBalance: string } | null = null;
    if (previewNeedsCash) {
      prelockedReturnShift = await resolveBranchCashShiftTx(
        tx,
        Number(cnPreview.branchId),
        actor.refundShiftId ?? null,
      );
      await lockCashSourceForUpdate(tx, {
        branchId: Number(cnPreview.branchId),
        cashBucket: "DRAWER",
        shiftId: prelockedReturnShift.shiftId,
      });
    }
    // الترتيب الموحد لمسارات التوصيل: source→party→consignment→invoice.
    const party = (
      await tx.select().from(deliveryParties).where(eq(deliveryParties.id, Number(cnPreview.partyId)))
        .for("update").limit(1)
    )[0];
    if (!party) throw new TRPCError({ code: "CONFLICT", message: "جهة توصيل الإرسالية غير موجودة" });
    if (!options.shipmentMember) await assertStandaloneConsignmentTx(tx, consignmentId, "استلام المرتجع", { currentRead: true });
    const cn = (await tx.select().from(deliveryConsignments).where(eq(deliveryConsignments.id, consignmentId)).for("update").limit(1))[0];
    if (!cn) throw new TRPCError({ code: "NOT_FOUND", message: "الإرسالية غير موجودة" });
    if (
      Number(cn.branchId) !== Number(cnPreview.branchId) ||
      Number(cn.partyId) !== Number(cnPreview.partyId) ||
      Number(cn.invoiceId) !== Number(cnPreview.invoiceId)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّرت أطراف الإرسالية أثناء الإرجاع؛ أعد المحاولة" });
    }
    const replayAfterLock = await checkIdempotency(tx, "delivery.return", actor.clientRequestId, payloadHash);
    if (replayAfterLock != null) return { consignmentId, reversed: true as const, idempotentReplay: true as const };
    if (cn.status !== "DISPATCHED" || cn.moneyStatus === "PARTIAL" || cn.moneyStatus === "SETTLED") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "يُرجَع فقط طرد لم يُحصَّل منه شيء؛ بعد التحصيل استعمل مرتجعات البيع" });
    }
    const physicalReceipt = await physicalReturnReceiptTx(tx, cn);
    if (cn.parcelStatus === "DELIVERED" || (cn.parcelStatus === "RETURNED" && !physicalReceipt)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الطرد مسلّم للعميل؛ نفّذ مرتجع بيع موثقاً بدل إرجاع الشحنة" });
    }
    // ١٨/٨ (بلاغ المالك: «المندوب يرجع الفاتورة والطلب إلى المكتبة» — حدثٌ يوميّ):
    // كان الإرجاع محصوراً بـASSIGNED|FAILED، وتسجيلُ FAILED **حصريٌّ ببوّابة المندوب**؛ وأغلب
    // الجهات بلا حسابات ⇒ طردٌ بيد السائق لا مخرج له إطلاقاً. الآن: الطرد الراجع فعلاً إلى
    // الفرع يُوسَم متعذّراً **داخل نفس المعاملة** بسببٍ إلزاميّ (سلسلة أحداث سليمة: FAILED ثم
    // RETURNED) بدل مطالبة الموظّف بزرٍّ لا يملكه.
    const inTransitParcel = cn.parcelStatus === "ACCEPTED"
      || cn.parcelStatus === "PICKED_UP"
      || cn.parcelStatus === "OUT_FOR_DELIVERY";
    if (inTransitParcel) {
      const reason = (actor.returnReason ?? "").trim();
      if (reason.length < 2) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "الطرد بعهدة السائق — اذكر سبب رجوعه (رفض العميل / عنوان خاطئ / تعذّر الوصول…)",
        });
      }
      const fromParcelStatus = cn.parcelStatus;
      await tx
        .update(deliveryConsignments)
        .set({ parcelStatus: "FAILED", failedAt: new Date(), failureReason: reason.slice(0, 255) })
        .where(eq(deliveryConsignments.id, consignmentId));
      await appendDeliveryEvent(tx, {
        eventKey: `PARCEL_FAILED:RETURN:${consignmentId}`,
        consignmentId,
        eventType: "PARCEL_FAILED",
        fromParcelStatus,
        toParcelStatus: "FAILED",
        actorUserId: actor.userId,
        payload: { reason, source: "STAFF_RETURN" },
      });
      cn.parcelStatus = "FAILED";
    } else if (cn.parcelStatus !== "ASSIGNED" && cn.parcelStatus !== "FAILED" && !physicalReceipt) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "حالة الطرد لا تسمح بالإرجاع من هنا" });
    }
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, Number(cn.invoiceId))).for("update").limit(1))[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الإرسالية غير موجودة" });
    // تدقيق ٦/٨ (ث٤): حارسٌ متبادل مع شاشة المرتجعات — فاتورةٌ أُرجع منها شيءٌ سلفاً يقيّد هنا
    // RETURN بكامل الإجمالي ويُعيد **كل** البنود للمخزون ⇒ إيرادٌ معكوسٌ مرّتين ومخزونٌ مضاعف.
    if (money(inv.returnedTotal ?? "0").gt(0)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الفاتورة أُرجع منها سلفاً (${money(inv.returnedTotal ?? "0").toFixed(2)}) — أكمل الإرجاع من شاشة المرتجعات لا من هنا (وإلّا انعكس البيع مرّتين)`,
      });
    }

    const items = await tx
      .select({
        id: invoiceItems.id,
        variantId: invoiceItems.variantId,
        total: invoiceItems.total,
        unitCost: invoiceItems.unitCost,
        lineCost: invoiceItems.lineCost,
        baseQuantity: invoiceItems.baseQuantity,
        isGift: invoiceItems.isGift,
        isService: products.isService,
        isConsignment: products.isConsignment,
        consignorId: products.consignorId,
        productType: products.productType,
      })
      .from(invoiceItems)
      .innerJoin(productVariants, eq(invoiceItems.variantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(eq(invoiceItems.invoiceId, Number(cn.invoiceId)));

    const itemVariantIds = Array.from(new Set(items.map((item) => Number(item.variantId))));
    const kindByVariant = await classifyVariants(tx, itemVariantIds);
    const bundleItemIds = items
      .filter((item) => kindByVariant.get(Number(item.variantId)) === "BUNDLE")
      .map((item) => Number(item.id));
    const bundleSnapshotByItem = new Map<number, Array<{
      componentVariantId: number;
      componentBaseQuantity: number;
      issueUnitCost: string | null;
      issueLineCost: string | null;
    }>>();
    if (bundleItemIds.length) {
      const snapshots = await tx
        .select({
          invoiceItemId: invoiceItemBundleComponents.invoiceItemId,
          componentVariantId: invoiceItemBundleComponents.componentVariantId,
          componentBaseQuantity: invoiceItemBundleComponents.componentBaseQuantity,
          issueUnitCost: invoiceItemBundleComponents.issueUnitCost,
          issueLineCost: invoiceItemBundleComponents.issueLineCost,
        })
        .from(invoiceItemBundleComponents)
        .where(inArray(invoiceItemBundleComponents.invoiceItemId, bundleItemIds));
      for (const snapshot of snapshots) {
        const itemId = Number(snapshot.invoiceItemId);
        const list = bundleSnapshotByItem.get(itemId) ?? [];
        list.push({
          componentVariantId: Number(snapshot.componentVariantId),
          componentBaseQuantity: Number(snapshot.componentBaseQuantity),
          issueUnitCost: snapshot.issueUnitCost,
          issueLineCost: snapshot.issueLineCost,
        });
        bundleSnapshotByItem.set(itemId, list);
      }
    }

    // نبني العائد المادي من لقطة البيع نفسها: السلعة المخزنية وقِطع البكج فقط. سطر الخدمة
    // وخاماتُه المستهلكة لا يعودان تلقائياً لمجرد رجوع الطرد، وناتج أمر الشغل ملكٌ للعميل
    // وليس صنفاً جاهزاً في branchStock. ثم نطابق الكميات مع OUT الأصلي كدليل خروج.
    const stockOps = new Map<number, { quantity: number; historicalValue: Decimal }>();
    const restockedItemIds = new Set<number>();
    if (inv.sourceType !== "WORKORDER") {
      for (const item of items) {
        const itemId = Number(item.id);
        const variantId = Number(item.variantId);
        const kind = kindByVariant.get(variantId) ?? "STOCKED";
        if (kind === "SERVICE") continue;
        if (kind === "BUNDLE") {
          const snapshots = bundleSnapshotByItem.get(itemId) ?? [];
          if (!snapshots.length) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: appErrorMessage({
                what: "تعذّر استلام بكج الإرسالية إلى المخزون",
                why: `البند ${itemId} لا يحمل لقطة مكوّنات البيع، وإرجاع وصفة اليوم قد يضيف أصنافاً لم تخرج أصلاً`,
                doThis: "أوقف الإرجاع وافتح مهمة مراجعة للمستند الأصلي لتوثيق المكونات والكميات التاريخية ثم أعد المحاولة",
              }),
            });
          }
          for (const snapshot of snapshots) {
            const quantity = snapshot.componentBaseQuantity * Number(item.baseQuantity);
            const historicalValue = snapshot.issueLineCost != null
              ? money(snapshot.issueLineCost)
              : snapshot.issueUnitCost != null
                ? round2(money(snapshot.issueUnitCost).times(quantity))
                : null;
            if (historicalValue == null) {
              throw new TRPCError({
                code: "CONFLICT",
                message: appErrorMessage({
                  what: "تعذّر تقييم مكوّن البكج الراجع",
                  why: `لقطة البند ${itemId} لا تحمل قيمة صرف تاريخية للمكوّن #${snapshot.componentVariantId}، ولا يجوز استعمال تكلفة اليوم`,
                  doThis: "أوقف الإرجاع وافتح مهمة مراجعة تكلفة للمستند الأصلي؛ بعد توثيق قيمة الصرف التاريخية أعد المحاولة",
                }),
              });
            }
            const current = stockOps.get(snapshot.componentVariantId) ?? {
              quantity: 0,
              historicalValue: money(0),
            };
            current.quantity += quantity;
            current.historicalValue = current.historicalValue.plus(historicalValue);
            stockOps.set(snapshot.componentVariantId, current);
          }
          restockedItemIds.add(itemId);
          continue;
        }
        const current = stockOps.get(variantId) ?? {
          quantity: 0,
          historicalValue: money(0),
        };
        current.quantity += Number(item.baseQuantity);
        current.historicalValue = current.historicalValue.plus(money(item.lineCost));
        stockOps.set(variantId, current);
        restockedItemIds.add(itemId);
      }
    }

    const originalOut = await tx
      .select({
        variantId: inventoryMovements.variantId,
        quantity: inventoryMovements.quantity,
      })
      .from(inventoryMovements)
      .where(and(
        eq(inventoryMovements.branchId, Number(cn.branchId)),
        eq(inventoryMovements.movementType, "OUT"),
        /**
         * ⭐ رافدا خصمِ المخزون كلاهما (تدقيق ١/٩/٢٦): `sale/create.ts` يَسِم حركاته
         * `INVOICE`، بينما `printSaleService.ts` يَسِمها **`PRINT_SALE`** (:606 و:624).
         * الشرط على `INVOICE` وحده كان يُرجع **صفرَ حركات** لفاتورة كاشير الطباعة، فيُعكَس
         * البيع في الدفتر والذمّة ولا تعود قطعةٌ واحدة إلى الرفّ: انفصالٌ تامّ بين الدفتر
         * والمخزون على القناة التي تعمل — «يبتلع المخزن ولا يعكس المخزنية» حرفياً.
         * `referenceId` هو `invoiceId` في كلتا الحالتين، والاختلاف في الوسم وحده.
         */
        inArray(inventoryMovements.referenceType, ["INVOICE", "PRINT_SALE"]),
        eq(inventoryMovements.referenceId, Number(cn.invoiceId)),
      ));
    const issuedByVariant = new Map<number, number>();
    for (const movement of originalOut) {
      const variantId = Number(movement.variantId);
      issuedByVariant.set(variantId, (issuedByVariant.get(variantId) ?? 0) + Number(movement.quantity));
    }
    for (const [variantId, operation] of Array.from(stockOps.entries())) {
      const issued = issuedByVariant.get(variantId) ?? 0;
      if (issued < operation.quantity) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذّر إثبات كمية البضاعة الراجعة",
            why: `المستند يطلب إعادة ${operation.quantity} من الصنف #${variantId} بينما حركات الصرف الأصلية المثبتة ${issued} فقط`,
            doThis: "أوقف الإرجاع وافتح مهمة مراجعة للمستند وحركات الصرف؛ صحّح الدليل التاريخي قبل أي إضافة للمخزون",
          }),
        });
      }
    }
    // تطبيق مجمَّع بترتيب variantId تصاعدي، بالقيمة التاريخية لا بتكلفة الصنف الحالية.
    const sortedVids = Array.from(stockOps.keys()).sort((a, b) => a - b);
    for (const vid of sortedVids) {
      const operation = stockOps.get(vid)!;
      if (operation.quantity <= 0) continue;
      await applyValuedInboundMovement(tx, {
        variantId: vid, branchId: Number(cn.branchId), baseQuantity: operation.quantity,
        historicalValue: operation.historicalValue,
        movementType: "RETURN", referenceType: "DELIVERY_RETURN", referenceId: consignmentId,
        documentNumber: cn.consignmentNumber, createdBy: actor.userId,
      });
    }

    // عكس البيع: قيد RETURN بقيم سالبة.
    // تدقيق ٦/٨ (ث٣): الفاتورة قد تحمل عميلاً مسجَّلاً (مسار إسناد الفاتورة يُبقي customerId
    // بخلاف مسار أمر الشغل) ⇒ التعليق القديم «لا AR — customerId=NULL» صار خاطئاً: البضاعة
    // عادت للرفّ والعميل يبقى مديناً بها للأبد. القيد يُختَم بالعميل، والذمّة تُخصَم أدناه.
    const total = money(inv.total);
    const tax = round2(money(inv.taxAmount ?? "0"));
    const deliveryRevenue = round2(money(inv.deliveryFee ?? "0"));
    const sectorRevenue = round2(total.minus(tax).minus(deliveryRevenue));

    // Mirror sale/create.ts exactly: discounts are allocated over paid lines,
    // and each source sector reverses the revenue role it originally credited.
    const revenueItems = items
      .filter((item) => !item.isGift && money(item.total).gt(0))
      .sort((a, b) => Number(a.id) - Number(b.id));
    const revenueBasis = revenueItems.reduce((sum, item) => sum.plus(money(item.total)), money(0));
    const revenueByRole = new Map<AccountRole, Decimal>();
    const returnClasses = new Set<"DIGITAL" | "SERVICE" | "CONSIGNMENT" | "INVENTORY">();
    let allocatedRevenue = money(0);
    for (let index = 0; index < revenueItems.length; index++) {
      const item = revenueItems[index]!;
      const amount = index === revenueItems.length - 1
        ? round2(sectorRevenue.minus(allocatedRevenue))
        : round2(sectorRevenue.times(money(item.total)).div(revenueBasis));
      allocatedRevenue = allocatedRevenue.plus(amount);
      const returnClass = item.productType === "DIGITAL_CARD"
        ? "DIGITAL"
        : item.isService
          ? "SERVICE"
          : item.isConsignment
            ? "CONSIGNMENT"
            : "INVENTORY";
      returnClasses.add(returnClass);
      const role: AccountRole = inv.sourceType === "WORKORDER"
        ? "SALES_FLEX"
        : returnClass === "DIGITAL"
          ? "OTHER_REVENUE"
          : returnClass === "SERVICE"
            ? "SALES_PRINT"
            : "SALES_STATIONERY";
      revenueByRole.set(role, round2((revenueByRole.get(role) ?? money(0)).plus(amount)));
    }
    const returnKind: DeliveryReturnSaleKind = inv.sourceType === "WORKORDER"
      ? "WORK_ORDER_SERVICE"
      : returnClasses.size > 1
        ? "MIXED"
        : returnClasses.has("DIGITAL")
          ? "DIGITAL"
          : returnClasses.has("SERVICE")
            ? "SERVICE"
            : returnClasses.has("CONSIGNMENT")
              ? "CONSIGNMENT"
              : "INVENTORY";

    const byConsignor = new Map<number, { paid: Decimal; gift: Decimal }>();
    let ownedInventoryCost = money(0);
    let giftCost = money(0);
    let ownedGiftCost = money(0);
    for (const item of items) {
      // لا نعكس تكلفةً ولا استحقاق مودِع إلا لما عاد فعلياً إلى المخزون. الخدمة
      // وناتج أمر الشغل يبقيان خارج حركة IN حتى لو عُكست تجارتهما.
      if (!restockedItemIds.has(Number(item.id))) continue;
      const share = money(item.lineCost);
      if (item.isGift) {
        giftCost = giftCost.plus(share);
        if (!item.isConsignment) ownedGiftCost = ownedGiftCost.plus(share);
      } else if (!item.isConsignment) {
        ownedInventoryCost = ownedInventoryCost.plus(share);
      }
      if (item.isConsignment) {
        if (item.consignorId == null) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `صنف أمانة بلا مودع في الفاتورة ${inv.invoiceNumber}` });
        }
        const consignorId = Number(item.consignorId);
        const split = byConsignor.get(consignorId) ?? { paid: money(0), gift: money(0) };
        if (item.isGift) split.gift = split.gift.plus(share);
        else split.paid = split.paid.plus(share);
        byConsignor.set(consignorId, split);
      }
    }
    ownedInventoryCost = round2(ownedInventoryCost);
    giftCost = round2(giftCost);
    ownedGiftCost = round2(ownedGiftCost);

    const invCustomerId = inv.customerId != null ? Number(inv.customerId) : null;
    const revenueBeforeTax = round2(total.minus(tax));
    // أمر الشغل والخدمة لا يعيدان مخزوناً في هذا المسار؛ تكلفة العائد التشغيلي تقتصر
    // على السلعة أو مكوّنات البكج التي ثبت استلامها وأضيفت فعلياً إلى المخزون.
    const operationalReturnCost = inv.sourceType === "WORKORDER"
      ? money(0)
      : ownedInventoryCost.neg();
    const operationalReturnRevenue = revenueBeforeTax.neg();
    const revenueRoleEntries = Array.from(revenueByRole.entries()).map(([role, amount]) => ({
      role: role as "SALES_FLEX" | "SALES_PRINT" | "SALES_STATIONERY" | "OTHER_REVENUE",
      amount,
    }));
    const accountingReturnKind: DeliveryReturnSaleKind =
      returnKind === "SERVICE" && ownedInventoryCost.gt(0) ? "MIXED" : returnKind;
    const reversesOwnedInventory = accountingReturnKind === "INVENTORY" ||
      accountingReturnKind === "DIGITAL" || accountingReturnKind === "MIXED";
    const roleDebits: Partial<Record<AccountRole, Decimal>> = {};
    for (const { role, amount } of revenueRoleEntries) roleDebits[role] = amount;
    if (deliveryRevenue.gt(0)) roleDebits.DELIVERY_REVENUE = deliveryRevenue;
    if (tax.gt(0)) roleDebits.TAX_PAYABLE = tax;
    if (reversesOwnedInventory && ownedInventoryCost.gt(0)) {
      roleDebits.INVENTORY = ownedInventoryCost;
    }
    const returnPostingSourceComponents: PostingSourceComponents = {
      roleDebits,
      roleCredits: {
        AR: total,
        ...(reversesOwnedInventory && ownedInventoryCost.gt(0)
          ? { COGS: ownedInventoryCost }
          : {}),
      },
    };
    if (total.gt(0)) {
      await postEntry(tx, {
        entryType: "RETURN", branchId: Number(cn.branchId), invoiceId: Number(cn.invoiceId),
        customerId: invCustomerId,
        revenue: operationalReturnRevenue,
        cost: operationalReturnCost,
        profit: round2(operationalReturnRevenue.minus(operationalReturnCost)),
        amount: total.neg(),
        taxAmount: tax.neg(),
        postingSourceComponents: returnPostingSourceComponents,
        postingIntent: deliveryReturnSaleIntent({
          kind: accountingReturnKind,
          sectorRevenue,
          revenueByRole: revenueRoleEntries,
          deliveryRevenue,
          tax,
          total,
          ownedInventoryCost,
        }),
        notes: `إرجاع إرسالية ${cn.consignmentNumber}`,
      });
    }

    // Gift expense reverses only for goods that physically returned. The
    // consignor part is a memo here because its GIFTS_PROMO leg is reversed by
    // PURCHASE_CONSIGNMENT below; owned goods restore INVENTORY directly.
    if (giftCost.gt(0)) {
      const giftPosting = classifyGiftPosting(giftCost, ownedGiftCost, -1);
      await postEntry(tx, {
        entryType: "GIFT_OUT",
        dedupeKey: `GIFT:DELIVERY_RETURN:${Number(cn.invoiceId)}`,
        branchId: Number(cn.branchId),
        invoiceId: Number(cn.invoiceId),
        customerId: invCustomerId,
        revenue: money(0),
        cost: giftCost.neg(),
        profit: giftCost,
        amount: giftCost.neg(),
        postingSourceComponents: giftPosting.sourceComponents,
        notes: `عكس هدايا إرسالية ${cn.consignmentNumber}; consignmentRemainder=${toDbMoney(giftPosting.consignmentRemainder)}`,
        postingIntent: giftPosting.intent,
      });
    }

    // Returned consignment goods no longer create a debt to the consignor.
    // Reverse both paid and gift shares with the original invoice link so the
    // commission/net-sales filters also see the exact mirror entry.
    for (const consignorId of Array.from(byConsignor.keys()).sort((a, b) => a - b)) {
      const split = byConsignor.get(consignorId)!;
      const paidShare = round2(split.paid);
      const giftShare = round2(split.gift);
      const share = round2(paidShare.plus(giftShare));
      if (share.lte(0)) continue;
      await postEntry(tx, {
        entryType: "PURCHASE",
        dedupeKey: `CONSIG:DELIVERY_RETURN:${Number(cn.invoiceId)}:${consignorId}`,
        supplierId: consignorId,
        invoiceId: Number(cn.invoiceId),
        branchId: Number(cn.branchId),
        amount: share.neg(),
        revenue: money(0),
        cost: money(0),
        profit: money(0),
        notes: `عكس استحقاق أمانة — إرجاع إرسالية ${cn.consignmentNumber}`,
        postingIntent: createPostingIntent("PURCHASE_CONSIGNMENT", "PURCHASE", [
          ...signedPostingLines("COGS", "CONSIGNMENT_PAYABLE", paidShare.neg()),
          ...signedPostingLines("GIFTS_PROMO", "CONSIGNMENT_PAYABLE", giftShare.neg()),
        ], {
          roleDebits: { CONSIGNMENT_PAYABLE: share },
          roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare },
        }),
        postingSourceComponents: {
          roleDebits: { CONSIGNMENT_PAYABLE: share },
          roleCredits: { COGS: paidShare, GIFTS_PROMO: giftShare },
        },
      });
      await adjustSupplierBalance(tx, consignorId, share.neg());
    }
    await tx.update(invoices).set({ status: "RETURNED", returnedTotal: toDbMoney(total) }).where(eq(invoices.id, Number(cn.invoiceId)));

    // عدّادات الأسطر — كانت مُغفَلةً هنا وحدها (returnService يكتبها في كل مرتجع).
    // أثرُ الإغفال أنّ عائلتَي التقارير تتناقضان على نفس اليوم: مجاميعُ الرأس تُصفّر الإيراد
    // عبر `returnedTotal`، بينما بُعد «الصنف» في `reportsSalesService` يشتقّ من السطر
    // (`ii.total × (baseQuantity − returnedBaseQuantity) / baseQuantity`) فيُبقي الإرسالية
    // المُرجَعة **بيعاً كاملاً إلى الأبد**، وتكلفتُها تُحيَّد أو لا حسب `returnedRestocked`.
    // المرتجع هنا كامل بحكم التصميم (الحالة RETURNED و`returnedTotal` = الإجمالي)، لكن
    // «المُعاد للرفّ» يتبع خطة العائد المادي أعلاه: السلعة المخزنية أو البكج الذي عادت
    // مكوّناته فقط. الخدمة وناتج أمر الشغل لا يسجلان عودة مخزنية.
    for (const item of items) {
      const restocked = restockedItemIds.has(Number(item.id))
        ? Number(item.baseQuantity)
        : 0;
      await tx
        .update(invoiceItems)
        .set({
          returnedBaseQuantity: Number(item.baseQuantity),
          returnedRestockedBaseQuantity: restocked,
        })
        .where(eq(invoiceItems.id, Number(item.id)));
    }

    // تحرير التعرض التشغيلي. في المرحلة الثانية لا ترتفع العهدة النقدية عند
    // الإسناد. أما الصفوف المرحّلة فتحمل custodyRecognizedAt لأن رصيدها القديم
    // كان تعرّضاً مُسجلاً في currentBalance؛ نعكس منه ما بقي فعلاً، ثم نحرر
    // الباقي كتعرّض غير محصّل حتى تبقى معادلتا العهدة والتعرض متوازنتين.
    // ⚠️ **تحريرٌ واحدٌ لا اثنان** (0246): إن كان الرجوعُ **مُعلَناً** سلفاً فتعرّضُه حُرِّر
    // لحظةَ الإعلان. و`deliveryLedgerEntries.eventKey` **بلا فهرسٍ فريد** في المخطّط ⇒ إدراجٌ
    // ثانٍ يمرّ بلا خطأ ويُحرّر المبلغ **مرّتين**، فيظهر للجهة رصيدٌ دائنٌ وهميّ. الحارسُ
    // صريحٌ هنا لأنّ القاعدة لا تحرسه.
    const alreadyReleasedOnDeclaration = cn.returnDeclaredAt != null;
    const outstanding = round2(money(cn.codAmount).minus(money(cn.collectedAmount)));
    if (outstanding.gt(0) && !alreadyReleasedOnDeclaration) {
      const cachedCustody = money(party?.currentBalance ?? "0");
      const legacyCustody = cn.custodyRecognizedAt == null
        ? money(0)
        : round2(outstanding.lt(cachedCustody) ? outstanding : cachedCustody);
      if (legacyCustody.gt(0)) {
        await adjustDeliveryBalance(tx, Number(cn.partyId), legacyCustody.neg());
        await appendDeliveryLedgerEntry(tx, {
          eventKey: `CN:${consignmentId}:COD_REMITTED:LEGACY_RETURN`,
          partyId: Number(cn.partyId),
          consignmentId,
          branchId: Number(cn.branchId),
          entryType: "COD_REMITTED",
          amount: toDbMoney(legacyCustody),
          actorUserId: actor.userId,
          notes: `عكس عهدة مرحّلة بعد إرجاع ${cn.consignmentNumber}`,
        });
      }

      const exposureToRelease = round2(outstanding.minus(legacyCustody));
      if (exposureToRelease.gt(0)) {
        await appendDeliveryLedgerEntry(tx, {
          eventKey: `CN:${consignmentId}:COD_RELEASED:RETURN`,
          partyId: Number(cn.partyId),
          consignmentId,
          branchId: Number(cn.branchId),
          entryType: "COD_RELEASED",
          amount: toDbMoney(exposureToRelease),
          actorUserId: actor.userId,
          notes: `تحرير تحصيل متوقع بعد إرجاع ${cn.consignmentNumber}`,
        });
      }
    }

    // الرد على رافد القبض المثبت: النقد فعلي الآن وغير النقد طلب تنفيذ خارجي معلق.
    const deposit = round2(money(inv.paidAmount));
    let materializedGoodsRefund=money(0);
    const pendingGoodsRefundReceiptIds:number[]=[];
    if(deposit.gt(0)){
      const caps=await loadRefundCaps(tx,Number(inv.id),{lock:true});
      if(deposit.gt(caps.pool))throw deliveryRefundError("مبلغ الفاتورة المقبوض لا يطابق وعاء الإيصالات الأصلي غير المردود");
      const cashCap=caps.netByMethod.get("CASH")??money(0);
      materializedGoodsRefund=round2(deposit.lt(cashCap)?deposit:cashCap);
      if(materializedGoodsRefund.gt(0)){
        const resolved=prelockedReturnShift;
        if(!resolved)throw deliveryRefundError("تغيّر القبض النقدي أثناء الإرجاع؛ أعد المحاولة لقفل مصدر الرد");
        await assertCashOutAvailable(tx,{branchId:Number(cn.branchId),cashBucket:"DRAWER",shiftId:resolved.shiftId,amount:materializedGoodsRefund,operation:"رد عربون إرجاع الإرسالية"});
        const rOut=await tx.insert(receipts).values({branchId:Number(cn.branchId),shiftId:resolved.shiftId,direction:"OUT",amount:toDbMoney(materializedGoodsRefund),paymentMethod:"CASH",cashBucket:"DRAWER",status:"COMPLETED",invoiceId:Number(cn.invoiceId),referenceNumber:`RET-${cn.consignmentNumber}`,description:`رد عربون إرجاع ${cn.consignmentNumber}`,createdBy:actor.userId});
        await postEntry(tx,{entryType:"PAYMENT_OUT",branchId:Number(cn.branchId),invoiceId:Number(cn.invoiceId),postingIntent:deliveryCustomerRefundIntent(materializedGoodsRefund,"DRAWER"),postingSourceComponents:{roleDebits:{AR:materializedGoodsRefund},roleCredits:{CASH:materializedGoodsRefund}},customerId:invCustomerId,receiptId:extractInsertId(rOut),amount:materializedGoodsRefund,notes:`رد عربون ${cn.consignmentNumber}`});
      }
      let noncashLeft=deposit.minus(materializedGoodsRefund);
      for(const method of ["CARD","TRANSFER","WALLET","CHECK"] as const){
        const cap=caps.netByMethod.get(method)??money(0),amount=round2(noncashLeft.lt(cap)?noncashLeft:cap);
        if(!amount.gt(0))continue;
        const original=await tx.select({id:receipts.id,referenceNumber:receipts.referenceNumber}).from(receipts).where(and(eq(receipts.invoiceId,Number(inv.id)),eq(receipts.direction,"IN"),eq(receipts.paymentMethod,method),eq(receipts.status,"COMPLETED")));
        pendingGoodsRefundReceiptIds.push(await createPendingDeliveryRefundTx(tx,{cn,kind:"GOODS",method,amount:toDbMoney(amount),sourceReceiptIds:original.filter(r=>!r.referenceNumber?.startsWith("DLV-FEE-")).map(r=>Number(r.id)),customerId:invCustomerId},actor));
        noncashLeft=noncashLeft.minus(amount);
      }
      if(noncashLeft.gt(0))throw deliveryRefundError("بقي مبلغ مقبوض لا يملك وسيلة قبض أصلية مثبتة؛ راجع تخصيصات الإيصالات");
      await tx.update(invoices).set({paidAmount:toDbMoney(deposit.minus(materializedGoodsRefund))}).where(eq(invoices.id,Number(inv.id)));
    }

    // تدقيق ٦/٨ (ث٣) — **خصم ذمّة العميل** (طلب المالك الحرفيّ: «لكي يتم خصم الذمم منه»):
    // ما لم يُستردّ نقداً من المدفوع يبقى ديناً على العميل عن بضاعةٍ عادت للرفّ. يُخصَم هنا
    // بنفس دلالة returnService (الجزء غير المستردّ نقداً يسقط من الذمّة).
    if (invCustomerId != null) {
      const arDrop = round2(total.minus(materializedGoodsRefund));
      if (arDrop.gt(0)) await adjustCustomerBalance(tx, invCustomerId, arDrop.neg());
    }

    // تدقيق ٦/٨ (ث٢) — **ردّ أمانة أجرة التوصيل** إن قُبضت في الاستقبال ولم تُصرف للمندوب:
    // التوصيل لم يقع، فالأمانة مالُ الزبون لا مالُ المكتبة ولا المندوب. بلا هذا الردّ تبقى
    // في الدرج بلا مالكٍ وتُرحَّل للخزينة كأنها إيراد.
    //
    // ⚠️ مراجعة PR #495 (ازدواج ردّ الأمانة): «مقبوضةٌ في الاستقبال» (COUNTER) تُصرَف للمندوب
    // **لحظة الإسناد** (dispatchInvoice/dispatch: settleFeeNow) بإيصال OUT مرجعُه **رقم
    // الإرسالية** لا `DLV-FEE-INV-{الفاتورة}` ⇒ الاستعلام القديم كان لا يرى الصرف فيرى الوارد
    // الأصليّ موجباً ويردّه **ثانيةً**: خروجُ نقدٍ مرّتين مقابل قبضةٍ واحدة، وΣ(DELIVERY_FEE_HELD)
    // ينقلب −الأجرة بدل صفر (ينسف ثابت «الأمانة مُبرَّأة ⇔ Σ=0»). الآن حارسان:
    //   (١) `feeSettledAt` — الأمانة غادرت الدرج إلى المندوب فلا التزامَ باقياً يُحرَّر.
    //   (٢) صافي الإيصالات يشمل صرف الأجرة برقم الإرسالية أيضاً (تصفيةٌ ذاتية للحالات القديمة).
    // ما دُفع للمندوب فعلاً ثم أراد المالك ردّه للزبون = **مصروفٌ على المكتبة** بسند صرفٍ
    // صريح، لا تحريرٌ ثانٍ لنفس الأمانة. (يُعلَن للواجهة بـ`feeAlreadyPaidToCourier`.)
    const { feeAlreadyPaidToCourier,pendingFeeRefundReceiptId } = await refundHeldDeliveryFeeForReturnTx(tx, cn, actor, prelockedReturnShift);

    assertConsignmentStatusTransition(cn.status, "RETURNED");
    const returnedAt = new Date();
    await tx.update(deliveryConsignments).set({
      status: "RETURNED",
      parcelStatus: "RETURNED",
      moneyStatus: "CANCELLED",
      returnedAt,
      settledAt: returnedAt,
    }).where(eq(deliveryConsignments.id, consignmentId));
    if (cn.workOrderId != null) {
      await tx.update(workOrders).set({ status: "CANCELLED" }).where(eq(workOrders.id, Number(cn.workOrderId)));
    }
    if (cn.sourceType === "ONLINE_ORDER") {
      await tx.update(onlineOrders).set({ status: "CANCELLED" }).where(eq(onlineOrders.id, Number(cn.sourceId)));
    } else if (cn.sourceType === "INVOICE" && inv.sourceType === "ONLINE") {
      await tx
        .update(onlineOrders)
        .set({ status: "CANCELLED" })
        .where(eq(onlineOrders.invoiceId, Number(cn.invoiceId)));
    }
    await appendDeliveryEvent(tx, {
      eventKey: `CN:${consignmentId}:RETURNED:${actor.clientRequestId ?? "legacy"}`,
      consignmentId,
      eventType: "RETURNED",
      fromParcelStatus: cn.parcelStatus,
      toParcelStatus: "RETURNED",
      fromMoneyStatus: cn.moneyStatus,
      toMoneyStatus: "CANCELLED",
      actorUserId: actor.userId,
      payload: { invoiceId: Number(cn.invoiceId) },
    });
    if (actor.clientRequestId)
      await recordIdempotencyKey(
        tx,
        "delivery.return",
        actor.clientRequestId,
        consignmentId,
        payloadHash,
      );
    void party;
    return {
      consignmentId,
      reversed: true as const,
      invoiceId: Number(cn.invoiceId),
      /** أمانة أجرةٍ صُرفت للمندوب قبل الإرجاع ⇒ لم تُردّ هنا (ردُّها للزبون قرارُ مالكٍ = مصروف). */
      feeAlreadyPaidToCourier,pendingFeeRefundReceiptId,pendingGoodsRefundReceiptIds,
      deliveryFee: String(cn.deliveryFee ?? "0"),
    };
  };
  return existingTx ? run(existingTx) : withTx(run);
}
