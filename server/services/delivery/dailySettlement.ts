/**
 * **التسويةُ اليوميّة لجهة التوصيل — «المتوقَّع محسوبٌ سلفاً، والتأكيدُ واحد»** (م١، PR-2).
 *
 * العقد المشترك مع الواجهة: `shared/deliveryBoard.ts` (`SettlementPreview` · `SettleDailyResult`).
 *
 * لماذا: شاشةُ التوريد القائمة تطلب من الموظّف اختيارَ الأسطر وإدخالَ مبالغها ثمّ عدَّ النقد — بينما
 * النظام يعرف المتوقَّع (كلّ طردٍ مُسلَّم لم يُورَّد + متبقّيه الحيّ). فالمعاينةُ تحسبه، والتسويةُ
 * تستدعي **الآلية القائمة نفسها** (`recordDeliveryRemittanceInTx`) بكلّ الأسطر — لا نسخةَ ثانية
 * من التوريد تنجرف عن الأولى — وتُضيف قرار العجز بسببٍ مصنَّف (يُقيَّد ذمّةً على الجهة) أو
 * ترفض الزيادة (تحتاج مصدراً: سندُ قبضٍ مستقلّ).
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import type { SettlementPreview, SettlementPreviewLine, SettleDailyResult } from "@shared/deliveryBoard";
import { isShortfallReason, type ShortfallReason } from "@shared/shortfallReason";
import { computePartyExposure, type PartyExposureLedgerEntry } from "@shared/partyExposure";
import {
  customers,
  deliveryConsignments,
  deliveryLedgerEntries,
  deliveryParties,
  invoices,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2 } from "../money";
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
      .select({ id: deliveryParties.id, name: deliveryParties.name, branchId: deliveryParties.branchId })
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
async function loadSettlementLines(tx: Tx, scope: DailySettlementScope): Promise<SettlementPreviewLine[]> {
  const rows = await tx
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      counterSettledAmount: deliveryConsignments.counterSettledAmount,
      // عجزُ التسليم المُقيَّد على الطرد — نقدٌ لم تقبضه الجهة (انظر `openParcelPredicates.ts`).
      shortfallAssigned: consignmentShortfallAssignedSql,
      parcelStatus: deliveryConsignments.parcelStatus,
      recipientName: deliveryConsignments.recipientName,
      invoiceNumber: invoices.invoiceNumber,
      invoiceContactName: invoices.contactName,
      customerName: customers.name,
    })
    .from(deliveryConsignments)
    .innerJoin(invoices, eq(invoices.id, deliveryConsignments.invoiceId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(
      eq(deliveryConsignments.partyId, scope.partyId),
      eq(deliveryConsignments.branchId, scope.branchId),
      sql`${deliveryConsignments.status} IN ('DISPATCHED', 'PARTIAL')`,
      eq(deliveryConsignments.parcelStatus, "DELIVERED"),
      sql`${deliveryConsignments.moneyStatus} IN ('UNSETTLED', 'PARTIAL')`,
      isNull(deliveryConsignments.returnDeclaredAt),
    ))
    .orderBy(deliveryConsignments.id);
  const lines: SettlementPreviewLine[] = [];
  for (const r of rows) {
    const cod = round2(money(r.codAmount));
    const collected = round2(money(r.collectedAmount ?? "0"));
    const remaining = round2(
      cod.minus(collected).minus(money(r.counterSettledAmount ?? "0")).minus(money(r.shortfallAssigned ?? "0")),
    );
    if (remaining.lte(0)) continue;
    lines.push({
      consignmentId: Number(r.id),
      consignmentNumber: r.consignmentNumber,
      invoiceNumber: r.invoiceNumber,
      customerName: r.customerName ?? r.invoiceContactName ?? r.recipientName ?? "زبون عابر",
      codAmount: cod.toFixed(2),
      collectedAmount: collected.toFixed(2),
      remaining: remaining.toFixed(2),
      parcelStatus: r.parcelStatus,
    });
  }
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
    .where(eq(deliveryLedgerEntries.partyId, partyId))
    .groupBy(deliveryLedgerEntries.entryType);
  const ledger: PartyExposureLedgerEntry[] = agg.map((r) => ({ entryType: r.entryType, amount: String(r.total ?? "0") }));
  return computePartyExposure({ cashInHand: 0, parcels: [], ledger }).feesOwedToThem;
}

export async function previewDailySettlementTx(
  tx: Tx,
  scope: DailySettlementScope,
  _actor: DeliveryTxActor,
): Promise<SettlementPreview> {
  await loadPartyOrThrow(tx, scope.partyId, "تعذّر حساب تسوية الجهة");
  const lines = await loadSettlementLines(tx, scope);
  const expectedCash = round2(lines.reduce((s, l) => s.plus(money(l.remaining)), money(0)));
  const returnsAwaiting = (
    await tx
      .select({ n: sql<number>`COUNT(*)` })
      .from(deliveryConsignments)
      .where(and(
        eq(deliveryConsignments.partyId, scope.partyId),
        eq(deliveryConsignments.branchId, scope.branchId),
        eq(deliveryConsignments.status, "DISPATCHED"),
        isNotNull(deliveryConsignments.returnDeclaredAt),
      ))
  )[0];
  // الاستقطاعات تُعرَف لحظة التوريد من كشف الشركة (إن وُجد) — المعاينة اليوميّة بلا كشف: صفر.
  const deductions = money(0);
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
  /** إلزاميٌّ حين يقلّ المعدود عن المتوقَّع — من القائمة المغلقة `shared/shortfallReason.ts`. */
  shortfallReason?: ShortfallReason | string | null;
  shortfallNotes?: string | null;
  shiftType?: "RECEPTION" | "RETAIL";
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
  const party = await loadPartyOrThrow(tx, input.partyId, "تعذّر تسجيل التسوية اليوميّة");
  const lines = await loadSettlementLines(tx, input);
  if (!lines.length) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: `لا شيء يُسوَّى لجهة «${party.name}» اليوم`,
        why: "لا طرود مُسلَّمة بنقدٍ لم يُورَّد على هذا الفرع — كلّ ما سُلِّم وُرِّد أو سُدِّد بالكاونتر",
        doThis: "اختم تسليم الطرود التي وصلت زبائنها أوّلاً (كشف الشركة أو «تم التسليم»)، ثمّ أعد التسوية",
      }),
    });
  }
  const expected = round2(lines.reduce((s, l) => s.plus(money(l.remaining)), money(0)));
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
  let shortfall: { reason: ShortfallReason; notes?: string | null } | null = null;
  if (counted.lt(expected)) {
    const reason = input.shortfallReason;
    if (!reason || !isShortfallReason(reason)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `النقد المعدود أقلّ من المتوقَّع لجهة «${party.name}»`,
          why: `المتوقَّع ${expected.toFixed(2)} والمعدود ${counted.toFixed(2)} — عجزٌ قدره ${expected.minus(counted).toFixed(2)} بلا سببٍ مصنَّف، والعجزُ يُقيَّد ذمّةً على الجهة فلا يُقبل بلا تصنيف`,
          doThis: "اختر سبب العجز من القائمة ثمّ أكّد؛ أو أعد عدّ النقد إن كان الفرق خطأً",
        }),
      });
    }
    shortfall = { reason, notes: input.shortfallNotes ?? null };
  }
  const res = await recordDeliveryRemittanceInTx(
    tx,
    {
      branchId: input.branchId,
      partyId: input.partyId,
      lines: lines.map((l) => ({ consignmentId: l.consignmentId, collectedAmount: l.remaining })),
      countedCash: counted.toFixed(2),
      shiftType: input.shiftType ?? "RECEPTION",
      clientRequestId: input.clientRequestId ?? null,
      shortfall,
    },
    actor,
  );
  return {
    remittanceId: res.remittanceId,
    status: res.status === "SHORT" ? "SHORT" : "BALANCED",
    shortfallTotal: String(res.shortfallTotal),
    receiptId: "receiptInId" in res && res.receiptInId != null ? Number(res.receiptInId) : null,
  };
}
