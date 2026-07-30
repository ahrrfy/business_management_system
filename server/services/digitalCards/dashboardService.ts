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
 * مشتقٌّ من `digitalSaleDetails` (اللقطة المثبَّتة) لا من حسابٍ موازٍ.
 */
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  branches,
  digitalCurrentPrices,
  digitalOfferingBranches,
  digitalOfferings,
  digitalPriceVersions,
  digitalProviders,
  digitalSaleDetails,
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

/** حدود الفترة كطوابع زمنية — النهاية حصرية دائماً. */
function bounds(p: Period): { start: Date; endExclusive: Date } {
  return { start: new Date(`${p.from}T00:00:00.000Z`), endExclusive: new Date(`${p.to}T00:00:00.000Z`) };
}

/** شرط الفترة + الفرع على الفاتورة المرتبطة بالتفاصيل. */
function saleConds(scope: Scope) {
  const { start, endExclusive } = bounds(scope);
  const conds = [gte(invoices.createdAt, start), lt(invoices.createdAt, endExclusive)];
  if (scope.branchId != null) conds.push(eq(invoices.branchId, scope.branchId));
  return conds;
}

/* ────────── ١) الملخّص ────────── */

export async function summary(db: DB, scope: Scope) {
  const [row] = await db
    .select({
      cards: sql<number>`COUNT(*)`,
      invoicesCount: sql<number>`COUNT(DISTINCT ${digitalSaleDetails.invoiceId})`,
      sales: sql<string>`COALESCE(SUM(${digitalSaleDetails.sellPriceSnapshot}), 0)`,
      providerShare: sql<string>`COALESCE(SUM(${digitalSaleDetails.providerShareSnapshot}), 0)`,
      profit: sql<string>`COALESCE(SUM(${digitalSaleDetails.profitSnapshot}), 0)`,
    })
    .from(digitalSaleDetails)
    .innerJoin(invoices, eq(digitalSaleDetails.invoiceId, invoices.id))
    .where(and(...saleConds(scope)));

  const byMode = await db
    .select({
      settlementMode: digitalSaleDetails.settlementModeSnapshot,
      cards: sql<number>`COUNT(*)`,
      sales: sql<string>`COALESCE(SUM(${digitalSaleDetails.sellPriceSnapshot}), 0)`,
      providerShare: sql<string>`COALESCE(SUM(${digitalSaleDetails.providerShareSnapshot}), 0)`,
      profit: sql<string>`COALESCE(SUM(${digitalSaleDetails.profitSnapshot}), 0)`,
    })
    .from(digitalSaleDetails)
    .innerJoin(invoices, eq(digitalSaleDetails.invoiceId, invoices.id))
    .where(and(...saleConds(scope)))
    .groupBy(digitalSaleDetails.settlementModeSnapshot);

  const hide = !scope.includeCost;
  return {
    cards: Number(row?.cards ?? 0),
    invoices: Number(row?.invoicesCount ?? 0),
    sales: toDbMoney(row?.sales ?? 0),
    providerShare: hide ? null : toDbMoney(row?.providerShare ?? 0),
    profit: hide ? null : toDbMoney(row?.profit ?? 0),
    byMode: byMode.map((m) => ({
      settlementMode: m.settlementMode,
      cards: Number(m.cards),
      sales: toDbMoney(m.sales),
      providerShare: hide ? null : toDbMoney(m.providerShare),
      profit: hide ? null : toDbMoney(m.profit),
    })),
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

/* ────────── ٤) صحة الأسعار ────────── */

/**
 * بطاقات فعّالة بلا سعر نافذ في فرعٍ ما — كل واحدةٍ منها بيعٌ ضائع.
 * منطق الجاهزية مطابقٌ لـ`posCards.listCards` (لا سعر ⇒ NO_PRICE، سريانٌ مُغلق ⇒ STALE_PRICE).
 */
export async function priceHealth(db: DB, branchId: number | null) {
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
      providerName: suppliers.name,
      priceVersionId: digitalCurrentPrices.priceVersionId,
      validUntil: digitalPriceVersions.validUntil,
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
    .where(and(...conds))
    .orderBy(asc(digitalOfferingBranches.branchId), asc(digitalOfferings.id));

  const items = rows.map((r) => ({
    branchId: Number(r.branchId),
    branchName: r.branchName,
    offeringId: Number(r.offeringId),
    offeringName: r.offeringName,
    providerName: r.providerName,
    availability: (r.priceVersionId == null
      ? "NO_PRICE"
      : r.validUntil != null
        ? "STALE_PRICE"
        : "READY") as "READY" | "STALE_PRICE" | "NO_PRICE",
  }));
  return {
    total: items.length,
    ready: items.filter((i) => i.availability === "READY").length,
    needsAttention: items.filter((i) => i.availability !== "READY"),
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
  const hide = !scope.includeCost;
  const rows = await db
    .select({
      offeringId: digitalSaleDetails.offeringId,
      offeringName: products.name,
      providerName: suppliers.name,
      cards: sql<number>`COUNT(*)`,
      sales: sql<string>`COALESCE(SUM(${digitalSaleDetails.sellPriceSnapshot}), 0)`,
      profit: sql<string>`COALESCE(SUM(${digitalSaleDetails.profitSnapshot}), 0)`,
    })
    .from(digitalSaleDetails)
    .innerJoin(invoices, eq(digitalSaleDetails.invoiceId, invoices.id))
    .innerJoin(digitalOfferings, eq(digitalSaleDetails.offeringId, digitalOfferings.id))
    .innerJoin(products, eq(digitalOfferings.productId, products.id))
    .innerJoin(digitalProviders, eq(digitalSaleDetails.providerId, digitalProviders.id))
    .innerJoin(suppliers, eq(digitalProviders.supplierId, suppliers.id))
    .where(and(...saleConds(scope)))
    .groupBy(digitalSaleDetails.offeringId, products.name, suppliers.name)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(Math.min(limit, 50));

  return rows.map((r) => ({
    offeringId: Number(r.offeringId),
    offeringName: r.offeringName,
    providerName: r.providerName,
    cards: Number(r.cards),
    sales: toDbMoney(r.sales),
    profit: hide ? null : toDbMoney(r.profit),
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
