# ذاكرة المشروع: القضاء الجذري على الأصفار العشرية في عرض الكميات وتوحيد التنسيق عبر النظام

> **التاريخ:** ٢٥ سبتمبر ٢٠٢٦  
> **الطلب الميداني:** القضاء على مشكلة عرض الكميات بأصفار عشرية زائدة بعد النقطة (مثل `1000.000` أو `120.000`) التي تسبب تشتتاً وصعوبة في القراءة.  
> **المرجع والبروتوكول:** `CLAUDE.md` — مصدر الحقيقة الموحد، بروتوكولات **V.E.R.I.F.Y**، الفحص الذري **Zero-Hallucination & Fact-Check**، ونظام التصحيح الذاتي المغلق **Closed-Loop Auto-Correction**.  
> **طلب الدمج:** PR #1256 (`fix_quantity_decimal_zeros`) — مدموج بالالتزام `4b640178` على `main`.  
> **النشر الإنتاجي:** نُشر بنجاح على خادم Hostinger VPS (`srv1548487.hstgr.cloud`) عبر `pnpm prod:deploy` في 233.5 ثانية مع تأكيد الصحة 200 OK على `/healthz`.

---

## ١. الجذر المعماري والمشكلة التشغيلية

1. **السبب الجذري في قاعدة البيانات (`MySQL Schema`):**
   - حقول الكميات في المخطط (مثل `quantity`, `receivedQuantity`, `returnQuantity`, `stockQuantity`, `baseQuantity`) معرفة بنوع `decimal(15,3)` لضمان الدقة المخزنية العالية للأصناف المقاسة بالأوزان أو الأطوال (مثل `1.125 kg` أو `2.500 m`).
   - تعيد مكتبة `mysql2` قيم الـ `decimal` كسلاسل نصية بصيغة ثابتة المنازل (مثل `"1000.000"` أو `"120.000"`).
   - عند عرض هذه الحقول مباشرة في واجهات المستخدم `{row.quantity}` دون وسيط معالجة، كانت تظهر للموظفين والمحاسبين بأصفار ثلاثية مشتتة (`1000.000` بدلاً من `1,000`).

2. **الأنماط الخاطئة السابقة في المعالجة:**
   - **الاستعمال الخاطئ لدوال المبالغ المالية (`round2` / `fmt` / `fmtAr`):** كانت بعض الشاشات تستعمل دوال المال التي تفرض منزلتين عشريتين (`120.00`)، وتقرب الكسور العادلة قسراً (مثل تحويل `1.125` إلى `1.13`) مما يتسبب في إتلاف الحسابات المخزنية ومخالفة حقيقة الجرد.
   - **الاستعمال الخاطئ للتقريب الصحيح (`fmtInt` / `Math.round`):** كان يبتر الكسور العشرية الحقيقية (مثل تحويل `1.5` متر إلى `1`).

---

## ٢. الحل الجذري والبنية التحتية الموحدة

### ٢.١ مصدر الحقيقة المركزي (`shared/quantityFormat.ts`)
تم إنشاء الوحدة المعمارية المركزية الوحيدة المسؤولة عن تنسيق الكميات:
- **الدالة الأساسية:** `formatQuantity(value, options?)`
- **الاسم البديل للطباعة:** `fmtQty(value, options?)`
- **القواعد الصارمة المنفذة:**
  1. تجريد الأصفار العشرية الزائدة من الأعداد الصحيحة تماماً: `1000.000` تصبح `1,000`، `120.000` تصبح `120`.
  2. صون الكسور العشرية الحقيقية حتى 4 منازل بلا تقريب جائر: `1.125` تبقى `1.125`، `0.250` تصبح `0.25`، `0.0005` تبقى `0.0005`.
  3. دعم فواصل الآلاف القياسية (Grouping) للأعداد الكبيرة: `50000` تصبح `50,000`.
  4. دعم خيار إلغاء فواصل الآلاف (`useGrouping: false`) للمواضع الضيقة في الفواتير الحرارية.
  5. معالجة آمنة بنسبة 100% للقيم الفارغة والمعدومة والسالبة مع خيار `fallback`.

### ٢.٢ اختبارات الوحدة الشاملة (`shared/quantityFormat.test.ts`)
- **11 اختباراً آلياً شاملاً** في Vitest لاختبار جميع الحالات الحدية (Edge Cases)، والتأكد من عدم فقدان أي دقة حسابية مخزنية، واجتازت جميعها بنسبة 100%.

### ٢.٣ إعادة التصدير الموحدة (`client/src/lib/money.ts`)
- تم تصدير الدالة وخياراتها قياسياً لجميع شاشات ومكونات الواجهة.

---

## ٣. النطاق الشامل للتطهير والمعالجة (62 ملفاً)

1. **المبيعات وعروض الأسعار والتحكم:**
   - بنود الفواتير (`InvoiceDetailComponents.tsx`).
   - عروض الأسعار ومسوداتها (`QuotationDetail.tsx`, `QuotationNew.tsx`).
   - شاشة اعتماد تعديلات المبيعات (`SalesControlApprovals.tsx`).
   - سجل المبيعات والتقارير التحليلية (`SalesRegister.tsx`, `SalesReport.tsx`, `InvoiceDrilldownView.tsx`).

2. **الكاشير ونقاط البيع والاستقبال:**
   - سلة الكاشير والتحقق من الأرصدة المتاحة والمحجوزة (`CartPanel.tsx`, `POSHeader.tsx`).
   - سلة مسودات الاستقبال والإيصالات (`CartTable.tsx`, `ReceiptOverlay.tsx`, `ReceptionDraftsPage.tsx`).
   - حجوزات البضاعة والكميات المعلقة (`ReservationsHub.tsx`).
   - شريط البحث الموحد للمنتجات (`UnifiedProductSearch.tsx`).
   - درج الطلبات المعلقة للكاشير (`HeldOrdersDrawer.tsx`).

3. **المشتريات والموردين وبضاعة الأمانة:**
   - تفاصيل أوامر الشراء والكميات المطلوبة والمستلمة والمتبقية (`PurchaseOrderDetail.tsx`, `PurchaseDetailDrawer.tsx`, `PurchaseOrderDrilldownView.tsx`).
   - سجل الشراء ومرتجع المشتريات (`PurchaseRegister.tsx`, `PurchaseReturnDetail.tsx`).
   - تسويات بضاعة الأمانة والأرصدة المباعة والمتبقية (`ConsignmentSettlements.tsx`).
   - شاشة الهدايا والمجانيات (`GiftsHub.tsx`, `DecisionRow.tsx`).

4. **المخزون وحركات المواد والتصنيع:**
   - بطاقة الصنف والمخزون وحركات المواد (`Products.tsx`, `Inventory.tsx`, `InventoryMovements.tsx`, `ItemLedger.tsx`).
   - تقارير تشغيل المخزون وحالة الأصناف (`InventoryOpsReport.tsx`, `StockStatus.tsx`, `StocktakeReport.tsx`).
   - تخطيط المواسم والتصنيع والتركيبات (`SeasonPlanning.tsx`, `ProductionDetail.tsx`, `ProductionNew.tsx`, `BundleRecipeCard.tsx`, `AnomalyWatch.tsx`).

5. **أوامر الشغل والمطبعة:**
   - شاشات ومحطات أوامر الشغل (`WorkOrderDetail.tsx`, `WorkOrderStation.tsx`).
   - محررات مواد أوامر الشغل والمعاينة (`WorkOrderMaterialsEditor.tsx`, `WorkOrderPreviewDrawer.tsx`, `CancelWorkOrderDialog.tsx`).

6. **المرتجعات والمتجر الإلكتروني:**
   - ملحن المرتجعات وبوابة الاسترجاع (`ReturnComposer.tsx`, `SalesReturnPortal.tsx`).
   - واجهة المتجر الإلكتروني وسلة التسوق وطلبات التسعير (`Storefront.tsx`, `StoreQuoteRequests.tsx`).

7. **قوالب الطباعة (Thermal & A4):**
   - توحيد كامل القوالب على `fmtQty`:
     - فواتير A4 للمبيعات (`a4Invoice.ts`).
     - إيصالات الكاشير الحرارية والنقطية (`printTemplatesV2.ts`, `printTemplates.ts`, `receiptRaster.ts`).
     - أوامر الشغل وبطاقات الإنتاج (`workOrderRaster.ts`).
     - تذاكر المسودات والحجوزات والطلبات الإلكترونية (`draftTicket.ts`, `reservationTicket.ts`, `onlineOrder.ts`).
     - إرساليات بضاعة الأمانة ووثائق النقل ومناقلات المخازن (`printConsignmentNote.ts`, `printTransferDoc.ts`).
     - بوالص الشحن الحرارية وقسائم الهدايا ونماذج الجرد (`shippingLabel.ts`, `giftVoucher.ts`, `stocktakeTemplates.ts`).

8. **نصوص المشاركة والواتساب والنسخ:**
   - رسائل تفاصيل الفاتورة عبر واتساب (`whatsapp.ts`).
   - نصوص النسخ المباشر للحافظة (`copy/formatters.ts`).

---

## ٤. دورة التصحيح التلقائي المغلقة (Closed-Loop Auto-Correction)

- **اكتشاف انحراف حزم الـ PWA:**
  - عند تشغيل خط أنابيب البناء عالي الجودة `quality-build` في CI، رُفضت حزمة المتجر الإلكتروني بسب خطأ:
    `STOREFRONT_PRECACHE_STATIC_IMPORT_MISSING:assets/quantityFormat-*.js`.
  - التحليل الجنائي: نظراً لأن واجهة المتجر الإلكتروني استوردت من `@/lib/money`، قام مجمع Rollup بعزل `quantityFormat` في حزمة منفصلة، في حين أن عقد خدمة PWA (`scripts/storefront-pwa-contract.mjs`) يشترط تضمين جميع الاستيرادات الثابتة في `STOREFRONT_SHELL_CHUNK_GLOB`.
  - المعالجة الذاتية: تم تحديث `STOREFRONT_SHELL_CHUNK_GLOB` لتضمين حزمة `quantityFormat`، واجتاز فحص `pnpm build` وفحص التحقق من العقد محلياً وعبر CI بنسبة 100%.

---

## ٥. نتائج التحقق والدمج والنشر (المرحلة الأولى)

1. **فحوصات الجودة المحلية وعبر السحاب:**
   - فحص الأنواع (`pnpm check`): 0 أخطاء (100% Clean).
   - حراس الجودة العشرة (`pnpm check:guards`): اجتياز كامل لجميع الحراس دون أي انحراف.
   - اختبارات CI السحابية الـ 14 (شاملة الشاردات الثمانية لاختبارات النظام): **All Green 100%**.
2. **الدمج في المستودع:**
   - دمج طلب الدمج PR #1256 في فرع `main` بالالتزام `4b640178`.
3. **النشر الإنتاجي:**
   - تنفيذ `pnpm prod:deploy` على خادم Hostinger VPS (`srv1548487.hstgr.cloud`) في 233.5 ثانية.
   - استقرار عمال الويب في PM2 وجسر الحضور، ونجاح فحص الحيوية 200 OK على `/healthz`.

---

## ٦. المرحلة الثانية: التدقيق الجنائي العميق، دعم Decimal، وتطهير تطبيقات الموبايل (PR #1265)

استكمالاً لبروتوكول V.E.R.I.F.Y الصارم واستهداف القضاء بنسبة 100% على أي ظهور للأصفار الزائدة حتى في أعمق النوافذ الحوارية والشاشات الداخلية وتطبيقات الموبايل:

### ٦.١ النطاق المضاف والمطهّر (32 ملفاً إضافياً):
1. **نوافذ الإرجاع والشاشات الحوارية:**
   - إيصالات المرتجع الحراري (`client/src/components/returns/printThermalReturnReceipt.ts`).
   - نافذة المرتجع بلا إيصال (`client/src/components/returns/NoReceiptReturnDialog.tsx`).
   - بوابة استرجاع المبيعات وحساب الكميات القصوى (`client/src/components/returns/SalesReturnPortal.tsx`).
   - نافذة تعديل الطلبات الإلكترونية (`client/src/components/store/EditOnlineOrderDialog.tsx`).
   - سلة الكاشير وشاشة معاينة الإيصال (`client/src/components/pos/CartPanel.tsx`, `client/src/components/pos/ReceiptOverlay.tsx`).
   - نافذة اختيار البطاقات الرقمية ومحدد الكميات (`client/src/components/pos/DigitalCardsPickerDialog.tsx`).
2. **سندات التحويل المخزني والعمليات:**
   - سلة سند التحويل المخزني وشارات النقص والنافذ (`client/src/components/transfer/TransferCart.tsx`).
   - سجل المناقلات وإجماليات السندات المنقولة والمستلمة ومودال الاستلام (`client/src/pages/TransfersLog.tsx`).
   - وثائق نقل بضاعة الأمانة (`client/src/lib/printing/printConsignmentNote.ts`).
3. **أوامر الشغل والتصنيع والتركيبات:**
   - بطاقات كانبان لأوامر الشغل وشارات الكمية (`client/src/components/workOrders/WorkOrderKanbanCard.tsx`).
   - وصفات وتراكيب الإنتاج ومعاينة BOM ومطابقة الوحدات الأساس (`client/src/pages/ProductionRecipes.tsx`).
4. **المتجر والمنتجات والنماذج:**
   - المتجر الإلكتروني، الصفوف المنسقة، والبطاقات، وسلة التسوق (`client/src/pages/Storefront.tsx`, `StorefrontCuratedRows.tsx`, `StorefrontProductCard.tsx`).
   - نافذة التخصيص والملاحظات (`client/src/components/CustomizationDialog.tsx`).
   - حقول ونماذج المنتجات البسيطة والمتعددة وإجمالي المخزون (`SimpleProductForm.tsx`, `ProductVariantsFields.tsx`).
   - حاسبة تسعير الطباعة ونماذج المشتريات والمبيعات ومطابقة الوحدات الكسرية (`PrintPricingCalculator.tsx`, `PurchaseEdit.tsx`, `PurchaseNew.tsx`, `SalesInvoiceNew.tsx`).
5. **تطبيقات الموبايل (Expo Native Apps):**
   - تطبيق كادر العمليات (`expo/superapp-mobile`):
     - إضافة دالة `formatQuantity` المعتمدة في `lib/format.ts`.
     - تطهير كميات المخزون وحد الطلب في `app/operations/inventory.tsx`.
     - تطهير كميات الفواتير في `app/operations/invoices.tsx`.
     - تطهير بطاقات الجرد والتدقيق المخزني والفروقات في `components/MobileStockAuditCard.tsx`.
   - تطبيق متجر العملاء (`expo/customer-store-mobile`):
     - توحيد عرض كميات السلة وإشعارات واتساب في `app/(tabs)/cart.tsx`.
     - توحيد كميات طلبات عروض الأسعار في `app/request-quote.tsx`.
     - توحيد كميات نافذة السلة الجانبية في `components/side-cart.tsx`.
     - توحيد وصف الاختيارات والكميات في `lib/checkout-selection.ts`.

### ٦.٢ الترقية المعمارية للمرونة الحسابية
- تم تحديث توقيع الدالة المركزية `formatQuantity` في `shared/quantityFormat.ts` ليقبل `string | number | { toString(): string } | null | undefined`.
- يتيح ذلك تمرير كائنات `Decimal` و `BigNumber` مباشرة بأمان ودون الحاجة لتحويلات يدوية أو حدوث أخطاء فحص أنواع.
- تعزيز حزمة الاختبارات لتصبح 12 اختباراً آلياً شاملاً في `shared/quantityFormat.test.ts`.

### ٦.٣ نتائج دمج ونشر المرحلة الثانية
1. **فحوصات الجودة:**
   - فحص الأنواع `pnpm check`: اجتياز كامل 0 أخطاء.
   - حراس الجودة المعمارية `pnpm check:guards`: اجتياز كامل لجميع الحراس الـ 45.
   - اختبارات الوحدة `shared/quantityFormat.test.ts`: نجاح 12/12 بنسبة 100%.
2. **فحوصات الـ CI والدمج:**
   - اجتياز 16 فحصاً في GitHub Actions CI (شاملة `superapp-check`, `customer-store-check`, `quality-build`, والشاردات الثمانية).
   - دمج PR #1265 في فرع `main` بالالتزام `73fdd29d`.
3. **النشر الإنتاجي:**
   - تنفيذ `pnpm prod:deploy` بنجاح على Hostinger VPS (`srv1548487.hstgr.cloud`) في 246.6 ثانية.
   - ثبات عمال الويب PM2 cluster وجسر الحضور erp-hr-bridge.
   - التحقق الحي من فحص الصحة: `HTTP/2 200 OK` على `https://srv1548487.hstgr.cloud/healthz`.

