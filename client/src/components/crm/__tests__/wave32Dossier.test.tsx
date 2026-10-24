// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  allowed: true,
  invite: vi.fn(),
  resolve: vi.fn(),
  openWhatsApp: vi.fn(),
  oldClose: null as (() => void) | null,
  cache: null as any,
}));
vi.mock("@/lib/catalogPeopleOperationAccess", () => ({
  useCatalogPeopleOperationAccess: () => ({
    can: (path: string) => path !== "customers.dossier360" || state.allowed,
  }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      customers: {
        dossier360: { invalidate: vi.fn() },
        feedbackList: { invalidate: vi.fn() },
      },
    }),
    auth: { me: { useQuery: () => ({ data: { role: "admin" } }) } },
    customers: {
      dossier360: {
        useQuery: ({ customerId }: { customerId: number }) => ({
          data: {
            ...state.cache,
            customer: {
              ...state.cache.customer,
              id: customerId,
              name: `عميل ${customerId}`,
            },
          },
          refetch: vi.fn(),
        }),
      },
      updateFeedbackStatus: { useMutation: () => ({ mutate: state.resolve }) },
      markGoogleReviewInviteSent: {
        useMutation: () => ({ mutate: state.invite }),
      },
    },
  },
}));
vi.mock("@/lib/whatsapp", () => ({
  openWhatsApp: state.openWhatsApp,
  preferredWhatsAppPhone: () => "07701234567",
  buildGoogleReviewInviteWhatsAppMessage: () => "دعوة",
  buildInstantGiftWhatsAppMessage: () => "هدية",
}));
vi.mock("@/lib/printing/giftVoucherPrint", () => ({
  printGiftVoucherDoc: vi.fn(),
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: any) => <div>{children}</div>,
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
  SheetDescription: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: any) => <div>{children}</div>,
  TabsContent: ({ children }: any) => <div>{children}</div>,
  TabsList: ({ children }: any) => <div>{children}</div>,
  TabsTrigger: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("../CustomerDossierTimeline", () => ({
  CustomerDossierTimeline: () => null,
}));
vi.mock("../InstantGiftModal", () => ({
  InstantGiftModal: () => <div>هدية مفتوحة</div>,
}));
vi.mock("../FeedbackModal", () => ({
  FeedbackModal: ({ open, onClose, customerId }: any) => {
    if (!open) return null;
    state.oldClose = onClose;
    return <button onClick={onClose}>إلغاء تقييم عميل {customerId}</button>;
  },
}));
import { CustomerDossierDrawer } from "../CustomerDossierDrawer";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
describe("customer dossier guarded sessions and truthful actions", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    state.allowed = true;
    state.invite.mockClear();
    state.resolve.mockClear();
    state.openWhatsApp.mockClear();
    state.oldClose = null;
    state.cache = {
      customer: { id: 1, name: "عميل 1", phone: "07701234567" },
      metrics: {
        balance: "123456",
        lifetimeValue: "0",
        avgInvoiceValue: "0",
        creditLimit: null,
        feedbackSummary: {
          averageRating: 5,
          openComplaintsCount: 1,
          totalReviews: 1,
          resolvedComplaintsCount: 0,
        },
      },
      recentFeedback: [
        {
          id: 7,
          rating: 5,
          category: "GENERAL",
          issueStatus: "NEW",
          createdAt: new Date("2026-10-24T00:00:00Z"),
        },
      ],
      recentCoupons: [],
      recentInvoices: [],
      recentWorkOrders: [],
    };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  function render(customerId = 1, open = true) {
    act(() =>
      root.render(
        <CustomerDossierDrawer
          customerId={customerId}
          open={open}
          onClose={vi.fn()}
        />,
      ),
    );
  }
  function click(text: string) {
    const b = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(text),
    );
    expect(b, text).toBeDefined();
    act(() => b!.click());
  }
  it("hides an already cached dossier when its operation is revoked", () => {
    render();
    expect(host.textContent).toContain("عميل 1");
    state.allowed = false;
    render();
    expect(host.textContent).not.toContain("عميل 1");
    expect(host.textContent).not.toContain("إهداء");
  });
  it("records an invitation only after the operator confirms sending", () => {
    render();
    click("دعوة Google");
    expect(state.openWhatsApp).toHaveBeenCalledOnce();
    expect(state.invite).not.toHaveBeenCalled();
    click("لم أرسلها");
    expect(state.invite).not.toHaveBeenCalled();
    click("دعوة Google");
    click("تأكيد إرسال الدعوة");
    expect(state.invite).toHaveBeenCalledWith(
      { customerId: 1, feedbackId: 7 },
      expect.any(Object),
    );
  });
  it("does not assert compensation or customer satisfaction when only resolving status", () => {
    render();
    click("إغلاق وحل");
    expect(state.resolve).toHaveBeenCalledWith({
      customerId: 1,
      feedbackId: 7,
      issueStatus: "RESOLVED",
      resolutionAction: "تمت معالجة الشكوى",
    });
  });
  it("does not clear a newer confirmation when an earlier request finishes", () => {
    render();
    click("دعوة Google");
    click("تأكيد إرسال الدعوة");
    const completion = state.invite.mock.calls[0][1].onSuccess;
    click("دعوة Google");
    act(() => completion());
    expect(host.textContent).toContain("تأكيد إرسال الدعوة");
  });
  it("does not transfer an open gift or complaint to a different customer or reopening", () => {
    render();
    click("إهداء فوري");
    expect(host.textContent).toContain("هدية مفتوحة");
    render(2);
    expect(host.textContent).not.toContain("هدية مفتوحة");
    click("تسجيل تقييم");
    expect(host.textContent).toContain("إلغاء تقييم عميل 2");
    render(2, false);
    render(2);
    expect(host.textContent).not.toContain("إلغاء تقييم عميل");
  });
  it("ignores an earlier cancelled modal's late close callback", () => {
    render();
    click("تسجيل تقييم");
    const earlierClose = state.oldClose!;
    click("إلغاء تقييم");
    click("تسجيل تقييم");
    act(() => earlierClose());
    expect(host.textContent).toContain("إلغاء تقييم عميل 1");
  });
});
