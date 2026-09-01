import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("server/routers/salesPipelineRouter.ts", "utf8");

describe("sales pipeline router authority", () => {
  it("gates every read with CRM READ and every write with CRM FULL", () => {
    expect(source.match(/crmReadProcedure/g)?.length).toBeGreaterThanOrEqual(6);
    expect(source.match(/crmWriteProcedure/g)?.length).toBeGreaterThanOrEqual(
      6,
    );
    expect(source).not.toContain("protectedProcedure");
    expect(source).not.toContain("adminProcedure");
  });

  it("passes injected branch and owner scope to all record reads", () => {
    expect(source).toContain("listSalesLeads(input ?? {}, scopeOf(ctx))");
    expect(source).toContain("getSalesLeadDetail(input.leadId, scopeOf(ctx))");
    expect(source).toContain(
      "listSalesOpportunities(input ?? {}, scopeOf(ctx))",
    );
    expect(source).toContain(
      "getSalesOpportunityDetail(input.opportunityId, scopeOf(ctx))",
    );
  });
});
