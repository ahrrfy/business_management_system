// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderSlaBadge } from "../OrderSlaBadge";
import { OrderContactCell, type ContactStatus } from "../OrderContactCell";
import { OrderQuickViewDrawer } from "../OrderQuickViewDrawer";
import { OrderLeaderboardModal } from "../OrderLeaderboardModal";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

// Mocks for tRPC and WhatsApp
const trpcMocks = vi.hoisted(() => ({
  orderDetailQuery: vi.fn(),
  leaderboardQuery: vi.fn(),
}));

const whatsappMocks = vi.hoisted(() => ({
  openWhatsApp: vi.fn(),
  buildOnlineOrderFollowupMessage: vi.fn(
    (data: { orderNumber: string }) => `رسالة تجريبية للطلب #${data.orderNumber}`,
  ),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    storeAdmin: {
      orders: {
        detail: {
          useQuery: trpcMocks.orderDetailQuery,
        },
        leaderboard: {
          useQuery: trpcMocks.leaderboardQuery,
        },
      },
    },
  },
}));

vi.mock("@/lib/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp")>();
  return {
    ...actual,
    openWhatsApp: whatsappMocks.openWhatsApp,
    buildOnlineOrderFollowupMessage: whatsappMocks.buildOnlineOrderFollowupMessage,
  };
});

describe("Store Order Components Suite", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    vi.restoreAllMocks();
    whatsappMocks.openWhatsApp.mockClear();
    whatsappMocks.buildOnlineOrderFollowupMessage.mockClear();
    trpcMocks.orderDetailQuery.mockClear();
    trpcMocks.leaderboardQuery.mockClear();

    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: vi.fn(),
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  // =========================================================================
  // 1. OrderSlaBadge
  // =========================================================================
  describe("OrderSlaBadge", () => {
    it("يعرض شارة جديدة بلون الإيجاب (--sem-pos) للطلبات الحديثة أقل من 15 دقيقة", () => {
      const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);

      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={tenMinsAgo}
            status="PENDING"
          />,
        );
      });

      expect(host.textContent).toContain("جديد (منذ 10 د)");
      const badge = host.querySelector("span");
      expect(badge?.className).toContain("var(--sem-pos)");
      expect(badge?.className).toContain("var(--sem-pos-bg)");
    });

    it("يعرض شارة التجهيز المسبق باللون الإيجابي عند تمرير fulfillmentDurationMinutes", () => {
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={new Date(Date.now() - 60 * 60 * 1000)}
            status="PREPARED"
            fulfillmentDurationMinutes={22}
          />,
        );
      });

      expect(host.textContent).toContain("جُهّز في 22 دقيقة");
      const wrapper = host.querySelector("div");
      expect(wrapper?.className).toContain("var(--sem-pos)");

      // حالة التجهيز في أقل من دقيقة
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={new Date()}
            status="PREPARED"
            fulfillmentDurationMinutes={0}
          />,
        );
      });

      expect(host.textContent).toContain("جُهّز في أقل من دقيقة");
    });

    it("يعرض شارة التأخير بلون التحذير (--sem-warn) للطلبات بين 15 و 45 دقيقة", () => {
      const thirtyFiveMinsAgo = new Date(Date.now() - 35 * 60 * 1000);

      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={thirtyFiveMinsAgo}
            status="PENDING"
          />,
        );
      });

      expect(host.textContent).toContain("متأخر (منذ 35 د)");
      const badge = host.querySelector("span");
      expect(badge?.className).toContain("var(--sem-warn)");
      expect(badge?.className).toContain("var(--sem-warn-bg)");
    });

    it("يعرض شارة عاجل بلون الخطر (--sem-neg) ونبض الحركة للطلبات الحرجة المتأخرة لأكثر من 45 دقيقة", () => {
      const seventyMinsAgo = new Date(Date.now() - 70 * 60 * 1000);

      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={seventyMinsAgo}
            status="PENDING"
          />,
        );
      });

      expect(host.textContent).toContain("عاجل! منذ 1 س و 10 د");
      const badge = host.querySelector("span");
      expect(badge?.className).toContain("var(--sem-neg)");
      expect(badge?.className).toContain("animate-pulse");

      // أقل من ساعة (50 دقيقة)
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={new Date(Date.now() - 50 * 60 * 1000)}
            status="PENDING"
          />,
        );
      });
      expect(host.textContent).toContain("عاجل! منذ 50 دقيقة");
    });

    it("ينسق الوقت العربي للطلبات المنتهية (DELIVERED / SHIPPED / CANCELLED)", () => {
      const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={twoHoursAgo}
            status="DELIVERED"
          />,
        );
      });
      expect(host.textContent).toContain("منذ 2 ساعة");

      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={thirtyMinsAgo}
            status="SHIPPED"
          />,
        );
      });
      expect(host.textContent).toContain("منذ 30 د");

      const twoDaysAgo = new Date(Date.now() - 50 * 60 * 60 * 1000);
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={twoDaysAgo}
            status="CANCELLED"
          />,
        );
      });
      expect(host.textContent).toContain("منذ 2 يوم");
    });

    it("يعرض تنبيهات حجز المخزون المتبقية والمنتهية", () => {
      // حجز منتهي الصلاحية
      const expiredDate = new Date(Date.now() - 1000);
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={new Date(Date.now() - 5 * 60 * 1000)}
            status="PENDING"
            reservationExpiresAt={expiredDate}
          />,
        );
      });
      expect(host.textContent).toContain("انتهت مهلة حجز المخزون!");
      expect(host.textContent).toContain("جديد (منذ 5 د)");

      // حجز باقي فيه ساعات (إضافة هامش دقيقتين لمنع انخفاض الفارق بأجزاء الثانية دون الـ 3 ساعات)
      const inThreeHours = new Date(Date.now() + 3 * 3600 * 1000 + 120_000);
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={new Date(Date.now() - 5 * 60 * 1000)}
            status="PENDING"
            reservationExpiresAt={inThreeHours}
          />,
        );
      });
      expect(host.textContent).toContain("باقي 3 س للإلغاء");

      // طلب معلق تجاوز مهلة الـ 24 ساعة بدون حجز محدد
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600 * 1000);
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt={twentyFiveHoursAgo}
            status="PENDING"
          />,
        );
      });
      expect(host.textContent).toContain("تجاوزت مهلة الـ 24 ساعة!");
    });

    it("يعرض شرطة عند تمرير تاريخ غير صالح", () => {
      act(() => {
        root.render(
          <OrderSlaBadge
            createdAt="invalid-date"
            status="PENDING"
          />,
        );
      });
      expect(host.textContent?.trim()).toBe("—");
    });
  });

  // =========================================================================
  // 2. OrderContactCell
  // =========================================================================
  describe("OrderContactCell", () => {
    const baseOrder = {
      id: 205,
      orderNumber: "SO-205",
      customerName: "سعد الرافدين",
      customerPhone: "07701234567",
      total: 45000,
      status: "PENDING",
      contactStatus: "NOT_CONTACTED",
      contactNotes: null,
    };

    it("يعرض اسم العميل ورقم الهاتف بعد التطبيع والأزرار الأساسية", () => {
      const onUpdate = vi.fn();
      act(() => {
        root.render(
          <OrderContactCell
            order={baseOrder}
            onUpdateContact={onUpdate}
          />,
        );
      });

      expect(host.textContent).toContain("سعد الرافدين");
      expect(host.textContent).toContain("07701234567");
      expect(host.textContent).toContain("واتساب");
      expect(host.textContent).toContain("لم يتم التواصل");
    });

    it("يشغّل نافذة واتساب ويحدّث الحالة تلقائياً عند النقر إذا لم يكن متواصلاً معه", () => {
      const onUpdate = vi.fn();
      act(() => {
        root.render(
          <OrderContactCell
            order={baseOrder}
            onUpdateContact={onUpdate}
          />,
        );
      });

      const whatsappBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("واتساب"),
      );
      expect(whatsappBtn).toBeTruthy();

      act(() => {
        whatsappBtn?.click();
      });

      expect(whatsappMocks.buildOnlineOrderFollowupMessage).toHaveBeenCalledWith({
        orderNumber: "SO-205",
        customerName: "سعد الرافدين",
        total: "45000",
        status: "PENDING",
      });
      expect(whatsappMocks.openWhatsApp).toHaveBeenCalledWith(
        "07701234567",
        expect.stringContaining("SO-205"),
      );
      expect(onUpdate).toHaveBeenCalledWith("WHATSAPP_SENT");
    });

    it("لا يغيّر حالة الاتصال تلقائياً إذا كان الطلب مؤكداً مسبقاً", () => {
      const onUpdate = vi.fn();
      act(() => {
        root.render(
          <OrderContactCell
            order={{ ...baseOrder, contactStatus: "CALLED_CONFIRMED" }}
            onUpdateContact={onUpdate}
          />,
        );
      });

      const whatsappBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("واتساب"),
      );
      act(() => {
        whatsappBtn?.click();
      });

      expect(whatsappMocks.openWhatsApp).toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("يشغّل زر الاتصال الهاتفي عبر window.open بنمط tel:", () => {
      const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      act(() => {
        root.render(
          <OrderContactCell
            order={baseOrder}
            onUpdateContact={() => undefined}
          />,
        );
      });

      const callBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.querySelector(".sr-only")?.textContent === "اتصال",
      );
      expect(callBtn).toBeTruthy();

      act(() => {
        callBtn?.click();
      });

      expect(windowOpenSpy).toHaveBeenCalledWith("tel:07701234567");
    });

    it("يعرض ألوان وشارات حالات الاتصال المختلفة والتراجع الآمن للحالات غير المعروفة", () => {
      const statuses: Array<{ status: string; label: string; tokenClass?: string }> = [
        { status: "CALLED_CONFIRMED", label: "مؤكّد هاتفياً", tokenClass: "var(--sem-pos)" },
        { status: "WHATSAPP_SENT", label: "أُرسل واتساب", tokenClass: "var(--sem-info)" },
        { status: "NO_ANSWER", label: "لا يرد", tokenClass: "var(--sem-warn)" },
        { status: "RETRY", label: "إعادة محاولة", tokenClass: "var(--sem-neg)" },
        { status: "UNREACHABLE", label: "لم يتم التواصل" }, // تراجع آمن
      ];

      for (const item of statuses) {
        act(() => {
          root.render(
            <OrderContactCell
              order={{ ...baseOrder, contactStatus: item.status }}
              onUpdateContact={() => undefined}
            />,
          );
        });

        expect(host.textContent).toContain(item.label);
        if (item.tokenClass) {
          const badgeBtn = Array.from(host.querySelectorAll("button")).find((b) =>
            b.textContent?.includes(item.label),
          );
          expect(badgeBtn?.className).toContain(item.tokenClass);
        }
      }
    });

    it("يعرض ملاحظة الاتصال ضمن تلميح الشارة عند توفرها", () => {
      act(() => {
        root.render(
          <OrderContactCell
            order={{
              ...baseOrder,
              contactStatus: "CALLED_CONFIRMED",
              contactNotes: "سيتواجد بعد صلاة الظهر",
            }}
            onUpdateContact={() => undefined}
          />,
        );
      });

      const badgeBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("مؤكّد هاتفياً"),
      );
      expect(badgeBtn?.getAttribute("title")).toBe(
        "مؤكّد هاتفياً — سيتواجد بعد صلاة الظهر",
      );
    });

    it("يعطّل الأزرار أثناء التحديث الجاري (isUpdating = true)", () => {
      act(() => {
        root.render(
          <OrderContactCell
            order={baseOrder}
            onUpdateContact={() => undefined}
            isUpdating={true}
          />,
        );
      });

      const buttons = host.querySelectorAll("button");
      buttons.forEach((btn) => {
        expect(btn.hasAttribute("disabled") || btn.getAttribute("aria-disabled") === "true").toBe(true);
      });
    });
  });

  // =========================================================================
  // 3. OrderQuickViewDrawer
  // =========================================================================
  describe("OrderQuickViewDrawer", () => {
    const sampleOrderDetail = {
      id: 501,
      orderNumber: "SO-501",
      status: "CONFIRMED",
      customerName: "فاطمة حيدر",
      customerPhone: "07801234567",
      governorate: "بغداد",
      addressText: "الكرادة - شارع العطار",
      latitude: 33.31,
      longitude: 44.42,
      claimedByName: "مهند أحمد",
      preparedByName: "يوسف الرؤية",
      fulfillmentDurationMinutes: 18,
      items: [
        {
          id: 1,
          productName: "دفتر تجارب علمية",
          imageUrl: null,
          variantLabel: "غلاف مقوى",
          unitName: "درزن",
          quantity: 2,
          unitPrice: 15000,
          total: 30000,
          hasCustomization: true,
          customizationSummary: "طباعة شعار المدرسة على الوجهين",
        },
      ],
      subtotal: 30000,
      deliveryFree: true,
      deliveryWaivedAmount: 5000,
      deliveryFee: 5000,
      couponCode: "STUDENT2026",
      couponDiscount: 3000,
      total: 27000,
    };

    it("يعرض حالة التحميل عند جلب بيانات الطلب", () => {
      trpcMocks.orderDetailQuery.mockReturnValue({
        isLoading: true,
        isError: false,
        data: undefined,
      });

      act(() => {
        root.render(
          <OrderQuickViewDrawer
            orderId={501}
            open={true}
            onOpenChange={() => undefined}
          />,
        );
      });

      expect(document.body.textContent).toContain("جارٍ تحميل بنود وبيانات الطلب…");
    });

    it("يعرض رسالة خطأ واضحة عند تعذر جلب البيانات", () => {
      trpcMocks.orderDetailQuery.mockReturnValue({
        isLoading: false,
        isError: true,
        error: { message: "فشل الاتصال بالخادم" },
        data: undefined,
      });

      act(() => {
        root.render(
          <OrderQuickViewDrawer
            orderId={501}
            open={true}
            onOpenChange={() => undefined}
          />,
        );
      });

      expect(document.body.textContent).toContain("تعذّر جلب تفاصيل الطلب: فشل الاتصال بالخادم");
    });

    it("يعرض كامل تفاصيل الطلب وبنود الأصناف والإسناد والملخص المالي", () => {
      trpcMocks.orderDetailQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: sampleOrderDetail,
      });

      act(() => {
        root.render(
          <OrderQuickViewDrawer
            orderId={501}
            open={true}
            onOpenChange={() => undefined}
          />,
        );
      });

      const bodyText = document.body.textContent || "";
      expect(bodyText).toContain("SO-501");
      expect(bodyText).toContain("فاطمة حيدر");
      expect(bodyText).toContain("07801234567");
      expect(bodyText).toContain("الكرادة - شارع العطار");
      expect(bodyText).toContain("موقع التوصيل على خرائط Google");

      // إسناد الموظفين ومدة الإنجاز
      expect(bodyText).toContain("المستلم للتجهيز: مهند أحمد");
      expect(bodyText).toContain("المجهّز: يوسف الرؤية (18 د)");

      // بنود الطلب والتخصيص
      expect(bodyText).toContain("دفتر تجارب علمية");
      expect(bodyText).toContain("غلاف مقوى");
      expect(bodyText).toContain("طباعة شعار المدرسة على الوجهين");
      expect(bodyText).toContain("30,000 د.ع");

      // الملخص المالي
      expect(bodyText).toContain("مجاني (تحمل المتجر 5,000 د.ع)");
      expect(bodyText).toContain("خصم القسيمة (STUDENT2026):");
      expect(bodyText).toContain("-3,000 د.ع");
      expect(bodyText).toContain("27,000 د.ع");
    });

    it("يشغّل أزرار طباعة الملصق والحراري واستمارة التجهيز A4", () => {
      trpcMocks.orderDetailQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: sampleOrderDetail,
      });

      const onPrintLabel = vi.fn();
      const onPrintThermal = vi.fn();
      const onPrintPrep = vi.fn();

      act(() => {
        root.render(
          <OrderQuickViewDrawer
            orderId={501}
            open={true}
            onOpenChange={() => undefined}
            onPrintLabel={onPrintLabel}
            onPrintThermal={onPrintThermal}
            onPrintPreparationA4={onPrintPrep}
          />,
        );
      });

      const labelBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("ملصق الشحن"),
      );
      const thermalBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("فاتورة حرارية"),
      );
      const prepBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("ورقة تجهيز A4"),
      );

      act(() => {
        labelBtn?.click();
        thermalBtn?.click();
        prepBtn?.click();
      });

      expect(onPrintLabel).toHaveBeenCalledWith(501);
      expect(onPrintThermal).toHaveBeenCalledWith(501);
      expect(onPrintPrep).toHaveBeenCalledWith(501);
    });

    it("يشغّل زر إسناد الطلب للمندوب عند توفر صلاحية canDispatch", () => {
      trpcMocks.orderDetailQuery.mockReturnValue({
        isLoading: false,
        isError: false,
        data: sampleOrderDetail,
      });

      const onDispatch = vi.fn();

      act(() => {
        root.render(
          <OrderQuickViewDrawer
            orderId={501}
            open={true}
            onOpenChange={() => undefined}
            canDispatch={true}
            onDispatch={onDispatch}
          />,
        );
      });

      const dispatchBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("إسناد الطلب لشركة/مندوب التوصيل"),
      );
      expect(dispatchBtn).toBeTruthy();

      act(() => {
        dispatchBtn?.click();
      });

      expect(onDispatch).toHaveBeenCalledWith({
        id: 501,
        orderNumber: "SO-501",
        total: 27000,
        customerName: "فاطمة حيدر",
        deliveryFree: true,
        deliveryWaivedAmount: 5000,
      });
    });
  });

  // =========================================================================
  // 4. OrderLeaderboardModal
  // =========================================================================
  describe("OrderLeaderboardModal", () => {
    const sampleLeaderboard = {
      today: [
        { userId: 10, userName: "حسين علي", count: 14, avgMinutes: 11, fastestMinutes: 4 },
        { userId: 11, userName: "مصطفى جواد", count: 9, avgMinutes: 15, fastestMinutes: 7 },
        { userId: 12, userName: "كرار أحمد", count: 5, avgMinutes: 19, fastestMinutes: 9 },
        { userId: 13, userName: "حسن حميد", count: 3, avgMinutes: 24, fastestMinutes: 12 },
      ],
      month: [
        { userId: 10, userName: "حسين علي", count: 180, avgMinutes: 12, fastestMinutes: 4 },
        { userId: 11, userName: "مصطفى جواد", count: 140, avgMinutes: 14, fastestMinutes: 5 },
      ],
    };

    it("يعرض لوحة المتصدرين والرتب ومعدلات السرعة وأيقونات الترتيب", () => {
      trpcMocks.leaderboardQuery.mockReturnValue({
        isLoading: false,
        data: sampleLeaderboard,
      });

      act(() => {
        root.render(
          <OrderLeaderboardModal
            open={true}
            onOpenChange={() => undefined}
          />,
        );
      });

      const bodyText = document.body.textContent || "";
      expect(bodyText).toContain("لوحة أبطال التجهيز والمنافسة");
      expect(bodyText).toContain("حسين علي");
      expect(bodyText).toContain("14 طلب");
      expect(bodyText).toContain("معدل 11 د");
      expect(bodyText).toContain("أسرع طلب: 4 د");

      expect(bodyText).toContain("مصطفى جواد");
      expect(bodyText).toContain("كرار أحمد");
      expect(bodyText).toContain("حسن حميد");

      // الحافز التشجيعي
      expect(bodyText).toContain("حافز التجهيز:");
    });

    it("يدعم التبديل بين إنجاز اليوم وأبطال الشهر", () => {
      trpcMocks.leaderboardQuery.mockReturnValue({
        isLoading: false,
        data: sampleLeaderboard,
      });

      act(() => {
        root.render(
          <OrderLeaderboardModal
            open={true}
            onOpenChange={() => undefined}
          />,
        );
      });

      const monthTab = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("أبطال الشهر"),
      );
      expect(monthTab).toBeTruthy();

      act(() => {
        monthTab?.click();
      });

      const bodyText = document.body.textContent || "";
      expect(bodyText).toContain("180 طلب");
      expect(bodyText).toContain("140 طلب");
    });

    it("يعرض رسالة تشجيعية واضحة عند فراغ قائمة التجهيز", () => {
      trpcMocks.leaderboardQuery.mockReturnValue({
        isLoading: false,
        data: { today: [], month: [] },
      });

      act(() => {
        root.render(
          <OrderLeaderboardModal
            open={true}
            onOpenChange={() => undefined}
          />,
        );
      });

      expect(document.body.textContent).toContain(
        "لا توجد طلبات مجهزة مسجلة في هذه الفترة بعد.",
      );
      expect(document.body.textContent).toContain(
        "التقط طلباً جديداً وجهزه لتكون أول المتصدرين!",
      );
    });
  });
});
