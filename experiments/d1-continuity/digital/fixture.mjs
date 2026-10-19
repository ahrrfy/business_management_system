import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sqlStatements } from "../cash/sql-statements.mjs";
import { oracleDatabase, parentLab } from "./mysql-lab.mjs";
import * as s from "../../../drizzle/schema.ts";
import { eq } from "drizzle-orm";
import { withTx } from "../../../server/services/tx.ts";
import { createSupplier } from "../../../server/services/supplierService.ts";
import {
  providerService,
  walletService,
  offeringService,
  pricingService,
} from "../../../server/services/digitalCards/index.ts";
import { CHART_ACCOUNTS } from "../../../server/services/accounting/chartSeed.ts";
import { POSTING_POLICY_HASH } from "../../../server/services/accounting/postingEngine.ts";
import {
  seedIraqiUnifiedProfile,
  approveStatutoryProfile,
} from "../../../server/services/accounting/statutoryAccounting.ts";
export const cashier = { userId: 1, branchId: 1, role: "cashier" };
export const manager = { userId: 2, branchId: 1, role: "manager" };
export const secondCashier = { userId: 3, branchId: 1, role: "cashier" };
export const foreignCashier = { userId: 4, branchId: 2, role: "cashier" };
export const syntheticBadge = "Q2-SYNTHETIC-APPROVER";
export const CLOCK = "2026-10-19T12:00:00.000Z";
export const fixturePath =
  parentLab +
  "/experiments/d1-continuity/returns/build/discovery-file/fixture.sql";
export async function foundation(db, c, mode) {
  const [[scope]] = await c.query(
    "SELECT DATABASE() db,@@port port,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),NOW()) utcOffset",
  );
  assert.deepEqual(scope, { db: oracleDatabase, port: 13326, utcOffset: 0 });
  const names = (
    await c.query("SHOW FULL TABLES WHERE Table_type='BASE TABLE'")
  )[0].map((r) => Object.values(r)[0]);
  await c.query("SET FOREIGN_KEY_CHECKS=0");
  try {
    for (const name of names) {
      assert.match(name, /^\w+$/);
      await c.query("TRUNCATE TABLE `" + name + "`");
    }
  } finally {
    await c.query("SET FOREIGN_KEY_CHECKS=1");
  }
  const fixture = await readFile(fixturePath, "utf8");
  for (const q of sqlStatements(fixture).filter(
    (q) => !/^UPDATE cashEpoch|^UPDATE customers SET searchNorm/i.test(q),
  ))
    await c.query(q);
  await db.insert(s.branches).values({
    id: 2,
    name: "Synthetic foreign branch",
    code: "Q2-OTHER",
    type: "SALES",
  });
  await db.insert(s.users).values([
    {
      id: 2,
      openId: "q2-manager",
      name: "Synthetic manager",
      role: "manager",
      branchId: 1,
      loginMethod: "local",
      badgeBarcode: syntheticBadge,
    },
    {
      id: 3,
      openId: "q2-cashier2",
      name: "Synthetic other cashier",
      role: "cashier",
      branchId: 1,
      loginMethod: "local",
    },
    {
      id: 4,
      openId: "q2-foreign",
      name: "Synthetic foreign cashier",
      role: "cashier",
      branchId: 2,
      loginMethod: "local",
    },
  ]);
  await db.insert(s.accounts).values(CHART_ACCOUNTS);
  await withTx(async (tx) => {
    const profile = await seedIraqiUnifiedProfile(tx, 2);
    await approveStatutoryProfile(
      tx,
      {
        profileId: profile.profileId,
        accountantName: "Synthetic Q2 accountant",
        approvalReference: "Q2-SYNTHETIC-ONLY",
      },
      2,
    );
  });
  const opening = "b".repeat(64),
    cycle = "q2-digital-synthetic-cycle";
  await db
    .update(s.doubleEntrySettings)
    .set({
      mode,
      shadowCycleId: cycle,
      shadowOpeningHash: opening,
      policyApprovalReference: "Q2-SYNTHETIC-POLICY",
      policyApprovalPolicyHash: POSTING_POLICY_HASH,
      policyApprovalCycleId: cycle,
      policyApprovalOpeningHash: opening,
      policyAccountantName: "Synthetic Q2 accountant",
      policyApprovedAt: new Date(CLOCK),
      policyApprovedBy: 2,
    })
    .where(eq(s.doubleEntrySettings.id, 1));
  return { mode, fixture, clock: CLOCK };
}
export async function provider(
  db,
  {
    name,
    mode = "PREPAID",
    balance = "100000.00",
    educational = false,
    share = "13400.37",
    margin = "850.13",
  },
) {
  const { supplierId } = await createSupplier(
    { name: "Synthetic " + name },
    cashier,
  );
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId,
        providerType: "TELECOM",
        settlementMode: mode,
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "OPTIONAL",
        settlementCycle: "ON_DEMAND",
      },
      cashier,
    ),
  );
  let walletId = null;
  if (mode === "PREPAID") {
    ({ walletId } = await withTx((tx) =>
      walletService.createWallet(
        tx,
        {
          providerId,
          branchId: 1,
          code: "Q2-W-" + providerId,
          name: "Synthetic wallet " + providerId,
        },
        cashier,
      ),
    ));
    // Opening fixture balance, not a fabricated payment or production top-up.
    await db
      .update(s.digitalWallets)
      .set({ currentBalance: balance })
      .where(eq(s.digitalWallets.id, walletId));
  }
  const { offeringId } = await withTx((tx) =>
    offeringService.createOffering(
      tx,
      {
        providerId,
        offeringType: educational ? "EDUCATIONAL_SUBSCRIPTION" : "TELECOM_CARD",
        name: "Synthetic " + name,
        requiresStudentData: educational,
        subscriptionDurationDays: educational ? 30 : null,
        pricingMode: "FIXED_MARGIN",
        fixedMargin: margin,
        roundingStep: "0",
        branches: [{ branchId: 1, walletId }],
      },
      cashier,
    ),
  );
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(
      tx,
      { branchId: 1, providerId, businessDate: CLOCK.slice(0, 10) },
      cashier,
    ),
  );
  await withTx((tx) =>
    pricingService.saveDraft(
      tx,
      { batchId, lines: [{ offeringId, providerShare: share }] },
      cashier,
    ),
  );
  await withTx((tx) => pricingService.publish(tx, { batchId }, cashier));
  const [current] = await db
    .select()
    .from(s.digitalCurrentPrices)
    .where(eq(s.digitalCurrentPrices.offeringId, offeringId));
  const [price] = await db
    .select()
    .from(s.digitalPriceVersions)
    .where(eq(s.digitalPriceVersions.id, current.priceVersionId));
  const [offering] = await db
    .select()
    .from(s.digitalOfferings)
    .where(eq(s.digitalOfferings.id, offeringId));
  return {
    supplierId,
    providerId,
    walletId,
    offeringId,
    priceVersionId: Number(current.priceVersionId),
    price: price.sellPrice,
    share,
    offering,
  };
}
export function digitalLine(p, key, extra = {}) {
  return {
    lineKey: key,
    offeringId: p.offeringId,
    priceVersionId: p.priceVersionId,
    expectedSellPrice: p.price,
    providerReference: "Q2-REF-" + key,
    ...extra,
  };
}
export function input(key, lines, extra = {}) {
  return {
    clientRequestId: "q2-" + key,
    branchId: 1,
    shiftId: 1,
    paymentMethod: "CASH",
    cartFingerprint: "q2-fp-" + key,
    lines,
    ...extra,
  };
}
export function invoiceInput(
  key,
  providers,
  { approved = false, customerId = 1, ...extra } = {},
) {
  const lines = providers.map((p, i) => digitalLine(p, key + "-" + i));
  return input(key, lines, {
    sourceType: "INVOICE",
    paymentMethod: "CREDIT",
    customerId,
    priceTier: "RETAIL",
    sourcePayload: {
      branchId: 1,
      shiftId: 1,
      customerId,
      priceTier: "RETAIL",
      clientRequestId: "q2-" + key,
      lines: providers.map((p, i) => ({
        variantId: Number(p.offering.variantId),
        productUnitId: Number(p.offering.productUnitId),
        quantity: "1",
        unitPriceOverride: p.price,
        internalLineToken: lines[i].lineKey,
      })),
    },
    ...(approved
      ? { managerApproval: { method: "BARCODE", barcode: syntheticBadge } }
      : {}),
    ...extra,
  });
}
