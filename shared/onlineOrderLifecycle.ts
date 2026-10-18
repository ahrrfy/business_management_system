import Decimal from "decimal.js";

/** Read model only: physical delivery, customer collection and shop remittance are separate facts. */
export interface OnlineOrderLifecycle {
  label: string;
  tone?: "info" | "positive" | "warning" | "negative" | "muted";
  collectionLabel: string | null;
  remittanceLabel: string | null;
  consignmentId: number | null;
  consignmentNumber: string | null;
  deliveryPartyName: string | null;
  latestEvent: {
    label: string;
    occurredAt: Date | string;
    actorName: string | null;
  } | null;
}

export interface OnlineOrderDeliveryFacts {
  parcelStatus: string;
  moneyStatus: string;
  status: string;
  codAmount: string;
  /** Already remitted to the shop, not what the customer handed the courier. */
  collectedAmount: string;
  customerCollectedAmount: string;
  /** Receipt-backed COUNTER_SETTLED events only; counterSettledAmount also contains obligation releases. */
  customerCounterCollectedAmount?: string;
  shortfallAssignedAmount?: string;
  counterSettledAmount: string;
  remittanceId: number | null;
  returnDeclaredAt?: unknown;
}

export function deriveOnlineOrderLifecycle(
  facts: OnlineOrderDeliveryFacts,
): Pick<
  OnlineOrderLifecycle,
  "label" | "tone" | "collectionLabel" | "remittanceLabel"
> {
  const physicalLabels: Record<string, string> = {
    ASSIGNED: "مسند لجهة التوصيل",
    ACCEPTED: "قبلته جهة التوصيل",
    PICKED_UP: "استلمته جهة التوصيل",
    OUT_FOR_DELIVERY: "بالطريق إلى العميل",
    DELIVERED: "تم التسليم",
    FAILED: "تعذر التسليم",
    RETURNED: "أعيد للمكتبة",
    CANCELLED: "ألغي الإسناد",
  };
  let label = physicalLabels[facts.parcelStatus] ?? "مع جهة التوصيل";
  let tone: OnlineOrderLifecycle["tone"] =
    facts.parcelStatus === "DELIVERED"
      ? "positive"
      : facts.parcelStatus === "FAILED"
        ? "negative"
        : facts.parcelStatus === "RETURNED" ||
            facts.parcelStatus === "CANCELLED"
          ? "muted"
          : "info";
  const live = facts.status === "DISPATCHED" || facts.status === "PARTIAL";
  if (
    live &&
    facts.returnDeclaredAt != null &&
    !["RETURNED", "CANCELLED"].includes(facts.parcelStatus)
  ) {
    label = "بانتظار استلام المرتجع";
    tone = "warning";
  }
  if (facts.parcelStatus !== "DELIVERED")
    return { label, tone, collectionLabel: null, remittanceLabel: null };

  const cod = new Decimal(facts.codAmount);
  if (cod.lte(0))
    return {
      label,
      tone,
      collectionLabel: "مدفوع مسبقا",
      remittanceLabel: null,
    };
  const proved = Decimal.max(
    0,
    facts.customerCollectedAmount,
    facts.collectedAmount,
  ).plus(facts.customerCounterCollectedAmount ?? "0");
  const collectionCeiling = Decimal.max(
    0,
    cod.minus(Decimal.max(0, facts.shortfallAssignedAmount ?? "0")),
  );
  const collected = Decimal.min(proved, collectionCeiling);
  const fullCollection = collected.gte(cod);
  const collectionLabel = fullCollection
    ? "تم التحصيل"
    : collected.gt(0)
      ? "تحصيل جزئي"
      : "لم يثبت التحصيل";
  if (fullCollection) label = "تم التسليم والتحصيل";
  const remittanceLabel =
    facts.moneyStatus === "WRITTEN_OFF"
      ? "شطب المتبقي"
      : facts.moneyStatus === "SETTLED"
        ? facts.remittanceId != null && new Decimal(facts.collectedAmount).gt(0)
          ? "تم التوريد"
          : "تمت التسوية"
        : facts.moneyStatus === "PARTIAL"
          ? "توريد جزئي"
          : "بانتظار التوريد";
  return { label, tone, collectionLabel, remittanceLabel };
}

export function onlineOrderLifecycleChipClass(
  tone: OnlineOrderLifecycle["tone"],
): string | null {
  const classes = {
    info: "bg-[var(--sem-info-bg)] text-[var(--sem-info)]",
    positive: "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]",
    warning: "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]",
    negative: "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]",
    muted: "bg-muted text-muted-foreground",
  };
  return tone ? classes[tone] : null;
}
