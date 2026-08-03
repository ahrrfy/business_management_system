# دفتر عمل حملة الفلاتر والمصطلحات — ٣ آب ٢٠٢٦

> **المصدر:** تدقيق عدائي بفريق ١٥ وكيلاً غطّى ١٩٤ شاشة (الخام الكامل في `audit-raw-pages.json`
> بجذر الفرع — يُحذف قبل الدمج، ونسخة الخلاصة في هذا الدفتر). **المُنفَّذ في هذه الحملة:** إعادة بناء
> PDF المستندات الرسمية + QR حقيقي في قوالب A4 + توحيد مصطلحات واسع (صنف→منتج، زبون→عميل،
> مسوّدة، نقدي، الرصيد الحالي…) + الشاشات الـ١٦ عالية الأولوية (فواتير/POS/سندات/مخزون/أوامر شغل/
> إنتاج/أمانة/محادثات/حجوزات/تقرير مبيعات/أعمار/رواتب). **هذا الدفتر يحفظ المتبقي** — عالجه
> بنداً-بنداً في جلسات قادمة: تنفيذ → فحص → تحقّق → شطب.

## ٠. قرارات مؤجَّلة تحتاج جلسة مستقلة (مالية — لا تُدرَج ضمن تمريرة فلاتر)

- [ ] **شريحة الاستقبال المالية** (`Reception.tsx` + `receptionCheckoutService`): منتقي فئة سعر
  (اليوم يسعّر التاجر/الحكومي «مفرد» صامتاً) + طريقة دفع «محفظة» WALLET (تُسجَّل اليوم «تحويل»
  فتنحرف تقارير Z) + حقل كوبون كما في كاشير التجزئة + حفظ مسوّدة السلة في localStorage +
  decimal بدل Number() في فرق العدّ. الخادم يحصر `CASH|CARD|TRANSFER` — التوسعة تغيير ماليّ
  يلزمه اختبارات تكامل كاملة (Z-report/العرابين/idempotency).
- [ ] **خيار CHECK الحي في خطط الأقساط** (`InstallmentPlans.tsx`) يناقض قرار «لا صكوك» (٢٢/٧) —
  يحتاج قرار مالك (هل القسط بصك مقبول استثناءً؟).
- [ ] **حاسبة تسعير الطباعة** (`PrintPricingCalculator.tsx`): مخرج عملي (نسخ التفصيل/إنشاء عرض سعر)
  + مراجعة حصرها بالمدير مع المالك.

## ١. أولوية متوسطة — مجموعات بالوحدات (من خلاصة التدقيق حرفياً)

### السجلات المالية
- [ ] `SalesRegister` + `PurchaseRegister` + `GeneralLedger`: توحيد الطباعة مع التصدير عبر
  fetchAllPaged (المطبوع اليوم = الصفحة المعروضة فيبدو تقريراً كاملاً وهو مبتور)، بحث نصي،
  فلتر مورّد بسجل المشتريات، اختيار متعدد entryTypes بالأستاذ، عمود تكلفة الوحدة بشاشة سجل
  المبيعات + إصلاح KPI صافي الربح. **خادمياً:** q في الإجراءات الثلاثة + supplierId.
- [ ] `Shifts`: انتقال من صف الوردية إلى فواتيرها (**خادمياً:** شرط shiftId في sales.list) —
  الغرض الأول لتحقيق الفروقات النقدية.
- [ ] `Treasury` + `TreasuryTransfers` + `Expenses` + `CardAccount` + `CashOrphanReport` +
  `DayCloseReport`: دفتر خزينة بمدى تاريخ وترقيم وتصدير (الحركات مثبَّتة على آخر ٢٠)، ترقيم
  فعلي للتحويلات، فلتر طريقة/مصدر بالمصروفات، بحث بحركات البطاقة، طباعة A4 لتقرير الإقفال
  (وثيقة توقيع) + زرا اليوم السابق/التالي.

### المبيعات والمرتجعات والعروض
- [ ] `SalesReturns` + `SalesInvoiceNew` + `SalesReturnNew`: بحث برقم الفاتورة وفلتر منفّذ
  المرتجع (**خادمياً:** q + createdBy في returns.list)، useUnsavedGuard بالنموذجين + تأكيد
  Esc/F12، استبدال window.print بقالب A4 محجوز + إصلاح سباق setTimeout في «حفظ وطباعة».
- [ ] `Quotations` + `QuotationNew` + `QuotationDetail`: فلتر فرع (جاهز خادمياً)، ترقيم
  (اقتطاع 200 صامت)، مسح فلاتر + URL، حارس فقد بيانات + Ctrl+S، showCost عبر canSeeCost.
  **خادمياً:** cursor/hasMore في listQuotations.

### المشتريات والموردون
- [ ] `Purchases` + `PurchaseNew` + `PurchaseReceive` + `PurchaseReturns` + `PurchaseReturnNew`:
  فلتر فرع + عمود فرع، مسح فلاتر + URL، حارس فقد بيانات + قرار «حفظ مسوّدة» الزائف (الراوتر
  يدعم DRAFT — فعّله أو أخفِه)، inputMode=numeric للاستلام + طباعة سند استلام جزئي، كميات
  المرتجع تبدأ صفراً + إظهار الحد الأعلى + طباعة مستند المرتجع من السجل.

### العملاء والذمم
- [ ] `Customers` + `CustomerEdit` + `CustomerStatement` + `CustomerNotes`: فلتر مدينة
  (**خادمياً:** city في search)، إزالة ?? 1 في مهام المتابعة، حارس فقد بيانات، فترة الكشف في
  URL + تقييد جدول الدفعات بالفترة، «إخفاء المحلولة» + ترقيم الملاحظات (**خادمياً:** offset/q).
- [ ] `ARReminders` + `APReminders` + `CreditApprovals` + `InstallmentPlans`: بحث/فلترة تبويب
  السجل + تصدير قائمة اليوم، فلتر شريحة تقادم، سجل عام للموافقات + إجراء إلغاء
  (**خادمياً:** list+cancel في creditApprovalRouter)، بحث رقم خطة + dueSoon قابلة للضبط +
  أتمتة وسم القسط بعد اعتماد السند المعلَّق.

### المخزون والكتالوج
- [ ] `InventoryMovements` + `TransfersLog` + `Transfers` + `ReorderAlerts` + `StocktakeNew` +
  `StockStatus` + `ItemLedger`: كشف فلتر referenceType (جاهز) + فلتر منشئ الحركة
  (**خادمياً:** createdBy)، بحث برقم سند التحويل + from/to (**خادمياً:** q)، إصلاح رابط
  «حركات المخزون» المضلِّل، بحث محلي وترقيم للتنبيهات، منتقي المنتجات ببحث خادمي بدل حد 1000،
  فصل نفد/منخفض + روابط عميقة.
- [ ] `Products` + `ProductEdit` + `BarcodeLabels` + `CatalogAnomalies`: منتقي فرع صريح بدل
  ?? 1 (يصحح مخزون الملصقات)، فلاتر في URL، حارس فقد بيانات + إدارة بدائل الباركود في التعديل
  (**خادمياً:** barcodeAliases في updateProductVariants)، حفظ قائمة الملصقات، لافتة اقتطاع + تصدير.
- [ ] `PriceWaves` + `Offers` + `Coupons` + `SeasonPlanning` + `GiftsHub`: تفاصيل صفوف الموجة
  (**خادمياً:** إجراء جديد)، تعديل/إعادة تفعيل عرض (**خادمياً:** update/reactivate)، بحث كوبون
  برمزه (**خادمياً:** q في listIssued)، بحث/فئة بخطة الموسم، مدى تاريخ للهدايا + بنود السند
  للمعتمِد (**خادمياً:** from/to).

### المحاسبة والإقفال
- [ ] `TrialBalance` + `BalanceSheet` + `MonthlyClosePack` + `ArApAgingDetail`: منتقي «كما في»
  (**خادمياً:** asOf في financialPosition — اللقطة دائماً الآن والطباعة توهم بالدعم)، تصدير
  Excel لحزمة الشهر + مقارنة بالشهر السابق، فلتر شريحة وبحث بالتفصيلي.
- [ ] `Reconcile` + `PeriodLock` + `YearEnd` + `KioskDevices` + `Branches` + `Settings`: أسماء
  أطراف بالانحرافات + تصدير، سجل الأقفال السابقة (محفوظ بالتدقيق بلا عرض)، فلترة الإقفالات
  بالسنة/الفرع (جاهزة)، طباعة آمنة تخفي رمز الكشك.

### الموارد البشرية
- [ ] `Employees` + `EmployeeNew` + `Attendance` + `AttendanceReport` + `MonthlyAttendanceReport`:
  includeInactive تلقائياً عند «منتهي الخدمة» (نتيجة فارغة كاذبة)، فلتر نوع الأجر (**خادمياً:**
  payType)، فلتر فرع للحضور (**خادمياً:** branchId — الشهري يدعمه أصلاً)، منتقي موظفين ببحث
  بدل قص 200، حارس نموذج الموظف (٤٠+ حقلاً).
- [ ] `Leaves` + `LeaveReport` + `EmployeeAdvances` + `HrDevices` + `Recruitment` +
  `HrChangesReport`: فلتر الموظف (جاهز) + مدى تاريخ + ترقيم، إصلاح «أيام هذا الشهر» للإجازة
  العابرة للشهور، تصدير السلف + فلتراها الجاهزان + إزالة ?? 1، فلاتر طابور البصمات، شاشة
  تفاصيل متقدِّم توظيف (get موجود بلا واجهة)، مدى تاريخ لتقرير التغييرات.

### الإدارة والنظام
- [ ] `Users` + `UserEdit` + `UserNew` + `RoleEdit` + `Roles` + `AuditLogs`: فلتر فرع + تصدير
  للمستخدمين (**خادمياً:** branchId)، حارس فقد بيانات بالنماذج (تغيير الفئة الأساسية يمسح
  المصفوفة بلا تأكيد)، منسدلة أفعال معرّبة من audit.facets الجاهزة + توسيع ACTION_AR، فلتر
  حالة للأدوار (includeInactive جاهز).

### المهام والتوصيل والمتفرقات
- [ ] `TasksHub` + `TaskDetail` + `OrderFulfillment` + `DeliveryHub` + `DeliveryParties` +
  `MyDeliveries`: مدى تاريخ + أولوية + تصدير للمهام (**خادمياً:** from/to/priority)، رابط
  المحادثة إلى المحادثة نفسها، ترقيم الطلبات + orderNumber بالتأكيد بدل id الداخلي، كشف
  search/activeOnly الجاهزين بالأطراف + إصلاح استخراج ref بregex هش.
- [ ] `DigitalSubscriptions` + `DigitalDashboard` + `ExchangeStatement` + `ExchangeOperations`:
  بحث باسم الطالب + «تنتهي قريباً» (**خادمياً:** q/expiring)، مدى حر للوحة، تصدير/طباعة كشف
  الصيرفة (جاهز واجهياً)، useRef بدل متغير موديول لإعادة المحاولة.
- [ ] تقارير: `WIPReport` (تصدير/طباعة — الوحيد بلا مخرج)، `ProfitabilityReport` (لافتة اقتطاع
  بُعد المنتج 100/1453)، `ExpensesReport` (حد جهات الصرف + drill-down)، `PurchasesReport`
  (بحث مورّد + مفتاح Math.random)، `OfflineSalesReport` (فلتر فرع جاهز + تصدير)، `AbcAnalysis`
  (بحث/فئة + فلتر A/B/C).
- [ ] `WorkOrderNew` + `WorkOrderDetail` + `WorkOrderStation`: حارس فقد بيانات، علّة
  deliveryMethod لا يُرسَل للخادم، رابط الفاتورة إلى /invoices/{id}، حقل مرجع عملية في تسليم
  WorkOrderDetail (مرآة POS)، decimal بدل Number() (3 مواضع)، بحث محلي بالمحطة.
- [ ] `ProductionNew` + `ProductionRecipes` + `ContractPrices` + `ConsignmentSettlements`:
  حارس + منتقي WO من المفتوحة بدل نص حر + إزالة ?? 1 (الأمانة **عملية مالية**)، فلتر حالة
  الوصفات (جاهز)، تصدير/طباعة ملحق الأسعار التعاقدية (يُرفق بالعقد الحكومي) وكشف التسوية،
  خيار CARD/TRANSFER للتسوية (الخادم يقبلها).
- [ ] `Campaigns` + `WaBroadcasts` + `WhatsappHubReport` + `Commission*` + `CrmOverview` +
  `Asset*`: بحث/فلاتر عميلية، زر طباعة تقرير واتساب (onPrint جاهز)، فلتر فرع للوحة الشرف،
  ar-IQ-u-nu-latn بدل en-US، بحث وطباعة تقرير العهد، مدى تاريخ لسجل الاستبعاد، حارس نماذج
  الأصول + تحقق قيمة الشراء > 0.

## ٢. أنماط عرضية متبقية (تُحل بتمريرة واحدة لكل نمط)

- [ ] **تعميم useUrlFilters** (أُنشئ في هذه الحملة وطُبّق على الشاشات عالية الأولوية) على بقية
  الشاشات (~15 متبقية).
- [ ] **تعميم حارس فقد البيانات + Ctrl+S** على النماذج العشرين المكشوفة (النموذج المرجعي
  ExpenseNew) + قاعدة: Esc وF12 لا يمسحان بلا تأكيد.
- [ ] **استئصال «branchId ?? 1» المتبقي** (محظور منذ #274/#288): ConsignmentSettlements (مالية!)/
  Customers/ContractPrices/Products/BarcodeLabels/ProductionNew/ProductionRecipes/WorkOrderNew/
  EmployeeAdvances — منتقي فرع موحّد للأدمن بلا فرع مُسنَد.
- [ ] **الاقتطاع الصامت** (درس #287) في البقية: Quotations(200)/ReorderAlerts(200)/GiftsHub(200)/
  OrderFulfillment(200)/TreasuryTransfers(50)/CatalogAnomalies/PriceWaves/ProfitabilityReport(100)/
  CustomerNotes(100)/AttendanceReport.
- [ ] **توحيد الطباعة مع التصدير** حيث يطبع الصفحة فقط: SalesRegister/PurchaseRegister/
  GeneralLedger/TreasuryReport.
- [ ] **استبدال window.prompt/confirm المتبقي**: VoucherCategories (دمج بمنتقٍ بالاسم بدل رقم!)/
  CatalogAnomalies/WaBroadcasts/ProductEdit.
- [ ] **توكنز دلالية بدل الألوان الخام** (يسقط بالوضع الداكن): InvoiceDetail/BalanceSheet/
  PriceWaves/Offers/HrDevices/PayrollLegalSettings.
- [ ] **استكمال ترحيل select الخام إلى AppSelect** وفق `docs/app-select-migration-plan.md`.
- [ ] **إزالة التشكيل الشاذ المتبقي**: SalesReportsHub/AgingReportsHub/WorkOrderStation.
- [ ] **توحيد «أمر شغل»** عبر PrintHub/WIPReport/WorkOrdersReport (لا «طلب خدمة»/«طابور المطبعة»).

## ٣. ملاحظات تحقّق للجلسات القادمة

- أرقام الأسطر في `audit-raw-pages.json` التُقطت قبل تعديلات هذه الحملة — تحقق دائماً بقراءة حية.
- أي فلتر خادمي جديد: اختياري في zod، لا يمس عزل الفروع (scopedBranchId حاكم)، وبنمط
  keyset/hasMore القائم.
- بعد كل شريحة: `pnpm check` + الاختبارات ذات الصلة + جولة بصرية عبر خادم التطوير.
