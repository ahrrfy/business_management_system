import { describe, expect, it } from "vitest";
import {
  buildPosModeUrl,
  isEmbeddedReservationsWorkspace,
  isPosRouteAccessDenied,
  readPosMode,
} from "./posRoute";

describe("readPosMode", () => {
  it("يعامل غياب mode كتجزئة افتراضية", () => {
    expect(readPosMode("")).toBe("RETAIL");
    expect(readPosMode("?draft=d-17&source=mobile")).toBe("RETAIL");
  });

  it.each(["RETAIL", "PRINT_SERVICES", "RECEPTION"] as const)(
    "يقرأ الوضع الصالح %s من الرابط",
    (mode) => {
      expect(readPosMode(`source=mobile&mode=${mode}&draft=d-17`)).toBe(mode);
    },
  );

  it.each(["", "print_services", "UNKNOWN"])(
    "يرفض قيمة mode غير الصالحة %s كي يعيد الغلاف توجيهها",
    (mode) => {
      expect(readPosMode(`source=mobile&mode=${mode}`)).toBeNull();
    },
  );

  it("يرفض أكثر من mode بدلاً من اختيار قيمة ملتبسة", () => {
    expect(readPosMode("mode=RETAIL&mode=RECEPTION")).toBeNull();
  });
});

describe("buildPosModeUrl", () => {
  it("يبدل mode في موضعه ويحفظ ترتيب بقية query والـ hash", () => {
    expect(
      buildPosModeUrl(
        {
          search:
            "return=%2Finvoices%3Ftab%3Dopen&mode=RETAIL&draft=d-17&source=mobile",
          hash: "#focus-payment",
        },
        "RECEPTION",
      ),
    ).toBe(
      "/pos?return=%2Finvoices%3Ftab%3Dopen&mode=RECEPTION&draft=d-17&source=mobile#focus-payment",
    );
  });

  it("يحذف mode وحده عند الرجوع إلى RETAIL", () => {
    expect(
      buildPosModeUrl(
        {
          search:
            "source=mobile&mode=PRINT_SERVICES&draft=d-17&return=%2Fsales%2Fnew",
          hash: "line-2",
        },
        "RETAIL",
      ),
    ).toBe("/pos?source=mobile&draft=d-17&return=%2Fsales%2Fnew#line-2");
  });

  it("يحفظ الترميز الخام للمعاملات ويضيف mode في النهاية حين يكون غائباً", () => {
    const search =
      "draft=%D9%85%D8%B3%D9%88%D8%AF%D8%A9%20%D9%A1&source=mobile%2Fapp&return=%2Forders%3Fx%3D1%26y%3D2";

    expect(
      buildPosModeUrl({ search, hash: "#line%202" }, "PRINT_SERVICES"),
    ).toBe(`/pos?${search}&mode=PRINT_SERVICES#line%202`);
  });

  it("يحوّل mode غير الصالح إلى أول محطة مسموحة مع حفظ السياق", () => {
    expect(
      buildPosModeUrl(
        { search: "source=mobile&mode=UNKNOWN&draft=d-17", hash: "#payment" },
        "RECEPTION",
      ),
    ).toBe("/pos?source=mobile&mode=RECEPTION&draft=d-17#payment");
  });

  it("يستبدل mode ذي ترميز percent التالف ولا يكرر المفتاح", () => {
    const search = "draft=%E0%A4%A&mode=%E0%A4%A&source=mobile";

    expect(readPosMode(search)).toBeNull();
    expect(buildPosModeUrl({ search }, "RECEPTION")).toBe(
      "/pos?draft=%E0%A4%A&mode=RECEPTION&source=mobile",
    );
  });

  it("يبقي رابط الوضع نفسه مستقراً ولا يكرر mode", () => {
    const search = "draft=d-17&mode=PRINT_SERVICES&source=mobile";

    expect(buildPosModeUrl({ search }, "PRINT_SERVICES")).toBe(
      `/pos?${search}`,
    );
  });

  it("يزيل محدد حجوزات الاستقبال المتنافر عند الانتقال الصريح إلى محطة", () => {
    expect(
      buildPosModeUrl(
        {
          search:
            "return=%2Fcustomers%2F15&workspace=reservations&mode=RECEPTION&draft=d-17",
          hash: "#customer",
        },
        "RECEPTION",
      ),
    ).toBe("/pos?return=%2Fcustomers%2F15&mode=RECEPTION&draft=d-17#customer");

    expect(
      buildPosModeUrl(
        {
          search: "workspace=reservations&mode=UNKNOWN&source=shortcut",
          hash: "#fallback",
        },
        "RETAIL",
      ),
    ).toBe("/pos?source=shortcut#fallback");
  });
});

describe("POS route access", () => {
  it("يرفض mode التالف حتى داخل مساحة الحجوزات المضمنة", () => {
    expect(
      isPosRouteAccessDenied({
        invalidMode: true,
        reservationsWorkspace: true,
        canReadReservations: true,
        canSeeReception: false,
        canSeeActiveMode: false,
      }),
    ).toBe(true);
  });

  it("يتجاوز بوابة المحطة للحجوزات المضمنة فقط، لا لمن يملك محطة الاستقبال", () => {
    expect(isEmbeddedReservationsWorkspace(true, false)).toBe(true);
    expect(
      isPosRouteAccessDenied({
        invalidMode: false,
        reservationsWorkspace: true,
        canReadReservations: true,
        canSeeReception: false,
        canSeeActiveMode: false,
      }),
    ).toBe(false);

    expect(isEmbeddedReservationsWorkspace(true, true)).toBe(false);
    expect(
      isPosRouteAccessDenied({
        invalidMode: false,
        reservationsWorkspace: true,
        canReadReservations: true,
        canSeeReception: true,
        canSeeActiveMode: false,
      }),
    ).toBe(true);
  });
});
