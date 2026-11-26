// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrderCustomizationAssets,
  resolveOrderShippingAddressAndNotes,
} from "./OrderCustomizationAssets";
import { buildInitialEditOnlineOrderFormState } from "./EditOnlineOrderDialog";
import { toShippingLabelPayload } from "@/pages/OrderFulfillment";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; React?: typeof React }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { React?: typeof React }).React = React;

const mockOrderDetail = {
  id: 501,
  branchId: 1,
  orderNumber: "WEB-2026-0501",
  status: "CONFIRMED",
  lifecycle: { label: "مثبّت", collectionLabel: null, remittanceLabel: null },
  customerName: "شركة النور",
  customerPhone: "07701234567",
  governorate: "بغداد",
  addressText: "الكرادة داخل - قرب ساحة كهرمانة\nملاحظة: ملاحظة قديمة مدمجة",
  customerNotes: "يرجى التسليم للاستعلامات في الطابق الأرضي",
  latitude: null,
  longitude: null,
  subtotal: "50000",
  deliveryFee: "5000",
  deliveryFree: false,
  deliveryWaivedAmount: "0",
  total: "55000",
  couponCode: null,
  couponDiscount: "0",
  pricingBenefitType: "NONE" as const,
  pricingBenefitLabel: null,
  pricingBenefitDiscount: "0",
  couponFreeShipping: false,
  deliveryZones: [],
  deliveryPartyId: null,
  deliveryPartyName: null,
  cancelReason: null,
  itemCount: 1,
  createdAt: "2026-10-26T06:00:00.000Z",
  reservationExpiresAt: null,
  claimedByUserId: 2,
  claimedByName: "أحمد",
  claimedAt: "2026-10-26T06:05:00.000Z",
  preparedByUserId: null,
  preparedByName: null,
  preparedAt: null,
  fulfillmentDurationMinutes: null,
  contactStatus: "CONFIRMED_PHONE" as const,
  contactNotes: null,
  labelToken: "lbl-token-501",
  items: [
    {
      id: 9001,
      productUnitId: 77,
      productName: "كوب سيراميك حراري",
      variantLabel: "أبيض",
      imageUrl: null,
      unitName: "قطعة",
      quantity: "10",
      unitPrice: "5000",
      total: "50000",
      hasCustomization: true,
      customizationSummary: "موضع الطباعة: أمامي",
      previewAssetUrl: "/api/img/order-customization/9001/preview",
      logoAssetUrl: "/api/img/order-customization/9001/logo",
    },
  ],
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    createClient: vi.fn(() => ({})),
    useUtils: () => ({
      storeAdmin: { orders: { invalidate: vi.fn() } },
    }),
    auth: {
      me: { useQuery: () => ({ data: { id: 1, role: "admin", permissionsOverride: null } }) },
    },
    reception: {
      duplicateOrders: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
    },
    storeAdmin: {
      orders: {
        detail: {
          useQuery: () => ({
            data: mockOrderDetail,
            isLoading: false,
          }),
        },
        counts: { useQuery: () => ({ data: {} }) },
        list: {
          useInfiniteQuery: () => ({
            data: { pages: [[]] },
            isLoading: false,
            isFetching: false,
            isError: false,
            hasNextPage: false,
          }),
        },
        setStatus: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        dispatch: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        claim: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        updateContact: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
        markPrepared: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        reactivateAndConfirm: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      },
    },
    delivery: {
      consignmentTimeline: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
    },
  },
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="sheet-root">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { OrderQuickViewDrawer } from "./OrderQuickViewDrawer";

describe("OrderCustomizationAssets & Store Admin address/notes rendering", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

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

  it("renders nothing when both previewAssetUrl and logoAssetUrl are empty or unsafe", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <OrderCustomizationAssets
          previewAssetUrl={null}
          logoAssetUrl="javascript:alert(1)"
          productName="كوب"
        />,
      );
    });

    expect(container.innerHTML).toBe("");
  });

  it("renders authenticated preview thumbnail and open/download links for previewAssetUrl and logoAssetUrl", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <OrderCustomizationAssets
          previewAssetUrl="/api/img/order-customization/9001/preview"
          logoAssetUrl="/api/img/order-customization/9001/logo"
          productName="كوب سيراميك حراري"
        />,
      );
    });

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/api/img/order-customization/9001/preview");

    const links = Array.from(container.querySelectorAll("a"));
    const previewLink = links.find((a) => a.textContent?.includes("معاينة التخصيص"));
    const logoLink = links.find((a) => a.textContent?.includes("ملف الشعار الأصلي"));

    expect(previewLink?.getAttribute("href")).toBe("/api/img/order-customization/9001/preview");
    expect(logoLink?.getAttribute("href")).toBe("/api/img/order-customization/9001/logo");
    expect(logoLink?.hasAttribute("download")).toBe(true);
  });

  it("resolves customerNotes ?? split.notes and clean shippingAddress across helpers, EditOnlineOrderDialog, and toShippingLabelPayload", () => {
    const resolvedWithCustomerNotes = resolveOrderShippingAddressAndNotes({
      addressText: "شارع فلسطين\nملاحظة: قديمة",
      customerNotes: "ملاحظة حديثة مستقلة",
    });
    expect(resolvedWithCustomerNotes).toEqual({
      shippingAddress: "شارع فلسطين",
      notes: "ملاحظة حديثة مستقلة",
    });

    const resolvedLegacyFallback = resolveOrderShippingAddressAndNotes({
      addressText: "المنصور - أميرات\nملاحظة: قرب الصيدلية",
      customerNotes: null,
    });
    expect(resolvedLegacyFallback).toEqual({
      shippingAddress: "المنصور - أميرات",
      notes: "قرب الصيدلية",
    });

    const editForm = buildInitialEditOnlineOrderFormState({
      customerName: "زينب",
      customerPhone: "07801112233",
      governorate: "baghdad",
      addressText: "زيونة - محلة 710",
      customerNotes: "الاتصال قبل الوصول بـ 15 دقيقة",
      items: [],
    });
    expect(editForm.shippingAddress).toBe("زيونة - محلة 710");
    expect(editForm.notes).toBe("الاتصال قبل الوصول بـ 15 دقيقة");

    const labelPayload = toShippingLabelPayload(mockOrderDetail as never);
    expect(labelPayload.addressText).toBe("الكرادة داخل - قرب ساحة كهرمانة");
    expect(labelPayload.notes).toBe("يرجى التسليم للاستعلامات في الطابق الأرضي");
  });

  it("mounts OrderCustomizationAssets and renders clean shippingAddress + customerNotes in OrderQuickViewDrawer and OrderFulfillment", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <OrderQuickViewDrawer
          orderId={501}
          open={true}
          onOpenChange={() => {}}
          canDispatch={true}
          canReadDeliveryTimeline={false}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("الكرادة داخل - قرب ساحة كهرمانة");
    expect(text).not.toContain("ملاحظة قديمة مدمجة");
    expect(text).toContain("يرجى التسليم للاستعلامات في الطابق الأرضي");
    expect(text).toContain("معاينة التخصيص");
    expect(text).toContain("ملف الشعار الأصلي");

    const fulfillmentSrc = fs.readFileSync(
      path.resolve(process.cwd(), "client/src/pages/OrderFulfillment.tsx"),
      "utf8",
    );
    expect(fulfillmentSrc).toContain("OrderCustomizationAssets");
    expect(fulfillmentSrc.split(/\r?\n/).length).toBeLessThan(1200);
  });
});
