import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const state = vi.hoisted(() => ({
  queries: [] as {
    totals: boolean;
    where?: unknown;
    limit?: number;
    offset?: number;
  }[],
}));
vi.mock("../../db", () => ({ getDb: () => ({ select: selectRows }) }));

import { listExpenses, type ListExpensesInput } from "../expenseService";

function selectRows(fields: Record<string, unknown>) {
  const entry = {
    totals: "active" in fields,
  } as (typeof state.queries)[number];
  state.queries.push(entry);
  const builder: any = {
    from: () => builder,
    leftJoin: () => builder,
    where: (value: unknown) => {
      entry.where = value;
      return builder;
    },
    orderBy: () => builder,
    limit: (value: number) => {
      entry.limit = value;
      return builder;
    },
    offset: (value: number) => {
      entry.offset = value;
      return builder;
    },
    then: (resolve: (rows: unknown[]) => unknown) =>
      Promise.resolve(entry.totals ? [{ count: 0 }] : []).then(resolve),
  };
  return builder;
}

const dialect = new MySqlDialect();
const compile = (entry: (typeof state.queries)[number]) =>
  dialect.sqlToQuery(entry.where as any);
beforeEach(() => {
  state.queries = [];
});

describe("expense audit filtering is part of the paginated read contract", () => {
  it.each([
    ["DESCRIPTION", "TRIM(COALESCE(`expenses`.`description`, '')) = ''"],
    ["PAYEE", "TRIM(COALESCE(`expenses`.`payee`, '')) = ''"],
    ["SOURCE", "accrualObligationEvents"],
    ["DRAWER", "`expenses`.`expenseCashBucket` = 'DRAWER'"],
  ] as const)(
    "applies %s identically to list, totals and offset export",
    async (auditFocus, predicate) => {
      const input: ListExpensesInput = {
        branchId: 7,
        createdBy: 42,
        auditFocus,
        limit: 1000,
        offset: 1000,
      };
      await listExpenses(input);
      const rows = state.queries.find((query) => !query.totals)!;
      const totals = state.queries.find((query) => query.totals)!;
      const query = compile(rows);
      expect(query.sql).toContain(predicate);
      expect(query.sql).toContain("`expenses`.`branchId` = ?");
      expect(query.sql).toContain("`expenses`.`createdBy` = ?");
      expect(query.params).toContain(7);
      expect(query.params).toContain(42);
      expect(compile(totals)).toEqual(query);
      expect(rows).toMatchObject({ limit: 1000, offset: 1000 });
    },
  );

  it("applies auditOnly before keyset pagination and retains full matching totals", async () => {
    await listExpenses({ auditOnly: true, cursor: 48, limit: 20 });
    const rows = state.queries.find((query) => !query.totals)!;
    const totals = state.queries.find((query) => query.totals)!;
    expect(compile(rows).sql).toContain("accrualObligationEvents");
    expect(compile(rows).sql).toContain("`expenses`.`id` < ?");
    expect(compile(totals).sql).not.toContain("`expenses`.`id` < ?");
    expect(rows).toMatchObject({ limit: 21, offset: 0 });
  });

  it("focus takes precedence over auditOnly, matching the selected audit card", async () => {
    await listExpenses({ auditFocus: "DESCRIPTION", auditOnly: true });
    const rows = state.queries.find((query) => !query.totals)!;
    expect(compile(rows).sql).toBe(
      "TRIM(COALESCE(`expenses`.`description`, '')) = ''",
    );
  });

  it("uses current reversal evidence and catches unknown funding on cancelled cash rows", async () => {
    await listExpenses({ auditFocus: "SOURCE" });
    const query = compile(state.queries.find((entry) => !entry.totals)!);
    expect(query.sql).toContain(
      "IN ('PAYMENT_SETTLED', 'SETTLEMENT_REVERSED')",
    );
    expect(query.sql).toContain("IN ('PAID', 'REFUND_PENDING', 'REFUNDED')");
    expect(query.sql).toContain("ORDER BY aoe.id DESC LIMIT 1");
    expect(query.sql).toContain("NOT IN ('PENDING_APPROVAL', 'REJECTED')");
  });

  it("keeps the recognized cancellation beneficiary exception when auditing missing payees", async () => {
    await listExpenses({ auditFocus: "PAYEE" });
    const query = compile(state.queries.find((entry) => !entry.totals)!);
    expect(query.sql).toContain(
      "TRIM(COALESCE(`receipts`.`counterpartyName`, '')) <> ''",
    );
  });
});
