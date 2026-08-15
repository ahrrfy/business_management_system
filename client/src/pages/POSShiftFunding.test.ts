import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("POS — استلام العهدة الإضافية", () => {
  it("يظهر الطلب في محطة الكاشير ولا ينسب النقد للدرج قبل التأكيد", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "client/src/pages/POS.tsx"),
      "utf8",
    );

    expect(source).toContain("trpc.shifts.fundingRequests.useQuery");
    expect(source).toContain("trpc.shifts.respondFunding.useMutation");
    expect(source).toContain("Number(request.shiftId) === Number(shift.id)");
    expect(source).toContain("posFundingRequests.map");
    expect(source).toContain('data-testid="pos-shift-funding-banner"');
    expect(source).toContain("لا تُضاف إلى الدرج إلا بعد عدّ النقد فعلياً");
    expect(source).toContain('decision: "ACCEPT"');
    expect(source).toContain("مراجعة الطلب أو رفضه");
  });
});
