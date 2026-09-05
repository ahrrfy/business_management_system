import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../DayCloseReport.tsx", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL(
    "../../../../server/services/cashDailyReconciliationService.ts",
    import.meta.url,
  ),
  "utf8",
);
const treasuryRouter = readFileSync(
  new URL("../../../../server/routers/treasuryRouter.ts", import.meta.url),
  "utf8",
);

describe("DayCloseReport missed daily count exception contract", () => {
  it("mounts the governed exception panel only with a concrete branch", () => {
    expect(page).toContain("MissedDailyCountExceptionPanel");
    expect(page).toContain('const missedDailyPanel = branchId === "" ? null');
    expect(page).toContain("businessDate={date}");
    expect(page).toContain("canManage={canManageDaily}");
    expect(treasuryRouter).toContain(
      "missedDailyCount: missedDailyCountExceptionRouter",
    );
  });

  it("states that daily count/close separation has no role exception", () => {
    expect(page).toContain(
      "مستخدماً مختلفاً عن منفّذ الجرد، بلا استثناء للدور",
    );
    expect(page).not.toContain("باستثناء الإداري");
  });

  it("keeps historical physical counts forbidden at the service boundary", () => {
    expect(service).toContain("input.businessDate !== todayUtcDate()");
    expect(service).toContain("الجرد المادي متاح لليوم الحالي فقط");
  });
});
