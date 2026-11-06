import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createSupplier } from "../supplierService";
import { withTx } from "../tx";
import { createConfirmedExternalPaymentAttemptTx } from "../posExternalPayment";
import {
  offeringService,
  pricingService,
  providerService,
  walletService,
} from "../digitalCards";
import {
  INCIDENT,
  assertIncidentTarget,
  incidentFingerprint,
  incidentManifestSchema,
  loadIncidentManifest,
  type IncidentManifest,
} from "../digitalCards/incidentRecoveryContract";
import {
  applyIncidentRecovery,
  planIncidentRecovery,
} from "../digitalCards/incidentRecoveryService";

const admin = { userId: 1, branchId: 1, role: "admin" };
const roots: string[] = [];
let manifestPath: string,
  manifest: IncidentManifest,
  intentId: number,
  walletId: number;
function db() {
  const d = getDb();
  if (!d) throw new Error("isolated DB unavailable");
  return d;
}
async function save() {
  await writeFile(manifestPath, JSON.stringify(manifest));
}

async function seed(
  mode: "PREPAID" | "POSTPAID" = "POSTPAID",
  existing = true,
  source: "POS" | "RECEPTION" = "POS",
) {
  const executed = new Date(
    Math.floor((Date.now() - 2 * 86400000) / 1000) * 1000,
  );
  await db()
    .insert(s.branches)
    .values({ id: 1, name: "Incident test", code: "INCIDENT", type: "MAIN" });
  await db()
    .insert(s.users)
    .values([
      {
        id: 1,
        openId: "incident-admin",
        role: "admin",
        branchId: 1,
        isOwner: true,
      },
      { id: 2, openId: "incident-operator", role: "cashier", branchId: 1 },
    ]);
  await db()
    .insert(s.shifts)
    .values([
      {
        id: 1,
        branchId: 1,
        userId: 2,
        status: "CLOSED",
        shiftType: source === "RECEPTION" ? "RECEPTION" : "RETAIL",
        openingBalance: "0",
        openedAt: new Date(executed.getTime() - 3600000),
        closedAt: new Date(executed.getTime() + 3600000),
      },
      {
        id: 2,
        branchId: 1,
        userId: 2,
        status: "OPEN",
        shiftType: source === "RECEPTION" ? "RECEPTION" : "RETAIL",
        openingBalance: "0",
      },
    ]);
  const { supplierId } = await createSupplier(
    { name: "Incident provider" },
    admin,
  );
  const { providerId } = await withTx((tx) =>
    providerService.createProvider(
      tx,
      {
        supplierId,
        providerType: "OTHER",
        settlementMode: mode,
        recognitionMode: "PRINCIPAL_GROSS",
        referencePolicy: "REQUIRED",
        settlementCycle: "ON_DEMAND",
      },
      admin,
    ),
  );
  walletId =
    mode === "PREPAID"
      ? (
          await withTx((tx) =>
            walletService.createWallet(
              tx,
              { providerId, branchId: 1, code: "I1", name: "Incident wallet" },
              admin,
            ),
          )
        ).walletId
      : 0;
  if (walletId) {
    await db()
      .insert(s.digitalWalletTransactions)
      .values({
        walletId,
        branchId: 1,
        type: "OPENING",
        amount: "1000000",
        direction: "IN",
        balanceAfter: "1000000",
        transactionNumber: "INCIDENT-OPENING",
        createdBy: 1,
        createdAt: new Date(executed.getTime() - 7200000),
      });
    await db()
      .update(s.digitalWallets)
      .set({
        currentBalance: "1000000",
        reservedBalance: existing ? "240000" : "0",
      })
      .where(eq(s.digitalWallets.id, walletId));
  }
  const { offeringId } = await withTx((tx) =>
    offeringService.createOffering(
      tx,
      {
        providerId,
        offeringType: "GLOBAL_CARD",
        name: "Issued card",
        requiresStudentData: false,
        pricingMode: "FIXED_MARGIN",
        fixedMargin: "10000",
        roundingStep: "0",
        branches: [{ branchId: 1, walletId: walletId || null }],
      },
      admin,
    ),
  );
  const { batchId } = await withTx((tx) =>
    pricingService.createOrGetDraft(
      tx,
      {
        branchId: 1,
        providerId,
        businessDate: executed.toISOString().slice(0, 10),
      },
      admin,
    ),
  );
  await withTx((tx) =>
    pricingService.saveDraft(
      tx,
      { batchId, lines: [{ offeringId, providerShare: "240000" }] },
      admin,
    ),
  );
  await withTx((tx) => pricingService.publish(tx, { batchId }, admin));
  const [price] = await db()
    .select()
    .from(s.digitalPriceVersions)
    .where(eq(s.digitalPriceVersions.offeringId, offeringId));
  await db()
    .update(s.digitalPriceVersions)
    .set({ validFrom: new Date(executed.getTime() - 3600000) })
    .where(eq(s.digitalPriceVersions.id, price.id));
  if (existing) {
    const result = await db()
      .insert(s.digitalSaleIntents)
      .values({
        clientRequestId: "original-incident",
        branchId: 1,
        shiftId: 1,
        createdBy: 2,
        status: "EXECUTED",
        cartFingerprint: "original",
        paymentMethod: "CARD",
        expectedTotal: INCIDENT.amount,
        createdAt: executed,
        expiresAt: executed,
        checkoutSnapshot: {
          version: 1,
          requestFingerprint: "original",
          customerId: null,
          priceTier: "RETAIL",
          regularLines: [],
          expectedSubtotal: "0.00",
          sourceType: source,
          sourcePayload: source === "RECEPTION" ? { legacy: true } : undefined,
        },
      });
    intentId = Number(result[0].insertId);
    await db().insert(s.digitalSaleIntentItems).values({
      intentId,
      lineKey: "card",
      offeringId,
      providerId,
      priceVersionId: price.id,
      sellPriceSnapshot: INCIDENT.amount,
      providerShareSnapshot: "240000.00",
      marginSnapshot: "10000.00",
      fulfillmentStatus: "SUCCESS",
      providerReference: INCIDENT.providerReference,
      confirmedBy: 2,
      confirmedAt: executed,
    });
    if (walletId)
      await db()
        .insert(s.digitalWalletReservations)
        .values({ walletId, intentId, amount: "240000" });
  }
  await db()
    .insert(s.financialPeriods)
    .values({ cutoffDate: executed.toISOString().slice(0, 10), lockedBy: 1 });
  const [identity] = await db()
    .select({
      name: sql<string>`DATABASE()`,
      serverUuid: sql<string>`@@server_uuid`,
    })
    .from(s.branches)
    .limit(1);
  const root = await mkdtemp(path.join(os.tmpdir(), "digital-incident-test-"));
  roots.push(root);
  const evidence: IncidentManifest["evidence"] = [];
  for (const kind of [
    "BANK",
    "PROVIDER_ISSUE",
    "ORIGINAL_PRICE",
    "ORIGINAL_FUNDING",
    "SETTLEMENT_REVIEW",
  ] as const) {
    const content = `Attested fixture ${kind}: ${INCIDENT.bankReference}/${INCIDENT.providerReference}`;
    const name = `${kind}.txt`;
    await writeFile(path.join(root, name), content);
    evidence.push({
      kind,
      path: name,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  manifest = incidentManifestSchema.parse({
    version: 1,
    incident: INCIDENT.key,
    amount: INCIDENT.amount,
    bankReference: INCIDENT.bankReference,
    providerReference: INCIDENT.providerReference,
    paymentMethod: "CARD",
    database: identity,
    authorityUserId: 1,
    branchId: 1,
    offeringId,
    providerId,
    priceVersionId: price.id,
    originalProviderShare: "240000.00",
    fundingMode: mode,
    walletId: walletId || null,
    originalOperatorId: 2,
    customerId: null,
    originalShiftId: 1,
    postingShiftId: 2,
    sourceType: source,
    executedAt: executed.toISOString(),
    deviceId: "incident-terminal",
    reason:
      "Original charged and issued sale had no invoice; owner reviewed every source.",
    priorProviderSettlement: "NOT_RECORDED",
    attestedEarlierBankCharge: true,
    attestedEarlierProviderIssue: true,
    evidence,
  });
  manifestPath = path.join(root, "manifest.json");
  await save();
}

beforeEach(() => {
  intentId = 0;
  walletId = 0;
});
afterAll(async () => {
  for (const root of roots) {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith("digital-incident-test-")
    )
      throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

describe("strict incident recovery", () => {
  it("keeps leading-zero references and rejects configurable incident/evidence gaps", () => {
    expect(INCIDENT.providerReference).toBe("001172");
    expect(incidentFingerprint({ b: 2, a: 1 })).toBe(
      incidentFingerprint({ a: 1, b: 2 }),
    );
    expect(() =>
      incidentManifestSchema.parse({ providerReference: 1172 }),
    ).toThrow();
    const testPortOptIn = process.env.ALLOW_TEST_DB_PORT_3306;
    try {
      delete process.env.ALLOW_TEST_DB_PORT_3306;
      expect(() =>
        assertIncidentTarget("mysql://x@127.0.0.1:3306/erp_test", true, true),
      ).toThrow(/Forbidden/);
    } finally {
      if (testPortOptIn == null) delete process.env.ALLOW_TEST_DB_PORT_3306;
      else process.env.ALLOW_TEST_DB_PORT_3306 = testPortOptIn;
    }
    expect(() =>
      assertIncidentTarget("mysql://x@127.0.0.1:3310/erp_test", false, false),
    ).toThrow();
    expect(() =>
      assertIncidentTarget("mysql://x@remote:3311/erp_test", false, false),
    ).toThrow(/Unsafe/);
    for (const suffix of ["?socketPath=%2Fvar%2Frun%2Fmysqld.sock", "?host=remote", "#other-target"]) {
      for (const production of [false, true]) {
        expect(() => assertIncidentTarget(`mysql://x@127.0.0.1:3311/erp_test${suffix}`, false, production)).toThrow(/Unsafe/);
      }
    }
    expect(() =>
      assertIncidentTarget(
        "mysql://x@production-db:3306/erp_production",
        false,
        false,
      ),
    ).toThrow(/Unsafe/);
    expect(() =>
      assertIncidentTarget(
        "mysql://x@production-db:3306/erp_production",
        true,
        true,
      ),
    ).not.toThrow();
  });
  it("dry-run is stable and read-only, exposing only safe plan fields", async () => {
    await seed();
    const plan = await planIncidentRecovery(manifestPath);
    expect(plan.conflicts).toEqual([]);
    expect((await planIncidentRecovery(manifestPath)).fingerprint).toBe(
      plan.fingerprint,
    );
    expect(plan.matches.intentIds).toEqual([intentId]);
    expect(JSON.stringify(plan)).not.toMatch(
      /password|studentPhone|studentAddress|contactPhone/,
    );
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(0);
  });
  it.each(["POSTPAID", "PREPAID"] as const)(
    "recovers %s once in the open period and preserves the closed shift",
    async (mode) => {
      await seed(mode);
      const [originalShift] = await db()
        .select()
        .from(s.shifts)
        .where(eq(s.shifts.id, 1));
      const [originalIntent] = await db()
        .select()
        .from(s.digitalSaleIntents)
        .where(eq(s.digitalSaleIntents.id, intentId));
      const plan = await planIncidentRecovery(manifestPath);
      expect(plan.conflicts).toEqual([]);
      const result = await applyIncidentRecovery(
        manifestPath,
        plan.fingerprint,
      );
      expect(result.idempotentReplay).toBe(false);
      const replay = await applyIncidentRecovery(
        manifestPath,
        plan.fingerprint,
      );
      expect(replay).toEqual({ ...result, idempotentReplay: true });
      expect(await db().select().from(s.invoices)).toHaveLength(1);
      expect(await db().select().from(s.receipts)).toHaveLength(1);
      const [detail] = await db().select().from(s.digitalSaleDetails);
      expect(detail.providerReference).toBe("001172");
      expect(detail.settlementModeSnapshot).toBe(mode);
      const [closedShift] = await db()
        .select()
        .from(s.shifts)
        .where(eq(s.shifts.id, 1));
      expect(closedShift).toEqual(originalShift);
      const [recovered] = await db()
        .select()
        .from(s.digitalSaleIntents)
        .where(eq(s.digitalSaleIntents.id, intentId));
      expect(recovered.createdAt).toEqual(originalIntent.createdAt);
      expect(recovered.shiftId).toBe(2);
      const [invoice] = await db().select().from(s.invoices);
      expect(invoice.createdBy).toBe(2);
      if (walletId) {
        const [wallet] = await db()
          .select()
          .from(s.digitalWallets)
          .where(eq(s.digitalWallets.id, walletId));
        expect(wallet.currentBalance).toBe("760000.00");
        expect(wallet.reservedBalance).toBe("0.00");
      }
    },
  );
  it("serializes concurrent retries into one invoice, collection and provider settlement", async () => {
    await seed();
    const plan = await planIncidentRecovery(manifestPath);
    const results = await Promise.all([
      applyIncidentRecovery(manifestPath, plan.fingerprint),
      applyIncidentRecovery(manifestPath, plan.fingerprint),
    ]);
    expect(results[0].invoiceId).toBe(results[1].invoiceId);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
  });
  it("reuses the exact recorded bank capture and verifies its binding on replay", async () => {
    await seed();
    const proof = await withTx((tx) =>
      createConfirmedExternalPaymentAttemptTx(
        tx,
        {
          branchId: 1,
          channel: "POS",
          method: "CARD",
          amount: INCIDENT.amount,
          reference: INCIDENT.bankReference,
          requestId: "prior-charge",
          deviceId: manifest.deviceId,
        },
        { userId: 2, branchId: 1, role: "cashier" },
      ),
    );
    await db()
      .update(s.digitalSaleIntents)
      .set({
        externalPaymentAttemptId: proof.id,
        externalPaymentDeviceId: manifest.deviceId,
      })
      .where(eq(s.digitalSaleIntents.id, intentId));
    const plan = await planIncidentRecovery(manifestPath);
    expect(plan.conflicts).toEqual([]);
    const result = await applyIncidentRecovery(manifestPath, plan.fingerprint);
    expect(
      (await db().select().from(s.externalPaymentAttempts)).map((p) => p.id),
    ).toEqual([proof.id]);
    expect(
      (await applyIncidentRecovery(manifestPath, plan.fingerprint)).invoiceId,
    ).toBe(result.invoiceId);
    await db()
      .update(s.externalPaymentAttempts)
      .set({ deviceId: "changed-device" })
      .where(eq(s.externalPaymentAttempts.id, proof.id));
    await expect(
      applyIncidentRecovery(manifestPath, plan.fingerprint),
    ).rejects.toThrow();
    expect(await db().select().from(s.invoices)).toHaveLength(1);
  });
  it.each([false, true])(
    "refuses adoption beside an unresolved legacy intent even with a valid unbound bank proof (exact intent also present: %s)",
    async (withExactIntent) => {
      await seed("POSTPAID", true, "RECEPTION");
      await db()
        .update(s.digitalSaleIntentItems)
        .set({ providerReference: null })
        .where(eq(s.digitalSaleIntentItems.intentId, intentId));
      const proof = await withTx((tx) =>
        createConfirmedExternalPaymentAttemptTx(
          tx,
          {
            branchId: 1,
            channel: "PRINT_POS",
            method: "CARD",
            amount: INCIDENT.amount,
            reference: INCIDENT.bankReference,
            requestId: "unbound-prior-charge",
            deviceId: manifest.deviceId,
          },
          { userId: 2, branchId: 1, role: "cashier" },
        ),
      );
      if (withExactIntent) {
        const [original] = await db().select().from(s.digitalSaleIntents);
        const [item] = await db().select().from(s.digitalSaleIntentItems);
        const duplicate = await db()
          .insert(s.digitalSaleIntents)
          .values({
            ...original,
            id: undefined,
            clientRequestId: "exact-incident-source",
          });
        await db()
          .insert(s.digitalSaleIntentItems)
          .values({
            ...item,
            id: undefined,
            refKey: undefined,
            intentId: Number(duplicate[0].insertId),
            providerReference: INCIDENT.providerReference,
          });
      }
      const originals = await db().select().from(s.digitalSaleIntents);
      const plan = await planIncidentRecovery(manifestPath);
      expect(plan.matches.bankAttemptIds).toEqual([proof.id]);
      expect(plan.matches.intentIds).toEqual(
        originals.map((intent) => intent.id),
      );
      expect(plan.conflicts).toContain(
        "Unresolved contextual intent may be the original incident",
      );
      await expect(
        applyIncidentRecovery(manifestPath, plan.fingerprint),
      ).rejects.toThrow(/Unresolved contextual intent/);
      expect(await db().select().from(s.digitalSaleIntents)).toEqual(originals);
      expect(await db().select().from(s.invoices)).toHaveLength(0);
      expect(await db().select().from(s.receipts)).toHaveLength(0);
      expect(await db().select().from(s.digitalSaleDetails)).toHaveLength(0);
      expect(await db().select().from(s.externalPaymentAttempts)).toEqual([
        proof,
      ]);
    },
  );
  it("distinguishes a contextual sale with a known different provider reference from the exact incident", async () => {
    await seed("POSTPAID", true, "RECEPTION");
    const [original] = await db().select().from(s.digitalSaleIntents);
    const [item] = await db().select().from(s.digitalSaleIntentItems);
    const other = await db()
      .insert(s.digitalSaleIntents)
      .values({
        ...original,
        id: undefined,
        clientRequestId: "different-issued-sale",
      });
    const otherId = Number(other[0].insertId);
    await db()
      .insert(s.digitalSaleIntentItems)
      .values({
        ...item,
        id: undefined,
        refKey: undefined,
        intentId: otherId,
        providerReference: "different-provider-reference",
      });
    const plan = await planIncidentRecovery(manifestPath);
    expect(plan.matches.intentIds).toEqual([intentId]);
    expect(plan.conflicts).toEqual([]);
    await applyIncidentRecovery(manifestPath, plan.fingerprint);
    const [unchanged] = await db()
      .select()
      .from(s.digitalSaleIntents)
      .where(eq(s.digitalSaleIntents.id, otherId));
    expect(unchanged).toEqual({
      ...original,
      id: otherId,
      clientRequestId: "different-issued-sale",
    });
    expect(await db().select().from(s.invoices)).toHaveLength(1);
  });
  it.each(["price", "balance", "shift", "period", "authority"])(
    "rejects a stale %s fingerprint atomically",
    async (kind) => {
      await seed("PREPAID");
      const plan = await planIncidentRecovery(manifestPath);
      if (kind === "price")
        await db()
          .update(s.digitalPriceVersions)
          .set({ providerShare: "239999" })
          .where(eq(s.digitalPriceVersions.id, manifest.priceVersionId));
      if (kind === "balance")
        await db()
          .update(s.digitalWallets)
          .set({ currentBalance: "999999" })
          .where(eq(s.digitalWallets.id, walletId));
      if (kind === "shift")
        await db()
          .update(s.shifts)
          .set({ status: "CLOSED" })
          .where(eq(s.shifts.id, 2));
      if (kind === "period")
        await db()
          .insert(s.financialPeriods)
          .values({
            cutoffDate: new Date().toISOString().slice(0, 10),
            lockedBy: 1,
          });
      if (kind === "authority")
        await db()
          .update(s.users)
          .set({ isActive: false })
          .where(eq(s.users.id, 1));
      await expect(
        applyIncidentRecovery(manifestPath, plan.fingerprint),
      ).rejects.toThrow(/stale|authority/);
      expect(await db().select().from(s.invoices)).toHaveLength(0);
      expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(
        0,
      );
    },
  );
  it("rejects changed or missing evidence and absent original share", async () => {
    await seed();
    const plan = await planIncidentRecovery(manifestPath);
    await writeFile(
      path.join(path.dirname(manifestPath), manifest.evidence[0].path),
      "changed",
    );
    await expect(
      applyIncidentRecovery(manifestPath, plan.fingerprint),
    ).rejects.toThrow(/SHA256/);
    const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(() =>
      incidentManifestSchema.parse({
        ...Object(value),
        originalProviderShare: undefined,
      }),
    ).toThrow();
  });
  it("rejects a conflicting bank proof, duplicate source and prior provider adjustment", async () => {
    await seed();
    await db().insert(s.externalPaymentAttempts).values({
      branchId: 1,
      channel: "PRINT_POS",
      paymentMethod: "CARD",
      amount: INCIDENT.amount,
      providerCode: "POS_TERMINAL",
      accountReference: "CARD_BANK",
      externalReference: INCIDENT.bankReference,
      normalizedReference: INCIDENT.bankReference,
      requestId: "other",
      deviceId: "other",
      state: "CONFIRMED",
      createdBy: 2,
      confirmedBy: 2,
      confirmedAt: new Date(),
    });
    expect((await planIncidentRecovery(manifestPath)).conflicts).toContain(
      "Existing bank proof has conflicting source/device/actor/state",
    );
    await db().insert(s.digitalSaleIntents).values({
      clientRequestId: INCIDENT.key,
      branchId: 1,
      shiftId: 1,
      createdBy: 2,
      cartFingerprint: "other",
      paymentMethod: "CARD",
      expectedTotal: INCIDENT.amount,
      expiresAt: new Date(),
    });
    expect((await planIncidentRecovery(manifestPath)).conflicts).toContain(
      "Ambiguous or duplicate source matches",
    );
    await db()
      .insert(s.accountingEntries)
      .values({
        entryType: "ADJUST",
        branchId: 1,
        supplierId: (await db().select().from(s.digitalProviders))[0]
          .supplierId,
        amount: "240000",
        entryDate: new Date(),
        createdBy: 1,
      });
    expect((await planIncidentRecovery(manifestPath)).conflicts).toContain(
      "Prior provider settlement/adjustment is ambiguous",
    );
  });
  it("refuses a reconciliation that might already include the provider issue", async () => {
    await seed("PREPAID");
    await db()
      .insert(s.digitalWalletReconciliations)
      .values({
        walletId,
        branchId: 1,
        businessDate: new Date().toISOString().slice(0, 10),
        expectedBalance: "1000000",
        actualBalance: "1000000",
        variance: "0",
        countedBy: 1,
      });
    expect((await planIncidentRecovery(manifestPath)).conflicts).toContain(
      "Provider wallet reconciliation after issuance makes prior settlement ambiguous",
    );
  });
  it("rolls all financial/proof/retargeting writes back if the mandatory audit fails", async () => {
    await seed("PREPAID");
    const plan = await planIncidentRecovery(manifestPath);
    await db().execute(
      sql`CREATE TRIGGER incident_audit_failure BEFORE INSERT ON auditLogs FOR EACH ROW BEGIN IF NEW.action = 'DIGITAL_INCIDENT_RECOVERED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'incident audit failure'; END IF; END`,
    );
    try {
      await expect(
        applyIncidentRecovery(manifestPath, plan.fingerprint),
      ).rejects.toThrow();
    } finally {
      await db().execute(sql`DROP TRIGGER incident_audit_failure`);
    }
    expect(await db().select().from(s.invoices)).toHaveLength(0);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.digitalSaleDetails)).toHaveLength(0);
    expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(0);
    const [intent] = await db()
      .select()
      .from(s.digitalSaleIntents)
      .where(eq(s.digitalSaleIntents.id, intentId));
    expect(intent.shiftId).toBe(1);
    const [wallet] = await db()
      .select()
      .from(s.digitalWallets)
      .where(eq(s.digitalWallets.id, walletId));
    expect(wallet.currentBalance).toBe("1000000.00");
    expect(wallet.reservedBalance).toBe("240000.00");
  });
  it("attests a prior Reception issue once on the open shift without another charge or issue", async () => {
    await seed("PREPAID", false, "RECEPTION");
    const plan = await planIncidentRecovery(manifestPath);
    expect(plan.action).toBe("ATTEST_PRIOR_ISSUE");
    expect(plan.conflicts).toEqual([]);
    const [result, replay] = await Promise.all(
      [1, 2].map(() => applyIncidentRecovery(manifestPath, plan.fingerprint)),
    );
    expect(result.invoiceId).toBe(replay.invoiceId);
    expect(await db().select().from(s.digitalSaleIntents)).toHaveLength(1);
    expect(await db().select().from(s.externalPaymentAttempts)).toHaveLength(1);
    expect(await db().select().from(s.invoices)).toHaveLength(1);
    expect(await db().select().from(s.receipts)).toHaveLength(1);
    const [proof] = await db().select().from(s.externalPaymentAttempts);
    expect(proof).toMatchObject({
      channel: "PRINT_POS",
      amount: "250000.00",
      externalReference: "10324087",
      state: "CONFIRMED",
    });
    const [detail] = await db().select().from(s.digitalSaleDetails);
    expect(detail).toMatchObject({
      providerReference: "001172",
      settlementModeSnapshot: "PREPAID",
      sellPriceSnapshot: "250000.00",
      providerShareSnapshot: "240000.00",
    });
    const [wallet] = await db()
      .select()
      .from(s.digitalWallets)
      .where(eq(s.digitalWallets.id, walletId));
    expect(wallet.reservedBalance).toBe("0.00");
    expect(wallet.currentBalance).toBe("760000.00");
    const [invoice] = await db().select().from(s.invoices);
    expect(invoice).toMatchObject({
      shiftId: 2,
      paymentMethod: "CARD",
      total: "250000.00",
    });
    const [closedShift] = await db()
      .select()
      .from(s.shifts)
      .where(eq(s.shifts.id, 1));
    expect(closedShift.status).toBe("CLOSED");
  });

  it.each([
    {
      label: "trimmed contacts",
      contactFields: {
        contactName: "  Original customer  ",
        contactPhone: "  07701234567  ",
      },
      expectedFields: {
        contactName: "Original customer",
        contactPhone: "07701234567",
      },
      invoiceFields: {
        contactName: "Original customer",
        contactPhone: "07701234567",
      },
    },
    {
      label: "null contacts",
      contactFields: { contactName: null, contactPhone: null },
      expectedFields: { contactName: null, contactPhone: null },
      invoiceFields: { contactName: null, contactPhone: null },
    },
    {
      label: "maximum valid contacts",
      contactFields: {
        contactName: "n".repeat(200),
        contactPhone: "1".repeat(25),
      },
      expectedFields: {
        contactName: "n".repeat(200),
        contactPhone: "1".repeat(25),
      },
      invoiceFields: {
        contactName: "n".repeat(200),
        contactPhone: "1".repeat(25),
      },
    },
    {
      label: "invalid name and valid phone",
      contactFields: {
        contactName: "n".repeat(201),
        contactPhone: "07701234567",
      },
      expectedFields: { contactPhone: "07701234567" },
      invoiceFields: { contactName: null, contactPhone: "07701234567" },
    },
    {
      label: "valid name and invalid phone",
      contactFields: {
        contactName: "Original customer",
        contactPhone: "1".repeat(26),
      },
      expectedFields: { contactName: "Original customer" },
      invoiceFields: { contactName: "Original customer", contactPhone: null },
    },
    {
      label: "untyped contacts",
      contactFields: {
        contactName: { password: "untrusted" },
        contactPhone: 123,
      },
      expectedFields: {},
      invoiceFields: { contactName: null, contactPhone: null },
    },
  ])(
    "normalizes only validated $label on the matched legacy Reception intent, preserving original evidence",
    async ({ contactFields, expectedFields, invoiceFields }) => {
      await seed("POSTPAID", true, "RECEPTION");
      const [seeded] = await db().select().from(s.digitalSaleIntents);
      if (!seeded.checkoutSnapshot) throw new Error("Missing fixture checkout");
      await db()
        .update(s.digitalSaleIntents)
        .set({
          checkoutSnapshot: {
            ...seeded.checkoutSnapshot,
            sourcePayload: {
              legacy: true,
              password: "untrusted",
              ...contactFields,
            },
          },
        })
        .where(eq(s.digitalSaleIntents.id, intentId));
      const [original] = await db().select().from(s.digitalSaleIntents);
      const [issued] = await db().select().from(s.digitalSaleIntentItems);
      const plan = await planIncidentRecovery(manifestPath);
      expect(plan.conflicts).toEqual([]);
      const result = await applyIncidentRecovery(
        manifestPath,
        plan.fingerprint,
      );
      expect(
        await applyIncidentRecovery(manifestPath, plan.fingerprint),
      ).toMatchObject({ invoiceId: result.invoiceId, idempotentReplay: true });
      const [intent] = await db().select().from(s.digitalSaleIntents);
      expect(intent.createdAt).toEqual(original.createdAt);
      expect(intent.checkoutSnapshot?.sourcePayload).toEqual({
        version: 1,
        cashRoundIQD: false,
        ...expectedFields,
      });
      expect((await db().select().from(s.digitalSaleIntentItems))[0]).toEqual(
        issued,
      );
      const [invoice] = await db().select().from(s.invoices);
      expect(invoice).toMatchObject(invoiceFields);
      expect((await db().select().from(s.digitalSaleDetails))[0]).toMatchObject(
        {
          providerReference: "001172",
          settlementModeSnapshot: "POSTPAID",
          providerShareSnapshot: "240000.00",
        },
      );
      const audit = (await db().select().from(s.auditLogs)).find(
        (row) => row.action === "DIGITAL_INCIDENT_RECOVERED",
      );
      expect(audit).toBeDefined();
      expect(await db().select().from(s.invoices)).toHaveLength(1);
      expect(await db().select().from(s.receipts)).toHaveLength(1);
    },
  );
});
