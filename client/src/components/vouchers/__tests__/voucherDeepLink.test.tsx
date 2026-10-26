// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoucherDeepLinkDialog } from "../VoucherDeepLinkDialog";

vi.mock("@/components/financial/AccountLedgerDrilldownDialog", () => ({
  AccountLedgerDrilldownDialog: ({
    target,
    onOpenChange,
  }: {
    target: { receiptId: number };
    onOpenChange: (open: boolean) => void;
  }) => (
    <button data-receipt={target.receiptId} onClick={() => onOpenChange(false)}>
      إغلاق السند
    </button>
  ),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function open(url: string) {
  window.history.replaceState(null, "", url);
  await act(async () => root.render(<VoucherDeepLinkDialog />));
}

describe("voucher document links", () => {
  it("opens the exact receipt and preserves the tab and filters when dismissed", async () => {
    await open("/treasury?tab=vouchers&q=PV-17&branch=2&voucherId=17");
    expect(host.querySelector("button")?.getAttribute("data-receipt")).toBe(
      "17",
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>("button")!.click(),
    );
    const params = new URLSearchParams(window.location.search);
    expect(params.has("voucherId")).toBe(false);
    expect(params.get("tab")).toBe("vouchers");
    expect(params.get("q")).toBe("PV-17");
    expect(params.get("branch")).toBe("2");
    expect(host.querySelector("button")).toBeNull();
  });

  it("follows another linked receipt while the same page stays mounted", async () => {
    await open("/treasury?tab=vouchers&voucherId=17");
    await act(async () =>
      window.history.pushState(null, "", "/treasury?tab=vouchers&voucherId=22"),
    );
    expect(host.querySelector("button")?.getAttribute("data-receipt")).toBe(
      "22",
    );
  });

  it.each(["0", "-3", "3.5", "NaN", "9007199254740993"])(
    "does not open an invalid receipt ID %s",
    async (id) => {
      await open(`/treasury?tab=vouchers&voucherId=${id}`);
      expect(host.querySelector("button")).toBeNull();
    },
  );
});
