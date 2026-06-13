import { describe, expect, it } from "vitest";
import { buildCredentialsMessage, whatsappLink } from "../credentialsMessage";

const BASE = {
  name: "علي محمد",
  email: "ali.mohamed@alroya.local",
  password: "Xy9#k2Pq7m",
  appUrl: "https://srv1548487.hstgr.cloud",
  roleLabel: "كاشير",
  branchName: "الفرع الرئيسي",
  jobTitle: "كاشير الوردية الصباحية",
  mustChangePassword: true,
};

describe("buildCredentialsMessage", () => {
  it("يحوي بيانات الدخول كاملة (الرابط/البريد/كلمة المرور)", () => {
    const m = buildCredentialsMessage(BASE);
    expect(m).toContain(BASE.appUrl);
    expect(m).toContain(BASE.email);
    expect(m).toContain(BASE.password);
  });

  it("يحوي معلومات المستخدم (الاسم/الصلاحية/الفرع/المسمّى)", () => {
    const m = buildCredentialsMessage(BASE);
    expect(m).toContain("علي محمد");
    expect(m).toContain("الصلاحية: كاشير");
    expect(m).toContain("الفرع: الفرع الرئيسي");
    expect(m).toContain("المسمّى: كاشير الوردية الصباحية");
  });

  it("يحوي تعليمات أوّلية بسيطة + ملاحظة تغيير الكلمة عند الإلزام", () => {
    const m = buildCredentialsMessage(BASE);
    expect(m).toContain("خطوات الدخول");
    expect(m).toMatch(/افتح الرابط/);
    expect(m).toMatch(/أدخل البريد/);
    expect(m).toMatch(/كلمة مرور جديدة عند أول دخول/);
    expect(m).toMatch(/سرّية/);
  });

  it("بلا فرع ⇒ «كل الفروع»، وبلا إلزام تغيير ⇒ تُحذف خطوة التغيير", () => {
    const m = buildCredentialsMessage({ ...BASE, branchName: null, mustChangePassword: false });
    expect(m).toContain("الفرع: كل الفروع");
    expect(m).not.toMatch(/كلمة مرور جديدة عند أول دخول/);
  });

  it("يتجاوز المسمّى/الصلاحية الفارغة بلا أسطر فارغة مضلِّلة", () => {
    const m = buildCredentialsMessage({ ...BASE, jobTitle: "   ", roleLabel: "" });
    expect(m).not.toContain("المسمّى:");
    expect(m).not.toContain("الصلاحية:");
    // يبقى البريد وكلمة المرور حاضرين
    expect(m).toContain(BASE.email);
  });
});

describe("whatsappLink", () => {
  it("يجرّد E.164 إلى أرقام فقط ويُرمّز النصّ", () => {
    const link = whatsappLink("+964 770 123 4567", "مرحبا");
    expect(link).toBe(`https://wa.me/9647701234567?text=${encodeURIComponent("مرحبا")}`);
  });

  it("يعيد null لرقم فارغ/غير صالح", () => {
    expect(whatsappLink("", "x")).toBeNull();
    expect(whatsappLink(null, "x")).toBeNull();
    expect(whatsappLink("   ", "x")).toBeNull();
  });

  it("النصّ المُرمَّز يفكّ إلى الأصل (سلامة الترميز)", () => {
    const text = buildCredentialsMessage(BASE);
    const link = whatsappLink("+9647701234567", text)!;
    const enc = link.split("?text=")[1];
    expect(decodeURIComponent(enc)).toBe(text);
  });
});
