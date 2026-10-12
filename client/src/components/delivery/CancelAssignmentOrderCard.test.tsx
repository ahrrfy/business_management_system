// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelAssignmentOrderCard } from "./CancelAssignmentOrderCard";
import type { ScannedOrderForCancellation } from "./CancelDeliveryAssignmentSection";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("CancelAssignmentOrderCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const sampleUnassignedOrder: ScannedOrderForCancellation = {
    id: 101,
    kind: "workOrder",
    orderNumber: "WO-101",
    title: "طباعة دروع تخرج",
    status: "READY",
    customerName: "علي الرافدين",
    customerPhone: "07701234567",
    salePrice: "75000.00",
    deposit: "25000.00",
    deliveryAddress: "بغداد - الكرادة",
    deliveryPhone: "07701234567",
    deliveryCost: "5000.00",
    version: 1,
    activeConsignment: null,
  };

  const sampleAssignedOrder: ScannedOrderForCancellation = {
    id: 102,
    kind: "workOrder",
    orderNumber: "WO-102",
    title: "مطبوعات تجارية",
    status: "READY",
    customerName: "شركة دجلة",
    customerPhone: "07801234567",
    salePrice: "120000.00",
    deposit: "0.00",
    deliveryAddress: "بغداد - المنصور",
    deliveryPhone: "07801234567",
    deliveryCost: "6000.00",
    version: 1,
    activeConsignment: {
      id: 55,
      consignmentNumber: "CN-1-20261007-0055",
      partyId: 10,
      partyName: "مندوب السلام (أحمد)",
      partyType: "INDIVIDUAL",
      parcelStatus: "ASSIGNED",
      moneyStatus: "PENDING",
      codAmount: "120000.00",
      collectedAmount: "0.00",
    },
  };

  const sampleParties = [
    {
      id: 10,
      name: "مندوب السلام (أحمد)",
      partyType: "INDIVIDUAL" as const,
      phone: "07700000001",
      userId: null,
      branchId: 1,
      defaultFee: "5000.00",
      currentBalance: "350000.00",
      floatLimit: "500000.00",
      isActive: true,
      drivers: [],
      hasPortalAccess: false,
      openConsignments: 4,
      oldestOutstanding: null,
      parcelsInTransitAmount: "350000.00",
      deliveredUncollectedAmount: "0.00",
      feesOwedAmount: "0.00",
      shortfallOwedAmount: "0.00",
      cashInHandLedger: "0.00",
      cashInHandStored: "0.00",
      cashInHandDrift: "0.00",
    },
    {
      id: 20,
      name: "شركة البراق السريع",
      partyType: "COMPANY" as const,
      phone: "07800000002",
      userId: null,
      branchId: 1,
      defaultFee: "6000.00",
      currentBalance: "100000.00",
      floatLimit: null,
      isActive: true,
      drivers: [],
      hasPortalAccess: false,
      openConsignments: 2,
      oldestOutstanding: null,
      parcelsInTransitAmount: "100000.00",
      deliveredUncollectedAmount: "0.00",
      feesOwedAmount: "0.00",
      shortfallOwedAmount: "0.00",
      cashInHandLedger: "0.00",
      cashInHandStored: "0.00",
      cashInHandDrift: "0.00",
    },
  ];

  it("يعرض تنبيهاً واضحاً عندما يكون الطلب غير مسند حالياً", () => {
    const onNavigate = vi.fn();
    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={sampleUnassignedOrder}
          reason=""
          onReasonChange={() => undefined}
          onConfirmCancel={() => undefined}
          onReset={() => undefined}
          onNavigateToDispatch={onNavigate}
          isPending={false}
        />,
      );
    });

    expect(host.textContent).toContain("الطلب غير مسند حالياً لأي جهة توصيل");
    expect(host.textContent).toContain("WO-101");
    expect(host.textContent).toContain("علي الرافدين");
    expect(host.textContent).toContain("الانتقال لإسناد هذا الطلب لمندوب");

    const dispatchBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الانتقال لإسناد هذا الطلب"),
    );
    expect(dispatchBtn).toBeTruthy();
    act(() => {
      dispatchBtn?.click();
    });
    expect(onNavigate).toHaveBeenCalledWith(sampleUnassignedOrder);
  });

  it("يعرض تفاصيل الإسناد والمندوب والمبالغ وزر الإلغاء عندما يكون الطلب مسنداً", () => {
    const onConfirm = vi.fn();
    const onReasonChange = vi.fn();

    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={sampleAssignedOrder}
          reason=""
          onReasonChange={onReasonChange}
          onConfirmCancel={onConfirm}
          onReset={() => undefined}
          isPending={false}
        />,
      );
    });

    expect(host.textContent).toContain("إرسالية توصيل نشطة: #CN-1-20261007-0055");
    expect(host.textContent).toContain("مندوب السلام (أحمد)");
    expect(host.textContent).toContain("120,000 د.ع");

    const cancelBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("تأكيد إلغاء الإسناد والتوصيل"),
    );
    expect(cancelBtn).toBeTruthy();
    // السبب فارغ (أقل من 3 أحرف) => الزر معطل
    expect(cancelBtn?.disabled).toBe(true);
  });

  it("يفعّل زر الإلغاء عند إدخال سبب صحيح بطول 3 أحرف فأكثر ويستدعي دالة التأكيد", () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={sampleAssignedOrder}
          reason="العميل سيستلم من الفرع"
          onReasonChange={() => undefined}
          onConfirmCancel={onConfirm}
          onReset={() => undefined}
          isPending={false}
        />,
      );
    });

    const cancelBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("تأكيد إلغاء الإسناد والتوصيل"),
    );
    expect(cancelBtn).toBeTruthy();
    expect(cancelBtn?.disabled).toBe(false);

    act(() => {
      cancelBtn?.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("يمنع الإلغاء المباشر ويعرض تحذيراً عند تسليم الطرد أو تحصيل مبالغ منه", () => {
    const deliveredOrder: ScannedOrderForCancellation = {
      ...sampleAssignedOrder,
      activeConsignment: {
        ...sampleAssignedOrder.activeConsignment!,
        parcelStatus: "DELIVERED",
        collectedAmount: "120000.00",
      },
    };

    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={deliveredOrder}
          reason=""
          onReasonChange={() => undefined}
          onConfirmCancel={() => undefined}
          onReset={() => undefined}
          isPending={false}
        />,
      );
    });

    expect(host.textContent).toContain("لا يمكن إلغاء الإسناد المباشر لهذا الطرد");
    expect(host.textContent).toContain("DELIVERED");
    expect(host.textContent).toContain("إلغاء / مرتجع");
    // زر الإلغاء المباشر لا يظهر
    const cancelBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("تأكيد إلغاء الإسناد والتوصيل"),
    );
    expect(cancelBtn).toBeFalsy();
  });

  it("يعرض تفاصيل المبالغ المالية الأربعة كاملة (قيمة الطلب، المسدد، المطلوب تحصيله، المحصل)", () => {
    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={sampleAssignedOrder}
          reason=""
          onReasonChange={() => undefined}
          onConfirmCancel={() => undefined}
          onReset={() => undefined}
          isPending={false}
        />,
      );
    });

    expect(host.textContent).toContain("قيمة الطلب:");
    expect(host.textContent).toContain("المسدد / العربون:");
    expect(host.textContent).toContain("المطلوب تحصيله (COD):");
    expect(host.textContent).toContain("المبلغ المحصّل:");
    expect(host.textContent).toContain("120,000 د.ع");
  });

  it("يمنع الإلغاء المباشر عندما تكون حالة الذمة المالية COLLECTED أو REMITTED حتى مع صفرية المبلغ المحصل", () => {
    const collectedStatusOrder: ScannedOrderForCancellation = {
      ...sampleAssignedOrder,
      activeConsignment: {
        ...sampleAssignedOrder.activeConsignment!,
        parcelStatus: "OUT_FOR_DELIVERY",
        moneyStatus: "COLLECTED",
        collectedAmount: "0.00",
      },
    };

    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={collectedStatusOrder}
          reason="سبب تجريبي"
          onReasonChange={() => undefined}
          onConfirmCancel={() => undefined}
          onReset={() => undefined}
          isPending={false}
        />,
      );
    });

    expect(host.textContent).toContain("لا يمكن إلغاء الإسناد المباشر لهذا الطرد");
    const cancelBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("تأكيد إلغاء الإسناد والتوصيل"),
    );
    expect(cancelBtn).toBeFalsy();
  });

  it("يتيح تأكيد الإلغاء بالضغط على زر Enter داخل حقل السبب عندما يكون السبب مستوفياً للشروط", () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={sampleAssignedOrder}
          reason="العميل حضر للاستلام الشخصي"
          onReasonChange={() => undefined}
          onConfirmCancel={onConfirm}
          onReset={() => undefined}
          isPending={false}
        />,
      );
    });

    const input = host.querySelector("input#cancel-delivery-reason") as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("يتيح اختيار أسباب الإلغاء السريعة بنقرة واحدة عبر الشرائح", () => {
    const onReasonChange = vi.fn();
    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={sampleAssignedOrder}
          reason=""
          onReasonChange={onReasonChange}
          onConfirmCancel={() => undefined}
          onReset={() => undefined}
          isPending={false}
        />,
      );
    });

    const chip = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("استلام الزبون من الفرع"),
    );
    expect(chip).toBeTruthy();
    act(() => {
      chip?.click();
    });
    expect(onReasonChange).toHaveBeenCalledWith("استلام الزبون من الفرع");
  });

  it("يعرض مؤشر عهدة المندوب الميدانية والطرود المفتوحة عبر شارة الذكاء التشغيلي", () => {
    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={sampleAssignedOrder}
          allParties={sampleParties}
          reason=""
          onReasonChange={() => undefined}
          onConfirmCancel={() => undefined}
          onReset={() => undefined}
          isPending={false}
        />,
      );
    });

    expect(host.textContent).toContain("مؤشر عهدة المندوب الميدانية:");
    expect(host.textContent).toContain("4 طرد");
    expect(host.textContent).toContain("350,000 د.ع");
  });

  it("يتيح التحويل المباشر لمندوب آخر واختياره وتأكيد الإسناد الفوري", () => {
    const onConfirmReassign = vi.fn();
    act(() => {
      root.render(
        <CancelAssignmentOrderCard
          scannedOrder={sampleAssignedOrder}
          allParties={sampleParties}
          reason=""
          onReasonChange={() => undefined}
          onConfirmCancel={() => undefined}
          onConfirmReassign={onConfirmReassign}
          onReset={() => undefined}
          isPending={false}
        />,
      );
    });

    const switchBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("تحويل لمندوب آخر مباشرة"),
    );
    expect(switchBtn).toBeTruthy();
    act(() => {
      switchBtn?.click();
    });

    expect(host.textContent).toContain("اختر المندوب الجديد لتحويل الإرسالية إليه");
    const trigger = host.querySelector("[role='combobox']");
    expect(trigger).toBeTruthy();

    const reassignBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("تأكيد التحويل للمندوب الجديد"),
    );
    expect(reassignBtn).toBeTruthy();
    // لم يتم اختيار مندوب بديل بعد => الزر معطل
    expect(reassignBtn?.disabled).toBe(true);
  });
});
