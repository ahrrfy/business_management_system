# أرشيف حملة الإصلاح الجذري لانهيار إضافة المنتجات في عرض السعر وتحصين المحررات المشتركة — 2026-10-23

- **رقم طلب الدمج:** `PR #1538`
- **الالتزام المدموج على `main`:** `a5c3d045b074e7d1b0bbb473dacb3d42cdf9b127`
- **إصدار الإنتاج المنشور ذرّياً:** `web-1792755508621-a5c3d045b074` (`https://srv1548487.hstgr.cloud` — `258.6s`، `/healthz` `200 ok:true`، `/quotations/new` `200`)

---

## ١. التشخيص الجنائي للأسباب الجذرية (Root Causes)

### ١-أ. السبب الجذري الأول (المباشر للانهيار الفوري عند `items.length: 0 → 1`)
في `client/src/components/invoice/useInvoiceLiveStockSync.ts` مقترناً بـ `client/src/components/invoice/reducer.ts`:
1. كان `trpc.useQueries` يُعيد مصفوفة `stockQueries` بمرجعٍ جديد (`[]` جديد) في كل دورة تصيير (`render`).
2. كانت `stockQueries` مُدرجة مباشرةً في مصفوفة اعتماديات `useEffect` (`[branchId, dispatch, stockQueries]`).
3. فور إضافة أول منتج في `/quotations/new` أو `/sales/new` أو نافذة تصحيح الفاتورة (`SalesCorrectionPanel`)، ينتقل `allStockUnitIds.length` من `0` إلى `1`، فيُطلَق `SET_STOCK_SNAPSHOTS` الذي كان في `reducer.ts` يُعيد `items.map(...)` بمرجع مصفوفة جديد دائماً بلا فحص تكافؤ القيم (`no-op bailout`)، مما يُحدث إعادة تصيير فورية، فتُبنى `stockQueries` بمرجعٍ جديد، فيشتغل `useEffect` مجدداً في حلقة لا نهائية تنتهي بانهيار `ErrorBoundary` بخطأ **React `#185` (`Maximum update depth exceeded`)**.

### ١-ب. السبب الجذري الثاني (انهيار الإدخال العابر في `MoneyInput`)
مكوّن `MoneyInput` يسمح مرحلياً بالقيم العابرة أثناء الكتابة مثل `"."` أو `"-"` قبل استكمال الرقم:
1. استدعاء `new Decimal(v || "0")` مباشرةً في حسابات العرض أو الحفظ على `QuotationNew.tsx`، `SalesInvoiceNew.tsx` (`discountValue`، `paidAmount`، `collectNow`)، `SalesCorrectionPanel.tsx`، `QuotationDetail.tsx` (`payAmount`)، `digitalBasket.ts`، و`quotationPayload.ts` كان يرمي استثناءً غير مُلتقَط `DecimalError: [DecimalError] Invalid argument: .` يُسقط الشاشة.
2. في `SalesInvoiceNew.tsx` كان اختصار لوحة المفاتيح `F4` (الحفظ والطباعة) يلتقط إغلاقاً قديماً (`stale closure`) لدالة `handleSubmit` بدلاً من مرجعٍ حيّ (`handleSubmitRef`)، كما كان حقل `collectNow` يفتقر إلى فحص `isValidNonNegMoneyInput` الصريح قبل الإرسال.

---

## ٢. المعالجات الجراحية والتحصينات الوقائية

1. **إغلاق حلقة التصيير وبث دفعات المخزون تدريجياً (`useInvoiceLiveStockSync.ts` + `reducer.ts` + `types.ts`):**
   - استبدال `trpc.useQueries` باستعلام `trpc.products.listStockByUnitIds.useQuery` للدفعة الأولى (`≤ 500` وحدة) بحيث يُبثّ مخزون أول `500` وحدة فوراً دون انتظار الدفعات اللاحقة، وجلب الدفعات الإضافية (`> 500`) عبر `utils.products.listStockByUnitIds.fetch` مستقلةً عبر `Promise.allSettled` مع حراس إلغاء الجيل (`generation`) وتطابق `branchId` وختم `stockBranchId` لكل سطر.
   - جعل `SET_STOCK_SNAPSHOTS` و`MARK_STOCK_STALE` و`SET_FIELD` في `reducer.ts` ذوات خمولٍ تامّ (`return state` بنفس المرجع) متى كانت القيم مطابقةً للحالة القائمة.
2. **تحصين الحسابات المالية وبوابات التحقق (`QuotationNew.tsx`، `SalesInvoiceNew.tsx`، `SalesCorrectionPanel.tsx`، `QuotationDetail.tsx`، `digitalBasket.ts`، `quotationPayload.ts`):**
   - استخدام `moneyInput(...)` الآمن في كافة مسارات المعاينة والحساب اللحظي لمنع انهيار `DecimalError` أثناء طباعة الفاصلة العشرية.
   - فرض رفضٍ صريح (`!isValidNonNegMoneyInput(...)`) عند الحفظ أو الاعتماد أو التحويل إلى فاتورة لأي قيمة مالية غير مكتملة (`"."`) في السعر والخصم والمدفوع والمحصّل الفوري (`collectNow` و`payAmount`)، مع ربط اختصار `F4` بـ `handleSubmitRef.current`.
3. **حراس الانحدار الدائمة (Static + Behavioral Regression Guards):**
   - [`client/src/__tests__/reactEffectLoopGuard.test.ts`](../client/src/__tests__/reactEffectLoopGuard.test.ts): حارس ساكن يفحص كافة ملفات `client/src/**` (مُسجَّل في `vitest.unit.config.ts`) لمنع تمرير ناتج `useQueries(...)` مباشرةً في مصفوفات اعتماديات `useEffect` / `useMemo` / `useCallback`.
   - [`client/src/pages/__tests__/QuotationNew.addProduct.test.tsx`](../client/src/pages/__tests__/QuotationNew.addProduct.test.tsx): اختبار تكاملي ببيئة DOM حقيقية يختبر إضافة منتج وتغيير الفرع والكتابة العابرة `"."` في حقول السعر والخصم والمدفوع ورفض الحفظ الجزئي.
   - تحديث وتوسيع `stockAvailability.test.ts`، `salesInvoiceDigitalIntegrity.test.ts`، و`invoiceEditorPaymentTermsContract.test.ts`.

---

## ٣. التحقق والتسليم والنشر الذري

- **الفحوصات المحلية:** `pnpm check` (`0` أخطاء)، `pnpm check:guards` (`46/46` حارساً ناجحاً)، `56/56` اختباراً مستهدفاً، و`322/322` ملف اختبار عميل ناجحاً تحت `TZ=UTC`.
- **بروتوكول الدفع والدمج الآمن:** اجتياز مراجعة Codex الآلية ومعالجة ملاحظتي `P1` (`collectNow` + `F4`) و`P2` (البث الفوري للدفعة الأولى)، واخضرار جميع وظائف GitHub Actions CI الـ 14 والفحص الأمني بنسبة 100%، والدمج عبر `pnpm pr:merge 1538` إلى `main` (`a5c3d045b`).
- **بروتوكول النشر الذري للإنتاج:** تنفيذ `pnpm prod:deploy` على `srv1548487.hstgr.cloud` وبناء وتفعيل الإصدار غير القابل للتعديل `web-1792755508621-a5c3d045b074` واجتياز فحوصات الجاهزية الحية (`/healthz` `200 ok:true`، `/quotations/new` `200`، `verify-nginx-storefront-readiness.mjs` `OK`).
