# ذاكرة المعالجة الذرية لإسناد وإلغاء التوصيل وتصفية بيانات الإرساليات الملغاة (24-09-2026)

**التاريخ:** 24 سبتمبر 2026  
**النطاق:** دورة حياة إسناد وإلغاء التوصيل، فواتير المبيعات، الاستقبال والورشة، مخرجات الطباعة A4 والحرارية، والاستعلامات الخلفية  
**طلب السحب:** PR #1211 (الالتزام المدموج: `560287c1` على `main`)  
**النشر الإنتاجي:** منشور بنجاح تام على سيرفر الإنتاج Hostinger VPS (`srv1548487.hstgr.cloud`) عبر النشر الذري `pnpm prod:deploy` (290.6 ثانية، `/healthz` 200 OK)  
**الحالة:** مدموج في main ومنشور على الإنتاج 100% بنجاح تام وبلا أي تسريب بيانات

---

## ١. ملخص المشكلة وجذرها الجنائي والتقني (Forensic & Root Cause Analysis)

### الخلل المشكو منه:
عند إسناد التوصيل لفاتورة مبيعات، ثم التراجع وإلغاء الإسناد لاحقاً عبر نافذة الإلغاء، كانت بيانات التوصيل تبقى ظاهرة على الفاتورة:
- تظهر أجرة التوصيل في الملخص المالي للفاتورة ومطبوعات الإيصال والـ A4.
- يظهر اسم المندوب أو جهة التوصيل وتفاصيل الإرسالية في ترويسة الفاتورة (`InvoiceHeaderCard`).
- في طابور فواتير الاستقبال (`ReceptionInvoiceQueue`) تظهر الفاتورة بحالة «(بالطريق)» ويتعطل زر الإرسال.
- كان السؤال الجوهري للمالك: *«أليس من الصحيح أن يتم الإسناد بشكل ذري وإلغاء الإسناد بشكل ذري أيضاً؟»*

### التحقيق الجنائي لشبكة الوكلاء الفرعيين (Sub-Agents Forensic Network):

1. **وكيل المخطط وقاعدة البيانات (Database Forensic Investigator):**
   - أثبت الفحص أن جدول `invoices` لا يحتوي على أي أعمدة تخص التوصيل أو المندوبين.
   - العلاقة بين الفاتورة وبيانات التوصيل مبنية بالكامل عبر جدول `deliveryConsignments` بقيد فريد `uq_consignment_invoice` على عمود `invoiceId`.
   - عند إلغاء الإسناد (`cancelDeliveryAssignment`)، لا يُحذف سجل الإرسالية من قاعدة البيانات، بل تُحوّل حالته إلى `CANCELLED`، وذلك لغاية تشغيلية ومحاسبية سليمة: حفظ قيود دفتر الأستاذ (`deliveryLedgerEntries`)، وسجل الأحداث والتدقيق (`deliveryEvents`)، وإتاحة إعادة التنشيط (`reactivation`) في حال أُعيد إسناد الفاتورة لاحقاً.
   - إذن، البيانات مخزنة بشكل سليم تشغيلياً، لكن المشكلة تكمن في طبقة القراءة والاستعلام.

2. **وكيل المسارات الخلفية (Backend Flow & Atomicity Investigator):**
   - كشف التحقيق أن جذر التسريب هو ربط خارجي غير مشروط:
     `LEFT JOIN deliveryConsignments ON deliveryConsignments.invoiceId = invoices.id`
     في كافة استعلامات الفواتير داخل `server/routers/saleRouter.ts` (`sales.get`, `sales.list`, `sales.listPage`, `sales.listSummary`)، وفي استعلامات الاستقبال `server/services/reception/queries.ts`، واستعلامات التصحيح `server/services/sale/correctionLookup.ts`، وخدمة المرتجعات `server/services/returnService.ts`.
   - هذا الربط الأعمى كان يُرجع سجل الإرسالية حتى لو كانت حالته `CANCELLED`، مما يجعل حقول `courierName`, `courierFee`, `courierFeeCollection`, `deliveryPartyId`, `consignmentStatus` تعود ممتلئة بالبيانات القديمة الملغاة بدلاً من أن تكون `NULL`.

3. **وكيل الواجهات والطباعة (Frontend & Document Auditor):**
   - في واجهة بطاقة الفاتورة `InvoiceHeaderCard.tsx`، كانت البطاقة تفحص وجود `courierFee` و `consignmentNumber` دون فحص ما إذا كانت `consignmentStatus === "CANCELLED"`.
   - في طباعة A4 في `InvoiceDetail.tsx` وطباعة الإيصال الحراري في `invoiceReceipt.ts`، كانت أجرة التوصيل تُضاف وتُطبع وتُطلب من الزبون لأن الواجهة قرأت بيانات الإرسالية الملغاة.
   - في حوار الإلغاء `CancelDeliveryAssignmentDialog.tsx`، لم يكن هناك إبطال لكاش استعلام `sales.get` و `sales.listSummary`، فكانت الواجهة تحتفظ بالحالة القديمة حتى بعد تحديث السيرفر.

---

## ٢. الحلول والمعالجات الهندسية المنفذة

### أ) الباك إند والاستعلامات الخلفية (Backend & Query Layer):
1. **تصفية الإرساليات الملغاة على مستوى الربط الخارجي (`LEFT JOIN`):**
   تحديث شرط الربط في كافة استعلامات الفواتير في `server/routers/saleRouter.ts`:
   ```typescript
   leftJoin(
     deliveryConsignments,
     and(
       eq(deliveryConsignments.invoiceId, invoices.id),
       ne(deliveryConsignments.status, "CANCELLED")
     )
   )
   ```
   **الأثر الهندسي:** هذا الشرط يضمن أن أي فاتورة ألغي إسنادها ستعود كافة حقول الإرسالية فيها (`courierName`, `courierFee`, `consignmentNumber`, إلخ) كـ `NULL` تلقائياً وفورياً لجميع الفواتير في النظام دون الحاجة لأي سكربت لتعديل أو حذف بيانات تاريخية.
2. **استعلامات فواتير الاستقبال والورشة (`server/services/reception/queries.ts`):**
   إضافة نفس قيد التصفية `ne(deliveryConsignments.status, "CANCELLED")` في `listReceptionInvoices` لضمان تحرير الفاتورة من حالة التوصيل فور إلغائه.
3. **استعلامات فحص التصحيح (`server/services/sale/correctionLookup.ts`):**
   تطبيق التصفية في `lookupInvoiceForCorrection` و `lookupWorkOrderForCorrection` لضمان عدم ربط سجل تصحيح بإرسالية ملغاة.
4. **معاينة المرتجعات (`server/services/returnService.ts`):**
   تحديث استعلام `deliveryPreview` لتجاهل الإرساليات الملغاة وعدم احتساب أجرة توصيل على المرتجع إن كان الإسناد ملغى.
5. **عكس إسناد أوامر الشغل (`server/services/workOrder/reverseDelivery.ts`):**
   تحديث `assertSettledConsignmentOrNone` للسماح بعمليات العكس إذا كانت الإرسالية ملغاة أصلاً (`status === "CANCELLED" && parcelStatus === "CANCELLED"`).

### ب) الواجهات ومخرجات الطباعة وقوائم الاستقبال (Frontend & Printing):
1. **بطاقة الفاتورة (`client/src/components/invoice/InvoiceHeaderCard.tsx`):**
   - حجب صندوق معلومات الإرسالية وحجب سطر أجرة التوصيل إذا كانت `consignmentStatus === "CANCELLED"`.
   - استرجاع الحساب المالي الصافي لقيمة البضاعة فقط دون إضافة أي أجرة توصيل ملغاة.
2. **شاشة تفاصيل الفاتورة وطباعة A4 (`client/src/pages/InvoiceDetail.tsx`):**
   - حجب بيانات التوصيل من مستند الطباعة A4 المعتمد (`printApprovedA4`) عند إلغاء الإرسالية.
   - منع طباعة ملصق الشحن `canPrintShippingLabel` إذا كانت حالة الإرسالية `CANCELLED`.
3. **الطباعة الحرارية للإيصالات (`client/src/lib/printing/invoiceReceipt.ts`):**
   - تحديث `invoiceToReceipt` لعدم تمرير `courierFee` و `courierName` إذا كانت حالة الإرسالية `CANCELLED`.
4. **حوار إلغاء الإسناد (`client/src/components/delivery/CancelDeliveryAssignmentDialog.tsx`):**
   - إضافة إبطال فوري لكاش استعلام `sales.get` و `sales.listSummary` فور نجاح الإلغاء لضمان التحديث اللحظي للواجهة بدون الحاجة لإعادة تحميل الصفحة.
5. **طابور فواتير الاستقبال (`client/src/components/reception/ReceptionInvoiceQueue.tsx`):**
   - منع إظهار شارة `(بالطريق)` للفاتورة عند إلغاء إسنادها، وإظهار حالتها المحاسبية الصريحة («مدفوعة جزئياً» أو «غير مدفوعة»).
   - إعادة تفعيل زر «إرسال للتوصيل» فوراً للفواتير الملغاة لتمكين إعادة إسنادها بسلاسة.

---

## ٣. التحقق والاختبارات الآلية (Automated Verification)

تم إنشاء وتحديث حزم اختبارات آلية شاملة لضمان استقرار السلوك ومنع الانتكاس:
- **`server/tests/deliveryAssignmentCancellation.test.ts`:**
  - 17 اختباراً ناجحاً بنسبة 100%.
  - يتضمن كتلة اختبارات ذرية متخصصة (`Sales queries omit cancelled consignment data`) تفحص `sales.get` و `sales.list` و `sales.listPage` وتثبت أن الفواتير ذات الإرساليات الملغاة تعود بحقول توصيل `null` خالية تماماً، بينما تعود الفواتير ذات الإرساليات النشطة بكامل بياناتها السليمة.
- **`client/src/lib/printing/__tests__/invoiceReceipt.test.ts`:** 3/3 اختبارات ناجحة تثبت حجب التوصيل الملغى من الإيصال الحراري.
- **`server/tests/receptionInvoiceWorkshop.test.ts`:** 8/8 اختبارات ناجحة تثبت سلامة طابور الاستقبال وإعادة الإسناد.
- **`server/tests/reverseServiceInvoice.test.ts`:** 2/2 اختبارات ناجحة تثبت سلامة مسار العكس المحاسبي.
- **فحص الأنواع وحراس الجودة:**
  - `pnpm check`: اجتياز كامل بدون أي خطأ (0 Type Errors).
  - `pnpm check:guards`: اجتياز كامل لحراس الجودة العشرة بنسبة 100%.

---

## ٤. بروتوكول الأتمتة الشامل، الدمج، والنشر الإنتاجي (CI/CD, Merge & Production Deploy)

1. **الالتزام والدفع:** التزام التغييرات بالالتزام `387633b5` ورفع الفرع `atomic_delivery_assignment_fix` إلى المستودع البعيد.
2. **طلب السحب (Pull Request):** إنشاء [PR #1211](https://github.com/ahrrfy/business_management_system/pull/1211).
3. **مراقبة خط الأنابيب (CI 100% Green):** اجتياز كافة وظائف الفحص الـ 13 في GitHub Actions بنجاح تام:
   - `GitGuardian security checks`
   - `dependency-audit`
   - `authz-guard`
   - `scope-guard`
   - `quality-build`
   - `test-shards (1 through 8)`
4. **الدمج التلقائي في `main`:** تم دمج PR #1211 بنجاح في فرع `main` بالالتزام `560287c1`.
5. **النشر الإنتاجي الذري الآمن (Hostinger VPS):**
   - تنفيذ النشر عبر `pnpm prod:deploy` على خادم الإنتاج المشترك `srv1548487.hstgr.cloud` بمستخدم `deploy`.
   - استغرق النشر **290.6 ثانية** واكتمل بنجاح تام (Exit Code: 0).
   - تم التحقق من سلامة البيئة الإنتاجية واستجابة فحص الصحة `/healthz` بكود `200 OK` واستقرار خوادم PM2 وجسر الحضور.
6. **تحرير أقفال التنسيق الرقابية:** تم تحرير ادعاء الشريحة الرقابية `pnpm coord:release atomic-delivery-assignment-fix` والتأكد من نظافة شجرة العمل.
