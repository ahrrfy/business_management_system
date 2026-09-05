import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("client/src/pages/SalesPipeline.tsx", "utf8");
const board = readFileSync(
  "client/src/components/salesPipeline/PipelineBoard.tsx",
  "utf8",
);
const dialogs = readFileSync(
  "client/src/components/salesPipeline/PipelineDialogs.tsx",
  "utf8",
);

describe("sales pipeline operational UX", () => {
  it("has board/list views, search, overdue filter and recovery states", () => {
    expect(page).toContain('view === "BOARD"');
    expect(page).toContain('view === "LIST"');
    expect(page).toContain("overdueOnly");
    expect(page).toContain("<ErrorState");
    expect(page).toContain("onRetry");
    expect(page).toContain("useInfiniteQuery");
    expect(page).toContain('enabled: section === "LEADS"');
    expect(page).toContain('enabled: section === "OPPORTUNITIES"');
    expect(page).toContain("hasNextPage");
    expect(page).toContain("fetchNextPage");
  });

  it("exposes create, edit, transition, conversion and history without delete", () => {
    expect(page).toContain("createLead.mutate");
    expect(page).toContain("updateLead.mutate");
    expect(page).toContain("transitionLead.mutate");
    expect(page).toContain("convertLead.mutate");
    expect(page).toContain("PipelineHistoryDialog");
    expect(page).not.toMatch(/deleteLead|deleteOpportunity/);
  });

  it("requires a reason for governed changes and an invoice on a won transition", () => {
    expect(dialogs).toContain("سبب التعديل");
    expect(dialogs).toContain("سبب الانتقال");
    expect(dialogs).toContain("فاتورة الفوز");
    expect(dialogs).toContain("won && !invoiceId");
  });

  it("renders each canonical state from the shared dictionaries", () => {
    expect(board).toContain("SALES_LEAD_STATUSES.map");
    expect(board).toContain("SALES_OPPORTUNITY_STAGES.map");
    expect(board).toContain("LEAD_ALLOWED_TRANSITIONS[lead.status]");
    expect(board).toContain(
      "OPPORTUNITY_ALLOWED_TRANSITIONS[opportunity.stage]",
    );
  });
});
