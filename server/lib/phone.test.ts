import { describe, expect, it } from "vitest";
import { canonicalIraqiMobile, iraqiMobileLocal, toAsciiPhoneDigits } from "./phone";

describe("هوية هاتف الاستقبال العراقي", () => {
  it.each([
    ["07701234567", "+9647701234567"],
    ["+9647701234567", "+9647701234567"],
    ["009647701234567", "+9647701234567"],
    ["٠٧٧٠١٢٣٤٥٦٧", "+9647701234567"],
    ["۰۷۷۰۱۲۳۴۵۶۷", "+9647701234567"],
  ])("يطبع %s إلى E.164 واحدة", (input, expected) => {
    expect(canonicalIraqiMobile(input)).toBe(expected);
    expect(iraqiMobileLocal(input)).toBe("07701234567");
  });

  it.each(["", "770123456", "0770123456", "077012345678", "06701234567", "+9667701234567"])(
    "يرفض الرقم غير العراقي أو غير المكتمل: %s",
    (input) => expect(canonicalIraqiMobile(input)).toBeNull(),
  );

  it("يحوّل الأرقام العربية والفارسية قبل التحقق", () => {
    expect(toAsciiPhoneDigits("٠٧٧-۰۱۲-34567")).toBe("07701234567");
  });
});
