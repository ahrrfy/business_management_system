# خطّة هجرة `<select>` → `AppSelect` (تدريجيّة، متعدّدة الشرائح)

> **الحالة (٣١/٧/٢٦):** الشريحة ١ منشورة إنتاجياً (PR #428 = `a121f3f`). المتبقّي **١٤٩ ملفاً** يستعمل `<select>` الأصليّ — يُهاجَر تدريجياً في شرائح صغيرة (٢٠-٣٠ ملفاً/شريحة) عبر جلسات قادمة.

## الخلفيّة
تدقيق المالك ٣١/٧: القوائم المنسدلة الأصليّة `<select>` تظهر مقتطعةً/مضغوطةً في Chromium — العرض/الحدود/الظلّ بيد المتصفّح لا يتجاوزها CSS.

**العلاجات المنشورة سابقاً:**
- PR **#425**: عدّاد الجرد الحقيقي (لم يكن جزءاً من مسألة الـselect لكنّه شغّل الشكوى بصرياً).
- PR **#426** (`55d6006`): قاعدة CSS دفاعيّة عالميّة على `<option>` — تُحسّن ما يُتاح للنمط دون استبدال المكوّن.
- PR **#428** (`a121f3f`): مكوّن `AppSelect` + هجرة `StocktakeNew.tsx` كنموذج (٤ قوائم).

## `AppSelect` — النمط النموذجي للهجرة

```tsx
// قبل:
<select className={cls} value={v} onChange={(e) => setV(e.target.value)}>
  <option value="X">A</option>
</select>

// بعد:
<AppSelect className={cls} value={v} onValueChange={setV}>
  <option value="X">A</option>
</AppSelect>
```

**التغييرات الحتميّة:**
- `<select>` → `<AppSelect>`
- `onChange={(e) => f(e.target.value)}` → `onValueChange={f}`
- `<option>`s **تبقى كما هي** (المكوّن يحوّلها داخلياً)
- القيم الرقميّة: `value={String(id)}` + `onValueChange={(v) => setX(Number(v))}` (نفس اتفاقيّة `<select>` — دائماً نصّ)
- `<option value="">— اختر —</option>` تُعامَل تلقائياً كـplaceholder (Radix يرفض `value=""` على SelectItem)
- `<optgroup label>` مدعوم (يُحوَّل إلى `SelectGroup + SelectLabel`)
- `disabled` على `<option>` مدعوم

**الفوائد المُكتسَبة تلقائياً:** popup يطابق عرض trigger، ظلّ/حدود من نظام الألوان، `data-theme`-aware، Type-ahead، تنقّل لوحة مفاتيح كامل، RTL-aware، حبس تركيز، a11y كامل، Portal (لا يُقصّه container).

## الأولويّات المقترحة (حسب الأثر التشغيليّ اليوميّ)

### شريحة ٢ — الكاشير عالي الحركة (٦ ملفات — أعلى استعمال يوميّ)
```
client/src/pages/POS.tsx
client/src/pages/Reception.tsx
client/src/pages/PrintPOS.tsx
client/src/pages/SalesInvoiceNew.tsx
client/src/components/pos/CashDropDialog.tsx
client/src/pages/QuotationNew.tsx
```

### شريحة ٣ — إنشاء وتحرير الفواتير والمرتجعات (٩ ملفات)
```
client/src/pages/PurchaseNew.tsx
client/src/pages/PurchaseReturnNew.tsx
client/src/pages/SalesReturnNew.tsx
client/src/pages/InvoiceDetail.tsx
client/src/pages/Invoices.tsx
client/src/pages/WorkOrderNew.tsx
client/src/pages/WorkOrderDetail.tsx
client/src/pages/WorkOrders.tsx
client/src/pages/PurchaseDetail.tsx
```

### شريحة ٤ — المخزون والتحويلات والجرد (٩ ملفات)
```
client/src/pages/Inventory.tsx
client/src/pages/InventoryMovements.tsx
client/src/pages/InventoryValuation.tsx
client/src/pages/Transfers.tsx
client/src/pages/TransfersLog.tsx
client/src/pages/ItemLedger.tsx
client/src/pages/StocktakeReview.tsx
client/src/pages/StocktakeMonitor.tsx
client/src/pages/Stocktakes.tsx
```

### شريحة ٥ — الكتالوج وإدارة المنتجات (٩ ملفات)
```
client/src/pages/Products.tsx
client/src/pages/ProductNew.tsx
client/src/pages/ProductEdit.tsx
client/src/pages/Categories.tsx
client/src/components/product/BundleForm.tsx
client/src/components/product/ServiceForm.tsx
client/src/components/product/SimpleProductForm.tsx
client/src/components/product/SimpleProductEditForm.tsx
client/src/components/product/VariantMatrix.tsx
```

### شريحة ٦ — العملاء والموردون والذمم (١٢ ملفاً)
```
client/src/pages/Customers.tsx · CustomerNew.tsx · CustomerEdit.tsx
client/src/pages/Suppliers.tsx · SupplierNew.tsx · SupplierEdit.tsx · SupplierStatement.tsx
client/src/pages/ARAging.tsx · APAging.tsx · ARReminders.tsx · APReminders.tsx
client/src/pages/ArApAgingDetail.tsx
client/src/components/CustomerPicker.tsx
client/src/components/customers/CustomerFollowUpDialog.tsx
```

### شريحة ٧ — الخزينة والصيرفة والسندات (٩ ملفات)
```
client/src/pages/Treasury.tsx · TreasuryReport.tsx · TreasuryTransfers.tsx
client/src/pages/Vouchers.tsx · VoucherCategories.tsx
client/src/pages/_VoucherFormShared.tsx
client/src/pages/ExchangeOperations.tsx · ExchangeReconcile.tsx · ExchangeSettle.tsx · ExchangeStatement.tsx
client/src/pages/CardAccount.tsx
```

### شريحة ٨ — الرواتب والموظفون والحضور (٩ ملفات)
```
client/src/pages/Payroll.tsx · PayrollLegalSettings.tsx
client/src/pages/Employees.tsx · EmployeeNew.tsx · EmployeeAdvances.tsx
client/src/pages/Attendance.tsx · AttendanceReport.tsx · Leaves.tsx
client/src/pages/HrDevices.tsx
```

### شريحة ٩ — التقارير والمالي (١٥ ملفاً)
```
BalanceSheet · CashFlow · GeneralLedger · TrialBalance · MonthlyClosePack · YearEnd
ExpensesReport · WorkOrdersReport · WorkOrderProfitability · WIPReport · DayCloseReport
InventoryOpsReport · AbcAnalysis · CreditExposureReport · CashOrphanReport · CourierPerformanceReport
```

### شريحة ١٠ — المتجر والتوصيل (٧ ملفات)
```
client/src/pages/Storefront.tsx
client/src/pages/store/*.tsx (2 ملفات)
client/src/pages/DeliveryHub.tsx · DeliveryParties.tsx
client/src/pages/KioskDevices.tsx
client/src/components/kiosk/KioskView.tsx
```

### شريحة ١١ — العمولات والأهداف والحجوزات والأقساط (٥ ملفات)
```
CommissionPlans · CommissionRuns · InstallmentPlans · Coupons · Offers
```

### شريحة ١٢ — البطاقات الرقميّة (٦ ملفات — وحدة كاملة)
```
client/src/pages/digitalCards/*.tsx
```

### شريحة ١٣ — الإدارة والإعدادات (١٢ ملفاً)
```
Users · UserEdit · Branches · AuditLogs · IntegrationsSettings · AnomalyWatch
Inbox · TasksHub · TaskDetail · WhatsappHubReport · WaBroadcasts · PriceWaves
```

### شريحة ١٤ — الأصول الثابتة والنطاق الأخير (٦ ملفات)
```
AssetRegister · AssetNew · AssetEdit · AssetDetail
BarcodeLabels · GiftsHub
```

### شريحة ١٥ — نماذج مشتركة ومكوّنات مرافقة (٩ ملفات)
```
client/src/components/form/AccountFields.tsx · Field.tsx · IntlPhoneInput.tsx
client/src/components/import/ImportDialog.tsx
client/src/components/reports/PeriodFilter.tsx
client/src/components/ShippingLabelSizeSelect.tsx
client/src/lib/categoryTree.tsx
client/src/pages/ContractPrices.tsx
client/src/pages/InvoiceNew.tsx (إن وُجد بلا هجرة)
```

## بروتوكول كل شريحة قادمة

قبل بدء الشريحة، شغّل هذا الأمر لتوليد قائمة محدَّثة (بعد كل دمج قد يتغيّر العدد):
```bash
grep -rln '<select\b' client/src --include="*.tsx" | wc -l && grep -rln '<select\b' client/src --include="*.tsx" | sort
```

خطوات كل شريحة:
1. `pnpm coord:claim app-select-migration-N --files <قائمة الملفات>`
2. لكل ملف: `<select>` → `<AppSelect>` + `onChange((e) => f(e.target.value))` → `onValueChange={f}`.
3. تحقّق من الحالات الخاصّة:
   - `value` رقميّ ⇒ لُفّه بـ`String()` عند الإرسال، وبـ`Number()` عند التغيير.
   - `<option value="">` ⇒ يصير placeholder تلقائياً.
   - `<optgroup>` ⇒ مدعوم أصلاً.
   - `size` attribute على `<select>` (نادر) ⇒ لا مقابل مباشر؛ خذ قراراً حالة بحالة.
   - `multiple` attribute (نادر جداً) ⇒ **غير مدعوم في `AppSelect`** — أبقِ `<select multiple>` كما هو أو ابنِ `MultiSelect` منفصلاً.
4. `pnpm check` نظيف.
5. PR + انتظار CI + دمج + `prod:deploy`.
6. تحقّق بصريّ حيّ على شاشة واحدة على الأقلّ من الشريحة.
7. `pnpm coord:release app-select-migration-N`.

## قواعد سلامة
- **لا شريحة كبيرة**: التزم بـ٢٠-٣٠ ملفاً/PR لتسهيل المراجعة والدرحلة (rollback).
- **الشاشات الحرِجة (POS، Reception، الرواتب)**: جولة بصريّة كاملة بعد النشر — لا نكتفي بـtypecheck.
- **لا هجرة داخل شريحة مالية غير مغلقة**: إن كانت هناك شريحة `feat` مالية جارية على نفس الملف، أجّل هجرته إلى ما بعد دمجها.
- **`InvoiceHeader.tsx`** يستعمل shadcn Select مباشرةً — لا يحتاج هجرة.

## مصادر
- `client/src/components/ui/AppSelect.tsx` — المكوّن نفسه.
- `client/src/pages/StocktakeNew.tsx` — نموذج الهجرة (٤ حالات مختلفة).
- PR #426 — CSS دفاعيّ يبقى صالحاً للـ149 ملفاً حتى تُهاجَر.
- PR #428 — المرجع الحاكم لهذه الخطّة.
