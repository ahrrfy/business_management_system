# ذاكرة إضافة باركود رقم الفاتورة للترويسة الرسمية لمستندات A4

**التاريخ:** ٣ أكتوبر ٢٠٢٦  
**الفرع:** `add_invoice_barcode`  
**الشريحة المنسقة:** `add-invoice-barcode`  
**الحالة:** ✅ مكتمل وجاهز للدمج والنشر الذري  

---

## ١. ملخص الطلب والهدف
بناءً على طلب المستخدم:
> «اريد اضافة باركود رقم الفاتورة بجانب الرقم او تحته افي مكان مرتب اخر
> نفذ التعديلات والمعالجات والاصلاحات بفريق وبروتوكولات Sub-Agents Network, V.E.R.I.F.Y Protocols, Zero-Hallucination & Fact-Check, Closed-Loop Auto-Correction بشكل عميق وذري وشامل 100%
> وبعدها نفذ بروتوكول الدفع الى المستودع والدمج وبروتوكول المعالجة التلقائي للملاحظات وبعدها بروتوكول النشر الذري
> وبعدها نفذ بروتوكول انهاء الجلسة والارشفة وتحديث ذاكرة المشروع وتنظيف»

---

## ٢. التصميم المعماري والتنفيذ الذري
1. **فصل رقم العرض عن رمز الآلة (ERP Standards):**
   - رقم العرض البشري: عدد تسلسلي قصير (مثل `22333`).
   - رمز الآلة للماسحات الضوئية: يعتمد معيار النظام الموحد في `@shared/documentNumber.ts` عبر دالة `docBarcode("INV", documentNumber)` لإنتاج `INV-22333`.
   - التوافق التام مع قارئات الباركود ونظام التوجيه السريع في `client/src/lib/scanRouter.ts` و`server/routers/saleRouter.ts` (التي تستخدم `stripDocPrefix`).

2. **الترويسة الموحدة `pageHeader` في `client/src/lib/printing/docHtml.ts`:**
   - تعريف واجهة `DocHeaderBarcode`:
     ```ts
     export interface DocHeaderBarcode {
       value: string;
       svg?: string | null;
       caption?: string | null;
       placement?: 'beside' | 'below';
     }
     ```
   - دعم الموضعين بمرونة متكاملة:
     - **بجانب الرقم (`beside` - الافتراضي):** مدمج وأنيق على نفس السطر مع رقم الفاتورة بارتفاع 22px ومحاذاة رأسية دقيقة ومساحة هدوء منضبطة.
     - **تحت الرقم (`below`):** باركود تحته مباشرة داخل عمود القيمة مع إمكانية إظهار نص توضيحي للرمز.
   - الكشف التلقائي عن حقل رقم المستند في الترويسة (`label.includes('رقم')` أو الحقل الأول).
   - الحفاظ على التوافق الخلفي بنسبة 100% في حال عدم تفعيل الباركود.

3. **قوالب الطباعة الرسمية V2 في `client/src/lib/printing/printTemplatesV2.ts`:**
   - دمج خيارات `barcode` و`barcodePlacement` في `SalesInvoiceV2Data`، `PurchaseInvoiceV2Data`، `QuotationV2Data`، و`WorkOrderV2Data`.
   - دالة مساعدة نقية `resolveDocBarcode` للربط التلقائي ببادئات المستندات الرسمية (`INV`، `PO`، `QUO`، `WO`).
   - تصدير دالتي `buildSalesInvoiceV2Html` و`buildPurchaseInvoiceV2Html` لتوليد HTML بدون الاعتماد الحصري على نافذة المتصفح، مما مكن من اختبار توليد الـ HTML في اختبارات الوحدة النقية.

4. **محول الطباعة `client/src/lib/printing/printTemplates.ts`:**
   - دعم وتمرير `barcode` و`barcodePlacement` في `InvoicePrintData` و`QuotationPrintData`.
   - إعادة تصدير دوال البناء والأنواع.

---

## ٣. الاختبارات والتحقق الجنائي (V.E.R.I.F.Y)
1. **اختبارات الوحدة النقية:**
   - إضافة 9 اختبارات وحدة مخصصة في `client/src/lib/printing/docHtml.test.ts`.
   - تسجيل الملف في `vitest.unit.config.ts`.
   - تشغيل الاختبارات بنجاح تام:
     - `docHtml.test.ts`: 9/9 ناجحة.
     - `barcode.test.ts`: 15/15 ناجحة.
     - `printTemplates.test.ts`: 19/19 ناجحة.
     - `documentNumber.test.ts`: 5/5 ناجحة.
2. **فحص الأنواع وبوابات الجودة الصارمة:**
   - `pnpm check`: اجتياز كامل 0 أخطاء (Code 0).
   - `pnpm check:guards`: اجتياز كافة الحراس الـ 45 بنسبة 100% (Code 0).
3. **المعاينة البصرية بالمتصفح:**
   - تم التحقق البصري بالتقاط لقطات شاشة كاملة عبر Chrome DevTools وتأكيد التناسق والتناسب مع مقاس A4 والخط الكوفي/القاهري والهوية البصرية الرسمية لمطبوعات مكتبة العربية.
