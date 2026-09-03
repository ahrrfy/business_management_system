import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "drizzle/migrations/0311_sales_leads_opportunities.sql",
  "utf8",
);
const leads = readFileSync("server/services/salesPipeline/leads.ts", "utf8");
const opportunities = readFileSync(
  "server/services/salesPipeline/opportunities.ts",
  "utf8",
);
const queries = readFileSync(
  "server/services/salesPipeline/queries.ts",
  "utf8",
);

describe("sales pipeline governance contract", () => {
  it("persists optimistic versions, idempotent keys and immutable event rows", () => {
    expect(migration).toContain("`version` INT NOT NULL DEFAULT 1");
    expect(migration).toContain("UNIQUE KEY `uq_sales_lead_event_key`");
    expect(migration).toContain("UNIQUE KEY `uq_sales_opp_event_key`");
    expect(leads).toContain("Number(lead.version) !== input.expectedVersion");
    expect(opportunities).toContain(
      "Number(opportunity.version) !== input.expectedVersion",
    );
  });

  it("has no hard-delete path and converts a qualified lead atomically", () => {
    expect(leads).not.toMatch(/\.delete\(salesLeads\)/);
    expect(opportunities).not.toMatch(/\.delete\(salesOpportunities\)/);
    expect(opportunities).toContain('lead.status !== "QUALIFIED"');
    expect(opportunities).toContain('status: "CONVERTED"');
    expect(opportunities).toContain('eventType: "CONVERTED"');
  });

  it("requires a live invoice for a won opportunity", () => {
    expect(migration).toContain("chk_sales_opp_won_invoice");
    expect(opportunities).toContain("assertWinningInvoiceTx");
    expect(opportunities).toContain("الفاتورة إلزامية عند إغلاق الفرصة رابحة");
  });

  it("enforces branch and owner scope on reads and writes", () => {
    expect(leads).toContain("assertPipelineRowWritable");
    expect(leads).toContain("scope.scopedBranchId");
    expect(leads).toContain("scope.scopedOwnerId");
    expect(opportunities).toContain("assertPipelineRowWritable");
    expect(opportunities).toContain("scope.scopedBranchId");
    expect(opportunities).toContain("scope.scopedOwnerId");
  });

  it("aggregates dashboard values in SQL and keyset-pages detail lists", () => {
    expect(queries).toContain("COUNT(*)");
    expect(queries).toContain("COALESCE(SUM(CASE WHEN");
    expect(queries).toContain(".groupBy(salesLeads.status)");
    expect(queries).toContain(".groupBy(salesOpportunities.stage)");
    expect(leads).toContain(".limit(limit + 1)");
    expect(leads).toContain("nextCursor:");
    expect(opportunities).toContain(".limit(limit + 1)");
    expect(opportunities).toContain("nextCursor:");
  });
});
