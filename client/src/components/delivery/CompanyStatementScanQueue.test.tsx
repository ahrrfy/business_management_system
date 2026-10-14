// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyStatementScanQueue } from "./CompanyStatementScanQueue";
vi.mock("@/components/form/MoneyInput", () => ({
  MoneyInput: ({ value, ariaLabel, disabled }: { value: string; ariaLabel?: string; disabled?: boolean }) => (
    <input readOnly disabled={disabled} value={value} aria-label={ariaLabel} />
  ),
}));
vi.mock("@/lib/notify", () => ({
  notify: { err: vi.fn(), warn: vi.fn(), ok: vi.fn() },
}));
vi.mock("@/lib/notifyBeep", () => ({ playReadyBeep: vi.fn() }));
vi.mock("@/lib/audioFeedback", () => ({ playAudioFeedback: vi.fn() }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function StatementHarness() {
  const [statementNumber, setStatementNumber] = useState("");

  return (
    <>
      <label htmlFor="statement-number">رقم الكشف</label>
      <input
        id="statement-number"
        value={statementNumber}
        onChange={(event) => setStatementNumber(event.currentTarget.value)}
      />
      <CompanyStatementScanQueue
        candidates={[]}
        queuedIds={[]}
        collectedById={{}}
        disabled={statementNumber.trim().length < 2}
        onQueue={() => undefined}
        onRemove={() => undefined}
        onCollectedChange={() => undefined}
      />
    </>
  );
}

describe("CompanyStatementScanQueue", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("لا يخطف التركيز من رقم الكشف عند إدخال الحرف الثاني", () => {
    act(() => root.render(<StatementHarness />));
    const statementInput =
      host.querySelector<HTMLInputElement>("#statement-number")!;
    statementInput.focus();

    changeInput(statementInput, "AB");
    act(() => vi.advanceTimersByTime(50));

    expect(document.activeElement).toBe(statementInput);
  });

  it("يربط حقل قارئ الباركود بتسمية عربية ظاهرة", () => {
    act(() => root.render(<StatementHarness />));
    const label = Array.from(host.querySelectorAll("label")).find((candidate) =>
      candidate.textContent?.includes("طابور كشف الشركة بالباركود"),
    );

    expect(label?.htmlFor).toBeTruthy();
    const scanner = document.getElementById(label!.htmlFor);
    expect(scanner).toBeInstanceOf(HTMLInputElement);
    expect(scanner?.getAttribute("dir")).toBe("ltr");
  });
  const candidates = [1, 2].map((id) => ({
    id,
    consignmentNumber: `CN-${id}`,
    externalTrackingRef: `000${id}`,
    codAmount: "0.10",
    collectedAmount: "0",
  }));
  const onQueue = vi.fn();
  const showQueue = (disabled = false, queuedIds: number[] = []) => {
    act(() =>
      root.render(
        <CompanyStatementScanQueue
          candidates={candidates}
          queuedIds={queuedIds}
          collectedById={{}}
          disabled={disabled}
          onQueue={onQueue}
          onRemove={() => {}}
          onCollectedChange={() => {}}
        />,
      ),
    );
  };
  function scan(raw: string) {
    const input = host.querySelector<HTMLInputElement>("input")!;
    for (const key of raw)
      act(() => {
        vi.advanceTimersByTime(8);
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: `Digit${key}`,
            bubbles: true,
          }),
        );
      });
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
        }),
      ),
    );
  }
  it("consumes the first physical scan and consecutive scans without stale barcode state", () => {
    onQueue.mockClear();
    showQueue();
    scan("0001");
    expect(onQueue).toHaveBeenNthCalledWith(1, candidates[0], "0.10");
    showQueue(false, [1]);
    scan("0002");
    expect(onQueue).toHaveBeenNthCalledWith(2, candidates[1], "0.10");
  });
  it("manual Enter consumes the current input immediately", () => {
    onQueue.mockClear();
    showQueue();
    const input = host.querySelector<HTMLInputElement>("input")!;
    changeInput(input, "0002");
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(onQueue).toHaveBeenCalledWith(candidates[1], "0.10");
  });
  it("prevents duplicate scans and respects disabled scanner state", () => {
    onQueue.mockClear();
    showQueue();
    scan("0001");
    showQueue(false, [1]);
    scan("0001");
    expect(onQueue).toHaveBeenCalledOnce();
    showQueue(true, [1]);
    scan("0002");
    expect(onQueue).toHaveBeenCalledOnce();
  });
  it("locks queued amounts and removal while the statement draft is disabled", () => {
    showQueue(true, [1]);
    expect((host.querySelector('[aria-label="إزالة من طابور الكشف"]') as HTMLButtonElement).disabled).toBe(true);
    const amount = host.querySelector<HTMLInputElement>('[aria-label^="مبلغ الكشف"]');
    expect(amount?.disabled).toBe(true);
  });
});

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
