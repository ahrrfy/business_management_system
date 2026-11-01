// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoricalAttendanceAttestation } from "./HistoricalAttendanceAttestation";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  useMutation: vi.fn(),
  mutate: vi.fn(),
  reset: vi.fn(),
  refetch: vi.fn(),
  generate: vi.fn(),
  notify: vi.fn(),
  onSuccess: undefined as ((_result: unknown, variables: { period: string; employeeId: number; expectedEmployeeName: string; sourceAuditId: number; sourceHash: string }) => Promise<void>) | undefined,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    payroll: {
      historicalAttendanceCandidates: { useQuery: mocks.query },
      attestHistoricalAttendanceExemption: { useMutation: mocks.useMutation },
      generate: { useMutation: () => ({ mutate: mocks.generate }) },
    },
  },
}));
vi.mock("@/lib/notify", () => ({ notify: { ok: mocks.notify } }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const candidate = {
  kind: "attestable" as const,
  employeeId: 42,
  employeeName: "أحمد علي",
  period: "2026-10",
  sourceAuditId: 123,
  sourceHash: "a".repeat(64),
  sourceChangedAt: new Date("2026-11-01T09:00:00Z"),
  beforeExempt: false,
  afterExempt: true,
};

describe("HistoricalAttendanceAttestation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let visibleCandidate: typeof candidate;

  const render = (period = "2026-10", enabled = true) =>
    act(() => root.render(<HistoricalAttendanceAttestation period={period} enabled={enabled} />));
  const review = () => act(() =>
    container.querySelector<HTMLButtonElement>('button[aria-label="مراجعة إقرار أحمد علي"]')!.click(),
  );
  const setEvidence = (text: string) => {
    const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const recordButton = () => Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("تسجيل الإقرار"))!;
  const confirm = () => act(() =>
    container.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click(),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onSuccess = undefined;
    visibleCandidate = { ...candidate };
    mocks.refetch.mockResolvedValue({});
    mocks.query.mockImplementation(({ period }: { period: string }) => ({
      data: period === visibleCandidate.period ? [visibleCandidate] : [],
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: mocks.refetch,
    }));
    mocks.useMutation.mockImplementation((options: { onSuccess: (_result: unknown, variables: { period: string; employeeId: number; expectedEmployeeName: string; sourceAuditId: number; sourceHash: string }) => Promise<void> }) => {
      mocks.onSuccess = options.onSuccess;
      return { mutate: mocks.mutate, reset: mocks.reset, isPending: false, isError: false };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the employee, month, source date and conflict without exposing the fingerprint", () => {
    render();
    expect(container.textContent).toContain("أحمد علي");
    expect(container.textContent).toContain("2026-10");
    expect(container.textContent).toContain("2026");
    expect(container.textContent).toContain("من غير معفى إلى معفى");
    expect(container.textContent).not.toContain(candidate.sourceHash);
    expect(mocks.query).toHaveBeenCalledWith({ period: "2026-10" }, { enabled: true });
  });

  it("requires explicit confirmation and evidence before recording, then refreshes without generating payroll", async () => {
    render();
    review();
    expect(container.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    expect(recordButton().disabled).toBe(true);
    setEvidence("دليل");
    confirm();
    expect(recordButton().disabled).toBe(true);
    setEvidence("سجل شؤون الموظفين المعتمد");
    expect(recordButton().disabled).toBe(false);
    act(() => recordButton().click());
    expect(mocks.mutate).toHaveBeenCalledWith({
      period: "2026-10", employeeId: 42, sourceAuditId: 123,
      expectedEmployeeName: "أحمد علي",
      sourceHash: candidate.sourceHash, evidenceText: "سجل شؤون الموظفين المعتمد",
      confirmFixedExemption: true,
    });
    expect(mocks.generate).not.toHaveBeenCalled();
    await act(async () => { await mocks.onSuccess?.(undefined, { period: "2026-10", employeeId: 42, expectedEmployeeName: "أحمد علي", sourceAuditId: 123, sourceHash: candidate.sourceHash }); });
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining("2026-10"));
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("clears the review and its confirmation when the selected month changes", () => {
    render();
    review();
    setEvidence("سجل شؤون الموظفين المعتمد");
    confirm();
    render("2026-09");
    expect(container.querySelector("textarea")).toBeNull();
    render("2026-10");
    review();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
    expect(container.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    expect(recordButton().disabled).toBe(true);
  });

  it("does not clear another month's review when an earlier request completes", async () => {
    render();
    review();
    setEvidence("سجل شؤون الموظفين المعتمد");
    confirm();
    act(() => recordButton().click());
    visibleCandidate = { ...candidate, period: "2026-09", sourceAuditId: 124 };
    render("2026-09");
    review();
    setEvidence("مستند مستقل للشهر الآخر");
    confirm();
    await act(async () => { await mocks.onSuccess?.(undefined, { period: "2026-10", employeeId: 42, expectedEmployeeName: "أحمد علي", sourceAuditId: 123, sourceHash: candidate.sourceHash }); });
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("مستند مستقل للشهر الآخر");
    expect(recordButton().disabled).toBe(false);
    expect(mocks.refetch).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining("2026-10"));
  });

  it("requires a fresh review if the candidate source changes", () => {
    render();
    review();
    setEvidence("سجل شؤون الموظفين المعتمد");
    confirm();
    visibleCandidate = { ...candidate, sourceHash: "b".repeat(64) };
    render();
    expect(container.querySelector("textarea")).toBeNull();
    review();
    expect(recordButton().disabled).toBe(true);
  });

  it("preserves a new review if an earlier request for the old name completes", async () => {
    render();
    review();
    setEvidence("سجل شؤون الموظفين المعتمد");
    confirm();
    act(() => recordButton().click());
    visibleCandidate = { ...candidate, employeeName: "أحمد حسن" };
    render();
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="مراجعة إقرار أحمد حسن"]')!.click());
    setEvidence("دليل الاسم الحالي للموظف");
    confirm();
    await act(async () => { await mocks.onSuccess?.(undefined, {
      period: "2026-10", employeeId: 42, expectedEmployeeName: "أحمد علي",
      sourceAuditId: 123, sourceHash: candidate.sourceHash,
    }); });
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("دليل الاسم الحالي للموظف");
    expect(recordButton().disabled).toBe(false);
  });

  it("shows unresolved cases with a reason and no attestation action", () => {
    mocks.query.mockReturnValue({
      data: [{ kind: "manual_review", employeeId: 51, employeeName: "زين حسن",
        period: "2026-10", reason: "سجل الأجر يحتاج إلى مراجعة إضافية" }],
      isLoading: false, isError: false, isFetching: false, refetch: mocks.refetch,
    });
    render();
    expect(container.textContent).toContain("زين حسن");
    expect(container.textContent).toContain("سجل الأجر يحتاج إلى مراجعة إضافية");
    expect(container.textContent).toContain("راجع ملف الموظف وسجل الأجر");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("keeps a supported case actionable alongside an unresolved case", () => {
    mocks.query.mockReturnValue({
      data: [candidate, { kind: "manual_review", employeeId: 51, employeeName: "زين حسن",
        period: "2026-10", reason: "سجل الأجر يحتاج إلى مراجعة إضافية" }],
      isLoading: false, isError: false, isFetching: false, refetch: mocks.refetch,
    });
    render();
    expect(container.querySelectorAll('button[aria-label^="مراجعة إقرار"]')).toHaveLength(1);
    expect(container.querySelector('button[aria-label="مراجعة إقرار زين حسن"]')).toBeNull();
    review();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("displays loading and query failures without claiming the month is clear", () => {
    mocks.query.mockReturnValueOnce({ isLoading: true, isError: false });
    render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("جارٍ فحص");
    mocks.query.mockReturnValueOnce({ isLoading: false, isError: true, refetch: mocks.refetch });
    render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("تعذّر فحص");
    act(() => container.querySelector("button")!.click());
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
