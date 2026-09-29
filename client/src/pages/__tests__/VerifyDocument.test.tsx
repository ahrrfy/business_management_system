import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageContent = readFileSync(new URL("../VerifyDocument.tsx", import.meta.url), "utf8");
const appContent = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");

describe("VerifyDocument — عقد الواجهة والتوجيه العام", () => {
  it("يسجّل مسار /verify/:id في App.tsx للمطابقة المباشرة", () => {
    expect(appContent).toContain('<Route path="/verify/:id" component={VerifyDocument} />');
    expect(appContent).toContain('<Route path="/verify" component={VerifyDocument} />');
  });

  it("يستخرج المعرف من مسار wouter ومعلمات الاستعلام (ref, id, payload, p, number)", () => {
    expect(pageContent).toContain('useRoute("/verify/:id")');
    expect(pageContent).toContain('searchParams.get("ref")');
    expect(pageContent).toContain('searchParams.get("id")');
    expect(pageContent).toContain('searchParams.get("payload")');
    expect(pageContent).toContain('searchParams.get("p")');
    expect(pageContent).toContain('searchParams.get("number")');
  });

  it("يُفكّك الروابط الكاملة والرموز المشفرة تلقائياً", () => {
    expect(pageContent).toContain('docIdentifier.startsWith("http://")');
    expect(pageContent).toContain('docIdentifier.includes("%")');
    expect(pageContent).toContain("decodeURIComponent(docIdentifier)");
  });

  it("يوفّر نموذج إدخال يدوي للبحث عند زيارة /verify بدون معاملات", () => {
    expect(pageContent).toContain("handleManualSearch");
    expect(pageContent).toContain("لا يوجد رمز تحقق");
    expect(pageContent).toContain("placeholder=\"مثال: ORD-100009 أو INV-...\"");
    expect(pageContent).toContain("setLocation(`/verify/${encodeURIComponent(clean)}`)");
  });

  it("يستهلك نص التحميل الموحد من ACTION_LABELS.verifying", () => {
    expect(pageContent).toContain("ACTION_LABELS.verifying");
  });

  it("يعرض تفاصيل المستند المعتمد مع شارة الحالة واسم العميل والفرع", () => {
    expect(pageContent).toContain("docTypeLabel(q.data.docType)");
    expect(pageContent).toContain("q.data.number");
    expect(pageContent).toContain("q.data.date");
    expect(pageContent).toContain("fmt(q.data.amount)");
    expect(pageContent).toContain("q.data.branchId");
    expect(pageContent).toContain("statusBadge");
    expect(pageContent).toContain("q.data.customerName");
  });

  it("يعرض العنوان الحرفي الصارم عند الفشل: فشل التحقق من صحة الوثيقة", () => {
    expect(pageContent).toContain("فشل التحقق من صحة الوثيقة");
  });

  it("يلتزم بحظر الإيموجي تماماً (Zero Emojis)", () => {
    const surrogateEmoji = new RegExp("[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]");
    const miscSymbols = new RegExp("[\\u2600-\\u27BF]");
    expect(surrogateEmoji.test(pageContent)).toBe(false);
    expect(miscSymbols.test(pageContent)).toBe(false);
  });
});
