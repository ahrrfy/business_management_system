// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBarcodeScanner } from "./useBarcodeScanner";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function ControlledScanField({
  onScan,
  initialValue = "",
}: {
  onScan: (code: string) => void;
  initialValue?: string;
}) {
  const [value, setValue] = useState(initialValue);
  useBarcodeScanner(onScan, { minLength: 3, thresholdMs: 120 });
  return (
    <>
      <input
        aria-label="بحث"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <output data-testid="controlled-value">{value}</output>
    </>
  );
}

describe("useBarcodeScanner — حقل React متحكم به", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("يزيل حرف المسح المتسرّب بعد النجاح ويحافظ على القيمة السابقة للحقل المتحكم به", () => {
    const onScan = vi.fn();
    act(() => root.render(<ControlledScanField onScan={onScan} initialValue="A" />));
    const input = host.querySelector("input");
    expect(input).not.toBeNull();
    input!.focus();

    press(input!, "B", "KeyB");
    press(input!, "5", "Digit5", 10);
    press(input!, "1", "Digit1", 10);
    press(input!, "8", "Digit8", 10);
    press(input!, "Enter", "Enter", 10);

    expect(onScan).toHaveBeenCalledOnce();
    expect(onScan).toHaveBeenCalledWith("B518");
    expect(input!.value).toBe("A");
    expect(host.querySelector("output")?.textContent).toBe("A");
  });

  it("لا يضمّ مفتاحاً يدوياً سابقاً إلى مسحٍ يبدأ بعد 800مي", () => {
    const onScan = vi.fn();
    act(() => root.render(<ControlledScanField onScan={onScan} />));
    const input = host.querySelector("input")!;
    input.focus();

    press(input, "A", "KeyA");
    press(input, "B", "KeyB", 800);
    press(input, "5", "Digit5", 10);
    press(input, "1", "Digit1", 10);
    press(input, "8", "Digit8", 10);
    press(input, "Enter", "Enter", 10);

    expect(onScan).not.toHaveBeenCalled();
    expect(input.value).toBe("AB518");
    expect(host.querySelector("output")?.textContent).toBe("AB518");
  });

  it("لا يعيد كتابة المرشّح اليدوي الخامل أو ينقل الحرف المكتوب وسط قيمة الحقل", () => {
    const onScan = vi.fn();
    act(() => root.render(<ControlledScanField onScan={onScan} initialValue="AC" />));
    const input = host.querySelector("input")!;
    input.focus();
    input.setSelectionRange(1, 1);

    press(input, "B", "KeyB");
    expect(input.value).toBe("ABC");
    act(() => vi.advanceTimersByTime(800));

    expect(onScan).not.toHaveBeenCalled();
    expect(input.value).toBe("ABC");
    expect(host.querySelector("output")?.textContent).toBe("ABC");
  });
});

function press(
  input: HTMLInputElement,
  key: string,
  code: string,
  advanceMs = 0,
): void {
  act(() => {
    vi.advanceTimersByTime(advanceMs);
    const event = new KeyboardEvent("keydown", {
      key,
      code,
      shiftKey: /^[A-Z]$/.test(key),
      bubbles: true,
      cancelable: true,
    });
    const shouldApplyDefault = input.dispatchEvent(event);
    if (!shouldApplyDefault || key.length !== 1) return;

    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    nativeSetter?.call(
      input,
      input.value.slice(0, start) + key + input.value.slice(end),
    );
    input.setSelectionRange(start + key.length, start + key.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
