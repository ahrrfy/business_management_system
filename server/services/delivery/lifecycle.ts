import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryEvents,
  deliveryLedgerEntries,
  deliveryOutbox,
  deliveryParties,
  deliveryPartyMembers,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import type { DeliveryConsignmentStatus } from "@shared/deliveryStatuses";
import { appErrorMessage } from "@shared/errors";

export type ParcelStatus =
  | "ASSIGNED"
  | "ACCEPTED"
  | "PICKED_UP"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "FAILED"
  | "CANCELLED"
  | "RETURNED";

export type DeliveryMoneyStatus =
  | "NOT_APPLICABLE"
  | "UNSETTLED"
  | "PARTIAL"
  | "SETTLED"
  | "CANCELLED"
  | "WRITTEN_OFF";

export type DeliveryMemberRole = "DRIVER" | "MANAGER" | "ACCOUNTANT";

export type DeliveryMembership = {
  partyId: number;
  partyName: string;
  partyType: "INDIVIDUAL" | "COMPANY";
  memberRole: DeliveryMemberRole;
  userId: number;
};

/**
 * سلطةُ **كشف شركة التوصيل** (١٩/٨) — بديلٌ عن عضوية البوّابة حين تُثبِت الشركةُ التسليم
 * بكشفها المستنديّ بدل حساب مندوب.
 *
 * لماذا: `resolveDeliveryMembership` يشترط حساب مستخدمٍ مرتبطاً بالجهة، وأغلب جهات التوصيل
 * كيانُ بياناتٍ بلا حساب ⇒ لا سطر يُختَم مُسلَّماً فلا توريد ولا أجرة، والمال يعلق بلا مخرج.
 * الكشف هو الدليل الذي أقرّه المالك، فتُشتقّ منه سلطةٌ بشكل العضوية نفسها كي يمرّ على **نفس
 * المسار الماليّ** بلا نسخةٍ ثانية تنجرف.
 *
 * الدور `MANAGER` مقصود: يتجاوز حصر السائق بإرسالياته وحدَه (`assertMemberCanUseConsignment`)
 * — الكشف مستندُ الشركة كلّها لا سجلَّ سائقٍ بعينه. و`userId = 0` علامةٌ صريحة على أنّ
 * السلطة ليست لمستخدمٍ بل لمستند؛ هويّة **الفاعل الحقيقيّ** تبقى في `actor` وسجلّ التدقيق.
 */
export async function resolveStatementWitnessAuthority(
  partyId: number,
): Promise<DeliveryMembership | null> {
  const db = getDb();
  if (!db) return null;
  const party = (
    await db
      .select({
        id: deliveryParties.id,
        name: deliveryParties.name,
        partyType: deliveryParties.partyType,
        isActive: deliveryParties.isActive,
      })
      .from(deliveryParties)
      .where(eq(deliveryParties.id, partyId))
      .limit(1)
  )[0];
  if (!party || party.isActive === false) return null;
  return {
    partyId: Number(party.id),
    partyName: party.name,
    partyType: party.partyType as "INDIVIDUAL" | "COMPANY",
    memberRole: "MANAGER",
    userId: 0,
  };
}

/** Resolve the new membership model first, then the legacy one-account link. */
export async function resolveDeliveryMembership(
  userId: number,
): Promise<DeliveryMembership | null> {
  const db = getDb();
  if (!db) return null;
  const member = (
    await db
      .select({
        partyId: deliveryParties.id,
        partyName: deliveryParties.name,
        partyType: deliveryParties.partyType,
        memberRole: deliveryPartyMembers.memberRole,
        isActive: deliveryParties.isActive,
      })
      .from(deliveryPartyMembers)
      .innerJoin(
        deliveryParties,
        eq(deliveryParties.id, deliveryPartyMembers.partyId),
      )
      .where(
        and(
          eq(deliveryPartyMembers.userId, userId),
          eq(deliveryPartyMembers.isActive, true),
        ),
      )
      .limit(1)
  )[0];
  if (member?.isActive) {
    return {
      partyId: Number(member.partyId),
      partyName: member.partyName,
      partyType: member.partyType,
      memberRole: member.memberRole,
      userId,
    };
  }

  const legacy = (
    await db
      .select({
        partyId: deliveryParties.id,
        partyName: deliveryParties.name,
        partyType: deliveryParties.partyType,
        isActive: deliveryParties.isActive,
      })
      .from(deliveryParties)
      .where(eq(deliveryParties.userId, userId))
      .limit(1)
  )[0];
  if (!legacy?.isActive) return null;
  return {
    partyId: Number(legacy.partyId),
    partyName: legacy.partyName,
    partyType: legacy.partyType,
    memberRole: legacy.partyType === "COMPANY" ? "MANAGER" : "DRIVER",
    userId,
  };
}

export async function appendDeliveryLedgerEntry(
  tx: Tx,
  input: {
    eventKey: string;
    partyId: number;
    consignmentId?: number | null;
    remittanceId?: number | null;
    branchId: number;
    entryType:
      | "COD_ASSIGNED"
      | "COD_COLLECTED"
      | "COD_REMITTED"
      | "COD_RELEASED"
      | "COD_WRITTEN_OFF"
      | "COD_RECOVERED"
      // Slice DFP1 (٣٠/٨/٢٦، هجرة 0295): عجزُ التحصيل — ذمّة فوريّة على المندوب.
      | "SHORTFALL_ASSIGNED"
      | "FEE_EARNED"
      | "FEE_PAID"
      | "FEE_OFFSET"
      | "FEE_REFUNDED";
    amount: string;
    notes?: string | null;
    actorUserId?: number | null;
    occurredAt?: Date;
    /**
     * Slice DFP1 (٣٠/٨/٢٦): سببُ العجز حين `entryType='SHORTFALL_ASSIGNED'` — قيمةٌ من enum
     * `shared/shortfallReason.ts`. المستدعي يمرّرها كنصّ، والحقلُ يبقى NULL لبقيّة الأنواع.
     */
    shortfallReason?: string | null;
  },
): Promise<void> {
  if (Number(input.amount) === 0) return;
  await tx.insert(deliveryLedgerEntries).values({
    eventKey: input.eventKey,
    partyId: input.partyId,
    consignmentId: input.consignmentId ?? null,
    remittanceId: input.remittanceId ?? null,
    branchId: input.branchId,
    entryType: input.entryType,
    amount: input.amount,
    notes: input.notes ?? null,
    createdBy: input.actorUserId ?? null,
    occurredAt: input.occurredAt ?? new Date(),
    shortfallReason: input.shortfallReason ?? null,
  });
}

/** Event and outbox are deliberately written in the caller's transaction. */
export async function appendDeliveryEvent(
  tx: Tx,
  input: {
    eventKey: string;
    consignmentId: number;
    eventType: string;
    fromParcelStatus?: string | null;
    toParcelStatus?: string | null;
    fromMoneyStatus?: string | null;
    toMoneyStatus?: string | null;
    actorUserId?: number | null;
    payload?: Record<string, unknown>;
  },
): Promise<number> {
  const payload = input.payload ?? {};
  const inserted = await tx.insert(deliveryEvents).values({
    eventKey: input.eventKey,
    consignmentId: input.consignmentId,
    eventType: input.eventType,
    fromParcelStatus: input.fromParcelStatus ?? null,
    toParcelStatus: input.toParcelStatus ?? null,
    fromMoneyStatus: input.fromMoneyStatus ?? null,
    toMoneyStatus: input.toMoneyStatus ?? null,
    payload,
    actorUserId: input.actorUserId ?? null,
  });
  const eventId = extractInsertId(inserted);
  await tx.insert(deliveryOutbox).values({
    eventId,
    topic: `delivery.${input.eventType.toLowerCase()}`,
    payload: {
      eventId,
      consignmentId: input.consignmentId,
      eventType: input.eventType,
      ...payload,
    },
  });
  return eventId;
}

const allowed: Record<ParcelStatus, ParcelStatus[]> = {
  ASSIGNED: ["ACCEPTED", "FAILED"],
  ACCEPTED: ["PICKED_UP", "FAILED"],
  PICKED_UP: ["OUT_FOR_DELIVERY", "FAILED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED"],
  DELIVERED: [],
  FAILED: ["ASSIGNED", "RETURNED"],
  CANCELLED: [],
  RETURNED: [],
};

export function assertParcelTransition(
  from: ParcelStatus,
  to: ParcelStatus,
): void {
  if (!allowed[from]?.includes(to)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `انتقال حالة التوصيل غير مسموح: ${from} → ${to}`,
    });
  }
}

export type ConsignmentStatus = DeliveryConsignmentStatus;

/**
 * **جدولُ انتقالات الإغلاق الماليّ للإرسالية** (`deliveryConsignments.status`) — م١ (PR-4).
 *
 * كان كلُّ كاتبٍ يقرّر الحالةَ التالية بحرّاسه المحلّية (`status ∈ {DISPATCHED, PARTIAL}` هنا،
 * `status === "DISPATCHED"` هناك) بلا مرجعٍ واحد يقول ما الانتقالُ المشروع. هذا الجدولُ يعلنه في
 * موضعٍ واحد **بلا تغييرٍ سلوكيّ**: كلُّ زوجٍ فيه يقع في الشيفرة اليوم، وكلُّ كاتبٍ يمرّ بـ
 * `assertConsignmentStatusTransition` قبل كتابته — فانتقالٌ جديد يظهر هنا وفي سجلّ الأتمتة
 * (`shared/automationRegistry.ts`، يحرس تطابقَهما `deliveryConsignmentTransitions.test.ts`).
 *
 *   DISPATCHED  → DELIVERED (توريدٌ مكتمل/سدادٌ كاونتريّ/ختمُ طردٍ بلا COD) · PARTIAL (توريدٌ ناقص)
 *               · CANCELLED (إلغاءُ إسناد) · RETURNED (استلامُ المرتجع) · WRITTEN_OFF (شطبٌ موجَّه)
 *   PARTIAL     → DELIVERED (توريدٌ متمِّم) · WRITTEN_OFF (شطبُ الباقي)
 *   CANCELLED   → DISPATCHED (إعادةُ تنشيط الصفّ الملغى بإسنادٍ جديد — `dispatch*.ts`)
 *   RETURNED    → DISPATCHED (إعادةُ إسناد أمر شغلٍ أُرجع طردُه بلا تحصيل — `dispatch.ts`)
 *   DELIVERED / WRITTEN_OFF نهائيّتان.
 *
 * الانتقالُ إلى الحالة نفسها (PARTIAL → PARTIAL عند توريدٍ ناقصٍ ثانٍ) لا يُعدّ انتقالاً ويمرّ.
 */
export const CONSIGNMENT_STATUS_TRANSITIONS: Readonly<Record<ConsignmentStatus, readonly ConsignmentStatus[]>> =
  Object.freeze({
    DISPATCHED: ["DELIVERED", "PARTIAL", "CANCELLED", "RETURNED", "WRITTEN_OFF"],
    PARTIAL: ["DELIVERED", "WRITTEN_OFF"],
    DELIVERED: [],
    CANCELLED: ["DISPATCHED"],
    RETURNED: ["DISPATCHED"],
    WRITTEN_OFF: [],
  });

export function assertConsignmentStatusTransition(
  from: ConsignmentStatus,
  to: ConsignmentStatus,
): void {
  if (from === to) return;
  if (!CONSIGNMENT_STATUS_TRANSITIONS[from]?.includes(to)) {
    const exits = CONSIGNMENT_STATUS_TRANSITIONS[from] ?? [];
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `انتقال حالة إغلاق الإرسالية غير مسموح: ${from} → ${to}`,
        why: exits.length
          ? `الإرسالية بحالة ${from} ولا تخرج منها إلّا إلى ${exits.join(" / ")} — والمطلوب ${to} ليس بينها`
          : `الحالة ${from} نهائيّة — أُغلق ملفُّ الإرسالية ماليّاً ولا مخرجَ منها`,
        doThis: "افتح بطاقة الإرسالية وراجع حالتها الحاليّة وسجلّ أحداثها؛ فإن كان الإغلاق خطأً فأعِد إسنادها من جديد بدل تكرار العمليّة عليها",
      }),
    });
  }
}

export function assertMemberCanUseConsignment(
  membership: DeliveryMembership,
  consignment: { partyId: number | string; assignedUserId?: number | null },
): void {
  if (Number(consignment.partyId) !== membership.partyId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هذه الإرسالية لا تخص جهة التوصيل المرتبطة بحسابك",
    });
  }
  if (
    membership.memberRole === "DRIVER" &&
    consignment.assignedUserId != null &&
    Number(consignment.assignedUserId) !== membership.userId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هذه الإرسالية مسندة إلى سائق آخر داخل الشركة",
    });
  }
}

/** Aggregates are derived from the immutable ledger, never currentBalance. */
export async function getDeliveryFinancialSummary(partyId: number, assignedUserId?: number) {
  const db = getDb();
  if (!db) {
    return {
      codAssigned: "0.00",
      codCollected: "0.00",
      codRemitted: "0.00",
      codReleased: "0.00",
      codWrittenOff: "0.00",
      codRecovered: "0.00",
      codOutstanding: "0.00",
      codOutstandingRaw: "0.00",
      cashInCustody: "0.00",
      feeEarned: "0.00",
      feePaid: "0.00",
      feeDue: "0.00",
      feeDueRaw: "0.00",
      hasFinancialAnomaly: false,
    };
  }
  const row = (
    await db
      .select({
        codAssigned: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_ASSIGNED' THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
        codCollected: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_COLLECTED' THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
        codRemitted: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_REMITTED' THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
        codReleased: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_RELEASED' THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
        codWrittenOff: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_WRITTEN_OFF' THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
        codRecovered: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_RECOVERED' THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
        feeEarned: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} = 'FEE_REFUNDED' THEN -${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
        feePaid: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET') THEN ${deliveryLedgerEntries.amount} ELSE 0 END),0)`,
      })
      .from(deliveryLedgerEntries)
      .leftJoin(deliveryConsignments, eq(deliveryConsignments.id, deliveryLedgerEntries.consignmentId))
      .where(and(
        eq(deliveryLedgerEntries.partyId, partyId),
        assignedUserId == null ? undefined : eq(deliveryConsignments.assignedUserId, assignedUserId),
      ))
  )[0];
  const n = (v: unknown) => Number(v ?? 0);
  const assigned = n(row?.codAssigned);
  const collected = n(row?.codCollected);
  const remitted = n(row?.codRemitted);
  const released = n(row?.codReleased);
  const writtenOff = n(row?.codWrittenOff);
  const recovered = n(row?.codRecovered);
  const earned = n(row?.feeEarned);
  const paid = n(row?.feePaid);
  const outstandingRaw = assigned - collected - released;
  const custody = collected - remitted - writtenOff;
  const feeDueRaw = earned - paid;
  /**
   * Slice DFP2 (٣١/٨/٢٦): قصّ `feeDue` عند صفر — أُبلغ عنه على الإنتاج (٣١/٨):
   * «أجرة مستحقة −1,000 د.ع» على مودال ابراهيم احمد. السالب يعني `feePaid > feeEarned` — أي دفعنا
   * لهذا المندوب زيادة (تصحيحُ سندٍ سابق أو صرفٌ فوق المستحقّ). القيمة السالبة تُعرَض للمستعمِل
   * كأنّها «مستحقٌّ عليه» بينما الحقيقة أنّها فائضٌ تاريخيّ — التباسٌ ماليّ خطر.
   *
   * القرار: قصّ صريح عند صفر (كما في listPartyObligations.feeDueTotal) + إبقاء `feeDueRaw` للتنبيه.
   * التقارير التاريخيّة تستعمل الخام؛ الشاشة اليومية تستعمل المقصوص.
   */
  const feeDue = Math.max(0, feeDueRaw);
  return {
    codAssigned: assigned.toFixed(2),
    codCollected: collected.toFixed(2),
    codRemitted: remitted.toFixed(2),
    codReleased: released.toFixed(2),
    codWrittenOff: writtenOff.toFixed(2),
    codRecovered: recovered.toFixed(2),
    codOutstanding: Math.max(outstandingRaw, 0).toFixed(2),
    codOutstandingRaw: outstandingRaw.toFixed(2),
    cashInCustody: custody.toFixed(2),
    feeEarned: earned.toFixed(2),
    feePaid: paid.toFixed(2),
    feeDue: feeDue.toFixed(2),
    /** Slice DFP2: القيمة الخام قبل القصّ — للتنبيه ولا تُعرَض عادةً. */
    feeDueRaw: feeDueRaw.toFixed(2),
    hasFinancialAnomaly: outstandingRaw < 0 || custody < 0 || feeDueRaw < 0,
  };
}

export const memberVisibilityCondition = (
  membership: DeliveryMembership,
) =>
  membership.memberRole === "DRIVER"
    ? or(
        eq(deliveryConsignments.assignedUserId, membership.userId),
        isNull(deliveryConsignments.assignedUserId),
      )
    : undefined;
