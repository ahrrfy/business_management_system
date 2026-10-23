# أرشيف حملة الإصلاح الجذري لانهيار إضافة المنتجات في عرض السعر وتحصين المحررات المشتركة — 2026-10-23

- **رقم طلب الدمج:** `PR #1538`
- **الالتزام المدموج على `main`:** `a5c3d045b074e7d1b0bbb473dacb3d42cdf9b127`
- **إصدار الإنتاج المنشور ذرّياً:** `web-1792755508621-a5c3d045b074` (`https://srv1548487.hstgr.cloud` — `258.6s`، `/healthz` `200 ok:true`، `/quotations/new` `200`)

---

## ١. التشخيص الجنائي للأسباب الجذرية (Root Causes)

### ١-أ. السبب الجذري الأول (المباشر للانهيار الفوري عند `items.length: 0 → 1`)
في `client/src/pages/QuotationNew.tsx` مقترناً بـ `client/src/components/invoice/reducer.ts`:
1. كان `allStockUnitIds` يُحسَب داخل `useMemo(..., [state.items])` فيُخصّص مصفوفة جديدة (`Array.from(...)`) عند كل تغيّر مرجعي في `state.items`، مع استعلام المخزون الحي عبر `trpc.catalog.stockByUnitIds.useQuery`.
2. كانت مصفوفة `allStockUnitIds` غير المستقرة مرجعياً مُمرَّرة ضمن اعتماديات `useEffect` الذي يُطلق `dispatch({ type: "SET_STOCK_SNAPSHOTS", ... })`.
3. فور إضافة أول منتج (أو فتح مسودة للتعديل أو تحويل طلب تسعير متجر)، ينتقل `allStockUnitIds.length` من `0` إلى `1`، فيُطلَق `SET_STOCK_SNAPSHOTS` الذي كان في `reducer.ts` يُعيد `state.items.map(...)` بمرجع مصفوفة جديد دائماً بلا فحص تكافؤ القيم (`no-op bailout`)، مما يُعيد حساب `allStockUnitIds` بمرجعٍ جديد ويُشعل حلقة `useMemo(state.items) → allStockUnitIds → useEffect(dispatch)` اللانهائية حتى انهيار `ErrorBoundary` بخطأ **React `#185` (`Maximum update depth exceeded`)**. (أمّا `SalesInvoiceNew.tsx` فكان يحفظ `stockUnitIds` دون تمريرها لاعتماديات `useEffect`، ثمّ جرى توحيده لاحقاً على نفس الخطّاف المشترك `useInvoiceLiveStockSync` لتوحيد السلوك وتحصين سلال `> 500` وحدة).

### ١-ب. السبب الجذري الثاني (انهيار الإدخال العابر في `MoneyInput` وإغلاق اختصار الحفظ)
مكوّن `MoneyInput` يسمح مرحلياً بالقيمة العابرة `"."` أثناء الكتابة قبل استكمال الرقم، كما تتحول `"."` عند فقدان التركيز (`blur`) إلى `""`:
1. استدعاء `new Decimal(v || "0")` مباشرةً في حسابات العرض أو الحفظ على `QuotationNew.tsx`، `SalesInvoiceNew.tsx` (`l.discount`، `state.globalDiscount`، `state.shipping`، `state.paidAmount`، `collectNow`)، `SalesCorrectionPanel.tsx`، `QuotationDetail.tsx` (`payAmount`)، `digitalBasket.ts`، و`quotationPayload.ts` كان يرمي استثناءً غير مُلتقَط `DecimalError: [DecimalError] Invalid argument: .` يُسقط الشاشة، أو يحوّل سعر البند الممسوح (`l.price === ""`) إلى `0.00` صامتة.
2. في `SalesInvoiceNew.tsx` كان اختصار لوحة المفاتيح `F4` (الحفظ أو إرسال التصحيح بدون طباعة، بينما `F9` هو الحفظ والطباعة) يلتقط إغلاقاً قديماً (`stale closure`) لدالة `handleSubmit` عند إبقاء التركيز داخل حقل `collectNow` على القيمة العابرة `"."`.

---

## ٢. المعالجات الجراحية والتحصينات الوقائية

1. **استخراج الخطّاف الموحّد وبث دفعات المخزون تدريجياً (`useInvoiceLiveStockSync.ts` + `reducer.ts` + `types.ts`):**
   - استخراج `useInvoiceLiveStockSync` بمفتاح نصّي بدائي مستقر (`allStockUnitIdsKey`) لا يتغيّر إلا عند تغيّر معرّفات الوحدات الموجبة (`productUnitId > 0`) فعلياً، مع حراسة `branchId > 0` وتطهير لقطة المخزون عند لصق البنود بين الفروع.
   - جلب الدفعة الأولى (`≤ 500` وحدة) عبر `trpc.catalog.stockByUnitIds.useQuery` وبثّها فوراً عبر `SET_STOCK_SNAPSHOTS`، ثم جلب الدفعات الإضافية (`> 500` وحدة) مستقلةً عبر `utilsRef.current.catalog.stockByUnitIds.fetch` داخل `Promise.allSettled` (`staleTime: 0` وإعادة المحاولة مع `dataUpdatedAt`) مع حراسة الإلغاء وتطابق `effectiveBranchId` و`queriedUnitIds`.
   - جعل `SET_STOCK_SNAPSHOTS` و`MARK_STOCK_STALE` و`SET_FIELD` في `reducer.ts` متماثلة المرجع (`return state`) متى كانت القيم مطابقةً للحالة القائمة.
2. **تحصين الحسابات المالية وبوابات التحقق (`QuotationNew.tsx`، `SalesInvoiceNew.tsx`، `SalesCorrectionPanel.tsx`، `QuotationDetail.tsx`، `digitalBasket.ts`، `quotationPayload.ts`):**
   - استخدام `moneyInput(...)` الآمن في مسارات المعاينة والحساب اللحظي لمنع انهيار `DecimalError` أثناء طباعة الفاصلة العشرية.
   - فرض رفضٍ صريح عبر `isCompleteNonNegativeMoneyInput` (مع `allowEmpty: false` لسعر البند والمبالغ الإلزامية، و`allowEmpty: true` للحقول الاختيارية) في `QuotationNew.tsx` و`SalesInvoiceNew.tsx` (بما فيها `collectNow`) و`QuotationDetail.tsx` (`payAmount`) و`buildQuotationLinePayload`، وربط اختصار الحفظ `F4` بـ `shortcutHandlersRef.current.handleSubmit()`.
3. **حراس الانحدار الدائمة (Static + Behavioral Regression Guards):**
   - [`client/src/pages/__tests__/reactEffectLoopGuard.test.ts`](../client/src/pages/__tests__/reactEffectLoopGuard.test.ts): حارس ساكن متوازن الأقواس (`findUnstableArrayEffectLoops`، مُسجَّل في `vitest.unit.config.ts`) يفحص ملفات `client/src/**` لمنع تمرير مصفوفات جديدة مُنشأة داخل `useMemo` يعتمد على `state.items` أو `items` أو `tabs` إلى اعتماديات `useEffect` يستدعي `dispatch(...)` أو `setState(...)`.
   - [`client/src/pages/__tests__/QuotationNew.addProduct.test.tsx`](../client/src/pages/__tests__/QuotationNew.addProduct.test.tsx): حزمة اختبارات تكاملية تختبر إضافة منتج من البحث الموحد، فتح مسودة عرض سعر للتعديل، تحويل طلب تسعير متجر، جلب وبث دفعات المخزون `> 500` وحدة وإعادة المحاولة وصلاحية `catalog.stockByUnitIds` وحراسة اللصق بين الفروع، كتابة `"."` العابرة في سعر البند ومنع الحفظ المجاني الصامت بعد `blur`، ورفض إرسال تصحيح فاتورة عبر `F4` عندما يكون `collectNow` على `"."`.
   - تحديث وتوسيع `stockAvailability.test.ts`، `quotationPayload.test.ts`، `salesInvoiceDigitalIntegrity.test.ts`، و`invoiceEditorPaymentTermsContract.test.ts`.

---

## ٣. التحقق والتسليم والنشر الذري

- **الفحوصات المحلية:** `pnpm check` (`0` أخطاء)، `pnpm check:guards` (`46/46` حارساً ناجحاً)، `56/56` اختباراً مستهدفاً، و`322/322` ملف اختبار عميل ناجحاً تحت `TZ=UTC`.
- **بروتوكول الدفع والدمج الآمن:** اجتياز مراجعة Codex الآلية ومعالجة ملاحظتي `P1` (`collectNow` + إغلاق `F4`) و`P2` (البث الفوري للدفعة الأولى)، واخضرار جميع وظائف GitHub Actions CI الـ 14 والفحص الأمني بنسبة 100%، والدمج عبر `pnpm pr:merge 1538` إلى `main` (`a5c3d045b`).
- **بروتوكول النشر الذري للإنتاج:** تنفيذ `pnpm prod:deploy` على `srv1548487.hstgr.cloud` وبناء وتفعيل الإصدار غير القابل للتعديل `web-1792755508621-a5c3d045b074` واجتياز فحوصات الجاهزية الحية (`/healthz` `200 ok:true`، `/quotations/new` `200`، `verify-nginx-storefront-readiness.mjs` `OK`).
