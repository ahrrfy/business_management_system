import { describe, expect, it, vi } from "vitest";
import { selfHealDivergedProductChannelLabels } from "../catalog/productChannelSyncSelfHeal";
import * as dbModule from "../../db";

describe("إصلاح ذاتي لتسميات قنوات المنتجات عند الإقلاع", () => {
  it("يتعامل بأمان ويعيد صفر عند عدم توفر اتصال قاعدة البيانات", async () => {
    vi.spyOn(dbModule, "getDb").mockReturnValue(null as any);
    const result = await selfHealDivergedProductChannelLabels();
    expect(result).toEqual({ healedCount: 0 });
    vi.restoreAllMocks();
  });

  it("ينفّذ استعلامات التحديث لقناة البيع PR-2027-UAIF والمنتجات المتباعدة", async () => {
    const executedQueries: any[] = [];
    const mockDb = {
      execute: vi.fn().mockImplementation((query) => {
        executedQueries.push(query);
        return [{ affectedRows: 2 }];
      }),
    };

    vi.spyOn(dbModule, "getDb").mockReturnValue(mockDb as any);

    const result = await selfHealDivergedProductChannelLabels();
    expect(result).toEqual({ healedCount: 2 });
    expect(mockDb.execute).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });
});
