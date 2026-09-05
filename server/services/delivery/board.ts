/**
 * **لوحةُ جهات التوصيل** (الأعمدة الخمسة + النقد بمصدرَيه) و**اقتراحُ الجهة بالمنطقة** — م١ (PR-2).
 *
 * العقد المشترك مع الواجهة: `shared/deliveryBoard.ts` (م١-عميل يستورده حرفياً). الراوترُ الرقيق
 * في `deliveryRouter.ts` يملكه م١-عميل ويستدعي هاتين الخدمتين.
 *
 * ## لماذا تُستدعى الدالّة النقيّة `computePartyExposure` هنا لا صيغةُ SQL ثالثة
 * كانت ثلاثُ نسخٍ متوازية للأعمدة (`parties.ts` و`queries.ts` و`shared/partyExposure.ts`)، والخادم
 * لا يستدعي النقيّة قطّ — فالدالّةُ التي تُختبَر ليست الدالّةَ التي تُعرَض. هنا يجمع SQL **المدخلات**
 * فقط (الطرود الحيّة + مجاميع الدفتر لكلّ نوع) والحسابُ كلُّه في النقيّة؛ وهي خطّيّة في المبالغ
 * فتمريرُ المجاميع يُنتج ما يُنتجه تمريرُ القيود واحداً واحداً.
 *
 * ## النقد بيد الجهة — مصدران يُعرَضان معاً (الطرح الظلّيّ §١٠)
 * `cashInHandLedger` من الدفتر (`deriveCashInHandFromLedger`) و`cashInHandStored` من العمود، و
 * `cashInHandDrift` فرقُهما؛ أيُّهما يدخل `net` يقرّره `deliveryCashSource()` (علَم `courierLedgerDerived`).
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { appErrorMessage } from "@shared/errors";
import type { PartyBoardBucket, PartyBoardRow } from "@shared/deliveryBoard";
import { computeDeliveryFee, type DeliveryPricingRuleInput } from "@shared/deliveryPricing";
import { computePartyExposure } from "@shared/partyExposure";
import {
  deliveryConsignments,
  deliveryParties,
  deliveryPricingRules,
  deliveryZones,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2 } from "../money";
import { deliveryCashSource } from "./cashSource";
import { loadPartyExposureInputsTx } from "./exposureInputs";
import { consignmentShortfallAssignedSql, staleOpenParcelCondition } from "./openParcelPredicates";
import type { DeliveryTxActor } from "./types";

export interface PartyBoardScope {
  /** فرعُ الرؤية: `null` = كلّ الفروع (للعابر وحده). */
  branchId: number | null;
  /** المالك/الأدمن وحدهما يعبُران (`canCrossBranches` من `server/lib/branchAuthority.ts`). */
  canCrossBranches: boolean;
}

/** نافذةُ عرض المرتجَع والملغى في اللوحة (يومٌ ماضٍ لا أرشيف). */
export const PARTY_BOARD_CLOSED_WINDOW_DAYS = 30;

const ZERO_BUCKET: PartyBoardBucket = { count: 0, amount: "0.00" };

const fmt = (v: unknown): string => round2(money(String(v ?? "0"))).toFixed(2);

export async function listPartyBoardTx(
  tx: Tx,
  scope: PartyBoardScope,
  _actor: DeliveryTxActor,
): Promise<PartyBoardRow[]> {
  if (!scope.canCrossBranches && scope.branchId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر عرض لوحة جهات التوصيل",
        why: "حسابك غير مُسنَدٍ إلى فرع، واللوحة تُعرَض بفرعٍ واحد لغير المالك/الأدمن",
        doThis: "اطلب من المدير إسناد حسابك إلى فرعٍ من شاشة المستخدمين، ثمّ أعد فتح اللوحة",
      }),
    });
  }
  const branchId = scope.branchId;

  const parties = await tx
    .select({
      id: deliveryParties.id,
      name: deliveryParties.name,
      partyType: deliveryParties.partyType,
      currentBalance: deliveryParties.currentBalance,
      isActive: deliveryParties.isActive,
      maxOpenParcelAgeDays: deliveryParties.maxOpenParcelAgeDays,
    })
    .from(deliveryParties)
    .where(branchId == null ? undefined : or(isNull(deliveryParties.branchId), eq(deliveryParties.branchId, branchId)))
    .orderBy(asc(deliveryParties.name));
  if (!parties.length) return [];
  const partyIds = parties.map((p) => Number(p.id));
  const cnBranch = branchId == null ? undefined : eq(deliveryConsignments.branchId, branchId);
  const windowStart = sql`DATE_SUB(NOW(), INTERVAL ${PARTY_BOARD_CLOSED_WINDOW_DAYS} DAY)`;

  // ── الدلاء الخمسة (parcelStatus = الحالة الفيزيائيّة) ────────────────────────────────
  const cod = sql`CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2))`;
  // المتبقّي الحيّ = COD − المورَّد − المسدَّد كاونترياً − عجزُ التسليم المُقيَّد على الطرد (لم تقبضه الجهة).
  const liveRemaining = sql`GREATEST(${cod}
    - CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2))
    - CAST(${deliveryConsignments.counterSettledAmount} AS DECIMAL(15,2))
    - ${consignmentShortfallAssignedSql}, 0)`;
  const isAssigned = sql`${deliveryConsignments.parcelStatus} IN ('ASSIGNED','ACCEPTED','PICKED_UP') AND ${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL')`;
  const isInTransit = sql`${deliveryConsignments.parcelStatus} = 'OUT_FOR_DELIVERY' AND ${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL')`;
  const isDeliveredUnremitted = sql`${deliveryConsignments.parcelStatus} = 'DELIVERED'
    AND ${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL')
    AND ${deliveryConsignments.returnDeclaredAt} IS NULL`;
  const isReturned = sql`${deliveryConsignments.parcelStatus} = 'RETURNED' AND COALESCE(${deliveryConsignments.returnedAt}, ${deliveryConsignments.updatedAt}) >= ${windowStart}`;
  const isCancelled = sql`${deliveryConsignments.parcelStatus} = 'CANCELLED' AND COALESCE(${deliveryConsignments.cancelledAt}, ${deliveryConsignments.updatedAt}) >= ${windowStart}`;
  const count = (cond: ReturnType<typeof sql>) => sql<number>`SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;
  const total = (cond: ReturnType<typeof sql>, amount: ReturnType<typeof sql>) =>
    sql<string>`COALESCE(SUM(CASE WHEN ${cond} THEN ${amount} ELSE 0 END), 0)`;
  const buckets = await tx
    .select({
      partyId: deliveryConsignments.partyId,
      assignedCount: count(isAssigned),
      assignedAmount: total(isAssigned, cod),
      inTransitCount: count(isInTransit),
      inTransitAmount: total(isInTransit, cod),
      deliveredCount: count(isDeliveredUnremitted),
      deliveredAmount: total(isDeliveredUnremitted, liveRemaining),
      returnedCount: count(isReturned),
      returnedAmount: total(isReturned, cod),
      cancelledCount: count(isCancelled),
      cancelledAmount: total(isCancelled, cod),
    })
    .from(deliveryConsignments)
    .where(and(inArray(deliveryConsignments.partyId, partyIds), cnBranch))
    .groupBy(deliveryConsignments.partyId);
  const bucketMap = new Map(buckets.map((b) => [Number(b.partyId), b]));

  // ── مدخلاتُ الدالّة النقيّة (المصدر الواحد `exposureInputs.ts`): الطرود الحيّة بعهدتها من
  // الدفتر + مجاميع الدفتر لكلّ نوع على مستوى الجهة كلّها (العمودُ المخزَّن جهويٌّ لا فرعيّ) ────
  const exposureInputs = await loadPartyExposureInputsTx(tx, partyIds, branchId);

  // ── الطرود المتأخّرة (نفس مسند حارس الإسناد — مصدرٌ واحد) ───────────────────────────
  const stale = await tx
    .select({ partyId: deliveryConsignments.partyId, n: sql<number>`COUNT(*)` })
    .from(deliveryConsignments)
    .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .where(and(
      inArray(deliveryConsignments.partyId, partyIds),
      staleOpenParcelCondition(sql`${deliveryParties.maxOpenParcelAgeDays}`),
    ))
    .groupBy(deliveryConsignments.partyId);
  const staleMap = new Map(stale.map((r) => [Number(r.partyId), Number(r.n ?? 0)]));

  const cashSource = deliveryCashSource();
  const rows: PartyBoardRow[] = [];
  for (const p of parties) {
    const id = Number(p.id);
    const b = bucketMap.get(id);
    const bucket = (c: unknown, a: unknown): PartyBoardBucket =>
      b ? { count: Number(c ?? 0), amount: fmt(a) } : ZERO_BUCKET;
    const inputs = exposureInputs.get(id);
    const ledger = inputs?.ledger ?? [];
    const cashInHandLedger = inputs?.cashInHandLedger ?? "0.00";
    const cashInHandStored = fmt(p.currentBalance);
    const cashInHandDrift = round2(money(cashInHandLedger).minus(money(cashInHandStored))).toFixed(2);
    const exposure = computePartyExposure({
      cashInHand: cashSource === "ledger" ? cashInHandLedger : cashInHandStored,
      parcels: inputs?.parcels ?? [],
      ledger,
    });
    const row: PartyBoardRow = {
      partyId: id,
      partyName: p.name,
      partyType: p.partyType as PartyBoardRow["partyType"],
      assigned: bucket(b?.assignedCount, b?.assignedAmount),
      inTransit: bucket(b?.inTransitCount, b?.inTransitAmount),
      deliveredUnremitted: bucket(b?.deliveredCount, b?.deliveredAmount),
      returned: bucket(b?.returnedCount, b?.returnedAmount),
      cancelled: bucket(b?.cancelledCount, b?.cancelledAmount),
      cashInHandLedger,
      cashInHandStored,
      cashInHandDrift,
      feesOwed: exposure.feesOwedToThem,
      net: exposure.netResponsibility,
      staleOpenParcels: staleMap.get(id) ?? 0,
    };
    // جهةٌ معطَّلة بلا أثرٍ حيّ تختفي؛ وما عليها التزامٌ (طرود/نقد/أجور) يبقى ظاهراً — الواجهةُ
    // الوحيدة التي تُسوَّى منها (نفس درس `listPartyObligations`، Codex P2 #5).
    const hasLiveObligation =
      row.assigned.count + row.inTransit.count + row.deliveredUnremitted.count > 0
      || !money(row.cashInHandStored).isZero()
      || !money(row.cashInHandLedger).isZero()
      || money(row.feesOwed).gt(0)
      || row.staleOpenParcels > 0;
    if (p.isActive || hasLiveObligation) rows.push(row);
  }
  // الأحوجُ للنظر أوّلاً: المتأخّرة، ثمّ الأعلى مسؤوليّةً، ثمّ الاسم.
  rows.sort((a, b) =>
    b.staleOpenParcels - a.staleOpenParcels
    || money(b.net).comparedTo(money(a.net))
    || a.partyName.localeCompare(b.partyName, "ar"));
  return rows;
}

/** نافذةُ التاريخ التي يُقاس عليها «الجهة المعتادة للمنطقة». */
export const ZONE_SUGGESTION_HISTORY_DAYS = 90;

export interface SuggestPartyForZoneInput {
  /** رمزُ المحافظة/المنطقة كما يخزّنه الإسناد في `deliveryConsignments.governorate` ويطابق `deliveryZones.code`. */
  governorate: string;
  branchId: number;
}

/**
 * **اقتراحُ جهةٍ للمنطقة** (أتمتة ٤ في الخطّة) — اقتراحٌ بدليل، والتأكيدُ بيد الكاشير.
 *
 * الدليلان:
 *  · **الجهة**: أكثرُ الجهات النشطة إسناداً لهذه المنطقة في هذا الفرع خلال آخر ٩٠ يوماً
 *    (`deliveryConsignments.governorate` — تاريخُ الإسناد الفعليّ لا قاعدةٌ مكتوبة)، مستبعَداً
 *    منها ما يرفضه حارسُ SLA الآن (طرودٌ متأخّرة) — اقتراحُ جهةٍ سيرفضها الإسناد ليس اقتراحاً.
 *  · **الأجرة**: قاعدةُ تسعير المنطقة الفعّالة (`deliveryZones.code = governorate` ⇒
 *    `deliveryPricingRules` ⇒ `computeDeliveryFee`)، وإلّا الأجرةُ الافتراضية للجهة المقترَحة.
 *
 * `null` **بصدق** حين لا تاريخَ للمنطقة: لا نقترح جهةً بلا دليل، ولا نُسمّي منطقةً بلا قواعد.
 */
export async function suggestPartyForZoneTx(
  tx: Tx,
  input: SuggestPartyForZoneInput,
): Promise<{ partyId: number; partyName: string; fee: string } | null> {
  const governorate = input.governorate.trim();
  if (!governorate) return null;

  const candidates = await tx
    .select({
      partyId: deliveryConsignments.partyId,
      partyName: deliveryParties.name,
      defaultFee: deliveryParties.defaultFee,
      maxOpenParcelAgeDays: deliveryParties.maxOpenParcelAgeDays,
      uses: sql<number>`COUNT(*)`,
      lastUsed: sql<string | null>`MAX(${deliveryConsignments.dispatchedAt})`,
    })
    .from(deliveryConsignments)
    .innerJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .where(and(
      sql`LOWER(${deliveryConsignments.governorate}) = LOWER(${governorate})`,
      eq(deliveryConsignments.branchId, input.branchId),
      gte(deliveryConsignments.dispatchedAt, sql`DATE_SUB(NOW(), INTERVAL ${ZONE_SUGGESTION_HISTORY_DAYS} DAY)`),
      eq(deliveryParties.isActive, true),
      or(isNull(deliveryParties.branchId), eq(deliveryParties.branchId, input.branchId)),
    ))
    .groupBy(deliveryConsignments.partyId, deliveryParties.name, deliveryParties.defaultFee, deliveryParties.maxOpenParcelAgeDays)
    .orderBy(desc(sql`COUNT(*)`), desc(sql`MAX(${deliveryConsignments.dispatchedAt})`));
  if (!candidates.length) return null;

  let chosen: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    const staleRow = (
      await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(deliveryConsignments)
        .where(and(
          eq(deliveryConsignments.partyId, Number(c.partyId)),
          staleOpenParcelCondition(Number(c.maxOpenParcelAgeDays ?? 7)),
        ))
    )[0];
    if (Number(staleRow?.n ?? 0) === 0) {
      chosen = c;
      break;
    }
  }
  if (!chosen) return null;

  const zone = (
    await tx
      .select({ id: deliveryZones.id, isActive: deliveryZones.isActive })
      .from(deliveryZones)
      .where(sql`LOWER(${deliveryZones.code}) = LOWER(${governorate})`)
      .limit(1)
  )[0];
  let fee = round2(money(String(chosen.defaultFee ?? "0")));
  if (zone?.isActive) {
    const rules = await tx
      .select()
      .from(deliveryPricingRules)
      .where(eq(deliveryPricingRules.zoneId, Number(zone.id)))
      .orderBy(asc(deliveryPricingRules.id));
    const asInput: DeliveryPricingRuleInput[] = rules.map((r) => ({
      id: Number(r.id),
      ruleType: r.ruleType,
      baseFee: r.baseFee,
      perKmFee: r.perKmFee ?? null,
      perKgFee: r.perKgFee ?? null,
      minFee: r.minFee ?? null,
      maxFee: r.maxFee ?? null,
      isActive: !!r.isActive,
    }));
    const quote = computeDeliveryFee(asInput, {});
    if (quote) fee = round2(money(String(quote.fee)));
  }
  return { partyId: Number(chosen.partyId), partyName: chosen.partyName, fee: fee.toFixed(2) };
}
