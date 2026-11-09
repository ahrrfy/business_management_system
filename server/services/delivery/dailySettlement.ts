import Decimal from "decimal.js";
import { consignmentFeeDueSql, createFeeWithholdingPolicy } from "./fees";
import { planDetachedShipmentFees } from "./detachedShipmentFees";
import { assertFeeWithholdingCapacity } from "./feeWithholdingPolicy";
/**
 * **التسويةُ اليوميّة لجهة التوصيل — «المتوقَّع محسوبٌ سلفاً، والتأكيدُ واحد»** (م١، PR-2).
 *
 * العقد المشترك مع الواجهة: `shared/deliveryBoard.ts` (`SettlementPreview` · `SettleDailyResult`).
 *
 * لماذا: شاشةُ التوريد القائمة تطلب من الموظّف اختيارَ الأسطر وإدخالَ مبالغها ثمّ عدَّ النقد — بينما
 * النظام يعرف المتوقَّع (كلّ طردٍ مُسلَّم لم يُورَّد + متبقّيه الحيّ). فالمعاينةُ تحسبه، والتسويةُ
 * تستدعي **الآلية القائمة نفسها** (`recordDeliveryRemittanceInTx`) بكلّ الأسطر — لا نسخةَ ثانية
 * من التوريد تنجرف عن الأولى — ويجب أن يطابق النقد المستلم الصافي كاملاً.
 */
import { effectiveDeliveryLedgerEntrySql } from "./legacyLedger";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import type {
  SettlementPreview,
  SettlementPreviewLine,
  SettleDailyResult,
} from "@shared/deliveryBoard";
import type { ShortfallReason } from "@shared/shortfallReason";
import {
  computePartyExposure,
  type PartyExposureLedgerEntry,
} from "@shared/partyExposure";
import {
  customers,
  deliveryConsignments,
  deliveryLedgerEntries,
  deliveryParties,
  deliveryRemittances,
  deliveryShipmentMembers,
  invoices,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import { money, round2, toDbMoney } from "../money";
import { consignmentShortfallAssignedSql } from "./openParcelPredicates";
import { recordDeliveryRemittanceInTx } from "./remittance";
import type { DeliveryTxActor } from "./types";

export interface DailySettlementScope {
  partyId: number;
  branchId: number;
}

async function loadPartyOrThrow(tx: Tx, partyId: number, what: string) {
  const party = (
    await tx
      .select({
        id: deliveryParties.id,
        name: deliveryParties.name,
        branchId: deliveryParties.branchId,
        useCommission: deliveryParties.useCommissionForSettlement,
      })
      .from(deliveryParties)
      .where(eq(deliveryParties.id, partyId))
      .limit(1)
  )[0];
  if (!party) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: appErrorMessage({
        what,
        why: `جهة التوصيل رقم ${partyId} غير موجودة أو أُزيلت`,
        doThis: "افتح شاشة «مناديب التوصيل» واختر جهةً موجودة",
      }),
    });
  }
  return party;
}

/**
 * الطرودُ المُسلَّمة غير المورَّدة لهذه الجهة على هذا الفرع، بمتبقّيها الحيّ
 * (`codAmount − collectedAmount − counterSettledAmount` > 0) — نفس تعريف سطر التوريد في
 * `recordDeliveryRemittanceInTx` حرفياً، مستثنىً منها المُعلَنُ رجوعُه.
 */
async function loadSettlementLines(
  tx: Tx,
  scope: DailySettlementScope,
  useCommission = false,
): Promise<SettlementPreviewLine[]> {
  const rows = await tx
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      codAmount: deliveryConsignments.codAmount,
      sourceType: deliveryConsignments.sourceType,
      feeCollection: deliveryConsignments.feeCollection,
      feeDue: consignmentFeeDueSql(),
      orderTotal: sql<string>`GREATEST(COALESCE(${invoices.total} - ${invoices.returnedTotal},0), 0)`,
      collectedAmount: deliveryConsignments.collectedAmount,
      counterSettledAmount: deliveryConsignments.counterSettledAmount,
      // عجزُ التسليم المُقيَّد على الطرد — نقدٌ لم تقبضه الجهة (انظر `openParcelPredicates.ts`).
      shortfallAssigned: consignmentShortfallAssignedSql, cashInCourierCustody: sql<string>`GREATEST(COALESCE((SELECT SUM(CASE WHEN returned_cash.entryType='COD_COLLECTED' THEN returned_cash.amount WHEN returned_cash.entryType IN ('COD_REMITTED','COD_RETURNED','COD_WRITTEN_OFF') THEN -returned_cash.amount ELSE 0 END) FROM deliveryLedgerEntries returned_cash WHERE returned_cash.consignmentId = ${deliveryConsignments.id} AND ${effectiveDeliveryLedgerEntrySql("returned_cash")}),0),0)`,
      parcelStatus: deliveryConsignments.parcelStatus,
      recipientName: deliveryConsignments.recipientName,
      invoiceNumber: invoices.invoiceNumber,
      invoiceContactName: invoices.contactName,
      customerName: customers.name,
    })
    .from(deliveryConsignments)
    .leftJoin(invoices, eq(invoices.id, deliveryConsignments.invoiceId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(
      and(
        eq(deliveryConsignments.partyId, scope.partyId),
        eq(deliveryConsignments.branchId, scope.branchId),
        sql`${deliveryConsignments.status} IN ('DISPATCHED', 'PARTIAL')`,
        eq(deliveryConsignments.parcelStatus, "DELIVERED"),
        sql`${deliveryConsignments.moneyStatus} IN ('UNSETTLED', 'PARTIAL')`,
        isNull(deliveryConsignments.returnDeclaredAt),
      ),
    )
    .orderBy(deliveryConsignments.id);
  const feePolicy = await createFeeWithholdingPolicy(
    tx,
    scope.partyId,
    useCommission,
  );
  const { quoteFee } = feePolicy;
  const lines: SettlementPreviewLine[] = [];
  const unremittableDeliveredIds: number[] = [];
  for (const r of rows) {
    const cod = round2(money(r.codAmount));
    const collected = round2(money(r.collectedAmount ?? "0"));
    const remaining = round2(
      cod
        .minus(collected)
        .minus(money(r.counterSettledAmount ?? "0"))
        .minus(money(r.shortfallAssigned ?? "0")),
    );
    if (remaining.lte(0)) continue;
    if (round2(money(r.cashInCourierCustody ?? "0")).lte(0)) {
      unremittableDeliveredIds.push(Number(r.id));
      continue;
    }
    let feeWithholding = money(0);
    if (r.sourceType === "ONLINE_ORDER" && r.feeCollection === "SHOP") {
      const due = money(r.feeDue);
      const quotedCash = quoteFee(due, money(r.orderTotal));
      assertFeeWithholdingCapacity(due, quotedCash, remaining);
      feeWithholding = Decimal.min(remaining, quotedCash);
    }
    lines.push({
      consignmentId: Number(r.id),
      consignmentNumber: r.consignmentNumber,
      invoiceNumber: r.invoiceNumber,
      customerName:
        r.customerName ??
        r.invoiceContactName ??
        r.recipientName ??
        "زبون عابر",
      codAmount: cod.toFixed(2),
      collectedAmount: collected.toFixed(2),
      remaining: remaining.toFixed(2),
      parcelStatus: r.parcelStatus,
      feeWithholding: feeWithholding.toFixed(2),
    });
  }
  if (unremittableDeliveredIds.length > 0) {
    const unremittableMemberships = await tx
      .select({ leaderId: deliveryShipmentMembers.leaderConsignmentId })
      .from(deliveryShipmentMembers)
      .where(inArray(deliveryShipmentMembers.consignmentId, unremittableDeliveredIds));
    const unremittableLeaders = Array.from(
      new Set(unremittableMemberships.map((m) => Number(m.leaderId))),
    );
    if (unremittableLeaders.length > 0) {
      const lineIdSet = new Set(lines.map((line) => line.consignmentId));
      const shipmentRows = await tx
        .select({
          leaderId: deliveryShipmentMembers.leaderConsignmentId,
          cn: deliveryConsignments,
          shortfall: consignmentShortfallAssignedSql,
        })
        .from(deliveryShipmentMembers)
        .innerJoin(
          deliveryConsignments,
          eq(deliveryConsignments.id, deliveryShipmentMembers.consignmentId),
        )
        .where(inArray(deliveryShipmentMembers.leaderConsignmentId, unremittableLeaders));
      for (const leaderId of unremittableLeaders) {
        const owing = shipmentRows
          .filter(
            (row) =>
              Number(row.leaderId) === leaderId &&
              !["CANCELLED", "RETURNED", "WRITTEN_OFF"].includes(row.cn.status) &&
              !["CANCELLED", "RETURNED"].includes(row.cn.parcelStatus),
          )
          .filter((row) =>
            round2(
              Decimal.max(
                0,
                money(row.cn.codAmount)
                  .minus(money(row.cn.collectedAmount ?? "0"))
                  .minus(money(row.cn.counterSettledAmount ?? "0"))
                  .minus(money(row.shortfall ?? "0")),
              ),
            ).gt(0),
          );
        if (
          owing.some(
            (row) =>
              row.cn.parcelStatus !== "DELIVERED" ||
              lineIdSet.has(Number(row.cn.id)),
          )
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "تعذر معاينة تسوية الشحنة",
              why: "توجد فواتير أخرى للشحنة لم تُدرج في التسوية",
              doThis: "راجع جميع فواتير الشحنة وأجرتها قبل التوريد",
            }),
          });
        }
      }
    }
  }
  const detached = await planDetachedShipmentFees(tx, { partyId: scope.partyId, branchId: scope.branchId,
    consignmentIds: lines.map((line) => line.consignmentId), useCommission, includePending: false, requireComplete: true, feePolicy });
  if (detached.blocked || detached.uncovered || detached.incomplete) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
      what: "تعذر معاينة تسوية الشحنة", why: detached.incomplete ? "توجد فواتير أخرى للشحنة لم تُدرج في التسوية" : detached.blocked ? "أجرة على فاتورة مغلقة تحتاج مطابقة قاعدة العمولة" : "نقد الشحنة لا يغطي أجرتها كاملة",
      doThis: "راجع جميع فواتير الشحنة وأجرتها قبل التوريد",
    }) });
  }
  for (const line of lines) line.feeWithholding = round2(money(line.feeWithholding ?? "0")
    .plus(detached.allocations.get(line.consignmentId) ?? 0)).toFixed(2);
  return lines;
}

/** أجرةُ الجهة المستحقّة من الدفتر — نفس عمود `feesOwedToThem` في `computePartyExposure`. */
async function ledgerFeeDue(tx: Tx, partyId: number): Promise<string> {
  const agg = await tx
    .select({
      entryType: deliveryLedgerEntries.entryType,
      total: sql<string>`COALESCE(SUM(${deliveryLedgerEntries.amount}), 0)`,
    })
    .from(deliveryLedgerEntries)
    .where(
      and(
        eq(deliveryLedgerEntries.partyId, partyId),
        effectiveDeliveryLedgerEntrySql(),
      ),
    )
    .groupBy(deliveryLedgerEntries.entryType);
  const ledger: PartyExposureLedgerEntry[] = agg.map((r) => ({
    entryType: r.entryType,
    amount: String(r.total ?? "0"),
  }));
  return computePartyExposure({ cashInHand: 0, parcels: [], ledger })
    .feesOwedToThem;
}

export async function previewDailySettlementTx(
  tx: Tx,
  scope: DailySettlementScope,
  _actor: DeliveryTxActor,
): Promise<SettlementPreview> {
  const party = await loadPartyOrThrow(
    tx,
    scope.partyId,
    "تعذّر حساب تسوية الجهة",
  );
  const lines = await loadSettlementLines(
    tx,
    scope,
    party.useCommission === true,
  );
  const expectedCash = round2(
    lines.reduce((s, l) => s.plus(money(l.remaining)), money(0)),
  );
  const returnsAwaiting = (
    await tx
      .select({ n: sql<number>`COUNT(*)` })
      .from(deliveryConsignments)
      .where(
        and(
          eq(deliveryConsignments.partyId, scope.partyId),
          eq(deliveryConsignments.branchId, scope.branchId),
          eq(deliveryConsignments.status, "DISPATCHED"),
          isNotNull(deliveryConsignments.returnDeclaredAt),
        ),
      )
  )[0];
  // المعاينة اليومية تحسم أجور المتجر المستحقة؛ الاستقطاع الإضافي يصرح به كشف الشركة.
  const deductions = lines.reduce(
    (v, l) => v.plus(money(l.feeWithholding ?? "0")),
    money(0),
  );
  return {
    partyId: scope.partyId,
    branchId: scope.branchId,
    expectedCash: expectedCash.toFixed(2),
    feeDue: await ledgerFeeDue(tx, scope.partyId),
    deductions: deductions.toFixed(2),
    net: round2(expectedCash.minus(deductions)).toFixed(2),
    lines,
    returnsAwaitingReceipt: Number(returnsAwaiting?.n ?? 0),
  };
}

export interface SettleDailyInput extends DailySettlementScope {
  /** النقدُ الذي عدّه المستلِم فعلياً من يد الجهة. */
  countedCash: string;
  /** Exact lines reviewed by the user; checked before any financial posting. */
  expectedLines?: Array<{ consignmentId: number; remaining: string }>;
  /** إلزاميٌّ حين يقلّ المعدود عن المتوقَّع — من القائمة المغلقة `shared/shortfallReason.ts`. */
  shortfallReason?: ShortfallReason | string | null;
  shortfallNotes?: string | null;
  shiftType?: "RECEPTION" | "RETAIL" | "PRINT_SERVICES";
  /**
   * ش-ISOLATION — الوردية/الدرج الذي سيستلم هذا النقد فعلياً.
   * يُجاوز `shiftType` والبحث الآلي بـ`actor.userId` حين يكون الفرع فيه
   * أكثر من وردية مفتوحة لموظفَين مختلفَين.
   */
  targetShiftId?: number | null;
  clientRequestId?: string | null;
}

/**
 * تأكيدٌ واحد: كلّ الطرود المُسلَّمة غير المورَّدة بمتبقّيها الحيّ عبر آلية التوريد القائمة.
 *   · المعدود = المتوقَّع ⇒ `BALANCED`.
 *   · المعدود < المتوقَّع ⇒ `SHORT` بسببٍ إلزاميّ؛ الفرقُ `SHORTFALL_ASSIGNED` ذمّةً على الجهة.
 *   · المعدود > المتوقَّع ⇒ رفضٌ (الزيادة تحتاج مصدراً — سندُ قبضٍ مستقلّ).
 */
export async function settleDailyTx(
  tx: Tx,
  input: SettleDailyInput,
  actor: DeliveryTxActor,
): Promise<SettleDailyResult> {
  const party = await loadPartyOrThrow(
    tx,
    input.partyId,
    "تعذّر تسجيل التسوية اليوميّة",
  );
  // Codex #1012 P1 — إعادةُ تسويةٍ سبق التزامها (ضاعت استجابتُها عبر النشر/الانقطاع): بعد التزام
  // الأولى تصير طرودُها SETTLED فتعود `loadSettlementLines` فارغةً، فكان الرمي «لا شيء يُسوَّى»
  // يسبق فحصَ idempotency في `recordDeliveryRemittanceInTx` ⇒ يُبلَّغ فشلاً عن عمليةٍ نجح مالُها،
  // فيُعيد الموظّف التسويةَ بمفتاحٍ جديد (تكرار). نفحص هويّة طلب التسوية قبل الأسطر،
  // لكن ببصمة حمولته كاملةً: مفتاحٌ مع نقد/سبب/وردية مختلفة تعارضٌ لا replay للسند القديم.
  const settleRequestHash = idempotencyHash({
    partyId: Number(input.partyId),
    branchId: Number(input.branchId),
    countedCash: toDbMoney(input.countedCash),
    shortfallReason: input.shortfallReason ?? null,
    shiftType: input.shiftType ?? "RECEPTION",
    // ش-ISOLATION: الوردية المستلِمة جزء من هوية التسوية — إعادة بوردية مختلفة تعارض لا replay.
    targetShiftId: input.targetShiftId ?? null,
    ...(input.expectedLines ? { expectedLines: input.expectedLines.map((line) => ({
      consignmentId: Number(line.consignmentId), remaining: toDbMoney(line.remaining),
    })).sort((a, b) => a.consignmentId - b.consignmentId) } : {}),
  });
  if (input.clientRequestId) {
    const existingId = await checkIdempotency(
      tx,
      "delivery.settleDaily",
      input.clientRequestId,
      settleRequestHash,
      { requireStoredHash: true },
    );
    if (existingId != null) {
      const rm = (
        await tx
          .select({
            id: deliveryRemittances.id,
            remittanceNumber: deliveryRemittances.remittanceNumber,
            collectedTotal: deliveryRemittances.collectedTotal,
            feesTotal: deliveryRemittances.feesTotal,
            netRemitted: deliveryRemittances.netRemitted,
            status: deliveryRemittances.status,
            shortfallTotal: deliveryRemittances.shortfallTotal,
            receiptInId: deliveryRemittances.receiptInId,
          })
          .from(deliveryRemittances)
          .where(eq(deliveryRemittances.id, existingId))
          .limit(1)
      )[0];
      if (rm) {
        return {
          remittanceId: Number(rm.id),
          remittanceNumber: rm.remittanceNumber,
          collectedTotal: String(rm.collectedTotal),
          feesTotal: String(rm.feesTotal),
          netRemitted: String(rm.netRemitted),
          status: rm.status === "SHORT" ? "SHORT" : "BALANCED",
          shortfallTotal: String(rm.shortfallTotal),
          receiptId: rm.receiptInId != null ? Number(rm.receiptInId) : null,
        };
      }
    }
  }
  const lines = await loadSettlementLines(
    tx,
    input,
    party.useCommission === true,
  );
  if (input.expectedLines) {
    const canonical = (items: Array<{ consignmentId: number; remaining: string }>) => items
      .map((line) => `${Number(line.consignmentId)}:${toDbMoney(line.remaining)}`).sort();
    if (JSON.stringify(canonical(input.expectedLines)) !== JSON.stringify(canonical(lines))) {
      throw new TRPCError({ code: "CONFLICT", message: appErrorMessage({
        what: "تغيرت شحنات التسوية منذ المعاينة", why: "الإرساليات أو مبالغها لم تعد مطابقة لما راجعته",
        doThis: "حدّث المعاينة وراجع الشحنات مجدداً قبل تأكيد التوريد",
      }) });
    }
  }
  if (!lines.length) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `لا شيء يُسوَّى لجهة «${party.name}» اليوم`,
        why: "لا طرود مُسلَّمة بنقدٍ لم يُورَّد على هذا الفرع — كلّ ما سُلِّم وُرِّد أو سُدِّد بالكاونتر",
        doThis:
          "اختم تسليم الطرود التي وصلت زبائنها أوّلاً (كشف الشركة أو «تم التسليم»)، ثمّ أعد التسوية",
      }),
    });
  }
  const expected = round2(
    lines.reduce(
      (s, l) =>
        s.plus(money(l.remaining)).minus(money(l.feeWithholding ?? "0")),
      money(0),
    ),
  );
  const counted = round2(money(input.countedCash));
  if (counted.lt(0)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل التسوية اليوميّة",
        why: `النقد المعدود سالب (${counted.toFixed(2)})`,
        doThis: "أدخل ما عددته فعلاً من يد الجهة (صفراً فأكثر)",
      }),
    });
  }
  if (!counted.eq(expected)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
    what: `تعذر إقفال توريد جهة «${party.name}»`, why: `المستلم ${counted.toFixed(2)} لا يطابق الصافي ${expected.toFixed(2)}`,
    doThis: "راجع الشحنات وأعد عدّ كامل النقد قبل التوريد",
  }) });
  const res = await recordDeliveryRemittanceInTx(
    tx,
    {
      branchId: input.branchId,
      partyId: input.partyId,
      lines: lines.map((l) => ({
        consignmentId: l.consignmentId,
        collectedAmount: l.remaining,
      })),
      countedCash: counted.toFixed(2),
      requireFullShipment: true,
      shiftType: input.shiftType ?? "RECEPTION",
      clientRequestId: input.clientRequestId ?? null,
      shortfall: null,
      targetShiftId: input.targetShiftId, // ش-ISOLATION: تمرير الدرج الصريح
    },
    actor,
  );
  if (input.clientRequestId) {
    await recordIdempotencyKey(
      tx,
      "delivery.settleDaily",
      input.clientRequestId,
      res.remittanceId,
      settleRequestHash,
    );
  }
  return {
    remittanceId: res.remittanceId,
    remittanceNumber: res.remittanceNumber ?? null,
    collectedTotal: String(res.collectedTotal),
    feesTotal: String(res.feesTotal),
    netRemitted: String(res.netRemitted),
    status: res.status === "SHORT" ? "SHORT" : "BALANCED",
    shortfallTotal: String(res.shortfallTotal),
    receiptId:
      "receiptInId" in res && res.receiptInId != null
        ? Number(res.receiptInId)
        : null,
  };
}
