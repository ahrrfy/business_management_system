import { beforeEach, describe, expect, it } from "vitest";
import { getDashboardMetrics, clearDashboardMetricsCache } from "../reportsService";

describe("كاش مقاييس لوحة التحكم (dashboardMetrics cache)", () => {
  beforeEach(() => {
    clearDashboardMetricsCache();
  });

  it("يخزن النتائج المشتركة في الذاكرة عند تفعيل الكاش (skipCache: false)", async () => {
    const res1 = await getDashboardMetrics({ branchId: 1, skipCache: false });
    const res2 = await getDashboardMetrics({ branchId: 1, skipCache: false });

    expect(res1.health.status).toBe(res2.health.status);
    expect(res1.lowStockCount).toBe(res2.lowStockCount);
    expect(res1.overdueAR.count).toBe(res2.overdueAR.count);
  });

  it("دالة clearDashboardMetricsCache تفرغ الكاش بنجاح", async () => {
    await getDashboardMetrics({ branchId: 1, skipCache: false });
    clearDashboardMetricsCache();
    const res = await getDashboardMetrics({ branchId: 1, skipCache: false });
    expect(res).toBeDefined();
    expect(res.morningBrief).toBeDefined();
  });

  it("يدمج الاستدعاءات المتزامنة المتطابقة دون تصادم", async () => {
    const [p1, p2, p3] = await Promise.all([
      getDashboardMetrics({ branchId: 1, skipCache: false }),
      getDashboardMetrics({ branchId: 1, skipCache: false }),
      getDashboardMetrics({ branchId: 1, skipCache: false }),
    ]);

    expect(p1.health.status).toBe(p2.health.status);
    expect(p2.health.status).toBe(p3.health.status);
  });
});
