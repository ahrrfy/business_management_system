// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/components/ui/dialog", () => ({
  useDialogComposition: () => null,
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));
import { useAttendanceCorrection } from "../statement/useAttendanceCorrection";
import { AttendanceCorrectionDialog } from "../statement/AttendanceCorrectionDialog";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
describe("attendance correction completion", () => {
  let host: HTMLDivElement;
  let root: Root;
  let correction: ReturnType<typeof useAttendanceCorrection>;
  const submit = vi.fn();
  const draft = (date: string) => ({
    date,
    shiftMode: "single" as const,
    checkIn: "08:00",
    checkOut: "16:00",
    hours: "8",
    crossMidnight: false,
    sessions: [],
    status: "PRESENT" as const,
    breakMinutes: "",
    lateDeductionMinutes: "",
    notes: "سبب موثق",
  });
  function Harness() {
    correction = useAttendanceCorrection();
    return (
      <AttendanceCorrectionDialog
        model={
          {
            ...correction,
            can: () => true,
            correct: { mutate: submit, isPending: false },
            employeeId: 3,
            d: {},
          } as any
        }
      />
    );
  }
  beforeEach(() => {
    submit.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  function save() {
    act(() =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "حفظ التصحيح")!
        .click(),
    );
  }
  it("retains a newer draft when an earlier saved correction responds late", () => {
    act(() => correction.setFix(draft("2026-10-01")));
    save();
    expect(submit.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        employeeId: 3,
        attendanceDate: "2026-10-01",
        hours: 8,
        checkIn: "08:00",
        checkOut: "16:00",
        breakMinutes: 0,
        notes: "سبب موثق",
        source: "manual",
      }),
    );
    act(() => correction.setFix(null));
    act(() => correction.setFix(draft("2026-10-02")));
    act(() => submit.mock.calls[0][1].onSuccess());
    expect(correction.fix?.date).toBe("2026-10-02");
  });
  it("closes the submitted draft when it is still the current correction", () => {
    act(() => correction.setFix(draft("2026-10-01")));
    save();
    act(() => submit.mock.calls[0][1].onSuccess());
    expect(correction.fix).toBeNull();
  });
});
