import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Decimal from "decimal.js";
import { hashPostingIntent } from "../../../server/services/accounting/postingEngine.ts";
import { validateProviderEvidence } from "./provider-evidence.mjs";
export { validateProviderEvidence } from "./provider-evidence.mjs";
const d = (x) => new Decimal(x),
  sum = (rows, key) => rows.reduce((n, r) => n.plus(r[key]), d(0)).toFixed(2);
export function assertRefusalUnchanged(command) {
  if (command.op === "VERIFIED_PREPARE") {
    // Original verifier and RPC middleware each persist one SOD failure audit.
    const before = command.before.auditLogs,
      after = command.after.auditLogs;
    assert.equal(
      new Set(after.map((a) => a.id)).size,
      after.length,
      "Duplicate audit identity",
    );
    assert.deepEqual(
      after.slice(0, before.length),
      before,
      "Prior audit graph/order must remain exact",
    );
    for (const row of before)
      assert.deepEqual(
        after.find((a) => a.id === row.id),
        row,
        "Prior audit row deleted/modified",
      );
    const added = command.after.auditLogs.filter(
      (a) => !command.before.auditLogs.some((b) => b.id === a.id),
    );
    assert.equal(added.length, 2, "Expected exact SOD and RPC audit additions");
    assert.equal(command.error?.code, "FORBIDDEN");
    const approval = command.input.managerApproval;
    assert.equal(approval.method, "BARCODE");
    const approver = command.before.users.find(
      (u) => u.badgeBarcode === approval.barcode,
    );
    assert.ok(approver);
    assert.equal(
      approver.id,
      command.actor.userId,
      "Must be actual self-approval refusal",
    );
    const common = {
      userId: command.actor.userId,
      branchId: command.actor.branchId,
      oldValue: null,
      operation: {
        actor: { source: "user" },
        outcome: "FAILURE",
        version: "operation.v2",
      },
      screenPath: null,
      ipAddress: null,
    };
    const expected = [
      {
        ...common,
        action: "sale.creditOverride.fail",
        entityType: "user",
        entityId: String(approver.id),
        newValue: {
          method: "BARCODE",
          reason: "self_approval",
          identifier: "barcode:" + approval.barcode.trim().toLowerCase(),
        },
      },
      {
        ...common,
        action: "rpc.prepare",
        entityType: "prepare",
        entityId: command.input.clientRequestId,
        newValue: {
          target: {
            entityId: command.input.clientRequestId,
            entityType: "prepare",
          },
          outcome: "FAILURE",
          procedure: "prepare",
          _auditContract: "operation.v1",
        },
      },
    ];
    for (let i = 0; i < expected.length; i++) {
      const { id, createdAt, ...payload } = added[i];
      assert.ok(
        Number.isInteger(id) && id > Math.max(0, ...before.map((a) => a.id)),
      );
      assert.equal(
        new Date(createdAt).toISOString(),
        new Date(
          command.before.doubleEntrySettings[0].policyApprovedAt,
        ).toISOString(),
      );
      assert.deepEqual(
        payload,
        expected[i],
        "Exact original verifier/RPC audit contract",
      );
    }
    assert.deepEqual(
      { ...command.after, auditLogs: command.before.auditLogs },
      command.before,
    );
  } else
    assert.deepEqual(
      command.after,
      command.before,
      "Rejected operation persisted effects",
    );
}
export function validateState(state) {
  const byId = (table, id) =>
    state[table].find((r) => String(r.id) === String(id));
  for (const wallet of state.digitalWallets) {
    const active = state.digitalWalletReservations.filter(
      (r) => r.walletId === wallet.id && r.status === "ACTIVE",
    );
    assert.equal(
      wallet.reservedBalance,
      sum(active, "amount"),
      "Reserved balance diverged from reservation rows",
    );
    assert.ok(
      d(wallet.currentBalance).gte(0) && d(wallet.reservedBalance).gte(0),
    );
  }
  for (const head of state.journalEntries) {
    const source = byId("accountingEntries", head.entryId);
    assert.ok(source, "Orphan journal");
    const lines = state.journalLines.filter((l) => l.journalId === head.id);
    assert.equal(
      sum(lines, "debit"),
      sum(lines, "credit"),
      "Unbalanced journal",
    );
    if (head.status === "POSTED") {
      assert.ok(lines.length > 0);
      assert.equal(head.postingProfile, source.postingProfile);
      assert.equal(head.cycleId, source.postingCycleId);
      assert.equal(
        source.postingIntentHash,
        hashPostingIntent(source.postingIntentJson),
        "Posting evidence hash drift",
      );
      assert.deepEqual(
        lines
          .map((l) => ({ role: l.role, debit: l.debit, credit: l.credit }))
          .sort((a, b) => a.role.localeCompare(b.role)),
        source.postingIntentJson.lines
          .map((l) => ({ role: l.role, debit: l.debit, credit: l.credit }))
          .sort((a, b) => a.role.localeCompare(b.role)),
        "Posted lines diverge from source intent",
      );
      for (const line of lines) {
        const account = byId("accounts", line.accountId),
          stat = byId("statutoryAccounts", line.statutoryAccountId);
        assert.equal(account?.systemRole, line.role);
        assert.ok(stat);
        assert.equal(stat.profileId, line.statutoryProfileId);
      }
    } else assert.equal(lines.length, 0);
  }
  for (const detail of state.digitalSaleDetails) {
    const item = byId("invoiceItems", detail.invoiceItemId),
      intentItem = byId("digitalSaleIntentItems", detail.intentItemId);
    assert.ok(item && intentItem);
    assert.equal(item.invoiceId, detail.invoiceId);
    assert.equal(detail.sellPriceSnapshot, item.total);
    assert.equal(detail.providerShareSnapshot, item.lineCost);
    assert.equal(
      d(detail.providerShareSnapshot).plus(detail.profitSnapshot).toFixed(2),
      detail.sellPriceSnapshot,
    );
    assert.equal(detail.providerReference, intentItem.providerReference);
    if (detail.settlementModeSnapshot === "PREPAID")
      assert.equal(
        byId("digitalWalletTransactions", detail.walletTransactionId)
          ?.invoiceId,
        detail.invoiceId,
      );
    else assert.equal(detail.walletTransactionId, null);
  }
  for (const supplier of state.suppliers) {
    const payable = state.accountingEntries.filter(
      (e) =>
        e.supplierId === supplier.id && e.dedupeKey?.startsWith("DIGITAL:AP:"),
    );
    assert.equal(
      supplier.currentBalance,
      sum(payable, "amount"),
      "Supplier AP balance diverged from per-document payable",
    );
  }
  for (const invoice of state.invoices) {
    const items = state.invoiceItems.filter((i) => i.invoiceId === invoice.id),
      entries = state.accountingEntries.filter(
        (e) => e.invoiceId === invoice.id,
      ),
      sale = entries.find((e) => e.entryType === "SALE");
    assert.ok(sale);
    assert.equal(sum(items, "total"), invoice.total);
    assert.equal(sale.amount, invoice.total);
    assert.equal(sale.cost, sum(items, "lineCost"));
    assert.equal(d(sale.revenue).minus(sale.cost).toFixed(2), sale.profit);
    const receipts = state.receipts.filter(
      (r) => r.invoiceId === invoice.id && r.direction === "IN",
    );
    assert.equal(sum(receipts, "amount"), invoice.paidAmount);
    const intent = state.digitalSaleIntents.find(
      (i) => i.invoiceId === invoice.id,
    );
    assert.equal(
      intent?.status,
      "FINALIZED",
      "Invoice lost its finalized intent link",
    );
    assert.ok(
      state.auditLogs.some(
        (a) =>
          a.action === "digitalCards.intent.finalized" &&
          a.entityId === String(intent.id) &&
          a.newValue?.invoiceId === invoice.id,
      ),
      "Missing per-invoice digital finalize audit",
    );
    for (const source of entries) {
      assert.ok(
        state.journalEntries.some((j) => j.entryId === source.id),
        "Financial source missing journal",
      );
      if (source.entryType === "DIGITAL_WALLET_CONSUMPTION")
        for (const field of ["revenue", "cost", "profit"])
          assert.equal(source[field], "0.00");
    }
    const details = state.digitalSaleDetails.filter(
      (r) => r.invoiceId === invoice.id,
    );
    for (const providerId of new Set(
      details
        .filter((r) => r.settlementModeSnapshot === "POSTPAID")
        .map((r) => r.providerId),
    )) {
      const subset = details.filter((r) => r.providerId === providerId),
        ap = entries.filter(
          (e) => e.dedupeKey === `DIGITAL:AP:${invoice.id}:${providerId}`,
        );
      assert.equal(ap.length, 1);
      assert.equal(ap[0].amount, sum(subset, "providerShareSnapshot"));
      assert.equal(ap[0].revenue, "0.00");
      assert.equal(ap[0].cost, "0.00");
    }
  }
  for (const customer of state.customers.filter((c) => c.id === 1)) {
    const invoices = state.invoices.filter((i) => i.customerId === customer.id);
    assert.equal(
      customer.currentBalance,
      invoices
        .reduce((n, i) => n.plus(i.total).minus(i.paidAmount), d(0))
        .toFixed(2),
    );
  }
  assert.equal(state.waOutbox.length, 0, "Unexpected WhatsApp outbox effect");
}
export function validateEvidence(evidence) {
  let commands = 0;
  for (const scenario of evidence.scenarios) {
    const opening = new Map();
    for (const command of scenario.commands) {
      commands++;
      if (command.expected.reject) {
        assert.ok(command.error);
        assertRefusalUnchanged(command);
      } else assert.equal(command.error, null);
      if (command.expected.replay)
        assert.deepEqual(command.after, command.before);
      validateState(command.after);
      for (const wallet of command.before.digitalWallets)
        if (!opening.has(wallet.id))
          opening.set(wallet.id, wallet.currentBalance);
      for (const wallet of command.after.digitalWallets) {
        const transactions = command.after.digitalWalletTransactions.filter(
          (t) => t.walletId === wallet.id,
        );
        const balance = transactions.reduce(
          (n, t) =>
            t.direction === "OUT" ? n.minus(t.amount) : n.plus(t.amount),
          d(opening.get(wallet.id)),
        );
        assert.equal(
          wallet.currentBalance,
          balance.toFixed(2),
          "Wallet balance diverged from opening + movement trail",
        );
      }
      if (command.op === "FINALIZE_FAULT") {
        const invoiceIndex = command.trace.findIndex((t) =>
          /^insert into `invoices`/i.test(t.sql),
        );
        const failureIndex = command.trace.findIndex(
          (t) => t.injectedFailure === "AFTER_INVOICE_BEFORE_WALLET_CLOSURE",
        );
        assert.ok(
          invoiceIndex >= 0 && failureIndex > invoiceIndex,
          "Rollback fault was not placed after actual invoice insertion",
        );
        assert.match(
          command.error.cause,
          /Q2_INJECTED_FINANCIAL_CLOSURE_FAILURE/,
        );
      }
    }
  }
  const { issued } = validateProviderEvidence(evidence);
  assert.equal(evidence.networkAttempts.length, 0);
  return {
    scenarios: evidence.scenarios.length,
    commands,
    providerResultKeys: issued.size,
    syntheticSuccessKeys: [...issued.values()].filter(
      (r) => r.result.status === "SUCCESS",
    ).length,
    syntheticFailedKeys: [...issued.values()].filter(
      (r) => r.result.status === "FAILED",
    ).length,
    fullRowGraph: true,
    decimalAndReferenceChecks: true,
  };
}
if (process.argv[1]?.endsWith("validate.mjs")) {
  const latest = JSON.parse(
    await readFile(
      "experiments/d1-continuity/digital/results/latest.json",
      "utf8",
    ),
  );
  console.log(
    JSON.stringify(
      validateEvidence(
        JSON.parse(
          await readFile(
            process.argv[2] ?? latest.out + "/oracle.json",
            "utf8",
          ),
        ),
      ),
    ),
  );
}
