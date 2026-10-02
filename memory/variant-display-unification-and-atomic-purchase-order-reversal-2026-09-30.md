# ذاكرة توحيد ظهور سمات وتنوعات المنتجات ومسار التصحيح الذري لأوامر الشراء (30-09-2026)

**التاريخ:** 30 سبتمبر 2026  
**النطاق:** توحيد عرض سمات وتنوعات المنتجات عبر كامل النظام، ومسار التصحيح الذري لأوامر الشراء المستلمة، ومعالجة مسار الخزينة الإدارية في الوردية.  
**الملفات الرئيسية المعدلة:**
- النواة المشتركة: `shared/variantDisplay.ts`, `shared/variantDisplay.test.ts`.
- خدمات وراوترات الخادم: `server/routers/purchaseRouter.ts`, `server/routers/saleRouter.ts`, `server/routers/workOrderRouter.ts`, `server/services/quotationService.ts`, `server/services/documentDeliveryService.ts`, `server/services/shiftService.ts`.
- شاشات وتطبيقات الواجهة والطباعة: `client/src/pages/PurchaseOrderDetail.tsx`, `client/src/pages/PurchaseEdit.tsx`, `client/src/pages/PurchaseNew.tsx`, `client/src/pages/PurchaseRequisitions.tsx`, `client/src/pages/PurchaseReturnDetail.tsx`, `client/src/pages/InvoiceDetail.tsx`, `client/src/components/invoice/InvoiceDetailComponents.tsx`, `client/src/pages/SalesControlApprovals.tsx`, `client/src/pages/QuotationDetail.tsx`, `client/src/pages/POS.tsx`, `client/src/components/pos/POSHeader.tsx`, `client/src/lib/printing/invoiceReceipt.ts`, `client/src/pages/WorkOrderDetail.tsx`, `client/src/pages/WorkOrderStation.tsx`.  
**طلب الدمج المعتمد:** PR #1335  
**الالتزامات الرئيسية:** `9c5f2754d6`, `e09b7196`, `264ad6a7`  
**البروتوكولات المفعلة:** Sub-Agents Network, V.E.R.I.F.Y Protocols, Zero-Hallucination & Fact-Check, Closed-Loop Auto-Correction, Definition of Done (DoD).

---

## ١. التحقيق الجنائي وكشف الجذور (Root Cause Analysis - RCA)

### المشكلة الأولى: اختفاء سمات وتنوعات المنتج (مثل اللون والقياس) بجانب الاسم:
1. **انفصال حقول التوليد:** مصفوفة السمات في الواجهة كانت تخزن اللون والمقاس في `productVariants.color` و`productVariants.size` و`productVariants.colorHex`، وتترك `productVariants.variantName` بقيمة `NULL`.
2. **قصور استعلامات الخادم:** استعلامات Drizzle في خوادم الشراء والبيع وعروض الأسعار وأوامر العمل والطباعة الرسمية كانت تستعلم فقط عن `products.name` و`productVariants.variantName` دون جلب `color` و`size` و`variantKind`.
3. **انهيار التسمية بالواجهة:** كانت الواجهات تستعمل دمجاً نصياً بدائياً `${productName} — ${variantName}` فيسقط إلى اسم المنتج فقط، مما أدى لظهور بنود متطابقة اسماً ومختلفة لوناً (مثل تكرار حبر طابعة 4 مرات متطابقة دون معرفة ألوانها).

### المشكلة الثانية: تعذر التعديل المباشر على أمر الشراء بعد استلامه واعتماده:
1. **المخاطر المحاسبية والمخزنية الحرجة:** عند تحول أمر الشراء إلى `RECEIVED`، تتولد 5 آثار فورية:
   - إضافة المخزون فعلياً (`applyMovement(IN)`).
   - إعادة احتساب التكلفة المرجحة (WAVG Cost).
   - ترحيل قيود دفتر اليومية لوسيط بضاعة واردة غير مفوترة (`GRNI`).
   - إثبات الالتزام المالي للمورد ومطابقة الفاتورة.
   - قيود التدقيق والإقفال المالي.
2. **استحالة التعديل السطحي:** أي تعديل مباشر في مكانه يؤدي حتماً لكسر ميزان المراجعة، انهيار تسعير المخزون المرجح، ورصيد سالب أو وهمي.
3. **الحل الذري المعتمد:** تفعيل مسار «عكس استلام البضاعة» (Goods Receipt Reversal) عبر معاملة ذرية متكاملة (`withTx`) تلغي حركة المخزون والقيود المحاسبية وتتيح إعادة الإدخال الصحيح.

---

## ٢. التعديلات الهندسية المنفذة

### ١. محرك التنويعات الموحد (`@shared/variantDisplay`):
- دمج اسم التنويعة مع (اللون/القياس) عند توفرهما معاً عبر `variantDescriptor`.
- تغطية 8 سيناريوهات اختبار بنجاح 100% في `shared/variantDisplay.test.ts`.

### ٢. توسيع استعلامات الخادم:
- إضافة `color`, `size`, `colorHex`, `variantKind` في استعلامات الشراء والمبيعات وأوامر العمل وعروض الأسعار والطباعة الرسمية وتصدير الـ PDF.

### ٣. تعميم العرض الشامل بالواجهات:
- شاشات أوامر الشراء، طلبات الشراء، المرتجعات، فواتير المبيعات، اعتمادات المبيعات، عروض الأسعار ومشاركتها بالواتساب، نقاط البيع، البحث السريع، إيصالات الدفع الحرارية، وأوامر العمل ومحطات الفنيين.
- إضافة زر إرشادي مباشر في `PurchaseOrderDetail` للمدير لتصحيح أمر الشراء المستلم عبر مسار عكس الاستلام الذري (`/purchases/goods-receipt-reversals`).

### ٤. الشفاء الذاتي لمسار الخزينة الإدارية (`server/services/shiftService.ts`):
- استعادة استثناء الخزينة الإدارية (`TREASURY`) للأدوار الإدارية (`admin`/`manager`) لتمكين سداد واسترداد المبالغ دون اشتراط وردية كاشير تجزئة مفتوحة، ومعالجة فشل شاردات اختبارات الـ CI.

---

## ٣. التحقق الهندسي وبوابات الجودة (V.E.R.I.F.Y)

1. **V - Verification of Invariants:** الحفاظ على قيود المحاسبة المزدوجة والتكلفة المرجحة والمخزون.
2. **E - Execution & Fact-Check:** فحص واختبار كافة المسارات والوظائف محلياً وعن بُعد بلا أي افتراضات غير مؤكدة.
3. **R - Ratchets & Guards:** اجتياز كافة حراس النظام الـ 45 بنسبة 100% (`pnpm check:guards`).
4. **I - Isolation & Coordination:** صون التنسيق المشترك وحماية ملفات الجلسات المتزامنة (`wave1-hr-gaps`).
5. **F - Forensic Diagnostics:** تشخيص ومعالجة سبب فشل الشاردات في CI برؤية جنائية دقيقة.
6. **Y - Yield & Deployment:** توثيق الذاكرة، ورفع الالتزامات لفرع PR #1335، والاستعداد للنشر الذري المدار.
