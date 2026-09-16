/**
 * تناظرُ زوج المنتج (م٦ ق٤) — مِسبارٌ نصّيّ على `ProductNew.tsx`/`ProductEdit.tsx` والمكوّن المشترك.
 *
 * قرار المالك: «شاشةُ التعديل تُظهر شاشة الإنشاء مطابقة». العلاجُ ليس نسخَ الحقول إلى الشاشتين بل
 * **مكوّنٌ واحد** (`ProductFormFields` في `components/form/` كي يتبعه `check:form-parity`) تُصيّره
 * الشاشتان بـ`mode` مختلف فوق `RecordForm` (Ctrl+S · حارس المغادرة · نتيجة مُهيكَلة).
 *
 * ما يُثبَت هنا (لا يقيسه حارس التناظر): أنّ الشاشة **لا تعود** تكتب متحقِّقاً أو بانيَ حمولةٍ أو
 * اختصاراً بيدها، وأنّ المكوّن المشترك يحمل الحقولَ الثمانية التي كانت منحرفة، وأنّ الأرقام لاتينية.
 *
 * ⚠️ `ProductEdit.tsx` يُقاس **حين يتبنّى** المكوّن (مملوكٌ لجلسةٍ أخرى وقت كتابة هذا) — قبلها يُتخطّى
 * بتصريحٍ ظاهر لا بصمت، وخطّ أساس `check:form-parity` يبقى الحارس الفاصل.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const NEW = read("../ProductNew.tsx");
const EDIT = read("../ProductEdit.tsx");
const FIELDS = read("../../components/form/product/ProductFormFields.tsx");
const VARIANT_FIELDS = read("../../components/form/product/ProductVariantsFields.tsx");
const SHARED = FIELDS + "\n" + VARIANT_FIELDS;

const EDIT_ADOPTED = EDIT.includes("@/components/form/product/ProductFormFields");

function delegationContract(source: string, label: string) {
  it(`${label}: تُصيّر المكوّن المشترك فوق RecordForm ولا تكتب حرّاسها بيدها`, () => {
    expect(source).toContain('import { ProductFormFields, type ProductModelPatch } from "@/components/form/product/ProductFormFields";');
    expect(source).toContain('import { RecordForm } from "@/components/form/RecordForm";');
    expect(source).toMatch(/<ProductFormFields\b/);
    expect(source).toMatch(/<RecordForm\b/);
    // لا متحقِّقَ ولا بانيَ حمولةٍ محلّيَّين — كلاهما في النموذج النقيّ.
    expect(source).not.toMatch(/function validateLocal\(/);
    expect(source).not.toMatch(/function buildPayload\(/);
    // لا اختصارَ ولا حارسَ مغادرةٍ يدويَّين — الغلافُ يربطهما.
    expect(source).not.toContain("useSaveShortcuts(");
    expect(source).not.toContain("useUnsavedGuard(");
    // الأرقام لاتينية (قرار المالك) — لا تحويلَ إلى الهندية.
    expect(source).not.toContain("toArabicDigits");
  });
}

describe("زوج المنتج — الإنشاء ⇒ التعديل شاشةٌ واحدة", () => {
  delegationContract(NEW, "ProductNew");

  if (EDIT_ADOPTED) {
    delegationContract(EDIT, "ProductEdit");
  } else {
    it.skip("ProductEdit: يُقاس حين يتبنّى المكوّن المشترك (الملفّ مملوكٌ لجلسةٍ أخرى وقت كتابة هذا)", () => {});
  }
});

describe("المكوّن المشترك — الحقول الثمانية التي كانت منحرفة صارت في الشاشتين", () => {
  it.each([
    "productName",
    "defaultMin",
    "allowAutoCartRecommendations",
    "allowBackorder",
    "isService",
    "showInPrintPos",
    "showInReception",
    "isActive",
  ])("الحقل «%s» مربوطٌ في المكوّن المشترك", (field) => {
    expect(SHARED).toMatch(new RegExp(`(?:value|checked)=\\{model\\.${field}\\}`));
  });

  it("لا اسمَ بديلاً للحقل نفسه (originalName) — اسمٌ واحد في الوضعين", () => {
    expect(SHARED).not.toContain("originalName");
  });

  it("المساعداتُ التي تحتاج سجلاً محفوظاً تُعرض بوجود المعرّف لا بالوضع", () => {
    expect(FIELDS).toContain("{productId != null && (");
    expect(FIELDS).toContain("<ProductCustomizationTemplateEditor productId={productId}");
    expect(FIELDS).toContain("<ProductRelatedProductsEditor productId={productId} />");
  });

  it("الفروقُ المشروعة بين الوضعين تمرّ بـmode لا بنسخةٍ ثانية", () => {
    expect(VARIANT_FIELDS).toContain("stockEditable={isCreate}");
    expect(VARIANT_FIELDS).toContain("localAliases={isCreate}");
    expect(VARIANT_FIELDS).toContain("priceHistory={!isCreate}");
  });

  it("الأرقام لاتينية في المكوّن المشترك", () => {
    expect(SHARED).not.toContain("toArabicDigits");
    expect(SHARED).not.toMatch(/toLocaleString\(["']ar-/);
  });
});
