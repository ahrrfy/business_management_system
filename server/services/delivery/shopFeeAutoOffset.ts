import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { deriveCashInHandFromLedger } from "@shared/partyExposure";
import {
  accountingEntries,
  deliveryConsignments,
  deliveryEvents,
  deliveryLedgerEntries,
  deliveryParties,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { adjustDeliveryBalance, postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";
import { effectiveDeliveryLedgerEntrySql } from "./legacyLedger";
import { appendDeliveryEvent, appendDeliveryLedgerEntry } from "./lifecycle";
import { shortfallAssignedForConsignmentTx } from "./openParcelPredicates";
import {
  deliveryFeeAccrualIntent,
  deliveryFeeSettlementIntent,
  deliveryRemitIntent,
} from "./posting";
import type { DeliveryTxActor } from "./types";

interface ParcelOffsetAllocation {
  consignmentId: number;
  amount: string;
  prevStatus: string;
  prevMoneyStatus: string;
  prevSettledAt: string | null;
}

interface ShopFeeAutoOffsetPayload {
  cycleKey: string;
  partyId: number;
  branchId: number;
  invoiceId: number | null;
  offsetAmount: string;
  totalFee: string;
  remitAccountingAmount: string;
  fromShortfall: string;
  fromPartyLedgerCash: string;
  parcelAllocations: ParcelOffsetAllocation[];
}

function buildCycleKey(
  consignmentId: number,
  dispatchedAt: Date | null | undefined,
  operationKey: string,
): string {
  return createHash("sha256")
    .update(
      `${consignmentId}:${dispatchedAt ? new Date(dispatchedAt).toISOString() : ""}:${operationKey}`,
    )
    .digest("hex")
    .slice(0, 20);
}

export async function findActiveShopFeeAutoOffsetTx(
  tx: Tx,
  consignmentId: number,
): Promise<ShopFeeAutoOffsetPayload | null> {
  const events = await tx
    .select({
      id: deliveryEvents.id,
      eventType: deliveryEvents.eventType,
      payload: deliveryEvents.payload,
    })
    .from(deliveryEvents)
    .where(
      and(
        eq(deliveryEvents.consignmentId, consignmentId),
        inArray(deliveryEvents.eventType, [
          "SHOP_FEE_AUTO_OFFSET",
          "SHOP_FEE_AUTO_OFFSET_REVERSED",
        ]),
      ),
    )
    .orderBy(asc(deliveryEvents.id))
    .for("share");

  const reversedCycles = new Set<string>();
  for (const ev of events) {
    if (ev.eventType === "SHOP_FEE_AUTO_OFFSET_REVERSED") {
      const p = ev.payload as { reversedCycleKey?: unknown } | null;
      if (typeof p?.reversedCycleKey === "string") {
        reversedCycles.add(p.reversedCycleKey);
      }
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.eventType !== "SHOP_FEE_AUTO_OFFSET") continue;
    const p = ev.payload as Partial<ShopFeeAutoOffsetPayload> | null;
    if (
      p &&
      typeof p.cycleKey === "string" &&
      !reversedCycles.has(p.cycleKey) &&
      typeof p.offsetAmount === "string" &&
      money(p.offsetAmount).gt(0)
    ) {
      return {
        cycleKey: p.cycleKey,
        partyId: Number(p.partyId),
        branchId: Number(p.branchId),
        invoiceId: p.invoiceId == null ? null : Number(p.invoiceId),
        offsetAmount: p.offsetAmount,
        totalFee: String(p.totalFee ?? p.offsetAmount),
        remitAccountingAmount: String(p.remitAccountingAmount ?? "0.00"),
        fromShortfall: String(p.fromShortfall ?? "0.00"),
        fromPartyLedgerCash: String(p.fromPartyLedgerCash ?? "0.00"),
        parcelAllocations: Array.isArray(p.parcelAllocations)
          ? p.parcelAllocations
          : [],
      };
    }
  }
  return null;
}

export async function activeShopFeeAutoOffsetAmountTx(
  tx: Tx,
  consignmentId: number,
): Promise<{ offsetAmount: Decimal; cycleKey: string | null }> {
  const active = await findActiveShopFeeAutoOffsetTx(tx, consignmentId);
  if (!active) return { offsetAmount: money(0), cycleKey: null };
  return {
    offsetAmount: round2(money(active.offsetAmount)),
    cycleKey: active.cycleKey,
  };
}

/**
 * التسوية التلقائية لأجور «التوصيل على المكتبة» (`SHOP`) عند الإسناد إذا كان لدينا رصيد/ذمة
 * مستحقة على جهة التوصيل (`deliveryParties.currentBalance > 0`).
 * تنقص ذمة جهة التوصيل فوراً بقيمة `min(deliveryFee, currentBalance)` مع توازن تام عبر:
 * - `deliveryParties.currentBalance`
 * - `deliveryLedgerEntries` (`FEE_EARNED` + `FEE_OFFSET` + ساق العهدة)
 * - `accountingEntries` / `journalLines` (بلا مساس ببصمة `POSTING_POLICY_HASH`)
 */
export async function autoOffsetShopDeliveryFeeOnDispatchTx(
  tx: Tx,
  input: {
    consignmentId: number;
    actor: DeliveryTxActor;
    operationKey: string;
  },
): Promise<{ offsetAmount: string; fullySettled: boolean } | null> {
  const [cn] = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.id, input.consignmentId))
    .for("update")
    .limit(1);
  if (
    !cn ||
    cn.feeCollection !== "SHOP" ||
    cn.sourceType === "AFTERCARE_EXECUTION" ||
    cn.feeSettledAt != null ||
    cn.partyId == null
  ) {
    return null;
  }

  const fee = round2(money(cn.deliveryFee ?? "0"));
  if (fee.lte(0)) return null;

  const existingActive = await findActiveShopFeeAutoOffsetTx(tx, Number(cn.id));
  if (existingActive) {
    return {
      offsetAmount: existingActive.offsetAmount,
      fullySettled: round2(money(existingActive.offsetAmount)).gte(fee),
    };
  }

  const partyId = Number(cn.partyId);
  const branchId = Number(cn.branchId);
  const [party] = await tx
    .select()
    .from(deliveryParties)
    .where(eq(deliveryParties.id, partyId))
    .for("update")
    .limit(1);
  if (!party) return null;

  const partyBalance = round2(money(party.currentBalance ?? "0"));
  if (partyBalance.lte(0)) return null;

  const offsetAmount = round2(Decimal.min(fee, partyBalance));
  if (offsetAmount.lte(0)) return null;

  const now = new Date();
  const cycleKey = buildCycleKey(
    Number(cn.id),
    cn.dispatchedAt,
    input.operationKey,
  );

  // ١) فحص الطرود المُسلَّمة غير المورَّدة لنفس الجهة في نفس الفرع كي يتطابق الرصيد المتبقي عند التوريد
  const deliveredOpen = await tx
    .select()
    .from(deliveryConsignments)
    .where(
      and(
        eq(deliveryConsignments.partyId, partyId),
        eq(deliveryConsignments.branchId, branchId),
        ne(deliveryConsignments.id, Number(cn.id)),
        inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]),
        eq(deliveryConsignments.parcelStatus, "DELIVERED"),
        inArray(deliveryConsignments.moneyStatus, ["UNSETTLED", "PARTIAL"]),
        isNull(deliveryConsignments.returnDeclaredAt),
      ),
    )
    .orderBy(asc(deliveryConsignments.id))
    .for("update");

  const deliveredCandidates: Array<{
    row: typeof deliveryConsignments.$inferSelect;
    rem: Decimal;
    shortfall: Decimal;
  }> = [];
  let totalUnremittedDeliveredCash = money(0);
  for (const row of deliveredOpen) {
    const sf = await shortfallAssignedForConsignmentTx(tx, Number(row.id), {
      partyId,
      branchId,
    });
    const rem = round2(
      Decimal.max(
        0,
        money(row.codAmount ?? "0")
          .minus(money(row.collectedAmount ?? "0"))
          .minus(money(row.counterSettledAmount ?? "0"))
          .minus(sf),
      ),
    );
    if (rem.gt(0)) {
      deliveredCandidates.push({ row, rem, shortfall: sf });
      totalUnremittedDeliveredCash = round2(
        totalUnremittedDeliveredCash.plus(rem),
      );
    }
  }

  // ٢) فحص أرصدة الدفتر التشغيلي والعجز غير المربوط بطرد
  const partyLedgerAgg = await tx
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
  const ledgerCustodyBefore = round2(
    money(
      deriveCashInHandFromLedger(
        partyLedgerAgg.map((r) => ({
          entryType: r.entryType,
          amount: String(r.total ?? "0"),
        })),
      ),
    ),
  );

  const [unlinkedShortfallRow] = await tx
    .select({
      net: sql<string>`COALESCE(SUM(CASE
        WHEN ${deliveryLedgerEntries.entryType} = 'SHORTFALL_ASSIGNED' THEN ${deliveryLedgerEntries.amount}
        WHEN ${deliveryLedgerEntries.entryType} = 'SHORTFALL_SETTLED' THEN -${deliveryLedgerEntries.amount}
        ELSE 0 END), 0)`,
    })
    .from(deliveryLedgerEntries)
    .where(
      and(
        eq(deliveryLedgerEntries.partyId, partyId),
        isNull(deliveryLedgerEntries.consignmentId),
        inArray(deliveryLedgerEntries.entryType, [
          "SHORTFALL_ASSIGNED",
          "SHORTFALL_SETTLED",
        ]),
      ),
    );
  const unlinkedShortfall = round2(
    Decimal.max(0, money(unlinkedShortfallRow?.net ?? "0")),
  );

  const unallocatedPartyFloat = round2(
    Decimal.max(0, partyBalance.minus(totalUnremittedDeliveredCash)),
  );
  const fromPartyFloat = round2(
    Decimal.min(offsetAmount, unallocatedPartyFloat),
  );
  const fromShortfall = round2(
    Decimal.min(fromPartyFloat, unlinkedShortfall),
  );
  const availablePartyLedgerCash = round2(
    Decimal.max(
      0,
      ledgerCustodyBefore
        .minus(totalUnremittedDeliveredCash)
        .minus(fromShortfall),
    ),
  );
  const fromPartyLedgerCash = round2(
    Decimal.min(fromPartyFloat.minus(fromShortfall), availablePartyLedgerCash),
  );

  if (fromShortfall.gt(0)) {
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${cn.id}:SHOP_SF:${cycleKey}`,
      partyId,
      branchId,
      entryType: "SHORTFALL_SETTLED",
      amount: toDbMoney(fromShortfall),
      notes: `مقاصة تلقائية لأجرة التوصيل على المكتبة — ${cn.consignmentNumber}`,
      actorUserId: input.actor.userId,
      occurredAt: now,
    });
  }
  if (fromPartyLedgerCash.gt(0)) {
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${cn.id}:SHOP_FLOAT:${cycleKey}`,
      partyId,
      branchId,
      entryType: "COD_REMITTED",
      amount: toDbMoney(fromPartyLedgerCash),
      notes: `مقاصة تلقائية لأجرة التوصيل على المكتبة — ${cn.consignmentNumber}`,
      actorUserId: input.actor.userId,
      occurredAt: now,
    });
  }

  let remainingForParcels = round2(offsetAmount.minus(fromPartyFloat));
  const parcelAllocations: ParcelOffsetAllocation[] = [];
  for (const cand of deliveredCandidates) {
    if (remainingForParcels.lte(0)) break;
    const take = round2(Decimal.min(remainingForParcels, cand.rem));
    if (take.lte(0)) continue;
    const newCollected = round2(
      money(cand.row.collectedAmount ?? "0").plus(take),
    );
    const fullyRemitted = newCollected
      .plus(money(cand.row.counterSettledAmount ?? "0"))
      .plus(cand.shortfall)
      .gte(round2(money(cand.row.codAmount ?? "0")));
    const nextStatus = fullyRemitted ? "DELIVERED" : "PARTIAL";
    const nextMoneyStatus = fullyRemitted ? "SETTLED" : "PARTIAL";

    parcelAllocations.push({
      consignmentId: Number(cand.row.id),
      amount: toDbMoney(take),
      prevStatus: cand.row.status,
      prevMoneyStatus: cand.row.moneyStatus,
      prevSettledAt: cand.row.settledAt
        ? new Date(cand.row.settledAt).toISOString()
        : null,
    });

    await tx
      .update(deliveryConsignments)
      .set({
        collectedAmount: toDbMoney(newCollected),
        status: nextStatus,
        moneyStatus: nextMoneyStatus,
        settledAt: fullyRemitted ? now : cand.row.settledAt,
      })
      .where(eq(deliveryConsignments.id, Number(cand.row.id)));

    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${cand.row.id}:SHOP_PARCEL:${cn.id}:${cycleKey}`,
      partyId,
      consignmentId: Number(cand.row.id),
      branchId,
      entryType: "COD_REMITTED",
      amount: toDbMoney(take),
      notes: `مقاصة تلقائية مقابل أجرة التوصيل على المكتبة للإرسالية ${cn.consignmentNumber}`,
      actorUserId: input.actor.userId,
      occurredAt: now,
    });
    remainingForParcels = round2(remainingForParcels.minus(take));
  }

  // ٣) إنقاص ذمة جهة التوصيل وتقييد الأجرة كمكتسبة ومسواة
  await adjustDeliveryBalance(tx, partyId, offsetAmount.neg());

  await appendDeliveryLedgerEntry(tx, {
    eventKey: `CN:${cn.id}:FEE_EARNED:SHOP:${cycleKey}`,
    partyId,
    consignmentId: Number(cn.id),
    branchId,
    entryType: "FEE_EARNED",
    amount: toDbMoney(offsetAmount),
    notes: `استحقاق أجرة توصيل على المكتبة — ${cn.consignmentNumber}`,
    actorUserId: input.actor.userId,
    occurredAt: now,
  });
  await appendDeliveryLedgerEntry(tx, {
    eventKey: `CN:${cn.id}:FEE_OFFSET:SHOP:${cycleKey}`,
    partyId,
    consignmentId: Number(cn.id),
    branchId,
    entryType: "FEE_OFFSET",
    amount: toDbMoney(offsetAmount),
    notes: `تسوية تلقائية من ذمة جهة التوصيل — ${cn.consignmentNumber}`,
    actorUserId: input.actor.userId,
    occurredAt: now,
  });

  // ٤) الترحيل المحاسبي المتوازن (مع الحفاظ التام على reconcileDeliveryFloat و POSTING_POLICY_HASH)
  const [entryFloatRow] = await tx
    .select({
      float: sql<string>`COALESCE(SUM(CASE
        WHEN ${accountingEntries.entryType} = 'DELIVERY_DISPATCH' THEN  CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'DELIVERY_REMIT'    THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        WHEN ${accountingEntries.entryType} = 'DELIVERY_WRITEOFF' THEN -CAST(${accountingEntries.amount} AS DECIMAL(15,2))
        ELSE 0 END), 0)`,
    })
    .from(accountingEntries)
    .where(eq(accountingEntries.deliveryPartyId, partyId));
  const entryFloatBefore = round2(
    Decimal.max(0, money(entryFloatRow?.float ?? "0")),
  );
  const remitAccountingAmount = round2(
    Decimal.min(offsetAmount, entryFloatBefore),
  );

  const invoiceId = cn.invoiceId == null ? null : Number(cn.invoiceId);
  await postEntry(tx, {
    entryType: "DELIVERY_FEE",
    postingIntent: deliveryFeeAccrualIntent(offsetAmount),
    dedupeKey: `DELIVERY_FEE_ACCRUAL:SHOP:${cn.id}:${cycleKey}`,
    branchId,
    invoiceId,
    deliveryPartyId: partyId,
    amount: offsetAmount,
    cost: offsetAmount,
    profit: offsetAmount.neg(),
    notes: `استحقاق أجرة توصيل على المكتبة ${cn.consignmentNumber}`,
  });

  if (remitAccountingAmount.gt(0)) {
    await postEntry(tx, {
      entryType: "DELIVERY_REMIT",
      postingIntent: deliveryRemitIntent(remitAccountingAmount, "TREASURY"),
      postingSourceComponents: {
        roleDebits: { TREASURY_CASH: remitAccountingAmount },
        roleCredits: { DELIVERY_FLOAT: remitAccountingAmount },
      },
      dedupeKey: `DELIVERY_REMIT:SHOP_OFFSET:${cn.id}:${cycleKey}`,
      branchId,
      invoiceId,
      deliveryPartyId: partyId,
      amount: remitAccountingAmount,
      notes: `تخفيض عهدة جهة التوصيل مقابل أجرة على المكتبة ${cn.consignmentNumber}`,
    });
    await postEntry(tx, {
      entryType: "DELIVERY_FEE",
      postingIntent: deliveryFeeSettlementIntent(
        remitAccountingAmount,
        "TREASURY",
      ),
      postingSourceComponents: {
        roleDebits: { COURIER_PAYABLE: remitAccountingAmount },
        roleCredits: { TREASURY_CASH: remitAccountingAmount },
      },
      dedupeKey: `DELIVERY_FEE_OFFSET:SHOP:${cn.id}:${cycleKey}`,
      branchId,
      invoiceId,
      deliveryPartyId: partyId,
      amount: remitAccountingAmount,
      notes: `تسوية تلقائية لأجرة التوصيل على المكتبة ${cn.consignmentNumber}`,
    });
  }

  const fullySettled = offsetAmount.gte(fee);
  if (fullySettled) {
    await tx
      .update(deliveryConsignments)
      .set({ feeSettledAt: now })
      .where(eq(deliveryConsignments.id, Number(cn.id)));
  }

  const payload: ShopFeeAutoOffsetPayload = {
    cycleKey,
    partyId,
    branchId,
    invoiceId,
    offsetAmount: toDbMoney(offsetAmount),
    totalFee: toDbMoney(fee),
    remitAccountingAmount: toDbMoney(remitAccountingAmount),
    fromShortfall: toDbMoney(fromShortfall),
    fromPartyLedgerCash: toDbMoney(fromPartyLedgerCash),
    parcelAllocations,
  };
  await appendDeliveryEvent(tx, {
    eventKey: `CN:${cn.id}:SHOP_AUTO_OFFSET:${cycleKey}`,
    consignmentId: Number(cn.id),
    eventType: "SHOP_FEE_AUTO_OFFSET",
    actorUserId: input.actor.userId,
    payload: payload as unknown as Record<string, unknown>,
  });

  return { offsetAmount: toDbMoney(offsetAmount), fullySettled };
}

/**
 * عكس التسوية التلقائية لأجور «التوصيل على المكتبة» عند إلغاء الإسناد أو رجوع الطرد غير مُسلَّم،
 * بحيث تعود ذمة جهة التوصيل كما كانت بدقة صفر انحراف.
 */
export async function reverseAutoOffsetShopDeliveryFeeTx(
  tx: Tx,
  input: {
    consignmentId: number;
    actor: DeliveryTxActor;
    operationKey: string;
    reason?: string | null;
  },
): Promise<{ restoredAmount: string } | null> {
  const active = await findActiveShopFeeAutoOffsetTx(tx, input.consignmentId);
  if (!active) return null;

  const offsetAmount = round2(money(active.offsetAmount));
  if (offsetAmount.lte(0)) return null;

  const now = new Date();
  const revKey = createHash("sha256")
    .update(`${input.consignmentId}:${active.cycleKey}:${input.operationKey}`)
    .digest("hex")
    .slice(0, 20);

  await adjustDeliveryBalance(tx, active.partyId, offsetAmount);

  const fromShortfall = round2(money(active.fromShortfall));
  if (fromShortfall.gt(0)) {
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${input.consignmentId}:SHOP_SF_REV:${revKey}`,
      partyId: active.partyId,
      branchId: active.branchId,
      entryType: "SHORTFALL_ASSIGNED",
      shortfallReason: "OTHER",
      amount: toDbMoney(fromShortfall),
      notes: `استرجاع عجز سابق بعد إلغاء إسناد ${input.consignmentId}${input.reason ? ` — ${input.reason}` : ""}`,
      actorUserId: input.actor.userId,
      occurredAt: now,
    });
  }

  const fromPartyLedgerCash = round2(money(active.fromPartyLedgerCash));
  if (fromPartyLedgerCash.gt(0)) {
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${input.consignmentId}:SHOP_FLOAT_REV:${revKey}`,
      partyId: active.partyId,
      branchId: active.branchId,
      entryType: "COD_COLLECTED",
      amount: toDbMoney(fromPartyLedgerCash),
      notes: `استرجاع ذمة جهة التوصيل بعد إلغاء إسناد ${input.consignmentId}${input.reason ? ` — ${input.reason}` : ""}`,
      actorUserId: input.actor.userId,
      occurredAt: now,
    });
  }

  for (const alloc of active.parcelAllocations) {
    const amt = round2(money(alloc.amount));
    if (amt.lte(0)) continue;
    const [targetCn] = await tx
      .select()
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.id, Number(alloc.consignmentId)))
      .for("update")
      .limit(1);
    if (targetCn) {
      const nextCollected = round2(
        Decimal.max(0, money(targetCn.collectedAmount ?? "0").minus(amt)),
      );
      await tx
        .update(deliveryConsignments)
        .set({
          collectedAmount: toDbMoney(nextCollected),
          status: (alloc.prevStatus || "DISPATCHED") as typeof targetCn.status,
          moneyStatus: (alloc.prevMoneyStatus ||
            "UNSETTLED") as typeof targetCn.moneyStatus,
          settledAt: alloc.prevSettledAt ? new Date(alloc.prevSettledAt) : null,
        })
        .where(eq(deliveryConsignments.id, Number(targetCn.id)));

      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${targetCn.id}:SHOP_PARCEL_REV:${input.consignmentId}:${revKey}`,
        partyId: active.partyId,
        consignmentId: Number(targetCn.id),
        branchId: active.branchId,
        entryType: "COD_COLLECTED",
        amount: toDbMoney(amt),
        notes: `استرجاع عهدة طرد بعد إلغاء مقاصة أجرة الإرسالية #${input.consignmentId}`,
        actorUserId: input.actor.userId,
        occurredAt: now,
      });
    }
  }

  await postEntry(tx, {
    entryType: "DELIVERY_FEE",
    postingIntent: deliveryFeeAccrualIntent(offsetAmount.neg()),
    dedupeKey: `DELIVERY_FEE_ACCRUAL_REV:SHOP:${input.consignmentId}:${revKey}`,
    branchId: active.branchId,
    invoiceId: active.invoiceId,
    deliveryPartyId: active.partyId,
    amount: offsetAmount.neg(),
    cost: offsetAmount.neg(),
    profit: offsetAmount,
    notes: `عكس استحقاق أجرة التوصيل على المكتبة للإرسالية #${input.consignmentId}`,
  });

  const remitAccountingAmount = round2(money(active.remitAccountingAmount));
  if (remitAccountingAmount.gt(0)) {
    await postEntry(tx, {
      entryType: "DELIVERY_REMIT",
      postingIntent: deliveryRemitIntent(
        remitAccountingAmount.neg(),
        "TREASURY",
      ),
      postingSourceComponents: {
        roleDebits: { DELIVERY_FLOAT: remitAccountingAmount },
        roleCredits: { TREASURY_CASH: remitAccountingAmount },
      },
      dedupeKey: `DELIVERY_REMIT_REV:SHOP_OFFSET:${input.consignmentId}:${revKey}`,
      branchId: active.branchId,
      invoiceId: active.invoiceId,
      deliveryPartyId: active.partyId,
      amount: remitAccountingAmount.neg(),
      notes: `إعادة ذمة جهة التوصيل بعد إلغاء الإرسالية #${input.consignmentId}`,
    });
    await postEntry(tx, {
      entryType: "DELIVERY_FEE",
      postingIntent: deliveryFeeSettlementIntent(
        remitAccountingAmount.neg(),
        "TREASURY",
      ),
      postingSourceComponents: {
        roleDebits: { TREASURY_CASH: remitAccountingAmount },
        roleCredits: { COURIER_PAYABLE: remitAccountingAmount },
      },
      dedupeKey: `DELIVERY_FEE_OFFSET_REV:SHOP:${input.consignmentId}:${revKey}`,
      branchId: active.branchId,
      invoiceId: active.invoiceId,
      deliveryPartyId: active.partyId,
      amount: remitAccountingAmount.neg(),
      notes: `عكس تسوية أجرة التوصيل على المكتبة للإرسالية #${input.consignmentId}`,
    });
  }

  await tx
    .update(deliveryConsignments)
    .set({ feeSettledAt: null })
    .where(eq(deliveryConsignments.id, input.consignmentId));

  await appendDeliveryEvent(tx, {
    eventKey: `CN:${input.consignmentId}:SHOP_AUTO_OFFSET_REV:${revKey}`,
    consignmentId: input.consignmentId,
    eventType: "SHOP_FEE_AUTO_OFFSET_REVERSED",
    actorUserId: input.actor.userId,
    payload: {
      reversedCycleKey: active.cycleKey,
      restoredAmount: toDbMoney(offsetAmount),
      reason: input.reason ?? null,
    },
  });

  return { restoredAmount: toDbMoney(offsetAmount) };
}
