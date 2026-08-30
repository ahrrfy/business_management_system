/**
 * اختبارات مصنّف أولوية الطلب (فحص معمارية الحمل ٣٠/٨/٢٦) — الثوابت التجارية:
 * عمليات الصندوق الحرجة لا تُخفَّف قبل غيرها أبداً، وزائر المتجر يُخفَّف أولاً،
 * والدفعة المختلطة لا ترث امتياز المتجر ولا تفقد امتياز الصندوق.
 */
import { describe, expect, it } from "vitest";
import {
  CRITICAL_CASHIER_PROCEDURES,
  classifyRequestLane,
  trpcProceduresFromPath,
} from "../requestPriority";

const PUBLIC_HOST = "alarabiya.online";
const ERP_HOST = "srv1548487.hstgr.cloud";

describe("trpcProceduresFromPath", () => {
  it("يفكّ الدفعة إلى أسماء إجراءات", () => {
    expect(trpcProceduresFromPath("/api/trpc/sales.create,products.list")).toEqual([
      "sales.create",
      "products.list",
    ]);
  });
  it("غير tRPC أو مسار شاذّ ⇒ null", () => {
    expect(trpcProceduresFromPath("/api/img/x.webp")).toBe(null);
    expect(trpcProceduresFromPath("/api/trpc/a.b/extra")).toBe(null);
    expect(trpcProceduresFromPath("/")).toBe(null);
  });
});

describe("classifyRequestLane — الحارات الثلاث", () => {
  it("كل عملية صندوق حرجة ⇒ critical (منفردةً وداخل دفعة)", () => {
    for (const proc of CRITICAL_CASHIER_PROCEDURES) {
      expect(classifyRequestLane(`/api/trpc/${proc}`, ERP_HOST)).toBe("critical");
      expect(classifyRequestLane(`/api/trpc/products.list,${proc}`, ERP_HOST)).toBe("critical");
    }
  });
  it("دفعة متجر خالصة ⇒ storefront أياً كان المضيف", () => {
    expect(classifyRequestLane("/api/trpc/storefront.catalog", PUBLIC_HOST)).toBe("storefront");
    expect(
      classifyRequestLane("/api/trpc/storefront.catalog,storefront.settings", ERP_HOST),
    ).toBe("storefront");
  });
  it("دفعة مختلطة (متجر + غيره) ⇒ normal — لا ترث تخفيف المتجر", () => {
    expect(
      classifyRequestLane("/api/trpc/storefront.catalog,products.list", ERP_HOST),
    ).toBe("normal");
  });
  it("صفحات وصور المضيف العام ⇒ storefront؛ نفسها على مضيف الشركة ⇒ normal", () => {
    expect(classifyRequestLane("/", PUBLIC_HOST)).toBe("storefront");
    expect(classifyRequestLane("/store", PUBLIC_HOST)).toBe("storefront");
    expect(classifyRequestLane("/api/img/products/1.webp", PUBLIC_HOST)).toBe("storefront");
    expect(classifyRequestLane("/api/img/products/1.webp", ERP_HOST)).toBe("normal");
    expect(classifyRequestLane("/", ERP_HOST)).toBe("normal");
  });
  it("نداءات الموظفين عبر المضيف العام (courier/auth) تبقى normal", () => {
    expect(classifyRequestLane("/api/trpc/courier.myDeliveries", PUBLIC_HOST)).toBe("normal");
    expect(classifyRequestLane("/api/trpc/auth.login", PUBLIC_HOST)).toBe("normal");
  });
  it("وثائق تطبيق المناديب TWA على الدومين العام normal لا storefront", () => {
    expect(classifyRequestLane("/my-deliveries", PUBLIC_HOST)).toBe("normal");
    expect(classifyRequestLane("/login", PUBLIC_HOST)).toBe("normal");
    expect(classifyRequestLane("/account", PUBLIC_HOST)).toBe("normal");
    expect(classifyRequestLane("/account/settings", PUBLIC_HOST)).toBe("normal");
  });
  it("مقدّمات الدفع الخارجي وبطاقة TELECOM داخل الحارة الحرجة (لا حماية للخاتمة وحدها)", () => {
    expect(classifyRequestLane("/api/trpc/sales.initiateExternalPayment", ERP_HOST)).toBe("critical");
    expect(classifyRequestLane("/api/trpc/printPos.confirmExternalPayment", ERP_HOST)).toBe("critical");
    expect(classifyRequestLane("/api/trpc/digitalCards.pos.confirmCard", ERP_HOST)).toBe("critical");
    expect(classifyRequestLane("/api/trpc/reception.draftSync", ERP_HOST)).toBe("critical");
  });
  it("تقارير الإدارة normal — لا امتياز", () => {
    expect(classifyRequestLane("/api/trpc/reports.managementAlerts", ERP_HOST)).toBe("normal");
  });
});
