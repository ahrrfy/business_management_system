# ذاكرة توجيه الخدمات إلى عروض الأسعار وفواتير المبيعات المتقدمة (30-09-2026)

**التاريخ:** 30 سبتمبر 2026  
**النطاق:** الكتالوج التجاري (`/products`), نموذج إنشاء وتعديل الخدمة والمنتج (`ServiceForm.tsx`, `ProductFormFields.tsx`, `productFormModel.ts`), محرك البحث وتصفية نقاط البيع (`server/services/catalog/search.ts`, `pos.ts`), شاشات الفواتير وعروض الأسعار (`BulkPicker.tsx`, `ProductSearchBar.tsx`), هجرة قاعدة البيانات المعتمدة (`0375_service_quotation_and_advanced_sale_routing.sql`).  
**طلب الدمج المعتمد:** PR #1326  
**الالتزام المدموج على main:** `532deb6b`  
**البروتوكولات المفعلة:** Sub-Agents Network, V.E.R.I.F.Y Protocols, Zero-Hallucination & Fact-Check, Closed-Loop Auto-Correction, Definition of Done (DoD).

---

## ١. المطلب الجوهري وتوصيف الميزة

طلب المالك توسيع منظومة توجيه عرض الخدمات (`أين تُباع الخدمة؟`)، بحيث تشمل إلى جانب نقاط البيع ومحطة الاستقبال وجهتين حرجتين:
1. **عروض الأسعار (Quotations / Price Offers):** إمكانية إظهار أو حجب الخدمات عند إنشاء عروض الأسعار للعملاء (`showInQuotations`).
2. **فواتير المبيعات المتقدمة (Advanced Sales Invoices):** إمكانية إظهار أو حجب الخدمات في واجهة الفواتير والمبيعات المتقدمة ومحددات المنتجات المجمعة (`showInAdvancedSales`).

---

## ٢. البنية التقنية والمعمارية المنفذة

### ١. مخطط قاعدة البيانات وهجرة Drizzle (`drizzle/schema.ts` و `0375_*.sql`):
- إضافة العمودين إلى جدول `products`:
  - `showInQuotations: boolean("show_in_quotations").notNull().default(true)`
  - `showInAdvancedSales: boolean("show_in_advanced_sales").notNull().default(true)`
- هجرة ذرية آمنة `0375_service_quotation_and_advanced_sale_routing.sql` تقوم بإنشاء العمودين افتراضياً بقيمة 1، مع ملء تلقائي رجعي لسجلات الخدمات القائمة، وتسجيلها في `_journal.json`.

### ٢. محرك البحث والكتالوج واللقطات والتوافق بلا اتصال (Offline CRC):
- تحديث خيارات التصفية في `search.ts`:
  - `includeQuotationServices?: boolean`
  - `includeAdvancedSaleServices?: boolean`
  - التوافقية العكسية: `includeAllServices` يفعّل تلقائياً كلا الخيارين.
- تحديث لقطات المنتجات وسجل الفروق (`productSnapshot.ts`, `shared/productSnapshot.ts`, `productVersioning.ts`, `shared/productVersionDiff.ts`).
- تحديث بصمة الحساب للمزامنة غير المتصلة `catalogSnapshot.ts`.

### ٣. الواجهات وتجربة المستخدم والنماذج المشتركة:
- **`ServiceForm.tsx`:** إضافة مفتاحي تبديل (`Switch`) أنيقين مع شارات توضيحية خضراء وزرقاء وتحذيرات مرئية عند إلغاء التفعيل:
  - «عرض في عروض الأسعار» (`showInQuotations`)
  - «عرض في المبيعات المتقدمة» (`showInAdvancedSales`)
- **`ProductFormFields.tsx` & `productFormModel.ts`:** دمج الحقلين ضمن النموذج المشترك المعتمد مع صون حارس تماثل النماذج (`productFormParity.test.ts`).
- **`ProductSearchBar.tsx` & `BulkPicker.tsx`:** ربط معامل `includeQuotationServices` عند البحث في سياق عروض الأسعار، و`includeAdvancedSaleServices` عند البحث في فواتير المبيعات المتقدمة.
- **`Products.tsx`:** إضافة شارات بصرية فورية في بطاقة الخدمة تدل على قنوات البيع النشطة.

---

## ٣. الاختبارات والتحقق الجنائي (V.E.R.I.F.Y)

1. **`server/services/__tests__/serviceRouting.test.ts` (4/4 tests passed):**
   - عروض الأسعار تُظهر الخدمات المفعّل عليها `showInQuotations` فقط.
   - المبيعات المتقدمة تُظهر الخدمات المفعّل عليها `showInAdvancedSales` فقط.
   - `includeAllServices` يتطابق تماماً مع `includeAdvancedSaleServices`.
   - إنشاء وتعديل خدمة بتوجيهات عروض الأسعار والمبيعات المتقدمة يحفظ الحقول ويسترجعها بدقة ذرية 100%.
2. **`client/src/pages/__tests__/productFormParity.test.ts` (16/16 tests passed):**
   - التحقق من ربط وتماثل الحقول الجديدة بنسبة 100% بين وضع الإضافة والتعديل.
3. **فحوصات البوابة والجودة والأمان:**
   - `pnpm check`: صفر أخطاء TypeScript.
   - `pnpm check:guards`: اجتياز كافة الحراس الـ 45 بنسبة 100%.
   - `audit`: اجتياز فحص الثغرات مع تحديث معرّفات `osv-scanner.toml`.
   - GitHub Actions CI: اجتياز جميع شاردات الاختبارات الـ 8 وبناء الجودة والأذونات والنطاق (12/12 وظيفة خضراء 100%).
4. **الدمج:**
   - دمج طلب الدمج PR #1326 في فرع `main` بالالتزام `532deb6b`.
