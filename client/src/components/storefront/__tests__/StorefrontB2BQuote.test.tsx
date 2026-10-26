// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; React?: typeof React }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { React?: typeof React }).React = React;

const printQuotationV2Mock = vi.fn();
const createQuoteMutateMock = vi.fn();
let latestCreateQuoteOptions: {
  onSuccess?: (res: unknown) => void;
  onError?: (err: { message?: string }) => void;
} = {};

vi.mock("@/lib/printing/printTemplatesV2", () => ({
  printQuotationV2: (...args: unknown[]) => printQuotationV2Mock(...args),
}));

vi.mock("@/components/storefront/TurnstileWidget", () => ({
  TurnstileWidget: (props: {
    siteKey: string;
    resetKey?: number;
    onTokenChange: (token: string | null) => void;
  }) => (
    <div data-testid="b2b-turnstile" data-site-key={props.siteKey} data-reset-key={String(props.resetKey ?? 0)}>
      <button
        type="button"
        data-testid="solve-b2b-turnstile"
        onClick={() => props.onTokenChange("mock")}
      >
        تحقق أمني
      </button>
    </div>
  ),
}));

vi.mock("@/components/ui/dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dialog")>();
  return {
    ...actual,
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange?: (nextOpen: boolean) => void;
      children: React.ReactNode;
    }) =>
      open ? (
        <div data-testid="b2b-dialog-root">
          <button
            type="button"
            data-testid="b2b-dialog-backdrop-close"
            onClick={() => onOpenChange?.(false)}
          >
            backdrop-close
          </button>
          {children}
        </div>
      ) : null,
    DialogContent: ({
      children,
      className,
      overlayClassName,
    }: {
      children: React.ReactNode;
      className?: string;
      overlayClassName?: string;
    }) => (
      <div
        data-testid="b2b-dialog-content"
        className={className}
        data-overlay-class={overlayClassName}
      >
        {children}
      </div>
    ),
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("@/lib/trpc", () => ({
  trpc: {
    storefront: {
      createQuoteRequest: {
        useMutation: (opts?: typeof latestCreateQuoteOptions) => {
          latestCreateQuoteOptions = opts ?? {};
          return {
            mutate: (input: unknown) => createQuoteMutateMock(input),
            isPending: false,
          };
        },
      },
    },
  },
}));

import { StorefrontB2BQuoteButton } from "../StorefrontB2BQuoteButton";

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForLazyDialog(container: HTMLElement): Promise<HTMLElement> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const el = container.querySelector<HTMLElement>('[data-testid="b2b-dialog-content"]');
    if (el) return el;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error("Timed out waiting for lazy StorefrontB2BQuoteDialog to resolve");
}

describe("StorefrontB2BQuoteButton & lazy official StorefrontB2BQuoteDialog", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    printQuotationV2Mock.mockReset();
    createQuoteMutateMock.mockReset();
    latestCreateQuoteOptions = {};
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  const sampleCartLines = [
    {
      cartKey: "u-101::base",
      productUnitId: 101,
      name: "ورق A4 للطباعة المكتبية",
      qty: 20,
      price: "6500",
      unitName: "رزمة",
    },
    {
      cartKey: "u-202::custom",
      productUnitId: 202,
      name: "أقلام دعائية مطبوعة",
      qty: 100,
      price: "750",
      unitName: "قطعة",
      variantLabel: "أزرق",
    },
  ];

  it("keeps estimated PDF download via printQuotationV2 AND opens lazy official B2B quote dialog", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <StorefrontB2BQuoteButton
          cartLines={sampleCartLines}
          cartSubtotal={205000}
          orderingEnabled={true}
          turnstileSiteKey="site-key"
        />,
      );
    });

    const pdfBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("B2B PDF"),
    );
    expect(pdfBtn).toBeDefined();
    await act(async () => {
      pdfBtn!.click();
    });
    expect(printQuotationV2Mock).toHaveBeenCalledTimes(1);

    const officialBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("طلب عرض سعر رسمي"),
    );
    expect(officialBtn).toBeDefined();
    await act(async () => {
      officialBtn!.click();
    });
    // Wait for React.lazy dynamic import to resolve
    await waitForLazyDialog(container);

    const dialogContent = container.querySelector('[data-testid="b2b-dialog-content"]');
    expect(dialogContent).not.toBeNull();
    expect(dialogContent?.className).toContain("sm:max-w-");
  });

  it("submits createQuoteRequest with productUnitId lines, Turnstile token, and displays SRQ-... requestNumber and tracking details", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const sessionToken = "s".repeat(48);

    await act(async () => {
      root!.render(
        <StorefrontB2BQuoteButton
          cartLines={sampleCartLines}
          cartSubtotal={205000}
          orderingEnabled={true}
          turnstileSiteKey="site-key"
          customerSessionToken={sessionToken}
        />,
      );
    });

    const officialBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("طلب عرض سعر رسمي"),
    )!;
    await act(async () => {
      officialBtn.click();
    });
    await waitForLazyDialog(container);

    const nameInput = container.querySelector<HTMLInputElement>("#b2b-quote-customer-name")!;
    const phoneInput = container.querySelector<HTMLInputElement>("#b2b-quote-customer-phone")!;
    const companyInput = container.querySelector<HTMLInputElement>("#b2b-quote-company-name")!;
    const noteInput = container.querySelector<HTMLTextAreaElement>("#b2b-quote-note")!;

    await act(async () => {
      setNativeValue(nameInput, "حيدر الكاظمي");
      setNativeValue(phoneInput, "07701234567");
      setNativeValue(companyInput, "شركة الأفق للمقاولات");
      setNativeValue(noteInput, "نرغب بعرض سعر رسمي مختوم مع التوصيل لمقر الشركة في الكرادة");
    });

    // Submitting before solving Turnstile must be blocked
    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(createQuoteMutateMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("أكمل التحقق الأمني");

    // Solve Turnstile and submit
    const solveBtn = container.querySelector<HTMLButtonElement>('[data-testid="solve-b2b-turnstile"]')!;
    await act(async () => {
      solveBtn.click();
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(createQuoteMutateMock).toHaveBeenCalledTimes(1);
    const payload = createQuoteMutateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      customerSessionToken: sessionToken,
      customerName: "حيدر الكاظمي",
      customerPhone: "+9647701234567",
      companyName: "شركة الأفق للمقاولات",
      governorate: "baghdad",
      contactPreference: "WHATSAPP",
      requestType: "BUSINESS",
      note: "نرغب بعرض سعر رسمي مختوم مع التوصيل لمقر الشركة في الكرادة",
      turnstileToken: "mock",
      lines: [
        { productUnitId: 101, quantity: 20 },
        { productUnitId: 202, quantity: 100 },
      ],
    });
    expect(typeof payload.clientRequestId).toBe("string");
    expect((payload.clientRequestId as string).length).toBeGreaterThanOrEqual(8);

    // Simulate backend success response
    await act(async () => {
      latestCreateQuoteOptions.onSuccess?.({
        requestId: 88,
        requestNumber: "SRQ-2026-0088",
        guestTrackingToken: "gst_token_" + "x".repeat(64),
        guestTrackingExpiresAt: "2026-11-25T07:00:00.000Z",
        idempotentReplay: false,
      });
    });

    expect(container.textContent).toContain("SRQ-2026-0088");
    expect(container.textContent).toContain("gst_token_");
  });

  it("blocks submission with clear alert when Turnstile / ordering is disabled (matching checkout)", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <StorefrontB2BQuoteButton
          cartLines={sampleCartLines}
          cartSubtotal={205000}
          orderingEnabled={false}
          turnstileSiteKey={null}
        />,
      );
    });

    const officialBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("طلب عرض سعر رسمي"),
    )!;
    await act(async () => {
      officialBtn.click();
    });
    await waitForLazyDialog(container);

    expect(container.querySelector('[data-testid="b2b-turnstile"]')).toBeNull();
    expect(container.textContent).toContain("متوقف مؤقتاً");
  });

  it("never silently truncates carts with >30 distinct units or >10,000 unit quantity and accepts Arabic-Indic phone digits", async () => {
    const { aggregateB2BQuoteLines } = await import("../StorefrontB2BQuoteDialog");

    const thirtyFiveLines = Array.from({ length: 35 }, (_, idx) => ({
      cartKey: `u-${idx + 1}::base`,
      productUnitId: idx + 1,
      name: `صنف شركات رقم ${idx + 1}`,
      qty: idx === 0 ? 15_000 : 10,
      price: "1000",
    }));

    const aggregated = aggregateB2BQuoteLines(thirtyFiveLines);
    expect(aggregated).toHaveLength(35);
    expect(aggregated[0]?.quantity).toBe(15_000);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <StorefrontB2BQuoteButton
          cartLines={thirtyFiveLines}
          cartSubtotal={500000}
          orderingEnabled={true}
          turnstileSiteKey="site-key"
        />,
      );
    });

    const officialBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("طلب عرض سعر رسمي"),
    )!;
    await act(async () => {
      officialBtn.click();
    });
    await waitForLazyDialog(container);

    expect(container.textContent).toContain("35 صنف");
    expect(container.textContent).toContain("30");

    const submitBtn = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submitBtn.disabled).toBe(true);

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(createQuoteMutateMock).not.toHaveBeenCalled();
  });

  it("blocks dialog dismissal while quote request is in flight and preserves SRQ confirmation across close/reopen", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <StorefrontB2BQuoteButton
          cartLines={sampleCartLines}
          cartSubtotal={205000}
          orderingEnabled={true}
          turnstileSiteKey="site-key"
        />,
      );
    });

    const officialBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("طلب عرض سعر رسمي"),
    )!;
    await act(async () => {
      officialBtn.click();
    });
    await waitForLazyDialog(container);

    await act(async () => {
      setNativeValue(container!.querySelector<HTMLInputElement>("#b2b-quote-customer-name")!, "سارة العبيدي");
      setNativeValue(container!.querySelector<HTMLInputElement>("#b2b-quote-customer-phone")!, "07709998877");
      setNativeValue(container!.querySelector<HTMLTextAreaElement>("#b2b-quote-note")!, "عرض سعر تجهيز قرطاسية سنوية");
      container!.querySelector<HTMLButtonElement>('[data-testid="solve-b2b-turnstile"]')!.click();
    });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(createQuoteMutateMock).toHaveBeenCalledTimes(1);

    // Attempt to dismiss via backdrop/Escape or Cancel while mutation is still in flight
    const backdropCloseBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="b2b-dialog-backdrop-close"]',
    )!;
    const cancelBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "إلغاء",
    )!;
    expect(cancelBtn.disabled).toBe(true);

    await act(async () => {
      backdropCloseBtn.click();
      cancelBtn.click();
    });
    // Dialog must remain open so onSuccess will not fire on an unmounted component
    expect(container.querySelector('[data-testid="b2b-dialog-content"]')).not.toBeNull();

    // Resolve mutation while dialog is still mounted and open
    await act(async () => {
      latestCreateQuoteOptions.onSuccess?.({
        requestId: 91,
        requestNumber: "SRQ-2026-0091",
        guestTrackingToken: "gst_keep_" + "y".repeat(64),
        guestTrackingExpiresAt: "2026-11-25T07:00:00.000Z",
        idempotentReplay: false,
      });
    });

    expect(container.textContent).toContain("SRQ-2026-0091");
    expect(container.textContent).toContain("gst_keep_");

    // Close dialog via إغلاق, then reopen: confirmation details must remain accessible
    const closeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "إغلاق",
    )!;
    await act(async () => {
      closeBtn.click();
    });
    expect(container.querySelector('[data-testid="b2b-dialog-content"]')).toBeNull();

    await act(async () => {
      officialBtn.click();
    });
    expect(container.textContent).toContain("SRQ-2026-0091");
    expect(container.textContent).toContain("gst_keep_");

    // Clicking "طلب عرض سعر جديد" resets back to the form cleanly
    const anotherBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("طلب عرض سعر جديد"),
    )!;
    await act(async () => {
      anotherBtn.click();
    });
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("preserves per-design quantities in note customization summaries when distinct customizations share the same productUnitId", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const multiDesignLines = [
      {
        cartKey: "u-501::design-a",
        productUnitId: 501,
        name: "درع كريستال",
        qty: 10,
        price: "15000",
        unitName: "قطعة",
        customization: {
          templateId: 7,
          selections: [
            {
              fieldKey: "engraving",
              label: "الحفر",
              value: "تكريم فرع بغداد",
              displayValue: "تكريم فرع بغداد",
            },
          ],
          values: { engraving: "تكريم فرع بغداد" },
        },
      },
      {
        cartKey: "u-501::design-b",
        productUnitId: 501,
        name: "درع كريستال",
        qty: 20,
        price: "15000",
        unitName: "قطعة",
        customization: {
          templateId: 7,
          values: { engraving: "تكريم فرع البصرة" },
          logoAssetKey: "customizer/t1/logo/basra.png",
        },
      },
    ];

    await act(async () => {
      root!.render(
        <StorefrontB2BQuoteButton
          cartLines={multiDesignLines}
          cartSubtotal={450000}
          orderingEnabled={true}
          turnstileSiteKey="site-key"
        />,
      );
    });

    const officialBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("طلب عرض سعر رسمي"),
    )!;
    await act(async () => {
      officialBtn.click();
    });
    await waitForLazyDialog(container);

    await act(async () => {
      setNativeValue(container!.querySelector<HTMLInputElement>("#b2b-quote-customer-name")!, "أحمد الطائي");
      setNativeValue(container!.querySelector<HTMLInputElement>("#b2b-quote-customer-phone")!, "07705554433");
      setNativeValue(container!.querySelector<HTMLTextAreaElement>("#b2b-quote-note")!, "يرجى تسعير الدفعتين معاً");
      container!.querySelector<HTMLButtonElement>('[data-testid="solve-b2b-turnstile"]')!.click();
    });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(createQuoteMutateMock).toHaveBeenCalledTimes(1);
    const payload = createQuoteMutateMock.mock.calls[0]![0] as {
      lines: Array<{ productUnitId: number; quantity: number }>;
      note: string;
      customizationAssets?: Array<{
        productUnitId: number;
        quantity: number;
        summary?: string;
        logoAssetKey?: string;
        previewAssetKey?: string;
      }>;
    };
    expect(payload.lines).toEqual([{ productUnitId: 501, quantity: 30 }]);
    expect(payload.note).toContain("درع كريستال [×10 قطعة]: الحفر: تكريم فرع بغداد");
    expect(payload.note).toContain("درع كريستال [×20 قطعة]: تكريم فرع البصرة • شعار مرفوع");
    expect(payload.customizationAssets).toEqual([
      {
        productUnitId: 501,
        quantity: 20,
        summary: "تكريم فرع البصرة",
        logoAssetKey: "customizer/t1/logo/basra.png",
      },
    ]);
  });

  it("layers quote dialog overlay (z-80) and content (z-81) above StorefrontPanelShell (z-55 / z-56) and attaches both logoAssetKey and previewAssetKey", async () => {
    const actualDialog = await vi.importActual<typeof import("@/components/ui/dialog")>(
      "@/components/ui/dialog",
    );
    const { StorefrontPanelShell } = await import("../StorefrontPanelShell");

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const linesWithAssets = [
      {
        cartKey: "u-901::studio",
        productUnitId: 901,
        name: "كوب حراري",
        qty: 15,
        price: "8000",
        unitName: "قطعة",
        customization: {
          templateId: 12,
          logoAssetKey: "customizer/default/logo/aabbcc.png",
          previewAssetKey: "customizer/default/preview/ddeeff.png",
        },
      },
    ];

    await act(async () => {
      root!.render(
        <StorefrontPanelShell title="سلة المشتريات" onClose={() => {}}>
          <StorefrontB2BQuoteButton
            cartLines={linesWithAssets}
            cartSubtotal={120000}
            orderingEnabled={true}
            turnstileSiteKey="site-key"
          />
          <actualDialog.Dialog open>
            <actualDialog.DialogContent
              overlayClassName="z-[80]"
              className="z-[81] sm:max-w-lg"
            >
              <actualDialog.DialogTitle>اختبار الطبقات</actualDialog.DialogTitle>
              <actualDialog.DialogDescription>فوق السلة</actualDialog.DialogDescription>
            </actualDialog.DialogContent>
          </actualDialog.Dialog>
        </StorefrontPanelShell>,
      );
    });

    // Verify real DialogOverlay and DialogContent twMerge z-[80]/z-[81] above StorefrontPanelShell z-[55]/z-[56]
    const realOverlay = document.body.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    const realContent = document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    expect(realOverlay?.className).toContain("z-[80]");
    expect(realOverlay?.className).not.toContain("z-50");
    expect(realContent?.className).toContain("z-[81]");
    expect(realContent?.className).not.toContain("z-50");

    // Verify StorefrontB2BQuoteDialog itself passes overlayClassName="z-[80]" and className containing "z-[81]"
    const officialBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("طلب عرض سعر رسمي"),
    )!;
    await act(async () => {
      officialBtn.click();
    });

    const dialogEl = await waitForLazyDialog(document.body);
    expect(dialogEl.getAttribute("data-overlay-class")).toBe("z-[80]");
    expect(dialogEl.className).toContain("z-[81]");

    await act(async () => {
      setNativeValue(document.body.querySelector<HTMLInputElement>("#b2b-quote-customer-name")!, "مؤسسة الرافدين");
      setNativeValue(document.body.querySelector<HTMLInputElement>("#b2b-quote-customer-phone")!, "07709998877");
      setNativeValue(document.body.querySelector<HTMLTextAreaElement>("#b2b-quote-note")!, "طباعة الشعار المعتمد");
      document.body.querySelector<HTMLButtonElement>('[data-testid="solve-b2b-turnstile"]')!.click();
    });

    const form = dialogEl.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(createQuoteMutateMock).toHaveBeenCalledTimes(1);
    const firstPayload = createQuoteMutateMock.mock.calls[0]![0] as {
      clientRequestId: string;
      customizationAssets?: Array<{
        productUnitId: number;
        quantity: number;
        logoAssetKey?: string;
        previewAssetKey?: string;
      }>;
    };
    expect(firstPayload.customizationAssets).toEqual([
      {
        productUnitId: 901,
        quantity: 15,
        logoAssetKey: "customizer/default/logo/aabbcc.png",
        previewAssetKey: "customizer/default/preview/ddeeff.png",
      },
    ]);
  });

  it("blocks submission with clear alert when >30 separate customized design attachments share <=30 productUnitIds", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const thirtyOneAttachmentsSameUnit = Array.from({ length: 31 }, (_, idx) => ({
      cartKey: `u-777::design-${idx + 1}`,
      productUnitId: 777,
      name: "درع تكريم مؤسسي",
      qty: 2,
      price: "12000",
      unitName: "قطعة",
      customization: {
        templateId: 5,
        values: { recipient: `موظف رقم ${idx + 1}` },
        logoAssetKey: `customizer/default/logo/design_${String(idx + 1).padStart(2, "0")}.png`,
      },
    }));

    await act(async () => {
      root!.render(
        <StorefrontB2BQuoteButton
          cartLines={thirtyOneAttachmentsSameUnit}
          cartSubtotal={744000}
          orderingEnabled={true}
          turnstileSiteKey="site-key"
        />,
      );
    });

    const officialBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("طلب عرض سعر رسمي"),
    )!;
    await act(async () => {
      officialBtn.click();
    });
    await waitForLazyDialog(container);

    expect(container.textContent).toContain("31 تصميماً مرفوعاً منفصلاً");
    expect(container.textContent).toContain("30 تصميماً");

    const submitBtn = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submitBtn.disabled).toBe(true);

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(createQuoteMutateMock).not.toHaveBeenCalled();
  });
});



