// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useReceptionShortcuts,
  type ReceptionShortcutsInput,
} from "@/components/reception/ReceptionShortcuts";

function input(
  overrides: Partial<ReceptionShortcutsInput> = {},
): ReceptionShortcutsInput {
  return {
    draftTransitionPending: false,
    blockingDialogOpen: false,
    showCustomization: false,
    showReceiptOverlay: false,
    cashDropping: false,
    approvalOpen: false,
    showInbox: false,
    depositMenuOpen: false,
    discountOpen: false,
    showDrop: false,
    cardsOpen: false,
    offline: false,
    depositOpen: false,
    canOpenCards: true,
    onReprint: vi.fn(),
    onFocusSearch: vi.fn(),
    onSubmit: vi.fn(),
    onClear: vi.fn(),
    onCloseApproval: vi.fn(),
    onCloseDiscount: vi.fn(),
    setShowReceiptOverlay: vi.fn(),
    setCashDropping: vi.fn(),
    setCardsOpen: vi.fn(),
    setDepositOpen: vi.fn(),
    setShowInbox: vi.fn(),
    setDepositMenuOpen: vi.fn(),
    setShowDrop: vi.fn(),
    ...overrides,
  };
}
let root: Root;
function Harness({ value }: { value: ReceptionShortcutsInput }) {
  useReceptionShortcuts(value);
  return null;
}
const press = (key: string) =>
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, cancelable: true }),
    );
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
describe("Reception keyboard modal guards", () => {
  it("blocks checkout, clear and card shortcuts while a deposit or another blocking dialog is open", () => {
    const value = input({ blockingDialogOpen: true, depositOpen: true });
    act(() => root.render(<Harness value={value} />));
    for (const key of ["F3", "F4", "F12"]) press(key);
    expect(value.onSubmit).not.toHaveBeenCalled();
    expect(value.onClear).not.toHaveBeenCalled();
    expect(value.setCardsOpen).not.toHaveBeenCalled();
    press("Escape");
    expect(value.setDepositOpen).toHaveBeenCalledWith(false);
    act(() =>
      root.render(
        <Harness
          value={{ ...value, blockingDialogOpen: false, depositOpen: false }}
        />,
      ),
    );
    press("F4");
    press("F12");
    expect(value.onSubmit).toHaveBeenCalledOnce();
    expect(value.onClear).toHaveBeenCalledOnce();
  });
  it("keeps receipt reprint and close available without allowing checkout behind the receipt", () => {
    const value = input({ showReceiptOverlay: true });
    act(() => root.render(<Harness value={value} />));
    press("F4");
    press("F12");
    press("F9");
    press("Escape");
    expect(value.onSubmit).not.toHaveBeenCalled();
    expect(value.onClear).not.toHaveBeenCalled();
    expect(value.onReprint).toHaveBeenCalledOnce();
    expect(value.setShowReceiptOverlay).toHaveBeenCalledWith(false);
  });
});
