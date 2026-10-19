import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import Decimal from "decimal.js";
import { logAuditTx } from "../../../server/services/auditService.ts";
import { RETURN_EXECUTED_AUDIT_ACTION } from "../../../server/services/returns/auditActions.ts";
import { setupLab, oracle, wire, compareGraph } from "./native-support.mjs";
import { resultRoot } from "./native.mjs";

test("Q1A native accounting matrix has exact financial parity", async () => {
  const evidence = [];
  for (const scenario of oracle.scenarios.filter(
    (s) =>
      !process.env.ACCOUNTING_SCENARIO ||
      s.name === process.env.ACCOUNTING_SCENARIO,
  )) {
    const lab = await setupLab("matrix-" + scenario.name);
    try {
      await lab.seed(scenario.commands[0].before);
      compareGraph(
        await lab.graph(),
        scenario.commands[0].before,
        scenario.name + " initial",
        lab.tables,
      );
      const originalResults = new Map(),
        expectedAudits = [];
      for (const [index, command] of scenario.commands.entries()) {
        // Followup fault is an explicit synthetic policy transition after the sale.
        if (index === 1 && scenario.name.includes("followup"))
          await lab.seed(command.before);
        const input = wire(command.input),
          route =
            input.commandType === "COLLECT"
              ? "/payment"
              : input.commandType === "RETURN"
                ? "/return"
                : "/sale";
        const r = await lab.call(lab.source, route, input);
        if (command.error) {
          assert.notEqual(
            r.status,
            200,
            scenario.name + ":" + index + JSON.stringify(r),
          );
          if (index === 0 || scenario.name.includes("followup"))
            assert.equal(r.body.message, command.error.message);
        } else
          assert.equal(
            r.status,
            200,
            scenario.name + ":" + index + JSON.stringify(r),
          );
        const graph = await lab.graph();
        compareGraph(
          graph,
          command.after,
          scenario.name + ":" + index,
          lab.tables,
        );
        if (
          !command.error &&
          !originalResults.has(input.clientRequestId) &&
          input.commandType === "RETURN"
        ) {
          const { commandType, ...original } = command.input;
          let captured;
          await logAuditTx(
            {
              insert() {
                return {
                  values(value) {
                    captured = value;
                    return Promise.resolve();
                  },
                };
              },
            },
            oracle.actor,
            {
              branchId: 1,
              action: RETURN_EXECUTED_AUDIT_ACTION,
              entityType: "invoice",
              entityId: String(input.invoiceId),
              newValue: { ...original, result: command.result },
            },
          );
          expectedAudits.push(captured);
        }
        assert.deepEqual(
          graph.auditLogs.map(({ id, createdAt, ...row }) => row),
          expectedAudits,
        );
        for (const journal of graph.journalEntries) {
          const lines = graph.journalLines.filter(
            (l) => l.journalId === journal.id,
          );
          const sum = (key) =>
            lines
              .reduce((sum, l) => sum.plus(l[key]), new Decimal(0))
              .toFixed(2);
          assert.equal(sum("debit"), sum("credit"));
        }
        assert.ok(r.profile.sqlCount <= 48, "Free SQL headroom exceeded");
        if (!command.error) {
          const {
            idempotentReplay,
            recoveryAcknowledged,
            recoveryEpoch,
            clientRequestId,
            ...result
          } = r.body;
          const { idempotentReplay: prior, ...expected } = command.result;
          for (const [key, value] of Object.entries(expected))
            assert.deepEqual(result[key], value);
          const first = originalResults.get(input.clientRequestId);
          if (first) assert.deepEqual(result, first);
          else {
            assert.deepEqual(result, expected);
            originalResults.set(input.clientRequestId, result);
          }
        }
        const saved = await lab.db
          .prepare("SELECT planJson FROM cashCommands WHERE requestId=?")
          .bind(input.clientRequestId)
          .first();
        const plan = saved ? JSON.parse(saved.planJson) : null;
        evidence.push({
          changedRows: plan?.changes.length,
          changes: plan?.changes.map((c) => ({
            table: c.table,
            update: !!c.before,
          })),
          scenario: scenario.name,
          index,
          status: r.status,
          profile: r.profile,
          body: r.body,
        });
      }
      assert.equal(lab.outbound.length, 0);
    } finally {
      await lab.close();
      await writeFile(
        resultRoot +
          "/native-matrix" +
          (process.env.ACCOUNTING_SCENARIO ? "-focused" : "") +
          ".json",
        JSON.stringify(evidence, null, 2),
      );
    }
  }
});
