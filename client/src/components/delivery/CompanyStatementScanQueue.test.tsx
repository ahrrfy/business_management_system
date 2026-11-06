// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyStatementScanQueue } from "./CompanyStatementScanQueue";
import { statementClaimSnapshot } from "./companyStatementQueue";
import { notify } from "@/lib/notify";
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
    Object.assign(globalThis, { React });
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
    expect((host.querySelector('input[aria-label^="مبلغ الكشف"]') as HTMLInputElement).disabled).toBe(true);
  });

  it("adds and removes every invoice in the scanned shipment", () => {
    const onQueueGroup = vi.fn();
    const onRemoveGroup = vi.fn();
    const shipment = [
      { ...candidates[0], shipmentLeaderConsignmentId: 1, shipmentInvoiceCount: 2, remainingDue: "7.50" },
      { ...candidates[1], externalTrackingRef: "0001", shipmentLeaderConsignmentId: 1, shipmentInvoiceCount: 2, remainingDue: "12.25" },
    ];
    const render = (queuedIds: number[]) => act(() => root.render(
      <CompanyStatementScanQueue
        candidates={shipment}
        queuedIds={queuedIds}
        collectedById={{ 1: "1.00", 2: "1.00" }}
        onQueue={onQueueGroup}
        onRemove={onRemoveGroup}
        onCollectedChange={() => {}}
      />,
    ));
    render([]);
    scan("0001");
    expect(onQueueGroup.mock.calls).toEqual([[shipment[0], "7.50"], [shipment[1], "12.25"]]);
    render([1, 2]);
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="إزالة من طابور الكشف"]')!;
    act(() => remove.click());
    expect(onRemoveGroup.mock.calls).toEqual([[1], [2]]);
  });

  it("keeps the entered amount when the live claim changes and permits editing it", () => {
    const onCollectedChange = vi.fn();
    const render = (remainingDue: string) => act(() => root.render(
      <CompanyStatementScanQueue
        candidates={[{ ...candidates[0], remainingDue }]}
        queuedIds={[1]}
        collectedById={{ 1: "1.00" }}
        onQueue={() => {}}
        onRemove={() => {}}
        onCollectedChange={onCollectedChange}
      />,
    ));
    render("7.50");
    let input = host.querySelector<HTMLInputElement>('input[aria-label^="مبلغ الكشف"]')!;
    expect(input.value).toBe("1");
    expect(host.textContent).toContain("7.5");
    changeInput(input, "3");
    expect(onCollectedChange).toHaveBeenCalledWith(1, "3");
    render("12.25");
    input = host.querySelector<HTMLInputElement>('input[aria-label^="مبلغ الكشف"]')!;
    expect(input.value).toBe("1");
    expect(host.textContent).toContain("12.25");
  });

  it("shows the proven custody and unproven parts separately and warns on a changed claim", () => {
    const original = { ...candidates[0], remainingDue: "100", cashInCourierCustody: "70", parcelStatus: "DELIVERED" };
    const render = (remainingDue: string) => act(() => root.render(
      <CompanyStatementScanQueue candidates={[{ ...original, remainingDue }]} queuedIds={[1]}
        collectedById={{ 1: "40" }} claimSnapshots={{ 1: statementClaimSnapshot(original) }}
        onQueue={() => {}} onRemove={() => {}} onCollectedChange={() => {}} />,
    ));
    render("100");
    expect(host.textContent).toContain("نقد مقبوض مثبت باقٍ بعهدة جهة التوصيل: 30");
    expect(host.textContent).toContain("فرق غير مثبت قبضه: 30");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    render("90");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("تغيرت بيانات الفاتورة");
    expect(host.querySelector<HTMLInputElement>('input[aria-label^="مبلغ الكشف"]')?.value).toBe("40");
  });

  it("warns but queues the available members when the recorded count is larger", () => {
    const onQueueGroup = vi.fn();
    vi.mocked(notify.warn).mockClear();
    const member = {
      ...candidates[1],
      externalTrackingRef: null,
      shipmentTrackingRef: "0001",
      shipmentLeaderConsignmentId: 1,
      shipmentInvoiceCount: 2,
    };
    act(() => root.render(
      <CompanyStatementScanQueue
        candidates={[member]}
        queuedIds={[]}
        collectedById={{}}
        onQueue={onQueueGroup}
        onRemove={() => {}}
        onCollectedChange={() => {}}
      />,
    ));
    scan("0001");
    expect(onQueueGroup).toHaveBeenCalledWith(member, "0.10");
    expect(notify.warn).toHaveBeenCalledWith(
      "تحقق من فواتير الشحنة",
      expect.stringContaining("سيتحقق النظام"),
    );
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
