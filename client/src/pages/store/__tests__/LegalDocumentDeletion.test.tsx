// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUseLocation,
  mockSettingsUseQuery,
  mockRequestDeletionUseMutation,
  mockMutate,
  turnstilePropsSpy,
} = vi.hoisted(() => ({
  mockUseLocation: vi.fn(),
  mockSettingsUseQuery: vi.fn(),
  mockRequestDeletionUseMutation: vi.fn(),
  mockMutate: vi.fn(),
  turnstilePropsSpy: vi.fn(),
}));

vi.mock("wouter", () => ({
  useLocation: () => [mockUseLocation(), vi.fn()],
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    storefront: {
      settings: { useQuery: mockSettingsUseQuery },
      requestAccountDeletion: { useMutation: mockRequestDeletionUseMutation },
    },
  },
}));

vi.mock("@/components/storefront/TurnstileWidget", () => ({
  TurnstileWidget: (props: {
    siteKey: string;
    resetKey: number;
    onTokenChange: (token: string | null) => void;
  }) => {
    turnstilePropsSpy(props);
    return (
      <div data-testid="turnstile-widget" data-reset-key={props.resetKey}>
        <button
          type="button"
          data-testid="mock-turnstile-verify"
          onClick={() => props.onTokenChange("ts-valid-token-123")}
        >
          verify
        </button>
      </div>
    );
  },
}));

import LegalDocument from "../../LegalDocument";

let root: Root;
let container: HTMLDivElement;
let lastMutationOpts: {
  onSuccess?: (res: {
    ok: true;
    requestNumber: string;
    retentionDays: number;
  }) => void;
  onError?: (err: { message?: string }) => void;
} = {};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mockUseLocation.mockReturnValue("/legal/delete-account");
  mockMutate.mockReset();
  turnstilePropsSpy.mockReset();
  lastMutationOpts = {};

  mockSettingsUseQuery.mockReturnValue({
    data: { orderingEnabled: true, turnstileSiteKey: null },
    isLoading: false,
  });

  mockRequestDeletionUseMutation.mockImplementation((opts: typeof lastMutationOpts) => {
    lastMutationOpts = opts ?? {};
    return {
      mutate: mockMutate,
      isPending: false,
    };
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("LegalDocument /legal/delete-account interactive deletion request", () => {
  it("discloses 365-day accounting retention policy and mobile OTP immediate deletion option", () => {
    act(() => root.render(<LegalDocument />));

    expect(mockSettingsUseQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: true }),
    );
    expect(container.textContent).toContain("365");
    expect(container.textContent).toContain("سنة واحدة");
    expect(container.textContent).toContain("تطبيق الجوال");
  });

  it("does not query storefront.settings on non-deletion legal pages", () => {
    mockUseLocation.mockReturnValue("/legal/privacy");
    act(() => root.render(<LegalDocument />));

    expect(mockSettingsUseQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: false }),
    );
  });

  it("validates Iraqi mobile phone before calling requestAccountDeletion", () => {
    act(() => root.render(<LegalDocument />));

    const phoneInput = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;
    expect(phoneInput).toBeTruthy();

    setInputValue(phoneInput, "12345");
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mockMutate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("07");
  });

  it("submits phone + optional reason without Turnstile when turnstileSiteKey is null and displays ADR requestNumber", () => {
    act(() => root.render(<LegalDocument />));

    expect(container.querySelector('[data-testid="turnstile-widget"]')).toBeNull();

    const phoneInput = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const reasonInput = container.querySelector("textarea") as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;
    expect(reasonInput).toBeTruthy();

    setInputValue(phoneInput, "0770 123 4567");
    setInputValue(reasonInput, "لم أعد أستخدم الحساب");

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledWith({
      phone: "07701234567",
      reason: "لم أعد أستخدم الحساب",
      turnstileToken: undefined,
    });

    act(() => {
      lastMutationOpts.onSuccess?.({
        ok: true,
        requestNumber: "ADR-100042",
        retentionDays: 365,
      });
    });

    expect(container.textContent).toContain("ADR-100042");
    expect(container.textContent).toContain("365");
  });

  it("gates submission on TurnstileWidget when turnstileSiteKey is configured and resets token on error", () => {
    mockSettingsUseQuery.mockReturnValue({
      data: { orderingEnabled: true, turnstileSiteKey: "cf-site-key-live" },
      isLoading: false,
    });
    act(() => root.render(<LegalDocument />));

    const widget = container.querySelector('[data-testid="turnstile-widget"]');
    expect(widget).toBeTruthy();

    const phoneInput = container.querySelector('input[type="tel"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;
    setInputValue(phoneInput, "07801112233");

    // Submit before completing Turnstile -> blocked
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mockMutate).not.toHaveBeenCalled();

    // Complete Turnstile challenge
    const verifyBtn = container.querySelector(
      '[data-testid="mock-turnstile-verify"]',
    ) as HTMLButtonElement;
    act(() => {
      verifyBtn.click();
    });

    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mockMutate).toHaveBeenCalledWith({
      phone: "07801112233",
      reason: undefined,
      turnstileToken: "ts-valid-token-123",
    });

    // Simulate backend error -> shows message & increments resetKey
    act(() => {
      lastMutationOpts.onError?.({
        message: "يوجد طلب نشط قيد التنفيذ على هذا الحساب",
      });
    });

    expect(container.textContent).toContain(
      "يوجد طلب نشط قيد التنفيذ على هذا الحساب",
    );
    expect(
      container
        .querySelector('[data-testid="turnstile-widget"]')
        ?.getAttribute("data-reset-key"),
    ).toBe("1");
  });
});
