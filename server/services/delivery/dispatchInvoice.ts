// ٥/٨ — إسناد **فاتورةٍ قائمة** للتوصيل (لا أمر شغل).
//
// الفجوة التي يعالجها: مسار الإرسال الوحيد كان dispatchToDelivery المفتاحُ فيه workOrderId، وهو
// **يُنشئ الفاتورة بنفسه**. فالبيع المباشر في الاستقبال (منتجات جاهزة/خدمات طباعة بلا تخصيص)
// يُنتج فاتورةً بلا أيّ أمر شغل ⇒ لا صفَّ له في الطابور ولا طريقةَ لإسناده لمندوب إطلاقاً.
// هنا نربط فاتورةً موجودةً بإرسالية: نفس محاسبة العهدة، بلا إنشاء فاتورةٍ ثانية وبلا لمس قيد
// SALE الأصليّ (الإيراد اعتُرف به لحظة البيع؛ التوصيل تسليمٌ لا بيع).
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryParties,
  deliveryShipmentMembers,
  invoices,
  receipts,
  receptionDrafts,
  workOrders,
} from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { withTx } from "../tx";
import { nextConsignmentNumber } from "./numbering";
import { assertFloatLimitTx, assertNoStaleOpenParcelsTx } from "./parties";
import type { DeliveryTxActor } from "./types";
import {
  appendDeliveryEvent,
  appendDeliveryLedgerEntry,
  assertConsignmentStatusTransition,
} from "./lifecycle";
import { assertSiblingsReady } from "../workOrder/siblings";
import { resolveConsignmentNumber } from "../workOrder/helpers";
import {
  assertExternalTrackingRefAvailable,
  normalizeExternalTrackingRef,
  requireExternalTrackingRef,
  rethrowExternalTrackingRefDuplicate,
} from "./trackingRefPolicy";
import { publishRealtimeEvent } from "../../realtime";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";

import { appErrorMessage } from "@shared/errors";
import { isDeadInvoiceStatus } from "@shared/invoiceStatus";
import { fulfillmentRequests } from "../../../drizzle/fulfillmentSchema";
import { assertNoPendingHeldFeeRefundTx } from "./feeHeld";
import { validateDeliveryDriverTx } from "./driverValidation";
import { heldCustomerParcelReissueTx } from "./workflow/returnReceipt";
import {
  initializeConsignmentCustodyTx,
  repairDeliveryCustodyFromRecordedEventsTx,
} from "./custody";

/** Service-only context; it is never part of a router input. */
export interface ShipmentDispatchContext {
  /** Trusted composition only; the writer rechecks actual inspected custody and carrier rights. */
  heldReturnReissue?: boolean;
  shipmentLeaderConsignmentId?: number;
  sharedTrackingLeaderId?: number;
  retainedShipmentLeader?: boolean;
}

/** Call after invoice locks; current reads preserve the existing held-fee owner. */
export async function loadInvoiceDeliveryFeeHeldTx(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  invoiceIds: number[],
) {
  const held = new Map<number, ReturnType<typeof money>>();
  if (!invoiceIds.length) return held;
  const rows = await tx
    .select({
      invoiceId: receipts.invoiceId,
      direction: receipts.direction,
      amount: receipts.amount,
    })
    .from(receipts)
    .where(
      and(
        inArray(receipts.invoiceId, invoiceIds),
        or(
          sql`${receipts.referenceNumber} = CONCAT('DLV-FEE-INV-', ${receipts.invoiceId})`,
          and(
            sql`${receipts.workOrderId} IS NOT NULL`,
            sql`${receipts.referenceNumber} = CONCAT('DLV-FEE-WO-', ${receipts.workOrderId})`,
            sql`EXISTS (SELECT 1 FROM ${workOrders} wo WHERE wo.id = ${receipts.workOrderId} AND wo.invoiceId = ${receipts.invoiceId})`,
          ),
        ),
        eq(receipts.status, "COMPLETED"),
      ),
    )
    .orderBy(asc(receipts.id))
    .for("share");
  for (const row of rows) {
    if (row.invoiceId == null) continue;
    const id = Number(row.invoiceId);
    const amount = money(row.amount);
    held.set(
      id,
      round2(
        (held.get(id) ?? money(0)).plus(
          row.direction === "IN" ? amount : amount.neg(),
        ),
      ),
    );
  }
  return held;
}

export interface DispatchInvoiceInput {
  invoiceId: number;
  partyId: number;
  deliveryFee?: string | null;
  /** مَن يقبض الأجرة (تمريرٌ لا إيراد): COURIER افتراضاً. COUNTER يعني أنّها في الدرج الآن. */
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
  governorate?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  clientRequestId?: string | null;
  /** Internal bridge used by store fulfillment while onlineOrders is retired. */
  onlineOrderId?: number | null;
  assignedUserId?: number | null;
  /**
   * **إرسالٌ جزئيّ مُقَرٌّ به** (ش٥، ١٩/٨): يمرّ رغم وجود إخوةٍ لم يجهزوا بعد.
   *
   * افتراضُه `false` كي **يفشل مغلقاً**: السلّة الواحدة قد تُنتج فاتورةَ بضاعةٍ جاهزة **و**
   * أوامرَ شغلٍ ما زالت تحت التنفيذ؛ إرسالُ الأولى وحدها يعني أنّ الزبون يستلم نصف طلبه
   * والباقي يبقى في المكتبة بلا من يذكّر به — وهو نصفٌ لا يُلام عليه المندوب ولا الاستقبال.
   * ومن يقرّه صراحةً يُكتب قراره في حدث الإرسالية.
   */
  partialDispatchConfirmed?: boolean;
  /** رقم التتبع / المرجع الخارجي — إلزامي عند الإسناد إلى شركة توصيل. */
  externalTrackingRef?: string | null;
  /** ملاحظات التوصيل للمندوب أو شركة الشحن. */
  notes?: string | null;
  /** Internal linkage only; original INVOICE/WORK_ORDER source identity is retained. */
  fulfillmentRequestId?: number;
}

export async function dispatchInvoiceToDelivery(
  input: DispatchInvoiceInput,
  actor: DeliveryTxActor,
) {
  const result = await withTx((tx) => dispatchInvoiceInTx(tx, input, actor));
  publishRealtimeEvent(
    REALTIME_EVENT_TYPES.DELIVERY_DISPATCHED,
    {
      deliveryId: result.consignmentId,
      invoiceId: result.invoiceId,
      orderId: input.onlineOrderId ? Number(input.onlineOrderId) : undefined,
      trackingNumber: result.consignmentNumber,
      driverId: input.assignedUserId ?? input.partyId,
      branchId: result.branchId,
    },
    { branchId: result.branchId },
  );
  const { branchId, ...ret } = result;
  return ret;
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
  shipment?: ShipmentDispatchContext,
) {
  try {
    const normalizedTrackingRef = normalizeExternalTrackingRef(
      input.externalTrackingRef,
    );
    const feeCollection = input.feeCollection ?? "COURIER";
    // Scope and membership are checked before replay, including cancelled shipments.
    const preview = (
      await tx
        .select({ branchId: invoices.branchId })
        .from(invoices)
        .where(eq(invoices.id, input.invoiceId))
        .limit(1)
    )[0];
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذر إسناد الفاتورة",
          why: "الفاتورة غير موجودة",
          doThis: "حدّث القائمة واختر فاتورة موجودة",
        }),
      });
    if (
      actor.role !== "admin" &&
      (actor.branchId == null ||
        Number(preview.branchId) !== Number(actor.branchId))
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذر إسناد الفاتورة",
          why: "الفاتورة تخص فرعاً آخر أو لا يوجد فرع مسند للموظف",
          doThis: "افتح الفاتورة من فرعها الصحيح",
        }),
      });
    }
    const existingMember = (
      await tx
        .select({ leaderId: deliveryShipmentMembers.leaderConsignmentId })
        .from(deliveryShipmentMembers)
        .innerJoin(
          deliveryConsignments,
          eq(deliveryConsignments.id, deliveryShipmentMembers.consignmentId),
        )
        .where(eq(deliveryConsignments.invoiceId, input.invoiceId))
        .limit(1)
    )[0];
    if (
      existingMember &&
      Number(existingMember.leaderId) !== shipment?.shipmentLeaderConsignmentId
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذر إسناد فاتورة من شحنة مجمعة منفردة",
          why: "الفاتورة مرتبطة بشحنة تضم فواتير أخرى",
          doThis: "افتح تفاصيل الشحنة وأعد إسناد جميع فواتيرها معاً",
        }),
      });
    }
    const payloadHash = idempotencyHash({
      invoiceId: Number(input.invoiceId),
      partyId: Number(input.partyId),
      deliveryFee:
        input.deliveryFee == null
          ? null
          : toDbMoney(round2(money(input.deliveryFee))),
      feeCollection,
      recipientName: input.recipientName ?? null,
      recipientPhone: input.recipientPhone ?? null,
      deliveryAddress: input.deliveryAddress ?? null,
      governorate: input.governorate ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      onlineOrderId: input.onlineOrderId ?? null,
      assignedUserId: input.assignedUserId ?? null,
      externalTrackingRef: normalizedTrackingRef,
      ...(input.fulfillmentRequestId != null
        ? { fulfillmentRequestId: input.fulfillmentRequestId }
        : {}),
    });
    if (input.clientRequestId) {
      const existingId = await checkIdempotency(
        tx,
        "delivery.dispatchInvoice",
        input.clientRequestId,
        payloadHash,
      );
      if (existingId != null) {
        await repairDeliveryCustodyFromRecordedEventsTx(tx, existingId);
        const cn = (
          await tx
            .select()
            .from(deliveryConsignments)
            .where(eq(deliveryConsignments.id, existingId))
            .limit(1)
        )[0];
        return {
          consignmentId: existingId,
          consignmentNumber: cn?.consignmentNumber ?? "",
          invoiceId: Number(cn?.invoiceId ?? 0),
          codAmount: String(cn?.codAmount ?? "0"),
          deliveryFee: String(cn?.deliveryFee ?? "0"),
          branchId: Number(preview.branchId),
          idempotentReplay: true as const,
        };
      }
    }

    // ترتيب أقفال موحّد مع dispatchToDelivery: الجهة ← الفاتورة (لا جمود متبادل).
    const party = (
      await tx
        .select()
        .from(deliveryParties)
        .where(eq(deliveryParties.id, input.partyId))
        .for("update")
        .limit(1)
    )[0];
    if (!party || !party.isActive)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "جهة التوصيل غير متاحة",
      });
    const externalTrackingRef =
      shipment?.sharedTrackingLeaderId == null
        ? requireExternalTrackingRef(party.partyType, normalizedTrackingRef)
        : null;
    if (shipment?.sharedTrackingLeaderId != null) {
      const leader = (
        await tx
          .select()
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, shipment.sharedTrackingLeaderId))
          .for("update")
          .limit(1)
      )[0];
      const leaderMember = (
        await tx
          .select()
          .from(deliveryShipmentMembers)
          .where(
            eq(
              deliveryShipmentMembers.consignmentId,
              shipment.sharedTrackingLeaderId,
            ),
          )
          .limit(1)
      )[0];
      const retainedInvoice =
        shipment.retainedShipmentLeader && leader
          ? (
              await tx
                .select({ status: invoices.status })
                .from(invoices)
                .where(eq(invoices.id, Number(leader.invoiceId)))
                .for("update")
                .limit(1)
            )[0]
          : null;
      const retainedClosedLeader =
        !!retainedInvoice &&
        isDeadInvoiceStatus(retainedInvoice.status) &&
        !!leader &&
        ["CANCELLED", "RETURNED"].includes(leader.parcelStatus);
      if (
        !leader ||
        !leaderMember ||
        Number(leaderMember.leaderConsignmentId) !== Number(leader.id) ||
        Number(leader.partyId) !== input.partyId ||
        Number(leader.branchId) !== Number(preview.branchId) ||
        shipment.shipmentLeaderConsignmentId !== Number(leader.id) ||
        normalizedTrackingRef != null ||
        input.deliveryFee == null ||
        !round2(money(input.deliveryFee ?? "0")).isZero() ||
        feeCollection !== "COURIER" ||
        (leader.parcelStatus !== "OUT_FOR_DELIVERY" && !retainedClosedLeader)
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذر ربط الفاتورة بالشحنة",
            why: "قائد الشحنة أو جهتها أو فرعها أو أجرتها غير متطابق",
            doThis: "أعد إسناد الشحنة كاملة من نافذة التوصيل",
          }),
        });
      }
      requireExternalTrackingRef(party.partyType, leader.externalTrackingRef);
    }
    await validateDeliveryDriverTx(tx, input, Number(preview.branchId));
    const assignedUserId = input.assignedUserId ?? null;

    const linkedOrders = await tx
      .select()
      .from(workOrders)
      .where(eq(workOrders.invoiceId, input.invoiceId))
      .orderBy(asc(workOrders.id))
      .for("update");
    const inv = (
      await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, input.invoiceId))
        .for("update")
        .limit(1)
    )[0];
    if (!inv)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "الفاتورة غير موجودة",
      });
    const linkedOrder =
      inv.sourceType === "WORKORDER" && linkedOrders.length === 1
        ? linkedOrders[0]
        : undefined;
    await assertNoPendingHeldFeeRefundTx(tx, { invoiceId: Number(inv.id) });
    if (
      inv.sourceType === "WORKORDER" &&
      (!linkedOrder ||
        linkedOrder.branchId !== inv.branchId ||
        linkedOrder.invoiceId !== inv.id)
    )
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: "تعذر ربط أمر الشغل بالإرسالية",
          why: "فاتورة الخدمة لا ترتبط بأمر شغل واحد موثوق في الفرع نفسه",
          doThis: "اطلب من المسؤول مراجعة رابط أمر الشغل الأصلي قبل الإرسال",
        }),
      });
    // عزل مدير الفرع (قرار المالك ١٢/٨): المالك/الأدمن فقط يعبُران الفروع (owner مُطبَّع ⇒ admin)؛
    // المدير صار مقيَّداً بفرعه فيَخضع لفحص المطابقة أدناه (كان `|| manager` يُعفيه).
    const elevated = actor.role === "admin";
    if (
      !elevated &&
      actor.branchId != null &&
      Number(inv.branchId) !== actor.branchId
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "لا يمكنك إسناد فاتورة فرعٍ آخر",
      });
    }
    if (
      party.branchId != null &&
      Number(party.branchId) !== Number(inv.branchId)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "جهة التوصيل لا تخصّ فرع الفاتورة",
      });
    }
    if (
      inv.status === "CANCELLED" ||
      inv.status === "RETURNED" ||
      inv.status === "SUPERSEDED"
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا تُسنَد فاتورة ملغاة أو مرتجعة أو مستبدلة للتوصيل",
      });
    }
    // مراجعة عدائية ٩/٨ — ازدواج عهدة عبر القناتين: فاتورة طلب متجر (ONLINE) عهدتها تُدار من
    // مسار المتجر (تأكيد المندوب في «توصيلاتي» يرفعها بمفتاح ONLINE_COD_CUSTODY) — إسنادُها
    // إرساليةً هنا يرفعها **ثانيةً** بمفتاح dedupe مختلف ⇒ رصيد المندوب ضعف النقد الذي بيده،
    // وإرسالية لا تُسوَّى أبداً (متبقّي الفاتورة يصفر من الجهة الأخرى).
    if (inv.sourceType === "ONLINE" && input.onlineOrderId == null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "فاتورة طلب متجر إلكتروني — إسناد المندوب من شاشة طلبات المتجر لا من هنا (عهدتها تُدار هناك)",
      });
    }
    // حارس بنيويّ مساند لقيد uq_consignment_invoice: رسالةٌ مفهومة بدل خطأ قاعدة بيانات.
    const already = (
      await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.invoiceId, input.invoiceId))
        .for("update")
        .limit(1)
    )[0];
    if (already) {
      const member = (
        await tx
          .select()
          .from(deliveryShipmentMembers)
          .where(eq(deliveryShipmentMembers.consignmentId, Number(already.id)))
          .for("update")
          .limit(1)
      )[0];
      if (
        member &&
        Number(member.leaderConsignmentId) !==
          shipment?.shipmentLeaderConsignmentId
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذر إسناد فاتورة من شحنة مجمعة منفردة",
            why: "الفاتورة مرتبطة بشحنة تضم فواتير أخرى",
            doThis: "افتح تفاصيل الشحنة وأعد إسناد جميع فواتيرها معاً",
          }),
        });
      }
    }
    const heldReturnReissue =
      already != null &&
      shipment?.heldReturnReissue === true &&
      (await heldCustomerParcelReissueTx(tx, already));
    if (shipment?.heldReturnReissue && !heldReturnReissue)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: "تعذرت إعادة إرسال العهدة المستلمة",
          why: "لا يوجد استلام فعلي صالح أو بقي نقد/تاريخ أجرة مرتبط بالناقل الأصلي",
          doThis:
            "سوّ حقوق الناقل من محطة التحصيل، أو افتح معالجة نقص MISSING_HELD مرتبطة بالمصدر لإعادة إرسال نفس العهدة بلا صرف مخزون جديد",
        }),
      });
    if (
      already &&
      !heldReturnReissue &&
      (already.status !== "CANCELLED" ||
        already.parcelStatus !== "CANCELLED" ||
        already.moneyStatus !== "CANCELLED")
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `الفاتورة مُسنَدة أصلاً للإرسالية ${already.consignmentNumber}`,
      });
    }
    if (
      already &&
      (!round2(money(already.collectedAmount ?? "0")).isZero() ||
        already.remittanceId != null)
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "الإرسالية الملغاة تحمل تحصيلاً أو توريداً؛ لا يمكن إعادة تنشيطها",
      });
    }
    // Check the current receipts after invoice locks, including when an earlier preview established a snapshot.
    const held =
      (await loadInvoiceDeliveryFeeHeldTx(tx, [input.invoiceId])).get(
        input.invoiceId,
      ) ?? money(0);
    if (feeCollection === "COUNTER") {
      const feeD = round2(money(input.deliveryFee ?? "0"));
      if (feeD.lte(0) || !held.eq(feeD)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: held.gt(0)
            ? `أمانة الأجرة المقبوضة (${held.toFixed(2)}) يجب أن تساوي الأجرة (${feeD.toFixed(2)}) — اجعل الأجرة ${held.toFixed(2)} أو صحّح المقبوض`
            : "«مقبوضة في الاستقبال» تتطلّب قبض الأجرة مع الطلب نفسه (خانة أجرة التوصيل في السلّة) — أو اختر «المندوب يقبضها من الزبون» / «على المكتبة»",
        });
      }
    } else {
      if (!held.isZero()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: appErrorMessage({
            what: "تعذر إسناد الفاتورة مع أمانة أجرة سابقة",
            why: held.gt(0)
              ? `توجد أمانة أجرة ${held.toFixed(2)} مقبوضة في الاستقبال على هذه الفاتورة ولا يمكن تحويلها إلى أجرة يقبضها المندوب أو تتحملها المكتبة`
              : "صافي أمانة أجرة الفاتورة سالب ويحتاج مراجعة سندات الأجرة",
            doThis: held.gt(0)
              ? `اختر «مقبوضة في الاستقبال» بأجرة ${held.toFixed(2)}، أو اطلب من المدير تسوية أمانة الأجرة قبل الإسناد`
              : "اطلب من المدير مراجعة سندات قبض وصرف أجرة هذه الفاتورة قبل الإسناد",
          }),
        });
      }
    }
    await assertExternalTrackingRefAvailable(
      tx,
      Number(input.partyId),
      externalTrackingRef,
      already != null ? Number(already.id) : null,
    );

    // ── ش٥: إخوةُ السلّة الواحدة (١٩/٨) ────────────────────────────────────────────
    // المسوّدةُ الواحدة تُنتج فاتورةَ بضاعةٍ **وأوامرَ شغلٍ** معاً؛ والإرسال يمسّ الفاتورة
    // وحدها. فبلا هذا الفحص يخرج نصفُ الطلب مع المندوب بينما نصفُه الآخر ما زال على الطاولة —
    // ولا شاشةَ تقول ذلك لأحد. (`draftId` كُتب في 0220 ولم يُقرأ حتى الآن — هذا قارئُه الأوّل.)
    // فشلٌ **مغلق**: يمرّ فقط بإقرارٍ صريح يُسجَّل في حدث الإرسالية.
    const draftRow = (
      await tx
        .select({ id: receptionDrafts.id })
        .from(receptionDrafts)
        .where(
          or(
            eq(receptionDrafts.committedInvoiceId, input.invoiceId),
            eq(receptionDrafts.committedPrintInvoiceId, input.invoiceId),
          ),
        )
        .limit(1)
    )[0];
    const siblingRows = await assertSiblingsReady(tx, {
      draftId: draftRow ? Number(draftRow.id) : null,
      confirmed: input.partialDispatchConfirmed === true,
      action: "dispatch",
    });

    const fee = round2(money(input.deliveryFee ?? party.defaultFee ?? "0"));
    if (fee.lt(0))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "أجرة التوصيل لا تصحّ أن تكون سالبة",
      });

    // COD = ما تبقّى على الفاتورة فقط (مالُنا). الأجرة **ليست** جزءاً منه — تمريرٌ للمندوب.
    // مراجعة عدائية ٩/٨: يُطرح returnedTotal أيضاً — مرتجعٌ جزئي قبل الإسناد كان يُنتج codAmount
    // منتفخاً بقيمته ⇒ عهدة وهمية على المندوب لا يمكن توريدها (حزام التوريد يسقفها بمتبقّي
    // الفاتورة الحيّ) فتعلق PARTIAL للأبد.
    const remaining = round2(
      money(inv.total)
        .minus(money(inv.returnedTotal ?? "0"))
        .minus(money(inv.paidAmount ?? "0")),
    );
    if (remaining.lt(0))
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "الفاتورة مدفوعةٌ بأكثر من قيمتها — راجعها قبل الإسناد",
      });
    const codAmount = inv.paymentMode === "CREDIT" ? money(0) : remaining;
    if (input.fulfillmentRequestId != null) {
      const [request] = await tx
        .select()
        .from(fulfillmentRequests)
        .where(eq(fulfillmentRequests.id, input.fulfillmentRequestId))
        .limit(1);
      if (
        !request ||
        request.branchId !== inv.branchId ||
        (request.customerId ?? null) !== (inv.customerId ?? null) ||
        (already?.fulfillmentRequestId != null &&
          already.fulfillmentRequestId !== request.id)
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: "تعذر ربط الشحنة بطلب التجهيز",
            why: "الطلب أو العميل أو الفرع لا يطابق الفاتورة والإرسالية",
            doThis: "حدّث طلب التجهيز واختر مستندات العميل والفرع نفسيهما",
          }),
        });
    }
    const codPositive = codAmount.gt(0);
    // الأجرة تُصرَف الآن حين لا توريدَ يُنتظَر (نفس قاعدة dispatch.ts). بعد حظر COUNTER (ش٠)
    // بقي مسارٌ واحد للصرف الفوريّ: SHOP بفاتورةٍ مدفوعة كاملاً (codAmount=0) — لا توريد يُخصم منه.
    // تدقيق ٦/٨ (ث١): الشرط القديم `SHOP && !codPositive` كان يستثني COUNTER تماماً — وفاتورة
    // الاستقبال المدفوعة كاملاً تُنتج codAmount=0 فتولد الإرسالية DELIVERED ولا يراها التوريد
    // أبداً ⇒ أجرةٌ قبضناها من الزبون أمانةً **لا تصل المندوب إطلاقاً** وتبقى في الدرج بلا
    // مالك. مطابقةٌ الآن لمسار أمر الشغل (dispatch.ts): COUNTER تُصرف فوراً دائماً (قبضناها
    // بالفعل)، وSHOP تُصرف حين لا توريدَ يُخصم منه.
    const dispatchedAt = new Date();
    let consignmentId: number;
    let consignmentNumber: string;
    if (already) {
      assertConsignmentStatusTransition(already.status, "DISPATCHED");
      consignmentId = Number(already.id);
      consignmentNumber = already.consignmentNumber;
      await tx
        .update(deliveryConsignments)
        .set({
          ...(linkedOrder ? { workOrderId: linkedOrder.id } : {}),
          ...(input.fulfillmentRequestId != null
            ? { fulfillmentRequestId: input.fulfillmentRequestId }
            : {}),
          branchId: Number(inv.branchId),
          partyId: input.partyId,
          assignedUserId,
          endCustomerId: inv.customerId ?? null,
          codAmount: toDbMoney(codAmount),
          collectedAmount: "0",
          // The replacement claim already excludes all historical counter receipts.
          // Preserve their events, but do not subtract the old claim's offset again.
          counterSettledAmount: "0",
          codClaimVersion: already.codClaimVersion + 1,
          deliveryFee: toDbMoney(fee),
          feeCollection,
          feeSettledAt: null,
          recipientName: input.recipientName ?? inv.contactName ?? null,
          recipientPhone: input.recipientPhone ?? inv.contactPhone ?? null,
          deliveryAddress: input.deliveryAddress ?? null,
          governorate: input.governorate ?? null,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          externalTrackingRef,
          notes: input.notes ?? already.notes ?? null,
          parcelStatus: "OUT_FOR_DELIVERY",
          moneyStatus: codPositive ? "UNSETTLED" : "NOT_APPLICABLE",
          status: "DISPATCHED",
          remittanceId: null,
          dispatchedBy: actor.userId,
          dispatchedAt,
          acceptedAt: null,
          pickedUpAt: null,
          outForDeliveryAt: dispatchedAt,
          settledAt: codPositive ? null : dispatchedAt,
          courierDeliveredAt: null,
          custodyRecognizedAt: null,
          failedAt: null,
          failureReason: null,
          cancelledAt: null,
          cancellationReason: null,
          cancelledBy: null,
          returnedAt: null,
          ...(heldReturnReissue
            ? {
                returnDeclaredAt: null,
                returnDeclaredBy: null,
                returnDeclaredReason: null,
              }
            : {}),
        })
        .where(eq(deliveryConsignments.id, consignmentId));
    } else {
      consignmentNumber = await resolveConsignmentNumber(
        tx,
        inv.invoiceNumber,
        Number(inv.branchId),
      );
      const cnRes = await tx.insert(deliveryConsignments).values({
        fulfillmentRequestId: input.fulfillmentRequestId ?? null,
        consignmentNumber,
        branchId: Number(inv.branchId),
        partyId: input.partyId,
        invoiceId: Number(inv.id),
        workOrderId: linkedOrder?.id ?? null,
        sourceType:
          input.onlineOrderId != null
            ? "ONLINE_ORDER"
            : linkedOrder
              ? "WORK_ORDER"
              : "INVOICE",
        sourceId:
          input.onlineOrderId != null
            ? Number(input.onlineOrderId)
            : linkedOrder
              ? linkedOrder.id
              : Number(inv.id),
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
        governorate: input.governorate ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        notes: input.notes ?? null,
        parcelStatus: "OUT_FOR_DELIVERY",
        moneyStatus: codPositive ? "UNSETTLED" : "NOT_APPLICABLE",
        // اكتمال الدفع لا يثبت وصول الطرد؛ أبقه تشغيلياً مع المندوب حتى ختم التسليم.
        status: "DISPATCHED",
        settledAt: codPositive ? null : dispatchedAt,
        dispatchedBy: actor.userId,
        dispatchedAt,
        outForDeliveryAt: dispatchedAt,
        externalTrackingRef,
      });
      consignmentId = extractInsertId(cnRes);
    }

    // Slice DFP1 (٣٠/٨/٢٦) — SLA على عمر الطرود المفتوحة (نفس القرار على مسار الفواتير).
    // ⚠️ خارج بلوك `codPositive` عمداً: طردٌ سابقٌ بـCOD صفريّ متأخر لا يمنع تلقائياً، لكنّ الطرد
    // الأقدم عادةً بـCOD موجب ⇒ الحارس يمسك الحالة الحقيقيّة، وترك الفحص عاماً أخفّ في المستقبل
    // إن قرّر المالك توسيع التعريف.
    await assertNoStaleOpenParcelsTx(tx, party);
    if (codPositive) {
      // تدقيق ٦/٨ (ث٧): `floatLimit` كان يُدخَل في شاشة الجهة ولا يقرؤه أيّ مسار إسناد ⇒ سقفٌ
      // مسرحيّ. يُنفَّذ الآن: عهدةٌ تتجاوز السقف تُرفض (تراكمُ نقدٍ بيد مندوبٍ بلا حدّ = خطر).
      // مراجعة PR #495: الحارس صار **مشتركاً** (parties.assertFloatLimit) فلا ينحرف مساران.
      await assertFloatLimitTx(tx, party, codAmount);
      await appendDeliveryLedgerEntry(tx, {
        eventKey: already
          ? `CN:${consignmentId}:COD_ASSIGNED:REACTIVATED:${input.clientRequestId ?? dispatchedAt.getTime()}`
          : `CN:${consignmentId}:COD_ASSIGNED`,
        partyId: input.partyId,
        consignmentId,
        branchId: Number(inv.branchId),
        entryType: "COD_ASSIGNED",
        amount: toDbMoney(codAmount),
        actorUserId: actor.userId,
      });
    }

    if (already) {
      await appendDeliveryEvent(tx, {
        eventKey: `CN:${consignmentId}:CLAIM_REACTIVATED:${input.clientRequestId ?? dispatchedAt.getTime()}`,
        consignmentId,
        eventType: "COD_CLAIM_CHANGED",
        actorUserId: actor.userId,
        payload: {
          invoiceId: Number(inv.id),
          claimVersion: already.codClaimVersion + 1,
          ackRequired: true,
        },
      });
    }

    await appendDeliveryEvent(tx, {
      eventKey: already
        ? `CN:${consignmentId}:ASSIGNMENT_REACTIVATED:${input.clientRequestId ?? dispatchedAt.getTime()}`
        : `CN:${consignmentId}:OUT_FOR_DELIVERY`,
      consignmentId,
      eventType: already ? "ASSIGNMENT_REACTIVATED" : "OUT_FOR_DELIVERY",
      fromParcelStatus: already?.parcelStatus ?? null,
      toParcelStatus: "OUT_FOR_DELIVERY",
      fromMoneyStatus: already?.moneyStatus ?? null,
      toMoneyStatus: codPositive ? "UNSETTLED" : "NOT_APPLICABLE",
      actorUserId: actor.userId,
      payload: {
        partyId: input.partyId,
        sourceType:
          already?.sourceType ??
          (input.onlineOrderId != null
            ? "ONLINE_ORDER"
            : linkedOrder
              ? "WORK_ORDER"
              : "INVOICE"),
        sourceId:
          already == null
            ? input.onlineOrderId != null
              ? Number(input.onlineOrderId)
              : linkedOrder
                ? linkedOrder.id
                : Number(inv.id)
            : Number(already.sourceId),
        previousPartyId: already == null ? null : Number(already.partyId),
        reactivated: already != null,
        // إقرارُ الإرسال الجزئيّ يُكتَب بأرقام إخوته — وإلّا صار «من أذن بخروج نصف الطلب؟»
        // سؤالاً بلا جواب بعد أسبوع.
        ...(siblingRows.length > 0
          ? {
              partialDispatch: true,
              unreadySiblings: siblingRows.map((r) => ({
                id: Number(r.id),
                orderNumber: r.orderNumber,
                status: r.status,
              })),
            }
          : {}),
      },
    });
    await initializeConsignmentCustodyTx(tx, {
      consignmentId,
      actorUserId: actor.userId,
      operationId:
        input.clientRequestId ?? `delivery.dispatchInvoice:${consignmentId}`,
      leaderConsignmentId: shipment?.shipmentLeaderConsignmentId,
    });

    if (input.clientRequestId) {
      await recordIdempotencyKey(
        tx,
        "delivery.dispatchInvoice",
        input.clientRequestId,
        consignmentId,
        payloadHash,
      );
    }
    return {
      consignmentId,
      consignmentNumber,
      invoiceId: Number(inv.id),
      invoiceNumber: inv.invoiceNumber,
      codAmount: codAmount.toFixed(2),
      deliveryFee: fee.toFixed(2),
      reactivated: already != null,
      branchId: Number(inv.branchId),
    };
  } catch (error) {
    rethrowExternalTrackingRefDuplicate(
      error,
      normalizeExternalTrackingRef(input.externalTrackingRef) ?? "",
    );
  }
}
