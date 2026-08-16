import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkerEligibleRequests,
  pendingDecemberRequests,
  yearEndReopenState,
  yearEndSelectionFromSearch,
  type YearEndCloseRequestLike,
} from "./YearEnd";

function request(
  id: number,
  month: string,
  status: string,
  requestedBy = 20,
): YearEndCloseRequestLike {
  return {
    id,
    month,
    status,
    requestedBy,
    requestedByName: `مستخدم ${requestedBy}`,
    requestedAt: "2026-01-02T10:00:00.000Z",
  };
}

describe("YearEnd December request selection", () => {
  it("لا يعرض إلا طلب ديسمبر المعلّق للسنة المختارة", () => {
    const rows = [
      request(1, "2025-12", "PENDING_APPROVAL"),
      request(2, "2025-11", "PENDING_APPROVAL"),
      request(3, "2025-12", "APPROVED"),
      request(4, "2024-12", "PENDING_APPROVAL"),
    ];

    expect(pendingDecemberRequests(rows, 2025).map((row) => row.id)).toEqual([
      1,
    ]);
  });

  it("يحجب طلب صانع الإقفال عن الحساب نفسه ويتيح طلب مستخدم آخر", () => {
    const rows = [
      request(10, "2025-12", "PENDING_APPROVAL", 41),
      request(11, "2025-12", "PENDING_APPROVAL", 42),
    ];

    expect(checkerEligibleRequests(rows, 41).map((row) => row.id)).toEqual([
      11,
    ]);
  });

  it("لا يتيح اعتماداً قبل اكتمال هوية المعتمِد", () => {
    const rows = [request(10, "2025-12", "PENDING_APPROVAL", 42)];
    expect(checkerEligibleRequests(rows, undefined)).toEqual([]);
  });
  it("reads the exact year and request from a deep link", () => {
    expect(
      yearEndSelectionFromSearch("?tab=yearend&year=2024&requestId=44", 2025),
    ).toEqual({ year: 2024, requestId: 44 });
    expect(
      yearEndSelectionFromSearch("tab=yearend&year=x&requestId=-1", 2025),
    ).toEqual({ year: 2025, requestId: null });
  });

  it("يعرض طلب الفتح لأحدث مراجعة فقط ويحفظ السابقة كتاريخ غير قابل للتعديل", () => {
    const snapshots = [
      { id: 10, year: 2025, revision: 1, branchId: null },
      { id: 11, year: 2025, revision: 2, branchId: null },
    ];
    expect(yearEndReopenState(snapshots[0], snapshots, [])).toBe("HISTORICAL");
    expect(yearEndReopenState(snapshots[1], snapshots, [])).toBe("AVAILABLE");
    expect(
      yearEndReopenState(snapshots[1], snapshots, [
        { id: 1, snapshotId: 11, status: "PENDING_APPROVAL" },
      ]),
    ).toBe("PENDING_APPROVAL");
    expect(
      yearEndReopenState(snapshots[1], snapshots, [
        { id: 2, snapshotId: 11, status: "APPROVED" },
      ]),
    ).toBe("APPROVED");
  });

  it("يحافظ على DECIMAL كسلسلة دقيقة في عرض الربح والخسارة", () => {
    const source = readFileSync("client/src/pages/YearEnd.tsx", "utf8");
    expect(source).toContain("const net = D(s.netProfit)");
    expect(source).toContain("net.abs().toFixed(2)");
    expect(source).not.toContain("Number(s.netProfit)");
    expect(source).not.toContain("Math.abs(net)");
  });
});
