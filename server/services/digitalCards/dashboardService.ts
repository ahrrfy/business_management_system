/**
 * داشبورد البطاقات الرقمية (ش١١) — قراءات تجميعية خادمية بحتة.
 *
 * قواعد §٩.٤ الحاكمة لكل نقطة هنا:
 *   • **فترة نصف مفتوحة** [from, to) — لا تداخل ولا ازدواج بين يومين متتاليين.
 *   • **عزل الفرع** يُفرض من المستدعي (scopedBranch) ويُمرَّر هنا صراحةً.
 *   • **التجميع في القاعدة** لا في الذاكرة — لا نجرّ صفوف البيع إلى Node لنجمعها.
 *   • **لا تفاصيل تكلفة لمستخدم غير مخوَّل**: `includeCost=false` يُصفّر الحصة والربح
 *     في المخرَج (حجبٌ في الخدمة لا في العرض).
 *
 * معيار خروج ش١١: «الأرقام تتطابق مع استعلامات تحقق مستقلة» — لذلك كل رقمٍ هنا
 * مشتقٌّ من لقطة البيع وأحداث المرتجع المؤرّخة، مع إظهار المتبقّي التاريخي من الدفتر.
 */
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  branches,
  digitalCurrentPrices,
  digitalOfferingBranches,
  digitalOfferings,
  digitalPriceVersions,
  digitalProviders,
  digitalSaleIntents,
  digitalWalletReconciliations,
  digitalWallets,
  invoices,
  products,
  suppliers,
} from "../../../drizzle/schema";
import type { DB } from "../../db";
import { money, toDbMoney } from "../money";

export interface Period {
  /** بداية شاملة (YYYY-MM-DD). */
  from: string;
  /** نهاية **حصرية** (YYYY-MM-DD) — نصف مفتوحة [from, to). */
  to: string;
}

export interface Scope extends Period {
  branchId: number | null;
  includeCost: boolean;
}

/**
 * Immutable sales and completed financial returns, scoped by each movement date.
 * Old RETURN entries have no trustworthy line allocation. Their invoice/date residual
 * is reported separately after subtracting dated allocations already represented here.
 * No current fulfillment status or historical timestamp is inferred.
 */
function movementEvents(scope: Scope) {
  const branch =
    scope.branchId == null ? sql`TRUE` : sql`i.branchId = ${scope.branchId}`;
  return sql`WITH completed_refunds AS (
    SELECT d.invoiceId, d.offeringId, d.providerId, d.settlementModeSnapshot AS settlementMode,
      r.occurredAt, r.revenue, r.cost
    FROM digitalRefundItems r
    INNER JOIN digitalSaleDetails d ON d.id = r.detailId
    INNER JOIN invoices i ON i.id = d.invoiceId
    WHERE r.occurredAt >= ${scope.from} AND r.occurredAt < ${scope.to} AND ${branch}
  ), ledger_returns AS (
    SELECT e.invoiceId, e.entryDate, SUM(e.revenue) AS revenue, SUM(e.cost) AS cost
    FROM accountingEntries e
    INNER JOIN invoices i ON i.id = e.invoiceId
    WHERE e.entryType = 'RETURN' AND e.dedupeKey LIKE 'DIGITAL:REV:%'
      AND e.entryDate >= ${scope.from} AND e.entryDate < ${scope.to} AND ${branch}
    GROUP BY e.invoiceId, e.entryDate
  ), movements AS (
    SELECT d.invoiceId, d.offeringId, d.providerId, d.settlementModeSnapshot AS settlementMode,
      'SALE' AS kind, 1 AS cards, d.sellPriceSnapshot AS revenue, d.providerShareSnapshot AS cost
    FROM digitalSaleDetails d
    INNER JOIN invoices i ON i.id = d.invoiceId
    WHERE i.createdAt >= ${scope.from} AND i.createdAt < ${scope.to} AND ${branch}
    UNION ALL
    SELECT invoiceId, offeringId, providerId, settlementMode, 'REFUND', -1, revenue, cost
    FROM completed_refunds
    UNION ALL
    SELECT l.invoiceId, NULL, NULL, NULL, 'LEGACY', 0,
      l.revenue - COALESCE(r.revenue, 0), l.cost - COALESCE(r.cost, 0)
    FROM ledger_returns l
    LEFT JOIN (
      SELECT invoiceId, DATE(occurredAt) AS eventDate, SUM(revenue) AS revenue, SUM(cost) AS cost
      FROM completed_refunds GROUP BY invoiceId, DATE(occurredAt)
    ) r ON r.invoiceId = l.invoiceId AND r.eventDate = l.entryDate
    WHERE l.revenue <> COALESCE(r.revenue, 0) OR l.cost <> COALESCE(r.cost, 0)
  )`;
}

interface MovementAggregate {
  cards: number;
  grossCards: number;
  refundedCards: number;
  invoicesCount: number;
  grossSales: string;
  refunds: string;
  sales: string;
  providerShare: string;
  profit: string;
}

const movementTotals = sql`
  COALESCE(SUM(cards), 0) AS cards,
  COALESCE(SUM(kind = 'SALE'), 0) AS grossCards,
  COALESCE(SUM(kind = 'REFUND'), 0) AS refundedCards,
  COUNT(DISTINCT CASE WHEN kind = 'SALE' THEN invoiceId END) AS invoicesCount,
  COALESCE(SUM(CASE WHEN kind = 'SALE' THEN revenue ELSE 0 END), 0) AS grossSales,
  COALESCE(SUM(CASE WHEN kind <> 'SALE' THEN revenue ELSE 0 END), 0) AS refunds,
  COALESCE(SUM(revenue), 0) AS sales,
  COALESCE(SUM(cost), 0) AS providerShare,
  COALESCE(SUM(revenue - cost), 0) AS profit`;

function amounts(
  row: Partial<MovementAggregate> | undefined,
  includeCost: boolean,
) {
  return {
    cards: Number(row?.cards ?? 0),
    grossCards: Number(row?.grossCards ?? 0),
    refundedCards: Number(row?.refundedCards ?? 0),
    grossSales: toDbMoney(row?.grossSales ?? 0),
    refunds: toDbMoney(row?.refunds ?? 0),
    sales: toDbMoney(row?.sales ?? 0),
    providerShare: includeCost ? toDbMoney(row?.providerShare ?? 0) : null,
    profit: includeCost ? toDbMoney(row?.profit ?? 0) : null,
  };
}

/* ────────── ١) الملخّص ────────── */

export async function summary(db: DB, scope: Scope) {
  const result = await db.execute(sql`${movementEvents(scope)}
    SELECT settlementMode, GROUPING(settlementMode) AS isTotal, ${movementTotals}
    FROM movements GROUP BY settlementMode WITH ROLLUP`);
  const rows = result[0] as unknown as (MovementAggregate & {
    settlementMode: "PREPAID" | "POSTPAID" | null;
    isTotal: number;
  })[];
  const total = rows.find((row) => Number(row.isTotal) === 1);
  const legacy = rows.find(
    (row) => row.settlementMode == null && Number(row.isTotal) === 0,
  );
  return {
    ...amounts(total, scope.includeCost),
    // Counts cover allocated events only; legacy ledger rows cannot prove card counts.
    countsComplete: legacy == null,
    invoices: Number(total?.invoicesCount ?? 0),
    byMode: rows
      .filter((row) => row.settlementMode != null)
      .map((row) => ({
        settlementMode: row.settlementMode!,
        ...amounts(row, scope.includeCost),
      })),
    // This bucket is included in totals, but cannot be assigned to a mode/offering.
    legacyAdjustment: {
      allocation: "UNALLOCATED_LEGACY" as const,
      ...amounts(legacy, scope.includeCost),
    },
  };
}

/* ────────── ٢) أرصدة المحافظ ────────── */

export async function providerBalances(db: DB, branchId: number | null) {
  const conds = [eq(digitalWallets.isActive, true)];
  if (branchId != null) conds.push(eq(digitalWallets.branchId, branchId));

  const rows = await db
    .select({
      walletId: digitalWallets.id,
      walletName: digitalWallets.name,
      branchId: digitalWallets.branchId,
      branchName: branches.name,
      providerId: digitalProviders.id,
      providerName: suppliers.name,
      currentBalance: digitalWallets.currentBalance,
      reservedBalance: digitalWallets.reservedBalance,
      threshold: digitalProviders.lowBalanceThreshold,
    })
    .from(digitalWallets)
    .innerJoin(digitalProviders, eq(digitalWallets.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(branches, eq(digitalWallets.branchId, branches.id))
    .where(and(...conds))
    .orderBy(asc(digitalWallets.id));

  let total = money(0);
  const wallets = rows.map((r) => {
    const available = money(r.currentBalance).minus(money(r.reservedBalance));
    total = total.plus(money(r.currentBalance));
    return {
      walletId: Number(r.walletId),
      walletName: r.walletName,
      branchId: Number(r.branchId),
      branchName: r.branchName,
      providerId: Number(r.providerId),
      providerName: r.providerName,
      currentBalance: r.currentBalance,
      reservedBalance: r.reservedBalance,
      available: toDbMoney(available),
      isLow: money(r.threshold).gt(0) && available.lte(money(r.threshold)),
    };
  });
  // إجمالي الأصل «أرصدة لدى مزوّدي الكروت» (§٥.١٢).
  return { wallets, totalAsset: toDbMoney(total) };
}

/* ────────── ٣) الذمم الآجلة ────────── */

/**
 * المستحقّ لمزوّدي الآجل. **مصدره `suppliers.currentBalance`** لا مجموع اللقطات:
 * الرصيد يعكس المدفوعات أيضاً، والمبيعاتُ وحدها لا تُظهر ما سُدِّد.
 */
export async function postpaidDues(db: DB) {
  const rows = await db
    .select({
      providerId: digitalProviders.id,
      supplierId: suppliers.id,
      providerName: suppliers.name,
      settlementCycle: digitalProviders.settlementCycle,
      currentBalance: suppliers.currentBalance,
    })
    .from(digitalProviders)
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .where(and(eq(digitalProviders.settlementMode, "POSTPAID"), eq(digitalProviders.isActive, true)))
    .orderBy(desc(suppliers.currentBalance));

  let total = money(0);
  for (const r of rows) total = total.plus(money(r.currentBalance));
  return {
    providers: rows.map((r) => ({
      providerId: Number(r.providerId),
      supplierId: Number(r.supplierId),
      providerName: r.providerName,
      settlementCycle: r.settlementCycle,
      due: r.currentBalance,
    })),
    totalDue: toDbMoney(total),
  };
}

/* ────────── ٤) جاهزية البيع ────────── */

/**
 * كل عرض فعّال يجب أن يمرّ بحراس السعر والربط والرصيد نفسها قبل أن نعدّه جاهزاً للبيع.
 * صلاحية السعر تطابق `posCards.listCards`، ثم تضاف حراس PREPAID التي يفرضها `intent.prepare`.
 */
export type DigitalSaleReadiness =
  | "READY"
  | "NO_PRICE"
  | "STALE_PRICE"
  | "NO_WALLET"
  | "WALLET_MISMATCH"
  | "WALLET_INACTIVE"
  | "INSUFFICIENT_BALANCE";

/**
 * جاهزية البيع الفعلية، لا وجود السعر فقط. هذا التقرير يجب أن يطابق الحراس التي سيصطدم بها
 * الكاشير في `prepare`: ربط المحفظة ونطاقها وحالتها وكفاية رصيد كرت واحد، إضافةً إلى صلاحية
 * السعر. لا نُخرج الحصة أو رصيد المحفظة؛ نعيد سبب المنع القابل للمعالجة فقط.
 */
export async function priceHealth(db: DB, branchId: number | null, now = new Date()) {
  const conds = [
    eq(digitalOfferingBranches.isActive, true),
    eq(digitalOfferings.isActive, true),
    eq(digitalProviders.isActive, true),
  ];
  if (branchId != null) conds.push(eq(digitalOfferingBranches.branchId, branchId));

  const rows = await db
    .select({
      branchId: digitalOfferingBranches.branchId,
      branchName: branches.name,
      offeringId: digitalOfferings.id,
      offeringName: products.name,
      providerId: digitalProviders.id,
      providerName: suppliers.name,
      settlementMode: digitalProviders.settlementMode,
      walletId: digitalOfferingBranches.walletId,
      walletProviderId: digitalWallets.providerId,
      walletBranchId: digitalWallets.branchId,
      walletActive: digitalWallets.isActive,
      walletBalance: digitalWallets.currentBalance,
      walletReserved: digitalWallets.reservedBalance,
      priceVersionId: digitalCurrentPrices.priceVersionId,
      providerShare: digitalPriceVersions.providerShare,
      validFrom: digitalPriceVersions.validFrom,
      validUntil: digitalPriceVersions.validUntil,
      priceValidityHours: digitalOfferings.priceValidityHours,
    })
    .from(digitalOfferingBranches)
    .innerJoin(digitalOfferings, eq(digitalOfferingBranches.offeringId, digitalOfferings.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(digitalProviders, eq(digitalOfferings.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .innerJoin(branches, eq(digitalOfferingBranches.branchId, branches.id))
    .leftJoin(
      digitalCurrentPrices,
      and(
        eq(digitalCurrentPrices.offeringId, digitalOfferings.id),
        eq(digitalCurrentPrices.branchId, digitalOfferingBranches.branchId),
      ),
    )
    .leftJoin(digitalPriceVersions, eq(digitalCurrentPrices.priceVersionId, digitalPriceVersions.id))
    .leftJoin(digitalWallets, eq(digitalOfferingBranches.walletId, digitalWallets.id))
    .where(and(...conds))
    .orderBy(asc(digitalOfferingBranches.branchId), asc(digitalOfferings.id));

  const items = rows.map((r) => {
    let availability: DigitalSaleReadiness = "READY";

    if (r.settlementMode === "PREPAID") {
      if (r.walletId == null || r.walletProviderId == null || r.walletBranchId == null) {
        availability = "NO_WALLET";
      } else if (
        Number(r.walletProviderId) !== Number(r.providerId) ||
        Number(r.walletBranchId) !== Number(r.branchId)
      ) {
        availability = "WALLET_MISMATCH";
      } else if (!r.walletActive) {
        availability = "WALLET_INACTIVE";
      }
    }

    if (availability === "READY") {
      if (r.priceVersionId == null || r.providerShare == null) {
        availability = "NO_PRICE";
      } else if (r.validUntil != null) {
        availability = "STALE_PRICE";
      } else if (r.priceValidityHours != null && r.validFrom != null) {
        const ageHours = (now.getTime() - new Date(r.validFrom).getTime()) / 3_600_000;
        if (ageHours > r.priceValidityHours) availability = "STALE_PRICE";
      }
    }

    if (
      availability === "READY" &&
      r.settlementMode === "PREPAID" &&
      r.walletBalance != null &&
      r.walletReserved != null &&
      r.providerShare != null &&
      money(r.walletBalance).minus(money(r.walletReserved)).lt(money(r.providerShare))
    ) {
      availability = "INSUFFICIENT_BALANCE";
    }

    return {
      branchId: Number(r.branchId),
      branchName: r.branchName,
      offeringId: Number(r.offeringId),
      offeringName: r.offeringName,
      providerId: Number(r.providerId),
      providerName: r.providerName,
      availability,
    };
  });
  const blockerCounts = items.reduce<Record<string, number>>((acc, item) => {
    if (item.availability !== "READY") {
      acc[item.availability] = (acc[item.availability] ?? 0) + 1;
    }
    return acc;
  }, {});
  return {
    total: items.length,
    ready: items.filter((i) => i.availability === "READY").length,
    needsAttention: items.filter((i) => i.availability !== "READY"),
    blockerCounts,
  };
}

/* ────────── ٥) الحالات المعلّقة ────────── */

/** نيّات لم تُثبَّت: قيد التنفيذ أو مُنفَّذة بلا فاتورة أو في طابور المراجعة. */
export async function pendingExecutions(db: DB, branchId: number | null) {
  const conds = [
    inArray(digitalSaleIntents.status, ["PREPARED", "EXECUTING", "EXECUTED", "NEEDS_REVIEW"]),
  ];
  if (branchId != null) conds.push(eq(digitalSaleIntents.branchId, branchId));

  const rows = await db
    .select({
      id: digitalSaleIntents.id,
      status: digitalSaleIntents.status,
      branchId: digitalSaleIntents.branchId,
      branchName: branches.name,
      expectedTotal: digitalSaleIntents.expectedTotal,
      createdAt: digitalSaleIntents.createdAt,
      expiresAt: digitalSaleIntents.expiresAt,
    })
    .from(digitalSaleIntents)
    .innerJoin(branches, eq(digitalSaleIntents.branchId, branches.id))
    .where(and(...conds))
    .orderBy(asc(digitalSaleIntents.id))
    .limit(200);

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    total: rows.length,
    byStatus,
    // NEEDS_REVIEW أخطرها: كرتٌ صدر بلا فاتورة.
    needsReview: rows.filter((r) => r.status === "NEEDS_REVIEW").length,
    items: rows.map((r) => ({ ...r, id: Number(r.id), branchId: Number(r.branchId) })),
  };
}

/* ────────── ٦) أكثر البطاقات مبيعاً ────────── */

export async function topOfferings(db: DB, scope: Scope, limit = 10) {
  const result = await db.execute(sql`${movementEvents(scope)}
    SELECT m.offeringId, p.name AS offeringName, s.name AS providerName, ${movementTotals}
    FROM movements m
    INNER JOIN digitalOfferings o ON o.id = m.offeringId
    INNER JOIN products p ON p.id = o.productId
    INNER JOIN digitalProviders dp ON dp.id = m.providerId
    INNER JOIN suppliers s ON s.id = dp.supplierId
    GROUP BY m.offeringId, p.name, s.name
    ORDER BY grossCards DESC, m.offeringId ASC
    LIMIT ${Math.max(0, Math.min(Math.trunc(limit), 50))}`);
  const rows = result[0] as unknown as (MovementAggregate & {
    offeringId: number;
    offeringName: string;
    providerName: string;
  })[];
  return rows.map((row) => ({
    offeringId: Number(row.offeringId),
    offeringName: row.offeringName,
    providerName: row.providerName,
    ...amounts(row, scope.includeCost),
  }));
}

/* ────────── ٧) حالة المطابقات ────────── */

export async function reconciliationStatus(db: DB, scope: Scope) {
  const conds = [
    gte(digitalWalletReconciliations.businessDate, scope.from),
    lt(digitalWalletReconciliations.businessDate, scope.to),
  ];
  if (scope.branchId != null) conds.push(eq(digitalWalletReconciliations.branchId, scope.branchId));

  const rows = await db
    .select({
      id: digitalWalletReconciliations.id,
      walletId: digitalWalletReconciliations.walletId,
      walletName: digitalWallets.name,
      businessDate: digitalWalletReconciliations.businessDate,
      variance: digitalWalletReconciliations.variance,
      status: digitalWalletReconciliations.status,
    })
    .from(digitalWalletReconciliations)
    .innerJoin(digitalWallets, eq(digitalWalletReconciliations.walletId, digitalWallets.id))
    .where(and(...conds))
    .orderBy(desc(digitalWalletReconciliations.businessDate))
    .limit(200);

  let openVariance = money(0);
  for (const r of rows) if (r.status === "VARIANCE_OPEN") openVariance = openVariance.plus(money(r.variance));

  return {
    total: rows.length,
    matched: rows.filter((r) => r.status === "MATCHED").length,
    open: rows.filter((r) => r.status === "VARIANCE_OPEN").length,
    resolved: rows.filter((r) => r.status === "RESOLVED").length,
    openVarianceTotal: toDbMoney(openVariance),
    items: rows.map((r) => ({ ...r, id: Number(r.id), walletId: Number(r.walletId) })),
  };
}
