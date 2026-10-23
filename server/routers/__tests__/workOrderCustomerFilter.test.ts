import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { buildWoFilterConds } from "../workOrderRouter";
describe("customer dossier work-order filter", () => {
  it("binds the exact customer ID independently from free-text search", () => {
    const dialect = new MySqlDialect();
    const filters = buildWoFilterConds({ customerId: 42 });
    expect(filters).toHaveLength(1);
    const query = dialect.sqlToQuery(filters[0]);
    expect(query.sql).toContain("customerId");
    expect(query.params).toEqual([42]);
  });
  it("leaves unfiltered queues unchanged", () =>
    expect(buildWoFilterConds(undefined)).toEqual([]));
});
