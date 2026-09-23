import { describe, expect, it, vi } from "vitest";
import { printShelfQrDocument, type ShelfQrPrintOptions } from "./shelfQrPrint";
import * as brandModule from "./brand";

describe("printShelfQrDocument", () => {
  it("ينشئ قالب شريط الرف الفردي مع الرابط ورمز QR واسم الفرع", () => {
    let capturedHtml = "";
    vi.spyOn(brandModule, "openPrintWindow").mockImplementation((html) => {
      capturedHtml = html;
      return true;
    });

    const opts: ShelfQrPrintOptions = {
      template: "shelf-strip",
      qrDataUrl: "data:image/png;base64,FAKE_QR",
      targetUrl: "https://alarabiya.online/shelf-lookup?branch=1",
      branchName: "الفرع الرئيسي",
      title: "الرؤية العربية",
      subtitle: "امسح لمعرفة السعر",
    };

    const res = printShelfQrDocument(opts);
    expect(res).toBe(true);
    expect(capturedHtml).toContain("shelf-strip-card");
    expect(capturedHtml).toContain("الفرع الرئيسي");
    expect(capturedHtml).toContain("امسح لمعرفة السعر");
    expect(capturedHtml).toContain("data:image/png;base64,FAKE_QR");
    expect(capturedHtml).toContain("60mm 35mm");
  });

  it("ينشئ قالب شيت A4 مجمّع بالعدد المطلوب", () => {
    let capturedHtml = "";
    vi.spyOn(brandModule, "openPrintWindow").mockImplementation((html) => {
      capturedHtml = html;
      return true;
    });

    const opts: ShelfQrPrintOptions = {
      template: "a4-sheet",
      qrDataUrl: "data:image/png;base64,FAKE_QR",
      targetUrl: "https://alarabiya.online/shelf-lookup",
      branchName: null,
      title: "الرؤية العربية",
      subtitle: "امسح لمعرفة السعر",
      sheetCount: 12,
    };

    const res = printShelfQrDocument(opts);
    expect(res).toBe(true);
    expect(capturedHtml).toContain("a4-sheet-grid");
    // عدد تكرارات البطاقة يجب أن يطابق sheetCount (12)
    const matches = capturedHtml.match(/<div class="shelf-strip-card"/g);
    expect(matches?.length).toBe(12);
  });

  it("ينشئ قالب ستاند الطاولة A5 مع الخطوات التوجيهية الثلاث", () => {
    let capturedHtml = "";
    vi.spyOn(brandModule, "openPrintWindow").mockImplementation((html) => {
      capturedHtml = html;
      return true;
    });

    const opts: ShelfQrPrintOptions = {
      template: "table-stand",
      qrDataUrl: "data:image/png;base64,FAKE_QR",
      targetUrl: "https://alarabiya.online/shelf-lookup?branch=2",
      branchName: "فرع الكرادة",
      title: "قارئ الأسعار الذكي",
      subtitle: "وجّه كاميرا هاتفك",
      customNote: "تخفيضات موسم العودة للمدارس",
    };

    const res = printShelfQrDocument(opts);
    expect(res).toBe(true);
    expect(capturedHtml).toContain("stand-wrapper");
    expect(capturedHtml).toContain("stand-steps");
    expect(capturedHtml).toContain("فرع: فرع الكرادة");
    expect(capturedHtml).toContain("تخفيضات موسم العودة للمدارس");
  });

  it("ينشئ لافتة وبوستر الممرات A4", () => {
    let capturedHtml = "";
    vi.spyOn(brandModule, "openPrintWindow").mockImplementation((html) => {
      capturedHtml = html;
      return true;
    });

    const opts: ShelfQrPrintOptions = {
      template: "poster-a4",
      qrDataUrl: "data:image/png;base64,FAKE_QR",
      targetUrl: "https://alarabiya.online/shelf-lookup",
      branchName: null,
      title: "قارئ الأسعار الفوري",
      subtitle: "وجّه كاميرا هاتفك نحو باركود أي سلعة",
    };

    const res = printShelfQrDocument(opts);
    expect(res).toBe(true);
    expect(capturedHtml).toContain("poster-page");
    expect(capturedHtml).toContain("poster-qr-card");
    expect(capturedHtml).toContain("قارئ الأسعار الفوري");
  });
});
