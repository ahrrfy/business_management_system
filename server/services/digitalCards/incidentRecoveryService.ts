/** One-off local recovery. No router export, payment adapter, or provider issuance. */
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import * as s from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, sumMoney, toDbMoney } from "../money";
import { assertPeriodOpen } from "../periodLockService";
import { createConfirmedExternalPaymentAttemptTx } from "../posExternalPayment";
import { requireDb, withTx, type Actor } from "../tx";
import { finalize } from "./finalizeService";
import {
  INCIDENT,
  assertIncidentTarget,
  incidentFingerprint,
  loadIncidentManifest,
  type IncidentManifest,
} from "./incidentRecoveryContract";

const AUDIT_ACTION = "DIGITAL_INCIDENT_RECOVERED";
const auditResultSchema = z.object({
  manifestFingerprint: z.string(),
  planFingerprint: z.string(),
  intentId: z.number(),
  invoiceId: z.number(),
});
export interface IncidentOptions {
  production?: boolean;
}
export interface IncidentPlan {
  incident: typeof INCIDENT;
  fingerprint: string;
  database: IncidentManifest["database"];
  matches: {
    intentIds: number[];
    bankAttemptIds: number[];
    invoiceIds: number[];
  };
  conflicts: string[];
  original: {
    shiftId: number;
    shiftStatus: string | null;
    executedAt: string;
    operatorId: number;
    source: string;
  };
  posting: {
    shiftId: number;
    shiftStatus: string | null;
    day: string;
    branchId: number;
  };
  financial: {
    offeringId: number;
    priceVersionId: number;
    providerId: number;
    providerShare: string;
    fundingMode: string;
    walletId: number | null;
    customerId: number | null;
    priorSettlement: string;
  };
  action: "RECOVER_EXISTING" | "ATTEST_PRIOR_ISSUE";
}

function refuse(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Incident recovery refused: ${reason}`);
}
function userSelection() {
  return {
    id: s.users.id,
    role: s.users.role,
    branchId: s.users.branchId,
    isOwner: s.users.isOwner,
    isActive: s.users.isActive,
    accessExpiresAt: s.users.accessExpiresAt,
    customRoleId: s.users.customRoleId,
    operationPolicyRevision: s.users.operationPolicyRevision,
    operationPolicy: s.users.operationPolicy,
    permissionsOverride: s.users.permissionsOverride,
    atomicPermissions: s.users.atomicPermissions,
    operationalCaps: s.users.operationalCaps,
  };
}
async function identity(tx: Tx, manifest: IncidentManifest) {
  const result = await tx.execute(
    sql`SELECT DATABASE() AS name, @@server_uuid AS serverUuid`,
  );
  const [current] = z
    .array(z.object({ name: z.string(), serverUuid: z.string() }))
    .parse(result[0]);
  refuse(
    current &&
      current.name === manifest.database.name &&
      current.serverUuid === manifest.database.serverUuid,
    "database identity mismatch",
  );
  return current;
}
async function authority(tx: Tx, manifest: IncidentManifest): Promise<Actor> {
  const [user] = await tx
    .select(userSelection())
    .from(s.users)
    .where(eq(s.users.id, manifest.authorityUserId))
    .for("share");
  refuse(
    user &&
      user.isActive &&
      (user.isOwner || (user.role === "admin" && user.customRoleId == null)),
    "persisted active owner/admin authority required",
  );
  refuse(
    !user.accessExpiresAt || user.accessExpiresAt > new Date(),
    "authority account expired",
  );
  return {
    userId: user.id,
    branchId: user.branchId ?? manifest.branchId,
    role: user.role,
  };
}

/** Every input to the decision is read again under locks at apply. The exclusive
 * company governance gate additionally excludes all canonical financial writers. */
async function snapshot(tx: Tx, m: IncidentManifest) {
  const database = await identity(tx, m);
  const actors = await tx
    .select(userSelection())
    .from(s.users)
    .where(inArray(s.users.id, [m.originalOperatorId, m.authorityUserId]))
    .orderBy(asc(s.users.id))
    .for("share");
  const branches = await tx
    .select()
    .from(s.branches)
    .where(eq(s.branches.id, m.branchId))
    .for("share");
  const shifts = await tx
    .select()
    .from(s.shifts)
    .where(inArray(s.shifts.id, [m.originalShiftId, m.postingShiftId]))
    .orderBy(asc(s.shifts.id))
    .for("update");
  const providers = await tx
    .select()
    .from(s.digitalProviders)
    .where(eq(s.digitalProviders.id, m.providerId))
    .for("update");
  const provider = providers[0];
  const suppliers = provider
    ? await tx
        .select()
        .from(s.suppliers)
        .where(eq(s.suppliers.id, provider.supplierId))
        .for("update")
    : [];
  const offerings = await tx
    .select()
    .from(s.digitalOfferings)
    .where(eq(s.digitalOfferings.id, m.offeringId))
    .for("update");
  const offering = offerings[0];
  const product = offering
    ? await tx
        .select()
        .from(s.products)
        .where(eq(s.products.id, offering.productId))
        .for("share")
    : [];
  const variants = offering
    ? await tx
        .select()
        .from(s.productVariants)
        .where(eq(s.productVariants.id, offering.variantId))
        .for("share")
    : [];
  const units = offering
    ? await tx
        .select()
        .from(s.productUnits)
        .where(eq(s.productUnits.id, offering.productUnitId))
        .for("share")
    : [];
  const prices = await tx
    .select()
    .from(s.digitalPriceVersions)
    .where(eq(s.digitalPriceVersions.id, m.priceVersionId))
    .for("share");
  const batches = prices[0]
    ? await tx
        .select()
        .from(s.digitalPriceBatches)
        .where(eq(s.digitalPriceBatches.id, prices[0].batchId))
        .for("share")
    : [];
  const customers =
    m.customerId == null
      ? []
      : await tx
          .select()
          .from(s.customers)
          .where(eq(s.customers.id, m.customerId))
          .for("share");
  const bank = await tx
    .select()
    .from(s.externalPaymentAttempts)
    .where(
      eq(s.externalPaymentAttempts.normalizedReference, INCIDENT.bankReference),
    )
    .orderBy(asc(s.externalPaymentAttempts.id))
    .for("update");
  const references = await tx
    .select()
    .from(s.digitalSaleIntentItems)
    .where(
      eq(
        s.digitalSaleIntentItems.providerReference,
        INCIDENT.providerReference,
      ),
    )
    .orderBy(asc(s.digitalSaleIntentItems.id))
    .for("update");
  const candidateIds = references.map((r) => r.intentId);
  const intentCondition = or(
    eq(s.digitalSaleIntents.clientRequestId, INCIDENT.key),
    candidateIds.length
      ? inArray(s.digitalSaleIntents.id, candidateIds)
      : undefined,
    bank.length
      ? inArray(
          s.digitalSaleIntents.externalPaymentAttemptId,
          bank.map((b) => b.id),
        )
      : undefined,
    references.length === 0 && bank.length === 0
      ? and(
          eq(s.digitalSaleIntents.branchId, m.branchId),
          eq(s.digitalSaleIntents.shiftId, m.originalShiftId),
          eq(s.digitalSaleIntents.createdBy, m.originalOperatorId),
          eq(s.digitalSaleIntents.paymentMethod, "CARD"),
          eq(s.digitalSaleIntents.expectedTotal, INCIDENT.amount),
        )
      : undefined,
  );
  const intents = await tx
    .select()
    .from(s.digitalSaleIntents)
    .where(intentCondition)
    .orderBy(asc(s.digitalSaleIntents.id))
    .for("update");
  const intentIds = intents.map((r) => r.id);
  const items = intentIds.length
    ? await tx
        .select()
        .from(s.digitalSaleIntentItems)
        .where(inArray(s.digitalSaleIntentItems.intentId, intentIds))
        .orderBy(asc(s.digitalSaleIntentItems.id))
        .for("update")
    : [];
  const reservations = intentIds.length
    ? await tx
        .select()
        .from(s.digitalWalletReservations)
        .where(inArray(s.digitalWalletReservations.intentId, intentIds))
        .orderBy(asc(s.digitalWalletReservations.id))
        .for("update")
    : [];
  const claimResult = items.length
    ? await tx.execute(
        sql`SELECT * FROM digitalSaleExecutionClaims WHERE intentItemId IN (${sql.join(
          items.map((r) => sql`${r.id}`),
          sql`, `,
        )}) ORDER BY intentItemId FOR UPDATE`,
      )
    : null;
  const claims = claimResult
    ? z
        .array(
          z
            .object({
              intentItemId: z.coerce.number(),
              completedAt: z.coerce.date().nullable(),
            })
            .passthrough(),
        )
        .parse(claimResult[0])
    : [];
  const resolutions = intentIds.length
    ? await tx
        .select()
        .from(s.digitalSaleReviewResolutions)
        .where(inArray(s.digitalSaleReviewResolutions.intentId, intentIds))
        .for("update")
    : [];
  const details = await tx
    .select()
    .from(s.digitalSaleDetails)
    .where(
      eq(s.digitalSaleDetails.providerReference, INCIDENT.providerReference),
    )
    .orderBy(asc(s.digitalSaleDetails.id))
    .for("update");
  const receipts = await tx
    .select()
    .from(s.receipts)
    .where(eq(s.receipts.referenceNumber, INCIDENT.bankReference))
    .orderBy(asc(s.receipts.id))
    .for("update");
  const invoices = await tx
    .select()
    .from(s.invoices)
    .where(
      or(
        eq(s.invoices.sourceId, INCIDENT.key),
        intentIds.length
          ? inArray(
              s.invoices.sourceId,
              intentIds.map((id) => `DIGITAL_INTENT:${id}`),
            )
          : undefined,
        details.length
          ? inArray(
              s.invoices.id,
              details.map((d) => d.invoiceId),
            )
          : undefined,
      ),
    )
    .orderBy(asc(s.invoices.id))
    .for("update");
  const wallets = await tx
    .select()
    .from(s.digitalWallets)
    .where(eq(s.digitalWallets.providerId, m.providerId))
    .orderBy(asc(s.digitalWallets.id))
    .for("update");
  const walletIds = wallets.map((w) => w.id);
  const walletTransactions = walletIds.length
    ? await tx
        .select()
        .from(s.digitalWalletTransactions)
        .where(inArray(s.digitalWalletTransactions.walletId, walletIds))
        .orderBy(asc(s.digitalWalletTransactions.id))
        .for("update")
    : [];
  const walletReservations = walletIds.length
    ? await tx
        .select()
        .from(s.digitalWalletReservations)
        .where(inArray(s.digitalWalletReservations.walletId, walletIds))
        .orderBy(asc(s.digitalWalletReservations.id))
        .for("update")
    : [];
  const reconciliations = walletIds.length
    ? await tx
        .select()
        .from(s.digitalWalletReconciliations)
        .where(inArray(s.digitalWalletReconciliations.walletId, walletIds))
        .orderBy(asc(s.digitalWalletReconciliations.id))
        .for("update")
    : [];
  const entries = provider
    ? await tx
        .select()
        .from(s.accountingEntries)
        .where(
          or(
            eq(s.accountingEntries.supplierId, provider.supplierId),
            walletIds.length
              ? inArray(s.accountingEntries.digitalWalletId, walletIds)
              : undefined,
          ),
        )
        .orderBy(asc(s.accountingEntries.id))
        .for("update")
    : [];
  const periods = await tx
    .select()
    .from(s.financialPeriods)
    .orderBy(asc(s.financialPeriods.id))
    .for("share");
  return {
    database,
    actors,
    branches,
    shifts,
    providers,
    suppliers,
    offerings,
    product,
    variants,
    units,
    prices,
    batches,
    customers,
    bank,
    references,
    intents,
    items,
    reservations,
    claims,
    resolutions,
    details,
    receipts,
    invoices,
    wallets,
    walletTransactions,
    walletReservations,
    reconciliations,
    entries,
    periods,
    postingDay: new Date().toISOString().slice(0, 10),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

function conflicts(m: IncidentManifest, data: Snapshot): string[] {
  const issues: string[] = [];
  const check = (ok: unknown, message: string) => {
    if (!ok) issues.push(message);
  };
  const executed = new Date(m.executedAt);
  const original = data.shifts.find((r) => r.id === m.originalShiftId);
  const posting = data.shifts.find((r) => r.id === m.postingShiftId);
  const provider = data.providers[0],
    offering = data.offerings[0],
    price = data.prices[0];
  const sourceShift = m.sourceType === "RECEPTION" ? "RECEPTION" : "RETAIL";
  check(data.branches[0]?.isActive, "Branch missing/inactive");
  check(
    original &&
      original.branchId === m.branchId &&
      original.userId === m.originalOperatorId &&
      original.shiftType === sourceShift,
    "Original shift/operator/source mismatch",
  );
  check(
    original &&
      executed >= original.openedAt &&
      (!original.closedAt || executed <= original.closedAt) &&
      executed <= new Date(),
    "Execution time is outside the original shift",
  );
  check(
    posting &&
      posting.status === "OPEN" &&
      posting.closedAt == null &&
      posting.branchId === m.branchId &&
      posting.shiftType === sourceShift,
    "Posting requires a currently open shift with matching branch/type",
  );
  check(
    data.actors.some((a) => a.id === m.originalOperatorId),
    "Original operator is missing",
  );
  check(
    m.customerId == null || data.customers.length === 1,
    "Original customer is missing",
  );
  check(
    provider &&
      data.suppliers.length === 1 &&
      offering?.providerId === provider.id,
    "Provider/offering binding mismatch",
  );
  check(
    data.product[0]?.productType === "DIGITAL_CARD" &&
      data.product[0]?.isService &&
      data.variants.length === 1 &&
      data.units.length === 1,
    "Digital catalog binding mismatch",
  );
  check(
    price &&
      price.offeringId === m.offeringId &&
      price.branchId === m.branchId &&
      money(price.sellPrice).eq(INCIDENT.amount) &&
      money(price.providerShare).eq(m.originalProviderShare) &&
      money(price.providerShare).gt(0) &&
      money(price.providerShare).lte(price.sellPrice) &&
      price.validFrom <= executed &&
      (!price.validUntil || executed < price.validUntil) &&
      ["PUBLISHED", "SUPERSEDED"].includes(data.batches[0]?.status ?? ""),
    "Original immutable price/share cannot be established",
  );
  check(
    !data.periods.some(
      (p) => p.status === "LOCKED" && p.cutoffDate >= data.postingDay,
    ),
    "Current posting period is closed",
  );
  check(
    data.intents.length <= 1 &&
      data.references.length <= 1 &&
      data.bank.length <= 1,
    "Ambiguous or duplicate source matches",
  );
  check(
    data.invoices.length === 0 &&
      data.receipts.length === 0 &&
      data.details.length === 0,
    "An invoice/collection/provider detail already exists without this tool's audit receipt",
  );
  check(
    data.resolutions.length === 0,
    "Existing review resolution must be handled separately",
  );
  check(
    data.claims.every((c) => c.completedAt != null),
    "Unfinished provider execution claim",
  );
  const intent = data.intents[0],
    item = data.items[0];
  if (intent) {
    check(
      ["EXECUTED", "NEEDS_REVIEW"].includes(intent.status) &&
        intent.invoiceId == null &&
        intent.paymentMethod === "CARD" &&
        intent.branchId === m.branchId &&
        intent.createdBy === m.originalOperatorId &&
        intent.shiftId === m.originalShiftId &&
        money(intent.expectedTotal).eq(INCIDENT.amount),
      "Existing intent is not the exact unposted incident",
    );
    check(
      data.items.length === 1 &&
        item?.providerId === m.providerId &&
        item?.offeringId === m.offeringId &&
        item?.priceVersionId === m.priceVersionId &&
        item.providerReference === INCIDENT.providerReference &&
        item.fulfillmentStatus === "SUCCESS" &&
        item.confirmedAt?.getTime() === executed.getTime() &&
        item.confirmedBy === m.originalOperatorId &&
        money(item.sellPriceSnapshot).eq(INCIDENT.amount) &&
        money(item.providerShareSnapshot).eq(m.originalProviderShare),
      "Existing issued item differs from immutable evidence",
    );
    check(
      (intent.checkoutSnapshot?.sourceType ?? "POS") === m.sourceType &&
        (intent.checkoutSnapshot?.customerId ?? null) === m.customerId &&
        (intent.checkoutSnapshot?.regularLines.length ?? 0) === 0 &&
        money(intent.checkoutSnapshot?.expectedSubtotal ?? "0").eq(0),
      "Existing checkout is not the original single-card source",
    );
    check(
      !data.bank[0] ||
        intent.externalPaymentAttemptId == null ||
        intent.externalPaymentAttemptId === data.bank[0].id,
      "Bank proof points to another attempt",
    );
  } else {
    check(
      data.references.length === 0 && data.reservations.length === 0,
      "Orphan incident source",
    );
    check(
      m.sourceType === "RECEPTION",
      "Prior-issue adoption requires the proven Reception source",
    );
  }
  const bank = data.bank[0];
  if (bank)
    check(
      bank.branchId === m.branchId &&
        bank.channel === (m.sourceType === "RECEPTION" ? "PRINT_POS" : "POS") &&
        bank.paymentMethod === "CARD" &&
        bank.externalReference === INCIDENT.bankReference &&
        bank.deviceId === m.deviceId &&
        bank.state === "CONFIRMED" &&
        bank.invoiceId == null &&
        bank.receiptId == null &&
        bank.consumedAt == null &&
        bank.createdBy === m.originalOperatorId &&
        bank.confirmedBy === m.originalOperatorId &&
        bank.confirmedAt != null &&
        money(bank.amount).eq(INCIDENT.amount),
      "Existing bank proof has conflicting source/device/actor/state",
    );
  if (intent?.externalPaymentAttemptId != null)
    check(
      bank?.id === intent.externalPaymentAttemptId &&
        intent.externalPaymentDeviceId === m.deviceId,
      "Existing intent's bank binding is unresolved",
    );
  if (m.fundingMode === "PREPAID") {
    const wallet = data.wallets.find((w) => w.id === m.walletId);
    check(
      wallet &&
        wallet.branchId === m.branchId &&
        wallet.providerId === m.providerId &&
        wallet.isActive,
      "Original wallet binding cannot be established",
    );
    check(
      !intent ||
        (data.reservations.length === 1 &&
          data.reservations[0].walletId === m.walletId &&
          data.reservations[0].status === "ACTIVE" &&
          money(data.reservations[0].amount).eq(m.originalProviderShare)),
      "Existing prepaid reservation differs from original funding evidence",
    );
    if (wallet) {
      const active = data.walletTransactions.filter(
        (r) => r.walletId === wallet.id && r.status === "ACTIVE",
      );
      const balance = sumMoney(
        active.map((r) =>
          toDbMoney(money(r.amount).times(r.direction === "IN" ? 1 : -1)),
        ),
      );
      const reserved = sumMoney(
        data.walletReservations
          .filter((r) => r.walletId === wallet.id && r.status === "ACTIVE")
          .map((r) => r.amount),
      );
      check(
        balance.eq(wallet.currentBalance) &&
          reserved.eq(wallet.reservedBalance),
        "Wallet ledger/reservation reconciliation mismatch",
      );
      check(
        money(wallet.currentBalance)
          .minus(wallet.reservedBalance)
          .plus(intent ? m.originalProviderShare : "0")
          .gte(m.originalProviderShare),
        "Insufficient unambiguous wallet funds",
      );
    }
  } else
    check(
      data.reservations.length === 0,
      "Original postpaid mode conflicts with a wallet reservation",
    );
  // A reconciliation or manual settlement may already contain this issuance. No
  // automatic inference from a missing invoice or a current provider setting.
  check(
    !data.reconciliations.some((r) => r.createdAt >= executed),
    "Provider wallet reconciliation after issuance makes prior settlement ambiguous",
  );
  check(
    !data.walletTransactions.some(
      (r) =>
        r.createdAt >= executed &&
        (["ADJUSTMENT", "WRITEOFF", "OPENING"].includes(r.type) ||
          (r.type === "SALE_CONSUMPTION" && r.invoiceId == null)),
    ),
    "Prior wallet adjustment/writeoff/unlinked consumption is ambiguous",
  );
  check(
    !data.entries.some(
      (r) =>
        r.entryDate.toISOString().slice(0, 10) >= m.executedAt.slice(0, 10) &&
        ([
          "ADJUST",
          "OPENING",
          "DIGITAL_WRITEOFF",
          "DIGITAL_WALLET_ADJUSTMENT",
        ].includes(r.entryType) ||
          (r.invoiceId == null &&
            (r.supplierId === data.providers[0]?.supplierId ||
              r.entryType === "DIGITAL_WALLET_CONSUMPTION"))),
    ),
    "Prior provider settlement/adjustment is ambiguous",
  );
  return issues;
}

function buildPlan(m: IncidentManifest, data: Snapshot): IncidentPlan {
  return {
    incident: INCIDENT,
    fingerprint: incidentFingerprint({ manifest: m, data }),
    database: m.database,
    matches: {
      intentIds: data.intents.map((i) => i.id),
      bankAttemptIds: data.bank.map((b) => b.id),
      invoiceIds: data.invoices.map((i) => i.id),
    },
    conflicts: conflicts(m, data),
    original: {
      shiftId: m.originalShiftId,
      shiftStatus:
        data.shifts.find((r) => r.id === m.originalShiftId)?.status ?? null,
      executedAt: m.executedAt,
      operatorId: m.originalOperatorId,
      source: m.sourceType,
    },
    posting: {
      shiftId: m.postingShiftId,
      shiftStatus:
        data.shifts.find((r) => r.id === m.postingShiftId)?.status ?? null,
      day: data.postingDay,
      branchId: m.branchId,
    },
    financial: {
      offeringId: m.offeringId,
      priceVersionId: m.priceVersionId,
      providerId: m.providerId,
      providerShare: m.originalProviderShare,
      fundingMode: m.fundingMode,
      walletId: m.walletId,
      customerId: m.customerId,
      priorSettlement: m.priorProviderSettlement,
    },
    action: data.intents.length ? "RECOVER_EXISTING" : "ATTEST_PRIOR_ISSUE",
  };
}

export async function planIncidentRecovery(
  manifestPath: string,
  options: IncidentOptions = {},
): Promise<IncidentPlan> {
  assertIncidentTarget(
    process.env.DATABASE_URL,
    false,
    options.production === true,
  );
  const m = await loadIncidentManifest(manifestPath);
  return requireDb().transaction(async (tx) => {
    await authority(tx, m);
    return buildPlan(m, await snapshot(tx, m));
  });
}

async function acceptance(
  tx: Tx,
  intentId: number,
  invoiceId: number,
  m: IncidentManifest,
) {
  const [invoice] = await tx
    .select()
    .from(s.invoices)
    .where(eq(s.invoices.id, invoiceId));
  const receipts = await tx
    .select()
    .from(s.receipts)
    .where(eq(s.receipts.invoiceId, invoiceId));
  const details = await tx
    .select()
    .from(s.digitalSaleDetails)
    .where(eq(s.digitalSaleDetails.invoiceId, invoiceId));
  const items = await tx
    .select()
    .from(s.digitalSaleIntentItems)
    .where(eq(s.digitalSaleIntentItems.intentId, intentId));
  const entries = await tx
    .select()
    .from(s.accountingEntries)
    .where(eq(s.accountingEntries.invoiceId, invoiceId));
  const settlement = entries.filter(
    (e) =>
      e.dedupeKey ===
      (m.fundingMode === "PREPAID"
        ? `DIGITAL:WCONS:${invoiceId}:${m.walletId}`
        : `DIGITAL:AP:${invoiceId}:${m.providerId}`),
  );
  refuse(
    invoice &&
      invoice.shiftId === m.postingShiftId &&
      money(invoice.total).eq(INCIDENT.amount) &&
      money(invoice.paidAmount).eq(INCIDENT.amount),
    "invoice acceptance failed",
  );
  refuse(
    receipts.length === 1 &&
      receipts[0].direction === "IN" &&
      receipts[0].paymentMethod === "CARD" &&
      receipts[0].cashBucket == null &&
      receipts[0].status === "COMPLETED" &&
      receipts[0].referenceNumber === INCIDENT.bankReference &&
      money(receipts[0].amount).eq(INCIDENT.amount),
    "collection acceptance failed",
  );
  refuse(
    details.length === 1 &&
      items.length === 1 &&
      details[0].intentItemId === items[0].id &&
      details[0].providerReference === INCIDENT.providerReference &&
      settlement.length === 1 &&
      money(settlement[0].amount).eq(m.originalProviderShare),
    "provider settlement acceptance failed",
  );
  return { intentId, invoiceId, invoiceNumber: invoice.invoiceNumber };
}

export async function applyIncidentRecovery(
  manifestPath: string,
  fingerprint: string,
  options: IncidentOptions = {},
) {
  assertIncidentTarget(
    process.env.DATABASE_URL,
    true,
    options.production === true,
  );
  refuse(
    /^[a-f0-9]{64}$/.test(fingerprint),
    "exact dry-run fingerprint required",
  );
  const m = await loadIncidentManifest(manifestPath);
  const manifestFingerprint = incidentFingerprint(m);
  return withTx(
    async (tx) => {
      await identity(tx, m);
      const authorizer = await authority(tx, m);
      const audits = await tx
        .select()
        .from(s.auditLogs)
        .where(
          and(
            eq(s.auditLogs.action, AUDIT_ACTION),
            eq(s.auditLogs.entityId, INCIDENT.key),
          ),
        )
        .for("update");
      refuse(audits.length <= 1, "ambiguous prior recovery audits");
      if (audits[0]) {
        const prior = auditResultSchema.parse(audits[0].newValue);
        refuse(
          prior.manifestFingerprint === manifestFingerprint &&
            prior.planFingerprint === fingerprint &&
            audits[0].userId === m.authorityUserId,
          "replay evidence/fingerprint differs from original recovery",
        );
        const [intent] = await tx
          .select()
          .from(s.digitalSaleIntents)
          .where(eq(s.digitalSaleIntents.id, prior.intentId))
          .for("update");
        const [operator] = await tx
          .select(userSelection())
          .from(s.users)
          .where(eq(s.users.id, m.originalOperatorId))
          .for("share");
        refuse(
          intent?.status === "FINALIZED" &&
            intent.invoiceId === prior.invoiceId &&
            operator,
          "replay intent is inconsistent",
        );
        await finalize(
          tx,
          {
            intentId: intent.id,
            clientRequestId: INCIDENT.key,
            paymentAmount: INCIDENT.amount,
            paymentMethod: "CARD",
            externalPaymentAttemptId: intent.externalPaymentAttemptId,
            deviceId: m.deviceId,
            customerId: m.customerId,
          },
          { userId: operator.id, branchId: m.branchId, role: operator.role },
          authorizer,
        );
        const result = await acceptance(tx, prior.intentId, prior.invoiceId, m);
        return { ...result, idempotentReplay: true };
      }
      const data = await snapshot(tx, m);
      const plan = buildPlan(m, data);
      refuse(
        plan.fingerprint === fingerprint,
        "stale plan: database/evidence/context changed; repeat dry-run",
      );
      refuse(plan.conflicts.length === 0, plan.conflicts.join("; "));
      refuse(
        incidentFingerprint(await loadIncidentManifest(manifestPath)) ===
          manifestFingerprint,
        "evidence changed while acquiring locks",
      );
      await assertPeriodOpen(tx, new Date());
      const operator = data.actors.find((u) => u.id === m.originalOperatorId);
      refuse(operator, "original operator missing");
      const actor: Actor = {
        userId: operator.id,
        branchId: m.branchId,
        role: operator.role,
      };
      let bank = data.bank[0];
      if (!bank)
        bank = await createConfirmedExternalPaymentAttemptTx(
          tx,
          {
            branchId: m.branchId,
            channel: m.sourceType === "RECEPTION" ? "PRINT_POS" : "POS",
            method: "CARD",
            amount: INCIDENT.amount,
            reference: INCIDENT.bankReference,
            requestId: INCIDENT.key,
            deviceId: m.deviceId,
          },
          actor,
        );
      let intent = data.intents[0];
      const oldSnapshotFingerprint = intent
        ? incidentFingerprint(intent)
        : null;
      if (!intent) {
        const inserted = await tx.insert(s.digitalSaleIntents).values({
          clientRequestId: INCIDENT.key,
          branchId: m.branchId,
          shiftId: m.postingShiftId,
          createdBy: m.originalOperatorId,
          status: "EXECUTED",
          cartFingerprint: manifestFingerprint,
          paymentMethod: "CARD",
          expectedTotal: INCIDENT.amount,
          externalPaymentAttemptId: bank.id,
          externalPaymentDeviceId: m.deviceId,
          createdAt: new Date(m.executedAt),
          expiresAt: new Date(m.executedAt),
          checkoutSnapshot: {
            version: 1,
            requestFingerprint: manifestFingerprint,
            customerId: m.customerId,
            priceTier: "RETAIL",
            regularLines: [],
            expectedSubtotal: "0.00",
            sourceType: m.sourceType,
            sourcePayload:
              m.sourceType === "RECEPTION"
                ? { version: 1, cashRoundIQD: false }
                : undefined,
          },
        });
        const intentId = extractInsertId(inserted);
        await tx.insert(s.digitalSaleIntentItems).values({
          intentId,
          lineKey: INCIDENT.key,
          offeringId: m.offeringId,
          providerId: m.providerId,
          priceVersionId: m.priceVersionId,
          sellPriceSnapshot: INCIDENT.amount,
          providerShareSnapshot: m.originalProviderShare,
          marginSnapshot: toDbMoney(
            money(INCIDENT.amount).minus(m.originalProviderShare),
          ),
          fulfillmentStatus: "SUCCESS",
          providerReference: INCIDENT.providerReference,
          confirmedBy: m.originalOperatorId,
          confirmedAt: new Date(m.executedAt),
        });
        if (m.walletId != null) {
          const wallet = data.wallets.find((w) => w.id === m.walletId);
          refuse(wallet, "original wallet missing");
          await tx.insert(s.digitalWalletReservations).values({
            walletId: wallet.id,
            intentId,
            amount: m.originalProviderShare,
          });
          await tx
            .update(s.digitalWallets)
            .set({
              reservedBalance: toDbMoney(
                money(wallet.reservedBalance).plus(m.originalProviderShare),
              ),
            })
            .where(eq(s.digitalWallets.id, wallet.id));
        }
        [intent] = await tx
          .select()
          .from(s.digitalSaleIntents)
          .where(eq(s.digitalSaleIntents.id, intentId));
      } else {
        // Scope was proved above. Preserve the existing source and every immutable
        // execution/price timestamp; only this unposted intent's target is changed.
        const checkout = intent.checkoutSnapshot;
        await tx
          .update(s.digitalSaleIntents)
          .set({
            shiftId: m.postingShiftId,
            externalPaymentAttemptId: bank.id,
            externalPaymentDeviceId: m.deviceId,
            ...(m.sourceType === "RECEPTION" && checkout
              ? {
                  checkoutSnapshot: {
                    ...checkout,
                    sourcePayload: { version: 1, cashRoundIQD: false },
                  },
                }
              : {}),
          })
          .where(eq(s.digitalSaleIntents.id, intent.id));
      }
      refuse(intent, "intent adoption failed");
      const [postingIntent] = await tx
        .select()
        .from(s.digitalSaleIntents)
        .where(eq(s.digitalSaleIntents.id, intent.id));
      const result = await finalize(
        tx,
        {
          intentId: intent.id,
          clientRequestId: INCIDENT.key,
          paymentAmount: INCIDENT.amount,
          paymentMethod: "CARD",
          externalPaymentAttemptId: bank.id,
          deviceId: m.deviceId,
          customerId: m.customerId,
        },
        actor,
        authorizer,
      );
      const accepted = await acceptance(tx, intent.id, result.invoiceId, m);
      // Mandatory audit is in the financial transaction; an audit failure rolls back all effects.
      await tx.insert(s.auditLogs).values({
        userId: m.authorityUserId,
        branchId: m.branchId,
        action: AUDIT_ACTION,
        entityType: "digitalIncident",
        entityId: INCIDENT.key,
        oldValue: { originalIntentFingerprint: oldSnapshotFingerprint },
        newValue: {
          manifestFingerprint,
          planFingerprint: fingerprint,
          intentId: intent.id,
          invoiceId: result.invoiceId,
          evidence: m.evidence.map(({ kind, sha256 }) => ({ kind, sha256 })),
          reason: m.reason,
          originalShiftId: m.originalShiftId,
          originalExecutedAt: m.executedAt,
          originalOperatorId: m.originalOperatorId,
          originalProviderShare: m.originalProviderShare,
          fundingMode: m.fundingMode,
          walletId: m.walletId,
          postingShiftId: m.postingShiftId,
          postingDay: data.postingDay,
          sourceType: m.sourceType,
          postingIntentFingerprint: incidentFingerprint(postingIntent),
          bankProofId: bank.id,
          originalBankChargeAttested: true,
          priorProviderIssueAttested: true,
        },
      });
      return { ...accepted, idempotentReplay: false };
    },
    { gate: "GOVERNANCE", bootstrapMissingGate: false },
  );
}
