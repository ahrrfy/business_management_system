// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyStatementScanQueue } from "./CompanyStatementScanQueue";

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
    const statementInput = host.querySelector<HTMLInputElement>("#statement-number")!;
    statementInput.focus();

    changeInput(statementInput, "AB");
    act(() => vi.advanceTimersByTime(50));

    expect(document.activeElement).toBe(statementInput);
  });

  it("يربط حقل قارئ الباركود بتسمية عربية ظاهرة", () => {
    act(() => root.render(<StatementHarness />));
    const label = Array.from(host.querySelectorAll("label"))
      .find((candidate) => candidate.textContent?.includes("طابور كشف الشركة بالباركود"));

    expect(label?.htmlFor).toBeTruthy();
    const scanner = document.getElementById(label!.htmlFor);
    expect(scanner).toBeInstanceOf(HTMLInputElement);
    expect(scanner?.getAttribute("dir")).toBe("ltr");
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
