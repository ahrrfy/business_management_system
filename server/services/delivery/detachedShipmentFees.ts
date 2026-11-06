import Decimal from "decimal.js";
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { and, eq, inArray } from "drizzle-orm";
import { deliveryConsignments, deliveryLedgerEntries, deliveryShipmentMembers } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2 } from "../money";
import { createFeeWithholdingPolicy, verifiedFeeBalance } from "./fees";
import { consignmentShortfallAssignedSql, shortfallAssignedForConsignmentTx } from "./openParcelPredicates";

type Consignment = typeof deliveryConsignments.$inferSelect;
type FeeSource = { cn: Consignment; amount: Decimal; cash: Decimal };

/**
 * A physical shipment can retain its fee on a closed/zero-COD invoice.
 * Project only that shipment's fee onto its still-payable invoice lines;
 * retain the original fee owner for the accounting posting.
 */
export async function planDetachedShipmentFees(
  db: Pick<Tx, "select">,
  input: { partyId: number; branchId?: number | null; consignmentIds: number[];
    useCommission: boolean; includePending: boolean; currentRead?: boolean; requireComplete?: boolean;
    allowBlockedPreview?: boolean; feePolicy?: Awaited<ReturnType<typeof createFeeWithholdingPolicy>> },
): Promise<{ sources: FeeSource[]; allocations: Map<number, Decimal>; blocked: boolean; uncovered: boolean; incomplete: boolean;
  blockedIds: Set<number>; uncoveredIds: Set<number> }> {
  const result = { sources: [] as FeeSource[], allocations: new Map<number, Decimal>(), blocked: false, uncovered: false,
    incomplete: false, blockedIds: new Set<number>(), uncoveredIds: new Set<number>() };
  if (!input.consignmentIds.length) return result;
  const membershipQuery = db.select().from(deliveryShipmentMembers)
    .where(inArray(deliveryShipmentMembers.consignmentId, input.consignmentIds));
  const membership = await (input.currentRead ? membershipQuery.for("share") : membershipQuery);
  const leaders = Array.from(new Set(membership.map((row) => Number(row.leaderConsignmentId))));
  const { quoteFee, hasOrderBasedCommission } = input.feePolicy ??
    await createFeeWithholdingPolicy(db, input.partyId, input.useCommission, input.currentRead);
  const query = db.select({ leaderId: deliveryShipmentMembers.leaderConsignmentId,
    cn: deliveryConsignments, shortfall: consignmentShortfallAssignedSql,
  }).from(deliveryShipmentMembers)
    .innerJoin(deliveryConsignments, eq(deliveryConsignments.id, deliveryShipmentMembers.consignmentId))
    .where(inArray(deliveryShipmentMembers.leaderConsignmentId, leaders));
  const members = await (input.currentRead ? query.for("share") : query);
  const standaloneIds = input.consignmentIds.filter((id) => !membership.some((row) => Number(row.consignmentId) === id));
  const standaloneQuery = standaloneIds.length ? db.select().from(deliveryConsignments)
    .where(inArray(deliveryConsignments.id, standaloneIds)) : null;
  const standalone = standaloneQuery ? await (input.currentRead ? standaloneQuery.for("share") : standaloneQuery) : [];
  const feeMembers = [...members.map(({ cn }) => cn), ...standalone]
    .filter((cn) => cn.sourceType === "ONLINE_ORDER" && cn.feeCollection === "SHOP");
  const feeMemberIds = Array.from(new Set(feeMembers.map((cn) => Number(cn.id))));
  const feeQuery = feeMemberIds.length ? db.select().from(deliveryLedgerEntries).where(and(
    inArray(deliveryLedgerEntries.consignmentId, feeMemberIds),
    inArray(deliveryLedgerEntries.entryType, ["FEE_EARNED", "FEE_REFUNDED", "FEE_PAID", "FEE_OFFSET"]),
  )) : null;
  // Lock actual ledger rows, not just a parent row with a snapshot-reading subquery.
  const feeRows = feeQuery ? await (input.currentRead ? feeQuery.for("share") : feeQuery) : [];
  const feeBalances = new Map<number, { due: Decimal; active: boolean }>();
  for (const cn of feeMembers) {
    const rows = feeRows.filter((row) => Number(row.consignmentId) === Number(cn.id));
    try {
      feeBalances.set(Number(cn.id), verifiedFeeBalance(cn, rows));
    } catch (error) {
      if (!input.allowBlockedPreview || !(error instanceof TRPCError) || error.code !== "PRECONDITION_FAILED") throw error;
      result.blockedIds.add(Number(cn.id));
    }
  }
  for (const leaderId of leaders) {
    const group = members.filter((row) => Number(row.leaderId) === leaderId).sort((a, b) => Number(a.cn.id) - Number(b.cn.id));
    const leader = group.find((row) => Number(row.cn.id) === leaderId)?.cn;
    const live = group.filter(({ cn }) => !["CANCELLED", "RETURNED", "WRITTEN_OFF"].includes(cn.status) &&
      !["CANCELLED", "RETURNED"].includes(cn.parcelStatus));
    const branchId = input.branchId ?? leader?.branchId;
    if (group.some(({ cn }) => result.blockedIds.has(Number(cn.id)))) {
      group.forEach(({ cn }) => result.blockedIds.add(Number(cn.id)));
      continue;
    }
    if (!leader || Number(leader.partyId) !== input.partyId ||
        group.some(({ cn }) => Number(cn.branchId) !== Number(branchId)) ||
        group.some(({ cn }) => (live.some(({ cn: item }) => item.id === cn.id) || money(cn.deliveryFee).gt(0) ||
          (feeBalances.get(Number(cn.id))?.due ?? money(0)).gt(0)) && Number(cn.partyId) !== input.partyId)) {
      if (input.allowBlockedPreview) {
        group.forEach(({ cn }) => result.blockedIds.add(Number(cn.id)));
        continue;
      }
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: appErrorMessage({
        what: "تعذر مطابقة أجور الشحنة", why: "روابط الشحنة أو جهتها أو فرعها غير متسقة",
        doThis: "راجع قائد الشحنة وأعضاءها قبل احتساب الأجرة",
      }) });
    }
    const currentShortfalls = new Map<number, Decimal>();
    if (input.currentRead) {
      for (const row of live) currentShortfalls.set(Number(row.cn.id), await shortfallAssignedForConsignmentTx(
        db, Number(row.cn.id), { partyId: input.partyId, branchId: Number(row.cn.branchId) },
      ));
    }
    const dueFor = (row: typeof group[number]) => round2(Decimal.max(0, money(row.cn.codAmount)
      .minus(money(row.cn.collectedAmount ?? "0")).minus(money(row.cn.counterSettledAmount ?? "0"))
      .minus(input.currentRead ? currentShortfalls.get(Number(row.cn.id)) ?? money(0) : money(row.shortfall ?? "0"))));
    const targets = live.filter((row) => dueFor(row).gt(0));
    if (!targets.some((row) => input.consignmentIds.includes(Number(row.cn.id)))) continue;
    if (input.requireComplete && targets.some((row) => !input.consignmentIds.includes(Number(row.cn.id)))) result.incomplete = true;
    const remainingCapacity = new Map(targets.map((row) => {
      const balance = feeBalances.get(Number(row.cn.id));
      const ownDue = row.cn.sourceType === "ONLINE_ORDER" && row.cn.feeCollection === "SHOP"
        ? (balance?.active ? balance.due : input.includePending && !row.cn.feeSettledAt ? money(row.cn.deliveryFee) : money(0))
        : money(0);
      const ownFee = quoteFee(ownDue, money(0));
      return [Number(row.cn.id), Decimal.max(0, dueFor(row).minus(ownFee))] as const;
    }));
    for (const source of group) {
      if (source.cn.sourceType !== "ONLINE_ORDER" || source.cn.feeCollection !== "SHOP" ||
          targets.some((row) => Number(row.cn.id) === Number(source.cn.id))) continue;
      const balance = feeBalances.get(Number(source.cn.id));
      const earned = balance?.due ?? money(0);
      const amount = earned.gt(0) ? earned : input.includePending && !balance?.active &&
        !source.cn.feeSettledAt && !live.some(({ cn }) => cn.parcelStatus === "DELIVERED")
        ? round2(money(source.cn.deliveryFee)) : money(0);
      if (amount.lte(0)) continue;
      if (hasOrderBasedCommission) {
        result.blocked = true;
        targets.forEach((target) => result.blockedIds.add(Number(target.cn.id)));
        continue;
      }
      const cash = quoteFee(amount, money(0));
      result.sources.push({ cn: source.cn, amount, cash });
      let left = cash;
      for (const target of targets) {
        const id = Number(target.cn.id);
        const take = Decimal.min(left, remainingCapacity.get(id) ?? 0);
        if (take.gt(0)) {
          result.allocations.set(id, round2((result.allocations.get(id) ?? money(0)).plus(take)));
          remainingCapacity.set(id, round2((remainingCapacity.get(id) ?? money(0)).minus(take)));
          left = round2(left.minus(take));
        }
        if (left.isZero()) break;
      }
      if (left.gt(0)) {
        result.uncovered = true;
        targets.forEach((target) => result.uncoveredIds.add(Number(target.cn.id)));
      }
    }
  }
  return result;
}
