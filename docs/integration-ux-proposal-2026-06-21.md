# وثيقة التكامل الوظيفي ورسائل التأكيد — تدقيق ذرّي شامل لكل شاشات النظام (١١٥ شاشة)

> **المُخرَج:** وثيقة اقتراحات مرجعية فقط (بلا تغيير كود). كل ملاحظة **ذرّية** بمسار وسطر
> تقريبي ونمط الإصلاح المرجعي. أُعِدّت بتدقيق ٢٢ وكيلاً للقراءة فقط (٢٠٢٦-٠٦-٢١).

---

## ١. السياق والمنهجية

النظام بلغ نضجاً وظيفياً عالياً (١١٥ شاشة، ١١ وحدة، بنية تحتية موحّدة قوية)، لكن **تبنّي
الأنماط الموحّدة غير متساوٍ** عبر الشاشات: بعضها مرجعيّ ممتاز، وأخرى تنحرف (window.confirm،
toast مباشر، toLocaleString/دوال محلية بدل money.ts، عمليات حسّاسة بلا تأكيد، قوائم بلا
طباعة سريعة، جداول يدوية بلا DataTable، حالات تحميل/فراغ صامتة). الانحراف يُنتج تجربة غير
متّسقة وخطر أخطاء بشرية في عمليات مالية لا رجعة فيها.

**المنهجية:** تدقيق ذرّي بـ٢٢ وكيلاً للقراءة فقط: استطلاع للشاشات المخفية (صفحات↔مسارات↔تنقّل
+ API↔واجهة)، ثم ١٨ مدقّقاً (وكيل لكل وحدة يقرأ كل ملف شاشة بالكامل) عبر ٦ أبعاد (حقول/أزرار/
طباعة/بصري/تنسيق/تأكيد)، ثم طبقة تركيب (أنماط أفقية + ناقد اكتمال عدائي). الإجمالي: ٣٣٨
استخدام أداة قراءة.

**رمز المحاور:** ✅ تأكيد · 🅵 حقول · 🅑 أزرار · 🅟 طباعة · 🆅 بصري · 🆃 تنسيق.

---

## ٢. نتيجة فحص الشاشات المخفية (المطلب الصريح) — ✔️ نظيف

| الفحص | النتيجة |
|---|---|
| إجمالي ملفات الصفحات | **١١٥** ملفاً، كلّها موصولة بمسار. |
| صفحات مرئية في التنقّل | ٤٩ شاشة رئيسية. |
| مسارات خارج التنقّل (بالـURL فقط) | ٦٥ — **كلّها مقصودة**: تفاصيل `/:id`، تعديل `/:id/edit`، إنشاء `/new`، خطوات سير عمل، بوابات عامة (kiosk/apply/count)، دخول. |
| ملفات بلا مسار (يتيمة) | **صفر** صفحة حقيقية — فقط `_VoucherFormShared.tsx` وهو مكوّن مساعد (بادئة `_`). |
| مسارات مكسورة (لمكوّن غير موجود) | **صفر**. |
| خلفية بلا واجهة | فقط `barcode.verify` (تحقّق QR داخلي يستعمله barcodeService — حميد، لا يحتاج شاشة). |

**ملاحظتان طفيفتان (غير مقلقتين):** `/production/new` و`/work-orders/new` لهما مسار خارج
التنقّل لكنهما يُفتحان بزر «+ جديد» من القائمة (نمط معتاد لكل نماذج `/new`).

**الحكم:** لا توجد شاشات مخفية أو مقلقة. معمارية التوجيه ناضجة.

---

## ٣. معايير التكامل الخمسة (لغة التصميم المرجعية)

| المحور | القاعدة | المرجع |
|---|---|---|
| 🅵 حقول | هاتف→`IntlPhoneInput`؛ كلمة مرور→`PasswordInput`؛ صورة→`ImageUploader`؛ عميل→`SmartCustomerInput`؛ **مبلغ→`AmountField` (ناقص — §٦)**؛ كمية→`inputMode=numeric` + تحقّق محلي. | `components/form/*` |
| 🅑 أزرار | إجراءات الصف→`RowActions`؛ كل mutation له حالة `pending` (تعطيل+نص «جارٍ…»)؛ الخطِر يمرّ عبر `confirm()`. | `components/list/RowActions`, `ui/button` |
| 🅟 طباعة | كل مستند ذي قالب له زر طباعة؛ القوائم لها طباعة/تصدير سريع؛ التقارير عبر `printReportDoc`. | `lib/printing/*` |
| 🆅 بصري | جداول→`DataTable`؛ فراغ→`EmptyState`؛ تحميل→`Skeleton/Spinner`؛ حالات→`Badge` بألوان دلالية ثابتة (§٦ قانون الشارات)؛ أرصدة→`BalanceBadge`. | `DataTable`, `EmptyState`, `ui/*` |
| 🆃 تنسيق | أموال→`money.ts` (ممنوع `toLocaleString`/`Number`/دوال محلية في العرض)؛ تاريخ→`@/lib/date` موحّد (ناقص — §٦)؛ أرقام→`tabular-nums` + `dir=ltr`. | `lib/money.ts` |

البنية التحتية للتأكيد/الإشعار موجودة وجاهزة: `lib/confirm.ts` (`confirm`/`confirmDelete`,
danger/warning/info + `requireText`)، `ConfirmHost.tsx`، `lib/notify.ts`
(`notify.ok/err/warn/info`)، `DangerConfirmDialog.tsx` (token+كلمة مرور للأخطر).

---

## ٤. مصفوفة رسائل التأكيد والتحذير الشاملة

**السياسة الموحّدة:** حذف/إلغاء/عكس → `danger`؛ إنهاء خدمة/إقفال سنة/تصفير/استعادة → `danger`+`requireText`؛
حذر قابل للتراجع → `warning`؛ تحرّك حالة غير مدمّر → `info` أو بلا؛ إنشاء عادي → بلا (نجاح بـ`notify.ok`).
**قاعدة عامة:** كل النتائج عبر `notify.*` — لا `toast.*` مباشر ولا `window.confirm`.

### P0 — مالية/لا رجعة فيها تنقصها تأكيد (الأعلى أولوية)
| العملية | الموضع | الحالي | المقترح |
|---|---|---|---|
| تسليم أمر شغل + فاتورة | `WorkOrders.tsx:698` deliver | حوار بلا confirm | danger+req |
| إنشاء أمر شغل (يقبض عربوناً) | `WorkOrderNew.tsx:243/263` | بلا تأكيد | danger+req |
| تسليم + فاتورة | `WorkOrderDetail.tsx:240` deliver | بلا تأكيد | danger+req |
| تحويل عرض→فاتورة | `QuotationNew.tsx:138` / `QuotationDetail.tsx:156` | بلا تأكيد | danger |
| تسجيل مرتجع بيع | `Returns.tsx:320` / `SalesReturnNew.tsx:251` | بلا تأكيد | danger |
| تسجيل مرتجع شراء | `PurchaseReturnNew.tsx:251` | بلا تأكيد | danger |
| تعديل رصيد مخزون مباشر | `Inventory.tsx:75-82` adjust | بلا تأكيد | danger |
| تنفيذ تحويل بين فروع | `Transfers.tsx:155` transfer | بلا تأكيد | danger |
| إلغاء جلسة جرد (يُتلف بيانات) | `StocktakeMonitor.tsx:175` | بلا تأكيد | danger |
| اعتماد الجرد (قيد تسوية دائم) | `StocktakeReview.tsx:187` approve | تأكيد ناقص | danger |
| حذف وصفة إنتاج | `ProductionRecipes.tsx:338` remove | بلا تأكيد | danger |
| إنهاء خدمة موظف | `EmployeeDetail.tsx:184` / `Promotions.tsx:227` | ضعيف/بلا dialog | danger+req(الاسم) |
| دفع مسيّر رواتب | `Payroll.tsx:181` | window.confirm | danger+req |
| عكس دفع مسيّر | `Payroll.tsx:190` | window.confirm | danger+req |
| التصرّف بأصل (بيع/خسارة/إخراج) | `AssetDetail.tsx:329` dispose | حوار بلا confirm | danger+req(الاسم) |
| إنهاء كل الجلسات | `Account.tsx:104` revoke | بلا تأكيد | danger+req |
| إقفال فترة مالية | `PeriodLock.tsx:109` lock | بلا تأكيد | danger |

### P1 — استبدال window.confirm + توحيد toast→notify + تأكيدات قابلة للتراجع
| العملية | الموضع | الحالي | المقترح |
|---|---|---|---|
| حذف مسودة رواتب | `Payroll.tsx:174` | window.confirm | confirmDelete |
| إلغاء إجازة موافق عليها | `Leaves.tsx:217` | window.confirm | danger |
| موافقة/رفض إجازة | `Leaves.tsx:204/210` | بلا تأكيد | info/warning |
| حذف جهاز كشك | `KioskDevices.tsx:204` | window.confirm + toast | confirmDelete + notify |
| تدوير رمز كشك | `KioskDevices.tsx` rotate | بلا تأكيد | warning |
| حذف نسخة احتياطية | `Settings.tsx:186` | window.confirm | confirmDelete |
| إعادة تعيين كلمة مرور | `UserEdit.tsx:123-127` resetPassword | بلا تأكيد | warning |
| تفعيل/تعطيل دور | `Roles.tsx:71` setActive | بلا تأكيد | warning |
| حذف وظيفة شاغرة | `Recruitment.tsx:673` vacancyDelete | بلا requireText | danger+req(الاسم) |
| رفض/أرشفة متقدّم | `Recruitment.tsx:301/313/322` | بلا تأكيد | warning |
| نقل جهاز بصمة | `HrDevices.tsx:202` migrate | بلا تأكيد | warning |
| إضافة حركة مخزون يدوية | `InventoryMovements.tsx:246` createManual | بلا تأكيد | warning |
| حفظ/إسناد باركود | `BarcodeLabels.tsx:219` assign | بلا تأكيد | warning |
| تفريغ قائمة الطباعة | `BarcodeLabels.tsx:459` | بلا تأكيد | warning |
| طلب إعادة عدّ | `StocktakeReview.tsx:171` requestRecount | تأكيد ناقص | info+req |
| إنهاء العدّ (بوابة العامل) | `CountPortal.tsx:422` finish | بلا تأكيد | warning |
| بدء تنفيذ أمر شغل (يخصم مواد) | `WorkOrders.tsx:545`, `WorkOrderDetail.tsx:231` start | بلا تأكيد | warning |
| إلغاء أمر شغل | `WorkOrders.tsx:587`, `WorkOrderDetail.tsx:252` cancel | محلي/بلا | warning(توحيد) |
| تحويل حالة عرض سعر | `Quotations.tsx:171`, `QuotationDetail.tsx:170/173/176` | بلا تأكيد | warning/info |
| إعادة أصل للخدمة من صيانة | `AssetDetail.tsx:100` returnMaint | بلا تأكيد | warning |
| اعتماد ترقية | `Promotions.tsx:169` approvePromo | بلا تأكيد | warning |
| إنشاء موافقة ائتمان | `CreditApprovals.tsx:117` + toast | بلا تأكيد | warning + notify |
| مصروف نقدي (مدير بلا وردية) | `ExpenseNew.tsx:157` | بلا تأكيد | warning شرطي |
| توحيد toast→notify | `PeriodLock`, `YearEnd`, `CreditApprovals`, `KioskDevices`, `Settings` | toast مباشر | notify.* |

### P2 — تأكيدات لطيفة (منع نقرة عرضية)
حذف صف سلة (`Transfers.tsx:301`, `WorkOrderNew.tsx:165`, `ProductionNew` removeRow)، إسناد موظف
ووضع «جاهز» (`WorkOrders.tsx:546/690`)، تسجيل حضور (`Attendance.tsx:100`)، عكس فروع التحويل عند سلة غير فارغة.

### نماذج مرجعية ممتازة (تُحتذى — لا تُلمَس)
`Vouchers.tsx` (إلغاء سند)، `YearEnd.tsx` (إقفال ✓)، `PeriodLock.tsx` (unlock ✓)،
`Expenses.tsx` (إلغاء حسب المصدر ✓)، `Settings.tsx` (استعادة/تصفير عبر DangerConfirmDialog ✓)،
`Users`/`Roles`/`Customers`/`Products`/`Suppliers` (تعطيل/حذف بـconfirm ✓)، `ProductionNew`/`ProductionDetail`.

---

## ٥. اقتراحات التكامل الذرّية لكل وحدة

### ٥.١ الكاشير والبيع
- **POS** `/pos`: 🅵 حقول الدفع/الرصيد الافتتاحي/الخصم بلا `inputMode=numeric` ولا إشارة وحدة الخصم (%/مبلغ). 🅑 `onQuickPay`/`submitSale` خطر نقر مزدوج — تعطيل كامل أثناء mutation؛ `closeShift` بلا تأكيد. 🆃 الأموال بلا `tabular-nums`. ✅ تقريب IQD + idempotency + إيصال مطبوع ✓.
- **PrintPOS** `/print-pos`: 🅵 `editPriceUid` بلا inputMode. 🅑 `submit` بلا رسالة عند سطر بسعر صفر. 🆃 أموال بلا tabular-nums. ✅ idempotency + تأكيد ✓.
- **PriceChecker** `/price-checker`: سليمة (شاشة عرض).
- **SalesInvoiceNew** `/sales/new`: 🅵 `paidAmount` بلا inputMode. 🅑 `save` تأكّد من تعطيل كامل (نقر مزدوج). 🆃 الإجمالي بلا tabular-nums. ✅ idempotency + Decimal + موافقة مدير ✓.
- **Invoices** `/invoices`: مرجعيّ — DataTable + Excel + RowActions ✓.
- **InvoiceDetail** `/invoices/:id`: 🅵 `payAmount` بلا inputMode. ✅ زر تسديد بلا تأكيد (أضف warning). + **(ناقد الاكتمال)** تحقّق من تأكيد إلغاء فاتورة مرحّلة وتعديل سطر بعد الترحيل (أثر دفتري).
- **SalesReport** `/sales-report`: مرجعيّ — DataTable + Excel + PDF ✓.

### ٥.٢ العروض والمرتجعات
- **Quotations** `/quotations`: ✅ `setStatus` (DRAFT→SENT) `:171` بلا تأكيد→warning. 🅵 حقل التاريخ خام. 🅟 لا طباعة جماعية للقائمة. ✅ fmt + RowActions + printQuotation + فلاتر خادمية ✓.
- **QuotationNew** `/quotations/new`: ✅ `convert` `:138` danger. 🅵 `validUntil` بلا type=date. 🅟 يطبع المحرّر لا القالب. ✅ Decimal + idempotency + اختصارات ✓.
- **QuotationDetail** `/quotations/:id`: ✅ `setStatus` `:170/173/176` + `convert` `:156`. 🆅 الحالة بلا STATUS_CLS موحّد. 🆃 `payAmount` بـ`Number()` بدل `D()` (خطر floating-point). 🅟 يطبع المحرّر — استدعِ `printQuotation()`.
- **Returns** `/returns`: ✅ `create` `:320` danger مع ملخّص الإرجاع. 🅵 `refundAmount` بلا inputMode. 🆅 جدول يدوي + EmptyState إجرائي. ✅ Decimal + validation شامل ✓.
- **SalesReturnNew** `/sales-returns/new`: ✅ `create` `:251` danger. 🅵 `refInvoice` بلا بحث/autocomplete؛ `paidAmount` بلا inputMode. 🆅 لا Spinner أثناء جلب المرجع. ✅ Decimal + تحقّق كميات ✓.
- **SalesReturns** `/sales-returns`: 🆅 جدول يدوي بلا Skeleton؛ 🅟 لا طباعة سريعة. ✅ RowActions + فلاتر + ترقيم ✓.
- **PurchaseReturnNew** `/purchase-returns/new`: ✅ `create` `:251` danger مالي. 🅵 `poReference` بلا autocomplete. 🆃 `totals.grandTotal` `:401` بلا fmt(). ✅ Decimal + validation + idempotency ✓.
- **PurchaseReturns** `/purchase-returns`: 🆅 جدول يدوي بلا Skeleton؛ 🅟 لا طباعة سريعة. ✅ RowActions + فلاتر ✓.

### ٥.٣ المشتريات والموردون
- **Purchases** `/purchases`: ✅ إلغاء أمر `:43-62` يستعمل confirm() ✓ (رفّعه لـDangerConfirmDialog للمبالغ الكبيرة). 🅑 زر طباعة بلا pending (نقر مزدوج→PDF متعدد). 🆅 جدول يدوي بلا Skeleton؛ EmptyState نصّي؛ شارات حالة خام. 🆃 التاريخ بـtoLocaleString؛ export بـ`Number()` يفقد العشريات.
- **PurchaseNew** `/purchases/new`: ✅ `create` `:72-79` بلا تأكيد→warning للمبالغ الكبيرة. 🅑 «حفظ المسودات» معطّل (notify.info فقط) — احذفه أو فعّله. 🆃 `totals.grandTotal` `:210` بلا fmt().
- **PurchaseReceive** `/purchases/:id/receive`: ✅ `receive` `:53-63` بلا تأكيد→info. 🅵 «استلام الآن» `:134` بلا inputMode؛ `payAmount` خام. 🆅 جدول يدوي بلا Skeleton؛ رسائل `<p>` بدل notify. 🅟 لا زر طباعة وصل استلام.
- **Suppliers** `/suppliers`: ✅ تعطيل `:41-68` confirm() ✓. 🆅 شارة الحالة inline بدل `<Badge>`. 🅟 لا طباعة قائمة. ✅ BalanceCell + RowActions + استيراد + ترقيم ✓.
- **SupplierNew** `/suppliers/new`: 🅵 `minOrderAmount` بـregex بدل AmountField؛ التقييم بلا مكوّن `StarRating` مشترك. ✅ IntlPhoneInput ✓.
- **SupplierEdit** `/suppliers/:id/edit`: 🅵 `email` بلا type=email/تحقّق. أخطاء بـ`<p>` بدل notify.err. ✅ الرصيد بـfmt + tabular-nums ✓.
- **SupplierStatement** `/suppliers-statement`: 🆅 جدول حركات يدوي بلا Skeleton. 🆃 التاريخ بـ`en-GB` (DD/MM/YYYY إنجليزي) `:84` → `ar-IQ`؛ تاريخ الفترة خام `:278`. 🅟 الكشف لا يطبع ألوان الشارات. ✅ Decimal + StatementReconcile + WhatsAppShare + export + BalanceCell ✓.

### ٥.٤ أوامر الشغل/المطبعة
- **WorkOrders** `/work-orders`: ✅ `deliver` `:698` danger+req، `cancel` `:587` (وحّده)، `start` `:545` warning، `markReady`/`assign` info. 🅵 `fmtN` `:64-65` (Number.toLocaleString) → fmt/fmtAr؛ `fmtDT` `:66` → منسّق مركزي؛ `DeliverDialog` amount بلا AmountField/تحقّق `≤ salePrice`. 🅑 لا طباعة جماعية؛ لا «تكرار أمر». 🆅 EmptyState/Skeleton نصّيان؛ شارات inline-oklch؛ Timeline يدوي. 🆃 تاريخ بـ`slice(0,10)`؛ كمية بلا tabular-nums. 🅟 ينقص قالبا «كشف عهدة»/«شهادة إنجاز». ✅ confirm(cancel) + notify + SmartCustomerInput + IntlPhone + ImageUploader + idempotency + DnD optimistic ✓.
- **WorkOrderNew** `/work-orders/new`: ✅ `createWO` `:243/263` danger+req؛ `createCustomer` `:234` warning؛ `removeRow` `:165` warning. 🅵 (كثيف) معرّف القناة (انستغرام/تيك توك) بلا تحقّق؛ كمية/سعر/أجور بلا AmountField/حدود؛ `dueDate` يقبل ماضياً؛ خصم بلا حدّ أقصى≤الإجمالي؛ عنوان/تكلفة توصيل بلا تحقّق مشروط؛ مرجع الدفع بلا pattern. 🅑 لا Spinner عند الحفظ؛ بحث منتجات بلا keyboard-nav. 🆃 fmt متّسق ✓؛ كمية بلا tabular-nums. 🅟 المعاينة بلا قالب رسمي (لوجو/خاتم).
- **WorkOrderDetail** `/work-orders/:id`: ✅ `start` `:231` warning، `markReady` `:236` info، `deliver` `:240` danger+req، `cancel` `:252` warning. 🅵 `payAmount` بلا حد `≤ salePrice`؛ تاريخ خام `slice(0,10)`. 🆅 loading/error نصّيان؛ جدول مواد يدوي؛ رسائل بـ`setState` بدل notify. 🅟 أضف dropdown قالب (أمر/عهدة/شهادة) + «طباعة الفاتورة». ✅ fmt + notify + printWorkOrder + ?print=1 ✓.

### ٥.٥ الإنتاج
- **Production** `/production`: 🅵 الكمية بـNumber.toLocaleString → fmtInt. 🅑 جدول يدوي بدل DataTable؛ تصدير بلا pending؛ روابط نصّية بدل RowActions. 🆅 شارة حالة inline؛ لا EmptyState/Skeleton. 🆃 `fmtDateTime` محلي `:16-19`.
- **ProductionNew** `/production/new`: ✅ `submitRecipe` `:131` warning ✓ (موجود). 🅵 كميات (دفعة/تالف/أجور) بلا inputMode/حدود؛ التالف قد يتجاوز الدفعة؛ الوضع اليدوي بلا تسمية وحدة القياس. 🅑 لا «حفظ مسودة»؛ زر طباعة بلا pending. 🆅 شارات توفّر inline؛ لا Skeleton أثناء المعاينة. ✅ confirm + Decimal ✓.
- **ProductionDetail** `/production/:id`: ✅ `cancel` `:39-47` danger ✓. 🆅 شارة حالة inline؛ loading نصّي. 🆃 الكميات بـ`toLocaleString('en-US')` `:112-114` → fmtInt؛ `fmtDateTime` محلي. 🅑 لا «عكس الإلغاء»؛ استبدل أيقونة 🖨 بـPrinter.
- **ProductionRecipes** `/production-recipes`: ✅ `setActive` `:337` warning، `remove` `:338` danger — **كلاهما بلا confirm**. 🅵 أجور/هدر/كمية مكوّن بلا inputMode. 🅑 أزرار البطاقة `<button>` خام بدل RowActions. 🆅 شارة حالة inline.
- **ProductionReport** `/reports/production`: مرجعيّ — fmtAr + printReportDoc ✓ (loading بلا Skeleton فقط).
- **WIPReport** `/wip-report`: 🅵 `fmtMoney` محلي `:9-14` → fmt. 🆅 `fmtDate` محلي بـ`en-GB` (تضارب مع `ar-IQ`)؛ صندوق ملخّص ألوان خام؛ جدول يدوي؛ لا EmptyState. 🅟 لا زر طباعة (نمط ReportShell متاح).

### ٥.٦ المنتجات والباركود
- **Products** `/products`: ✅ تعطيل `:53-64` confirm() ✓. 🅵 السعر بـ`toLocaleString` `:161` → fmtAr؛ المخزون بلا tabular-nums. 🅑 mutation بلا منع نقر محلي. 🆅 جدول يدوي؛ EmptyState نصّي؛ شارة حالة بلا Badge. 🅟 لا طباعة تقرير للكل. ✅ confirm + notify + RowActions + ListToolbar + debounce ✓.
- **ProductNew** `/products/new`: ✅ `removeUnit` `:484` warning (لو للوحدة بيانات). 🅵 التكلفة/الأسعار `:61/478-480` بلا AmountField؛ تحقّق الباركود في VariantsTable. ✅ validateLocal + checkBarcodes debounced + ImageUploader + pending text ✓.
- **ProductEdit** `/products/:id/edit`: ✅ تعطيل متغيّر `:235` + `removeUnit` `:461` warning. 🅵 التكلفة `:430` بلا AmountField. تصميم «تعطيل بدل حذف» سليم ✓.
- **BarcodeLabels** `/barcode-labels`: ✅ `assign` `:216-224` warning، تفريغ القائمة `:459` warning. 🅑 `saveBarcode`/`pairPrinter`/`testPrint`/`printLabels` بلا pending (WebUSB async). 🆅 جداول يدوية مقبولة. ✅ printLabel(WebUSB+fallback) + معاينة حيّة + money() + scanner hook ✓.

### ٥.٧ المخزون والتحويلات
- **Inventory** `/inventory`: ✅ `adjust` `:75-82` danger (تغيير مالي مباشر) **بلا تأكيد**. 🅵 الرصيد المستهدف `:185` بلا inputMode/dir ثابت؛ الملاحظات بلا maxLength/اختيارات سريعة. 🅑 زر الحفظ بلا نص pending قوي؛ التسوية المباشرة `:235` نقر مزدوج. 🆅 جدول يدوي؛ EmptyState/Skeleton ناقصان. 🆃 الأرقام بـ`toLocaleString` `:193/196/281/292` → fmtInt؛ tabular-nums غير متّسق. 🅟 لا زر طباعة (شهادة أرصدة).
- **InventoryMovements** `/inventory-movements`: ✅ `createManual` `:224-255` warning **بلا تأكيد**. 🅵 `mQty` `:691` بلا inputMode؛ الملاحظات `slice(0,500)` بدل maxLength+عدّاد. 🆅 جدول يدوي؛ EmptyState نصّي؛ شارات تحقّق ألوانها مع BalanceBadge. 🆃 `fmtNum`/`fmtDateTime` محليان → fmtInt. ✅ Dialog + RowActions + فلاتر + Excel/PDF ✓.
- **Transfers** `/transfers`: ✅ `transfer` `:155` danger **بلا تأكيد**؛ `removeLine` `:301` info؛ عكس الفروع (swap) عند سلة غير فارغة. 🅵 بحث الأصناف بلا Skeleton؛ `mQty` أضف pattern صريح. 🆅 جدول سلة يدوي؛ EmptyState نصّي؛ بلا opacity عند pending. 🆃 `fmtNum` محلي → fmtInt؛ أرقام بلا tabular-nums. 🅟 لا زر طباعة للسند بعد التنفيذ. ✅ swap + F2 + validation + رقم سند ✓.

### ٥.٨ الجرد
- **Stocktakes** `/stocktakes`: 🆅 جدول جلسات يدوي `:339-417`. 🆃 `nf` بـtoLocaleString `:46` → fmtInt. ✅ StatusBadge + fmtInt elsewhere ✓.
- **StocktakeNew** `/stocktakes/new`: 🅵 حدود الاعتماد `:751-795` بلا AmountField. ✅ stepError + prefill + distribution ✓.
- **StocktakeMonitor** `/stocktakes/:id`: ✅ `cancel` `:175` danger (يُتلف الجلسة). 🅵 بحث `:517` بـ`<input>` خام بدل `Input`. ✅ confirm + notify ✓.
- **StocktakeReview** `/stocktakes/:id/review`: ✅ `firstSign` `:180` warning (توقيع ثانٍ من مدير مختلف)، `approve` `:187` danger (تسوية+قيد)، `requestRecount` `:171` info+req. 🅵 منتقى السبب `<select>` خام. 🆅 جدول فروقات يدوي ١١ عمود. ✅ confirm+Dialog + Decimal ✓.
- **StocktakeReport** `/stocktakes/:id/report`: مرجعيّ — printStocktakeReport ✓.
- **StocktakeCountSheets** `/stocktakes/:id/sheets`: مرجعيّ — Tabs + Print + Blind ✓.
- **CountPortal** `/count/:code`: ✅ `finish` `:422` warning (يقفل العدّ). 🅵 بحث `<input>` خام. ✅ Queue + Barcode + Async ✓.

### ٥.٩ العملاء والذمم
- **Customers** `/customers`: ✅ تعطيل `:80-86` confirm() danger ✓. 🅵 `creditLimit` في New/Edit بلا inputMode=decimal. 🅑 toggle بلا نص pending؛ أضف «نسخ المعرّف» لـRowActions. 🆅 جدول يدوي؛ EmptyState نصّي؛ شارة حالة بدل Badge. 🆃 export بـ`Number()` يكسر الدقّة. 🅟 لا طباعة قائمة/بطاقة عميل QR. ✅ confirm + notify + fmtAr + BalanceCell + RowActions ✓.
- **CustomerNew** `/customers/new`: 🅵 IntlPhoneInput ✓ لكن بلا تحقّق E.164 محلي؛ `creditLimit` بلا inputMode=decimal؛ notes/address بلا maxLength+عدّاد. 🅑 زر بلا نص pending؛ لا تحذير «تغييرات غير محفوظة». 🆅 خطأ بـ`<p>` بدل `<Alert>`. 🅟 لا طباعة بطاقة بعد الإنشاء. ✅ IntlPhoneInput + notify ✓.
- **CustomerEdit** `/customers/:id/edit`: ✅ تعطيل `:238` confirm() ✓. 🅵 **تناقض**: phone بلا IntlPhoneInput `:159` (خلاف New)؛ `creditLimit` بلا inputMode (خلاف New)؛ العنوان `Input` بدل `Textarea`. 🅑 IIFE معقّدة للتفعيل/التعطيل — استخرجها لدالة. 🆅 شارة حالة inline. 🅟 بطاقة QR بلا زر طباعة بجانبها. ✅ confirm + BarcodeDisplay + fmtAr ✓.
- **CustomerStatement** `/customers-statement`: ✅ تسوية `:252` info (StatementReconcile). 🅵 تواريخ بلا تحقّق `to ≥ from`؛ منتقى العميل `<select>` خام (بطيء عند آلاف) → SmartCustomerInput. 🆅 جداول يدوية؛ EmptyState نصّي. ✅ printCustomerStmt + export + Decimal + CopyInline + WhatsAppShare ✓.
- **ARAging** `/ar-aging`: 🅵 فلتر الفرع `<select>` خام. 🆅 جدول ١٢ عمود يدوي؛ EmptyState نصّي. ✅ Decimal دقيق + fmtAr + Bucket KPI + printARAging + export ✓.
- **APAging** `/ap-aging`: مطابق ARAging (جدول ١١ عمود يدوي + فلتر خام). ✅ Decimal + Bucket + printAPAging ✓.
- **ArApAgingDetail** `/reports/aging-detail`: 🆅 loading بلا Skeleton؛ جدول يدوي مع hover. ✅ ReportShell + printReportDoc + export + fmtAr + KPIs ✓.

### ٥.١٠ الأصول الثابتة
- **Assets** `/assets`: 🅑 أزرار التنقّل بلا disabled أثناء التحميل. 🆅 جدول صيانة يدوي؛ EmptyState مختلط. 🆃 `iqd()` بلا tabular-nums أحياناً. ✅ StatCard ✓.
- **AssetNew** `/assets/new`: 🅵 `purchaseValue`/`salvageValue` `:127/142` بلا AmountField؛ `usefulLifeYears` بـregex بدل min/max؛ لا تحقّق «الشراء > الخردة». 🆃 معاينة القسط بلا tabular-nums. ✅ pending + AlertCircle + auto-update العمر ✓.
- **AssetEdit** `/assets/:id/edit`: 🅵 قيم بلا AmountField. ✅ تغيير طريقة الإهلاك/العمر بلا confirm (P2). 🆃 `stripMoney` بـregex بدل round2. ✅ pending + حارس الأصل المُستبعَد ✓.
- **AssetDetail** `/assets/:id`: ✅ `returnMaint` `:100` warning، `dispose` `:329` danger+req(الاسم) — **حسّاس مالي بلا confirm**. 🅵 `mCost`/`dValue` بلا AmountField. 🆅 جداول إهلاك/صيانة يدوية؛ شارات سلسلة العهدة + ربح/خسارة inline. 🆃 `iqd()` بلا tabular-nums متّسق؛ تاريخ الاستبعاد خام `:62`. 🅟 لا طباعة جدول إهلاك/عهدة. ✅ notify + BarcodeDisplay + printAssetLabel ✓.
- **AssetRegister** `/assets/register`: 🅑 لا RowActions على الصفوف. 🆅 جدول يدوي **حرج** (لا فرز/صفحات/Skeleton)؛ avatar inline؛ EmptyState صفّي. ✅ بحث + فلاتر + Excel + iqd(tabular-nums) ✓.
- **AssetCustodyReport** `/assets/custody-report`: 🅑 «إقرار عهدة» بلا confirm (P2). 🆅 صفوف قابلة للطيّ بلا `Collapsible`(ARIA)؛ EmptyState صفّي. ✅ printCustodyAck + Excel + StatCard ✓.
- **AssetDisposalLog** `/assets/disposal-log`: 🆅 شارة حالة + ربح/خسارة inline؛ جدول يدوي؛ EmptyState صفّي. 🆃 تاريخ الاستبعاد خام في الجدول `:118` (صحيح في التقرير). ✅ printReportDoc + Excel + StatCard ✓.

### ٥.١١ الموارد البشرية — أساس
- **Employees** `/hr/employees`: 🅑 زر إضافة بلا disabled أثناء التحميل. 🆃 `hireDate` خام → formatDate. 🅟 لا طباعة قائمة. ✅ ListToolbar + Excel + EmptyState + EmploymentStatusBadge + CopyInline ✓.
- **EmployeeNew** `/hr/employees/new`: 🅵 `salary` بلا AmountField/فواصل؛ phone `Input` بدل IntlPhoneInput؛ `dayRates`/`annualLeaveBalance` بلا حدّ ووحدة ظاهرة. 🅑 زر بلا Spinner داخلي. 🅟 لا طباعة استمارة. ✅ ImageUploader + datetime + تعليم ديناميكي ✓.
- **EmployeeDetail** `/hr/employees/:id`: ✅ `setStatus→terminated` `:184` danger+req(الاسم)، `→active` `:76` info — **بلا confirm مسبق**. 🆃 تواريخ خام. 🅟 بطاقة الموظف بلا زر طباعة؛ شهادات عمل/كشف مستحقات/عهدة ناقصة. ✅ iqd + tabular-nums + EmploymentStatusBadge + BarcodeDisplay ✓.
- **Attendance** `/hr/attendance`: ✅ `record` `:100` info. 🅵 `hours` بلا تحقّق نطاق؛ `checkIn/checkOut` بلا تحقّق ترابط (انصراف قبل حضور). 🅑 زر بلا نص pending. 🆃 `totalHours` بـtoLocaleString بلا tabular-nums. 🅟 لا كشف حضور شهري. ✅ Decimal + iqd + StatCard ✓.
- **HrDevices** `/hr/devices`: ✅ `migrate` `:202` warning **بلا تأكيد**. 🅵 `port` بلا max=65535؛ `IP` بلا تحقّق IPv4. ✅ بطاقة بطل + شارات حالة + Dialog ✓.
- **JobApply** `/apply` (عام): ✅ `submit` `:351` info. 🅵 phone/email بلا تحقّق محلي. ✅ Dark mode + Skeleton + EmptyState ✓.
- **Recruitment** `/hr/recruitment`: ✅ `updateStage` `:301/313/322` warning (رفض/أرشفة)، `vacancyDelete` `:673` danger+req(اسم الوظيفة). 🆅 Kanban responsive ✓؛ EmptyState بسيط. 🆃 أعداد بلا tabular-nums. 🅟 لا تصدير سجل المتقدّمين. ✅ STAGE_COLOR + بطاقات + Dialogs ✓.

### ٥.١٢ الموارد البشرية — رواتب
- **Payroll** `/hr/payroll`: ✅ حذف مسودة `:174` (window.confirm→confirmDelete)، دفع `:181` danger+req، عكس `:190` danger+req — الثلاثة `window.confirm`. 🅵 بنود الإضافي/الاستقطاع بلا AmountField. 🆅 جدول بنود يدوي (لا بحث/تصدير/Skeleton/EmptyState). 🅟 قسيمة الراتب `:352` تستعمل `window.print()` عام بدل قالب printDoc؛ ينقص «طباعة مفصّل رواتب الشهر». ✅ notify + EmpAvatar ✓.
- **Leaves** `/hr/leaves`: ✅ موافقة `:204` info، رفض `:210` warning، إلغاء موافق عليه `:217` (window.confirm→danger). 🅵 حقول التاريخ بلا dir/class؛ لا تحذير عند `to < from`. 🆅 جدولا الطلبات/الأرصدة يدويان؛ لا badge «رصيد منخفض»؛ EmptyState نصّي. 🅟 لا طباعة شهادة/قائمة إجازات. ✅ notify + daysBetween + EmpAvatar ✓.
- **Promotions** `/hr/promotions`: ✅ اعتماد ترقية `:169` warning، إكمال إنهاء خدمة `:227` danger+req (تحذير نصّي فقط حالياً). 🅵 الراتب الجديد/التسوية بلا وحدة (د.ع) ظاهرة. 🆅 جدولان يدويان. 🅟 لا شهادة ترقية/إنهاء خدمة. ✅ notify + iqd + EmpCell ✓.
- **PayrollReport** `/reports/payroll`, **AttendanceReport** `/reports/attendance`, **LeaveReport** `/reports/leaves`, **HrChangesReport** `/reports/hr-changes`: مرجعية — ReportShell + printReportDoc + fmtAr + PeriodFilter ✓ (لا فجوات جوهرية).

### ٥.١٣ الخزينة والمدفوعات
- **Expenses** `/expenses`: ✅ إلغاء مصروف `:223-234` confirm() danger ✓ (رسالة حسب المصدر). 🆃 `expenseDate` خام `:111` → fmtDate. 🅟 لا «طباعة الكل» للقائمة. ✅ نموذج مرجعي ✓.
- **ExpenseNew** `/expenses/new`: ✅ صرف مخزون (نثرية/تلف) confirm() danger ✓؛ **مصروف نقدي (مدير بلا وردية) بلا تأكيد→warning شرطي**. 🅵 المبلغ بلا حدّ أقصى/AmountField. ✅ Decimal + fmt ✓.
- **Vouchers** `/vouchers`: **نموذج مرجعي** — إلغاء سند confirm() danger + printDoc ✓.
- **VoucherReceiptNew/PaymentNew** `/vouchers/*/new` (+`_VoucherFormShared`): **(ناقد الاكتمال)** تأكيدات الإنشاء ناقصة وقد تحتاج `requireText` على مدفوعات P0 — تحقّق وأضف confirm عند الصرف.
- **Shifts** `/shifts`: مرجعيّ — إعادة طباعة Z-report عبر printDoc ✓ (لا عملية مدمّرة).

### ٥.١٤ التقارير المالية (مرجعية ممتازة)
`ReportsCenter`, `ProfitLoss`, `GeneralLedger`, `TrialBalance`, `BalanceSheet`, `CashFlow`,
`ExecutiveDashboard`: كلّها للقراءة فقط، تستعمل `fmtAr/formatIqd` + `printReportDoc` + `exportRows`
+ `tabular-nums/dir=ltr` بإتقان. **الفجوات الوحيدة المتكرّرة:** فلاتر الفرع `<select>` خام،
حالات التحميل/الفراغ نصّية (لا Skeleton/EmptyState)، أزرار تصدير/طباعة بلا نص pending،
شارات نوع القيد في GeneralLedger inline. (ExecutiveDashboard: الطباعة المزدوجة تحتاج `await` للترتيب.)

### ٥.١٥ التقارير التشغيلية
`SalesRegister, SalesByDimension, PurchasesReport, PurchaseRegister, InventoryValuation,
StockStatus, ItemLedger, AbcAnalysis, TreasuryReport, ExpensesReport, CashOrphanReport,
WorkOrdersReport`: كلّها ReportShell + `printReportDoc` + `fmtAr` ✓. **الفجوات الأفقية:**
حالات تحميل/فراغ نصّية (لا Spinner/EmptyState) في الـ١٢، وكميات بـ`toLocaleString`/دوال محلية
بدل `fmtInt` في `InventoryValuation:30/120`, `StockStatus:22 (numAr)`, `ItemLedger:30 (fmtNum)`,
`PurchaseRegister:86/149` (كمية خام).

### ٥.١٦ الإدارة — مستخدمون وأدوار
- **Users** `/users`: ✅ تعطيل `:93-104` confirm() danger ✓. 🆅 جدول يدوي؛ لا Skeleton للحالة؛ EmptyState نصّي. ✅ RowActions + RoleBadge + ترقيم + fmtDate + ListToolbar ✓.
- **UserNew** `/users/new`: 🅵 الاسم بلا min/maxLength؛ `hiredAt` بلا تحقّق «ليس مستقبلاً». 🅑 توليد تلقائي بلا pending؛ زر الحفظ لا يتعطّل عند `emailError/usernameError`. 🆃 رسالة سياسة كلمة المرور بلا تمييز بصري. ✅ PasswordInput + IntlPhoneInput + checkEmail/Username + PermissionMatrix + CredentialsShare ✓.
- **UserEdit** `/users/:id/edit`: ✅ تعطيل `:226` confirm() ✓؛ **`resetPassword` `:123-127` بلا تأكيد→warning**. 🅵 `email` بلا إعادة فحص توفّر. 🆅 لا Skeleton عند التحميل الأولي. ✅ ResetShare + checkUsername + mustChangePassword ✓.
- **Roles** `/roles`: ✅ حذف `:20-24` confirm() ✓؛ **`setActive` `:71` بلا تأكيد→warning**. 🆅 جدول يدوي؛ EmptyState نصّي. ✅ عدّاد مستخدمين + حماية حذف دور مُسنَد ✓.
- **RoleEdit** `/roles/:id/edit`: 🅵 `label` بلا min/maxLength. 🅑 الحفظ لا يُمنع عند `!label.trim()`. ✅ PermissionMatrix + baseRole + Skeleton عند التحميل ✓.
- **Account** `/account`: ✅ **`revoke` (إنهاء كل الجلسات) `:104` بلا تأكيد→danger+req**. ✅ تنبيه التغيير الإلزامي ✓.
- **AuditLogs** `/audit`: 🆅 جدول يدوي؛ EmptyState نصّي؛ تفاصيل بـtruncate (أضف HoverCard). ✅ ترجمة الأفعال + Excel + dt() + dir=ltr ✓.

### ٥.١٧ الإدارة — ضوابط النظام
- **Reconcile** `/reconcile`: 🅑 زر التحديث بلا disabled أثناء الجلب. 🆅 loading نصّي بلا Skeleton. 🅟 لا تصدير تقرير الانحراف (مهم للتدقيق). ✅ fmt + جدول tabular-nums + RowActions + بادج انحراف ✓.
- **PeriodLock** `/period-lock`: ✅ unlock confirm() ✓؛ **lock `:109` بلا تأكيد→danger**. 🅵 `cutoffDate` بلا تحقّق `≥ اليوم`؛ `notes` بلا عدّاد. 🅑 أزرار بلا نص pending. 🆃 `fmtDate` محلي مكرّر؛ **toast مباشر→notify**. 🅟 لا شهادة إقفال فترة.
- **YearEnd** `/year-end`: ✅ close confirm() danger ✓. 🅵 السنة بلا تحقّق نطاق عند submit. 🅑 زر بلا نص pending. 🆅 لا Skeleton/EmptyState. 🆃 `fmtMoney` محلي → fmtAr؛ `netProfit` بـ`Number()` بدل D(). 🅟 لا طباعة ملخّص الإقفال.
- **CreditApprovals** `/credit-approvals`: ✅ **إنشاء موافقة `:117` بلا تأكيد→warning**. 🅵 `maxAmount` بـregex بدل AmountField؛ بحث العميل بدل SmartCustomerInput؛ `ttlMinutes` بلا معاينة انتهاء؛ **رصيد العميل خام `:73` → fmtAr**. 🅑 زر بلا نص pending. 🆅 loading/EmptyState نصّيان. 🆃 `fmtDateTime` محلي؛ **toast→notify**. 🅟 لا طباعة قسيمة الموافقة (token+QR للكاشير).
- **KioskDevices** `/kiosk-devices`: ✅ **حذف `:204` window.confirm→confirmDelete**؛ تدوير الرمز warning. 🅵 `label` بلا maxLength. 🅑 أزرار (تدوير/تفعيل/تعطيل) بلا نص pending. 🆅 loading/EmptyState نصّيان؛ شارة حالة inline. 🆃 `fmtDate` محلي؛ **toast→notify**. 🅟 لا طباعة QR إعداد الجهاز.
- **Settings** `/settings`: ✅ استعادة/تصفير عبر DangerConfirmDialog ✓ (أعلى معيار)؛ **حذف نسخة `:186` window.confirm→confirmDelete**. 🅑 أزرار النسخ بلا نص pending. 🆅 loading/EmptyState نصّيان. 🆃 `fmtDate` بـ`en-GB` + `fmtKb` محليان → مكتبة موحّدة؛ **toast→notify**. ✅ DangerConfirmDialog + password+token+warnings ✓.
- **Kiosk** `/kiosk` (عام): 🅑 زر التفعيل/الإعادة بلا نص pending/disabled. 🆅 شاشات التحميل/غير المخوّل بأنماط inline (استخرجها لمكوّنات). ✅ استخراج آمن للـtoken + عدم تسجيله ✓.

### ٥.١٨ الأساسية
- **Login** `/login`: 🅵 كلمة المرور `Input` خام بدل `PasswordInput`. 🅑 زر الدخول بلا أيقونة تحميل (يتعطّل فقط). ✅ mustChangePassword redirect + خطأ ظاهر ✓.
- **Dashboard** `/`: 🆅 لا EmptyState عند غياب وحدات الدور (إخفاء صامت `:762`)؛ مؤشرات تحميل «...» نصّية؛ أيقونات SVG مكرّرة (استعمل lucide). 🆃 `fmt` محلي `:422` → fmtAr؛ أوقات بصيغ مختلفة؛ أرقام بلا `tabular-nums` `:551`. 🅟 لا لقطة طباعة للوحة. ✅ theme + branchScope + dedup queries ✓.

---

## ٦. الأنماط الأفقية والمكوّنات المشتركة المقترحة (أعلى رافعة)

1. **`AmountField` / `CurrencyInput` (P0):** حقل مبلغ موحّد (`inputMode=decimal` + تحقّق `money.ts` + لاحقة «د.ع» + `tabular-nums`). يستهدف ≥٢٠ شاشة (PurchaseNew، WorkOrderNew، SalesInvoiceNew، ProductionNew، Payroll، AssetNew/Edit/Detail، CustomerNew/Edit، CreditApprovals، Promotions...). يُلغي عشرات حقول `type=number`.
2. **`@/lib/date` موحّد (P0):** `fmtDate/fmtDateTime/fmtTime/fmtDateRange` بـ`ar-IQ-u-nu-latn`. يلغي **≥١٢ دالة محلية مكرّرة** (PeriodLock، YearEnd، Settings، CreditApprovals، KioskDevices، Production، WIPReport، WorkOrders...) ويصحّح تضارب `en-GB`/`ar-IQ` و`YYYY-MM-DD` الخام.
3. **حملة توحيد `money.ts` (P1):** استبدال كل `toLocaleString`/`Number`/دوال محلية في العرض بـ`fmt/fmtAr/fmtInt` — ~٣٨ موضعاً مرصوداً (Products:161، Inventory، InventoryMovements، Transfers، Dashboard:422، InventoryValuation، StockStatus، ItemLedger، Production*، WorkOrders، YearEnd...).
4. **قانون شارات الحالة (Badge canon) (P1):** ألوان دلالية ثابتة عبر كل الوحدات — نشط/مكتمل/متوازن→`success(emerald)`؛ معلّق/تحذير/مخزون منخفض→`warning(amber)`؛ ملغى/مرفوض/متأخّر/نفد→`destructive(rose)`؛ مسودة→`outline(blue)`؛ قيد التنفيذ→`sky`؛ مُرسَل/مُسلَّم→`indigo`؛ معطّل/مؤرشف→`secondary(slate)`. يستهدف ~٢٠ شاشة بشارات inline.
5. **تبنّي `DataTable` (P1):** ~٣٠ جدولاً يدوياً (Purchases، Products، Production، Inventory، InventoryMovements، Transfers، AR/APAging، AssetRegister، Employees، Roles، AuditLogs، Payroll، Leaves، Promotions، سجلّات التقارير...). يجلب بحث/فرز/صفحات/Skeleton/EmptyState/تصدير مجاناً.
6. **تبنّي `RowActions` (P1):** ~١٠ شاشات بأزرار يدوية (Customers، Products، Production، AssetRegister/CustodyReport، Payroll، Roles، ProductionRecipes، HrDevices، Recruitment).
7. **توحيد حالات التحميل/الفراغ (P1):** `Skeleton/Spinner` + `EmptyState` في ~٤٠ شاشة بفراغ/تحميل صامت (لا سيّما الـ١٢ تقريراً تشغيلياً والمالية).
8. **نص pending على ~٥٠ زرّاً (P2):** `{isPending ? 'جارٍ…' : '…'}` + تعطيل، لمنع النقر المزدوج (حسّاس في الكاشير/الدفع/التحويل).
9. **قوالب طباعة HR/تشغيلية ناقصة (P2):** قسيمة راتب، كشف حضور، شهادة عمل/إنهاء خدمة، كشف عهدة موظف/أصل، شهادة ترقية، وثيقة تحويل، شهادة إقفال فترة، قسيمة موافقة ائتمان (token+QR)، جدول إهلاك، شهادة استبعاد أصل، QR إعداد كشك.

---

## ٧. عمليات حسّاسة إضافية للتحقّق (من ناقد الاكتمال — تحتاج فحصاً قبل التأكيد)
هذه **فرضيات** يجب التحقّق منها في الكود قبل الجزم (بعضها قد يكون محكوماً خلفياً):
- إلغاء فاتورة مرحّلة / تعديل سطر بعد الترحيل (`InvoiceDetail.tsx`) — أثر دفتري، P0.
- عكس دفعة ذمم مدينة (`CustomerStatement`) — تحقّق من إعادة التطابق، P0.
- منع الحذف الصلب لقيد دفتر (`GeneralLedger`) — يجب أن تمنعه المعمارية، P0.
- خفض حدّ ائتمان العميل (`CustomerEdit:134`) — معاينة الأثر، P1.
- تعديل تكلفة منتج بأثر رجعي (`ProductEdit`) — تحذير فرق، P1.
- إعادة فتح أمر شغل مكتمل (`WorkOrders`) — فحص عكس الفاتورة، P1.
- تغيير طريقة الإهلاك بأثر رجعي (`AssetEdit:49-55`)، تعديل راتب جماعي (`Payroll`) — P1.
- **شاشات إعداد محتملة غير موجودة** (قد تكون فجوات وظيفية أو مقصودة): شجرة حسابات/دليل حسابات، إدارة الفروع، إعداد الضريبة، تحويل الوحدات، إعداد العملة، طرق الإهلاك. (الضريبة 0% والعملة IQD الواحدة قد تجعل بعضها غير ضروري — قرار المالك.)
- **سياسة الحذف:** تأكيد أنّ كل حذف للبيانات الرئيسية = حذف منطقي (status=inactive) والحذف الصلب للمعاملات فقط.

---

## ٨. خارطة الطريق المرحلية (شرائح coord)

| المرحلة | المحتوى | الرافعة |
|---|---|---|
| **P0 — جولة سلامة التأكيدات** | §٤ P0 (~١٧ بنداً) عبر النظام. | حماية فورية من خطأ مالي لا رجعة فيه. |
| **P1-أ — توحيد التأكيد/الإشعار** | استبدال window.confirm (٦ مواضع) + toast→notify (٥ شاشات) + تأكيدات P1. | إزالة الانحراف. |
| **P1-ب — مكوّنا `AmountField` + `@/lib/date`** | إنشاؤهما + ربط الشاشات. | يصحّح عشرات الحقول والتواريخ. |
| **P2-أ — التوحيد التنسيقي** | حملة `money.ts` (~٣٨ موضعاً) + قانون الشارات. | اتساق بصري بكلفة منخفضة. |
| **P2-ب — DataTable/RowActions/حالات** | ترحيل ~٣٠ جدولاً + ~٤٠ حالة تحميل/فراغ + نص pending. | استثمار بنيوي يرفع كل الشاشات. |
| **P2-ج — قوالب الطباعة الناقصة** | HR + عهد + شهادات + تشغيلية. | قيمة تشغيلية مباشرة. |

كل شريحة بملكية ملفات صريحة (كاتب واحد/ملف)، دمج متكرّر، وتجنّب الملفات الساخنة
(routers/App/AppLayout/schema/seed) إلا عبر قائد التكامل. بوّابة الاكتمال: خلفية+واجهة+`pnpm check`+جولة
بصرية عبر `preview_*` تُثبت التأكيد/التنسيق/الطباعة فعلياً + لقطة برهان.

---

## ٩. ملحق — أرقام المنهجية
- ٢٢ وكيلاً للقراءة فقط، ٣٣٨ استخدام أداة، ~٥٧٠ ثانية، ٢.١٦ مليون رمز تدقيق.
- التغطية: ١١٥ شاشة / ١٨ وحدة + استطلاع تنقّل + استطلاع API + تركيب أفقي + ناقد اكتمال.
