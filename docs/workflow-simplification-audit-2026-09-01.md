# تدقيق تبسيط مسارات النظام — 2026-09-01

## الهدف والقاعدة الحاكمة

فحص فريق من سبعة مسارات النظام قراءةً من الواجهة حتى قاعدة البيانات: المبيعات، المخزون، الخزينة، أوامر الشغل والتوصيل، CRM والمتجر، المجالات الداعمة، والمسارات/الإجراءات اليتيمة.

القرار لا يُبنى على عدد النقرات وحده:

- **KEEP — إبقاء:** حدث مادي أو مالي أو قانوني مستقل، أو فصل مهام يمنع الغش والخطأ.
- **MERGE — دمج:** إدخال مكرر أو واجهتان لنفس النتيجة، مع إبقاء المحرك الحاكم الواحد.
- **REMOVE — حذف:** حالة أو زر أو endpoint لا يغيّر حقيقة العمل، أو مسار ميت/مضلل.
- لا يجوز أن تنشئ نقرة تنظيمية مثل الإسناد أو Kanban أثراً مالياً قبل الحدث المادي المقابل.
- لا يُحذف اعتماد ثانٍ حين يكون هو حاجز خروج النقد أو عكس المخزون أو تسوية ذات أثر جوهري.

## القرار المنفذ: فاتورة الشراء بلا خطوة استلام

### المسار الجديد

| الحالة | المسار | الأثر | القرار |
|---|---|---|---|
| حفظ مسودة | `/purchases/new` (`PurchaseNew.tsx`) أو تطبيق Android → `purchases.createOrder` → `createPurchaseOrder` | يحفظ الأمر ومراجعته بحالة `DRAFT` فقط؛ لا مخزون ولا WAVG ولا GRNI ولا AP | **KEEP** |
| إرسال للاعتماد | `/purchases` (`Purchases.tsx`) أو تفاصيل Android → `purchases.confirmOrder` → `submitPurchaseOrderForApproval` | ينتقل `DRAFT → SENT` وينشئ طلب `APPROVE_REVISION` معلّقاً؛ لا أثر مخزني أو مالي | **KEEP** كحدّ فصل مهام |
| اعتماد المراجعة مع إقرار الوصول الكامل | `/purchases?tab=approvals` (`PurchaseApprovalQueue.tsx`) → `purchases.decideControl` مع `confirmedFullReceipt=true` → `decidePurchaseOrderControl` → `postApprovedPurchaseInvoiceInTx` | في `withTx` واحد: GRN داخلي لكامل الكميات → `stock/WAVG` → GRNI → فاتورة مورد داخلية → مطابقة ثلاثية وترحيل AP/رصيد المورد → حالة الأمر `RECEIVED`. أي فشل يرجع السلسلة كلها، والمعتمد مستقل عن المنشئ وآخر محرر وصاحب الطلب | **MERGE — المنفذ التشغيلي الوحيد** |
| الروابط القديمة | `/purchases/:id/receive` و`/purchases/goods-receipts` و`/purchases/supplier-invoices` | Redirects توافقية فقط إلى شاشة المشتريات؛ لا شاشة إدخال ولا tRPC عام للاستلام أو لفاتورة المورد | **KEEP مؤقتاً للتوافق** |
| تسديد المورد | `PurchaseOrderDetail.tsx` → `purchases.pay` أو `settleUsdDirect` → خدمات الدفع/الاعتماد | طلب دفع مخصص للفاتورة؛ النقد لا يخرج قبل اعتماد شخص آخر | **KEEP** |
| بونص المورد | `PurchaseOrderDetail.tsx` → `gifts.receivePurchaseBonus` → `purchaseBonus.ts` | سند هدية مستقل وحركة مخزون مستقلة للكميات المجانية غير الموجودة في الفاتورة | **KEEP** |
| مرتجع الشراء | `/purchase-returns` → `purchaseReturns.create` → `purchaseReturnsService` | عكس مخزون/ذمة/تسوية حسب أصل الفاتورة | **KEEP** |

الأسطح التشغيلية المحذوفة من جذورها: `PurchaseReceive.tsx`، و`tRPC purchases.receive`، و`purchasesWarehouseProcedure`، وشاشتا/راوترا GRN وفاتورة المورد المنفصلان، ونموذج/زر/Repository الاستلام في Android، وروابط الاستلام الداخلية. تبقى خدمات GRN وفاتورة المورد والمطابقة **داخلية فقط** كي يصنعها اعتماد `APPROVE_REVISION` ذرياً ويحفظ أدلة المخزون وGRNI وAP؛ ليست لها واجهة إدخال عامة. أمّا `receivePurchase` القديم فليس مساراً تشغيلياً، ويُحصر في التوافق الداخلي والاختبارات التاريخية إلى حين إزالته الآمنة.

### شرط السلامة التشغيلي

**اعتماد فاتورة الشراء يعني أن البضاعة وصلت فعلياً وتمت مطابقة كامل كمياتها.** لذلك:

- الإنشاء `DRAFT` والإرسال `SENT` صفريا الأثر؛ لا يبدأ الاستلام أو الالتزام بمجرد الحفظ أو الإرسال.
- قبل الإرسال أو بعد رفض الطلب إلى `DRAFT`: يُعدل النقص أو التلف في المسودة ثم يُعاد إرسالها.
- الشحنة الجزئية: تُسجّل **كفاتورة شراء مستقلة** بالكميات الواصلة فعلياً؛ لا استلام جزئي على الفاتورة الأصلية.
- أجور الشحن والجمارك وطريقة تسويتها ومرجعها تُثبت في الفاتورة نفسها، فلا توجد شاشة متابعة منفصلة لإكمالها.
- بعد الاعتماد: التصحيح بمرتجع شراء موثق، لا بتعديل المخزون صامتاً.
- طلب الدفع النقدي يبقى maker-checker؛ تبسيط الاستلام لا يبرر الدفع الذاتي.

هذا الشرط هو الحد الفاصل بين التبسيط الصحيح وبين تضخيم المخزون والذمم وWAVG.

## خريطة العمليات الرئيسية وقرارات الفريق

### المبيعات والتحصيل

| العملية | المسار UI → API → الخدمة/الأثر | القرار |
|---|---|---|
| بيع التجزئة | `/pos` → `POS.tsx` → `sales.create`/بوابة الدفع الخارجي → `createSaleInTx` → فاتورة + مخزون OUT + SALE + إيصال/ذمة | **KEEP** للنواة، **MERGE P2** بين `submitSale` و`quickPay` |
| بيع طباعة فوري | `/pos?mode=PRINT_SERVICES` → `PrintPOS.tsx` → `printPos.createSale` → `createPrintSaleInTx` → استهلاك مواد الوصفة + فاتورة/قيد/إيصال | **KEEP** |
| سلة الاستقبال المختلطة | `/pos?mode=RECEPTION` → `Reception.tsx` → `workOrders.receptionCheckout` → `receptionCheckoutService` → بيع/طباعة/أمر شغل/عربون ذرياً | **KEEP**، مشاركة مكونات العرض فقط |
| فاتورة متقدمة/تصحيح | `/sales/new` أو `/invoices/:id/correct` → `sales.create/reissue` → `sale/create.ts` أو `sale/correct.ts` | **KEEP** |
| إلغاء فاتورة | `InvoiceDetail.tsx` → `sales.cancel` → `sale/cancel.ts` → عكس البيع والمخزون والإيصال | **KEEP** واعتماد المدير |
| عرض سعر | `/quotations/new` → `quotations.create/update` → `quotationService` → مستند بلا مخزون؛ التحويل يستدعي `createSale` | **KEEP** القبول والتحويل، **MERGE P1** حفظ/مسودة، **REMOVE P2** زر التحويل الميت في المحرر |
| إرسال عرض سعر | `QuotationNew.tsx` → مشاركة بلا `SENT` حقيقي | **MERGE/FIX P1**: إرسال واحد يوسم `SENT`؛ الحفظ يبقى `DRAFT` |
| حجز | `/reservations` → `reservations.create/convert` → reservation soft stock ثم `createSaleInTx` عند التحويل | **KEEP**؛ **REMOVE P3** فرع POS الخفي `workspace=reservations` |
| مرتجع بيع مباشر | `/returns` → `returns.create` → `returnSaleInTx` → RETURN + restock/refund/ذمة | **KEEP** |
| طلب مرتجع موظف | `ReceptionInvoiceQueue` → `returns.request` → `returnRequests` ثم اعتماد المدير | **KEEP** SOD، **REMOVE/MERGE P1** إعادة إدخال البنود عند الاعتماد لأن الخادم ينفذ `linesJson` الأصلية |
| تحصيل لاحق | `InvoiceDetail.tsx` أو `ReceptionInvoiceQueue.tsx` → `sales.pay`/`reception.collectOnInvoice` → `processPayment` | **KEEP** الإجرائين لصلاحياتهما، **MERGE P2** نموذج الدفع |
| سند قبض خزينة | `/vouchers/receipt/new` → `vouchers.create` → `createVoucherTx`/`invoiceAllocation` | **KEEP** كمستند خزينة مستقل |

### المخزون والإنتاج

| العملية | المسار UI → API → الخدمة/الأثر | القرار |
|---|---|---|
| منتج ووحدات | `ProductNew/Edit` → `catalog.createProduct/updateProductVariants` → خدمات الكتالوج → منتجات/وحدات/أسعار ورصيد افتتاحي | **KEEP** للمسار الحديث |
| تسوية كمية | `/inventory?tab=stock` → `inventory.adjust/approveAdjustment` → `adjustmentApproval.ts` → `setStock(ADJUST)` + قيد | **KEEP** SOD |
| إعادة تقييم تكلفة | واجهة المخزون → طلب/اعتماد revaluation → `costRevaluationRequest.ts` → cost + قيد | **KEEP** SOD |
| تحويل فروع | `/inventory?tab=transfers` → `transferBatch` ثم `transferReceive/cancel` → `transferService` → OUT/transit/IN | **KEEP**؛ الاستلام هنا حدث مادي حقيقي |
| جرد | `/stocktakes/*` → create/count/finish/review/sign/approve → خدمات الجرد → STOCKTAKE/OPENING + قيد فرق | **KEEP** المراحل، **MERGE P3** الغلاف والمسارات فقط |
| إعادة طلب | `/inventory?tab=reorder` → `createReorderDraft` → `inventory/reorder.ts` → PO DRAFT بلا مخزون | **KEEP**؛ **MERGE P1** قارئ العتبة مع التقارير |
| إنتاج دفعة | `/production/new` → `production.create` → `production/create.ts` → مواد OUT ومخرجات IN وWAVG | **KEEP** وسمّه «دفعة منجزة» |
| إلغاء إنتاج | `production.cancel` → `production/cancel.ts` → عكس المخزون/WAVG | **KEEP** للمحرك، **MERGE P1** إلى طلب/اعتماد مع سبب |
| ربط إنتاج بأمر شغل | `ProductionNew.tsx linkedWorkOrderId` مع خصم مستقل في `production/create.ts` و`workOrder/lifecycle.ts` | **REMOVE/MERGE P0**: يخصم المواد مرتين؛ أزل الخيار حتى يوجد مالك استهلاك واحد |
| عقود مخزون قديمة | `inventory.transfer` الأحادي، `movements` القديم، `createManualMovement`، `catalog.getForEdit/updateProduct` القديم | **REMOVE P2** بعد مهلة توافق/سجل استخدام |

### أوامر الشغل والتوصيل

| العملية | المسار UI → API → الخدمة/الأثر | القرار |
|---|---|---|
| استقبال طلب | `Reception.tsx` → `workOrders.receptionCheckout` → `createWorkOrderInTx` → `RECEIVED` وعربون محتمل | **KEEP** |
| ادعاء/إسناد عامل | محطة العمل → `claim/assign` → `workOrder/lifecycle.ts` → مسؤولية وسجل بلا مال | **KEEP** كتنظيم فقط |
| بدء العمل | `start` → `workOrder/lifecycle.ts` → مواد OUT وWIP ثم `IN_PROGRESS` | **KEEP** |
| جاهز | `markReady` → lifecycle → `READY` وإشعار بلا مال | **KEEP** |
| تسليم مباشر | الاستقبال/التفاصيل → `workOrders.deliver` → `workOrder/deliver.ts` → فاتورة + SALE + COGS + `DELIVERED` | **KEEP** |
| إسناد لمندوب | `DeliveryHub` → `delivery.dispatch` → `delivery/dispatch.ts` | **MERGE/FIX P0**: لا يجوز إنشاء SALE/AR عند الإسناد الإداري قبل التسليم |
| تسليم عهدة للمندوب | `staffHandover` → `delivery/staffTransition.ts` → `OUT_FOR_DELIVERY` | **KEEP** |
| إثبات التسليم | `staffConfirm/manualProof/courier` → `confirmConsignmentDelivery` → تسليم/فاتورة/ذمم | **KEEP** المحرك، **MERGE** واجهات الإثبات |
| توريد المندوب | `recordRemittance` → `delivery/remittance.ts` → receipt + ledger + تصفية عهدة | **KEEP** منفصلاً عن إثبات التسليم |
| فشل/إرجاع شحنة | `staffMarkFailed/declareReturn/returnConsignment` → `delivery/returns.ts` → عكس/إعادة مخزون | **KEEP** |
| Kanban READY موازٍ | `workOrder.kanbanState` بجانب الحالة الرسمية `READY` | **REMOVE/MERGE P1**: احتفظ بـ`BLOCKED` وسببه فقط |
| أسطح lifecycle المتكررة | `WorkOrders` و`WorkOrderDetail` و`WorkOrderStation` و`ReceptionOrderQueue` | **MERGE P1** مكون القرار والصلاحيات، لا الخدمات |

### الخزينة والمصروفات والصيرفة

| العملية | المسار UI → API → الخدمة/الأثر | القرار |
|---|---|---|
| سند قبض/صرف | `_VoucherFormShared` → `vouchers.create/approve` → `voucher/create.ts`/`approval.ts` → receipt + ledger + party | **KEEP** |
| مصروف | `ExpenseNew/Expenses` → `expenses.create/approve` → `expenseService` → expense + receipt + ledger | **KEEP** |
| فئات مصروف داخل سند OTHER | سند عام يكرر إيجار/رواتب/خدمات المصروفات ولا ينشئ `expenses` | **MERGE P1** مع وحدة المصروفات ثم إخفاؤها من OTHER |
| وردية ودرج | POS/Reception/Shifts → `shifts.open/close` → `shiftService` → عهدة وإيصالات وتقارير Z | **KEEP** |
| إسقاط نقد/تمويل درج | `CashDropDialog/Shifts/Treasury` → خدمات cash drop/funding/handover → transit + زوج قيود | **KEEP** الأحداث، **MERGE P2** وثيقة نقل عهدة موحدة |
| تمويل خزينة مباشر | `Treasury.tsx` → `treasury.fundTreasury` → `treasuryFundingService` → CAPITAL فوري | **MERGE ثم REMOVE P1**: استخدم سند قبض CAPITAL باعتماد وطرف |
| تحويل نقد فروع | `TreasuryTransfers` → `cashTransfers.*` → `cashTransferService` → TREASURY/transit/TREASURY | **KEEP**؛ **REMOVE P2** خيار الرصيد السالب الذي تتجاهله الخدمة |
| دفعة عميل | `InvoiceDetail` → `sales.pay` → `sale/payment.ts` | **KEEP**؛ مشاركة واجهة التخصيص |
| دفعة مورد مخصصة | `PurchaseOrderDetail` → `purchases.pay` → `purchase/pay.ts` → طلب/اعتماد + تحديث PO | **KEEP** |
| سند مورد عام | voucher SUPPLIER يغير المورد ولا يخصص `purchaseOrders.paidAmount` | **RESTRICT/MERGE P1** إلى دفعة مقدمة أو تخصيص PO؛ خطر دفع مزدوج |
| صيرفة | `Exchange*` → `exchange.*` → خدمات deposit/withdraw/buyUsd/settle/reverse | **KEEP** للمحرك المتخصص |
| تسوية مورد بالصيرفة | `exchange.settleSupplier` → `settleSupplier.ts` يثبت المنشئ والمعتمد نفسه | **MERGE/FIX P1** إلى طلب دفع واعتماد شخص آخر |
| USD مادي | `exchangeTransactions` + ledger بلا وثيقة `receipts` متعددة العملات | **MERGE/FIX P1**: وثيقة USD رسمية أو اعتماد exchange transaction كوثيقة خزينة كاملة |

### CRM والمتجر

| العملية | المسار UI → API → الخدمة/الأثر | القرار |
|---|---|---|
| وارد القنوات | webhook → `conversationService` → `conversations/messages/waOutbox`؛ العرض/الرد في `Inbox` | **KEEP** |
| وارد → عميل | `Inbox` ينسخ البيانات ثم `/customers/new` ثم ربط يدوي | **MERGE P1** إنشاء وربط ذرياً |
| هوية عميل المتجر | `Storefront` → `storefront.createOrder` → `lockOrCreateOnlineCustomer` يبحث phone فقط | **MERGE/FIX P1** مع محلل phone/phone2/phone3/whatsapp |
| وارد → عرض سعر | Inbox/CRM → `quotations.create` | **KEEP** المحرك، **MERGE P2** handoff سياقي بلا كيان فرصة ثانٍ |
| وارد → مهمة | Inbox/Tasks → `tasks.create` → `tasks/create.ts` + events | **KEEP** المحرك، **MERGE P1/P2** تمرير conversation/workOrder/quotation وعرض الروابط |
| متابعة عميل | `Customers.tsx` ينشئ note ثم task بنداءين | **MERGE P1** إلى مصدر تنفيذ واحد/معاملة مركبة |
| وارد → استقبال | Inbox داخل Reception يحتفظ `conversationId` في المسودة فقط | **MERGE/FIX P1** حمل المعرّف في commit الوحيد |
| طلب متجر | `Storefront` → `storefront.createOrder` → `onlineOrderService` → PENDING بلا مال | **KEEP** |
| تثبيت/إرسال متجر | `OrderFulfillment` → `storeAdmin.orders.dispatch` → `dispatchOnlineOrder` → sale + dispatch ذرياً | **KEEP** |
| تسليم/تحصيل متجر | `MyDeliveries/DeliveryHub` → confirm/remittance → courier/remittance services | **KEEP** |
| CRM Overview/Store Dashboard | بطاقات تكرر التبويبات والقوائم بلا funnel أو deep links | **MERGE P2** |

### الموردون والهدايا والأمانة والأصول وHR

| العملية | المسار UI → API → الخدمة/الأثر | القرار |
|---|---|---|
| مورد | `Suppliers*` → `supplier.*` → `supplierService` → supplier/opening balance/guards | **KEEP** CRUD الحاكم؛ **MERGE P2** `list/search` |
| هدية إدخال/إخراج | `/gifts` → `gifts.*` → inbound/outbound → vouchers + stock + ledger | **KEEP** فصل الاتجاه والموافقة |
| قائمة هدايا | `giftsRouter` يعيد SQL القائمة ويكرر حسم الفرع | **MERGE P1** إلى خدمة قائمة عميقة واحدة |
| مذكرة أمانة | `SuppliersHub` → `consignment.*` → `noteService` → CONSIGNMENT IN/OUT | **KEEP** |
| تسوية أمانة | `consignment.settle` → طلب سند دفع معلّق | **KEEP** منفصلة عن المذكرة |
| تقارير أمانة | `consignmentRouter` يسمح branchId فارغاً فيقرأ كل الفروع | **MERGE/FIX P0** حسم الفرع قبل الخدمة وتوحيد SQL التقارير |
| أصل ثابت | `/assets` → `assets.*` → create/depreciate/custody/maintenance/dispose | **KEEP** العمليات المالية المنفصلة |
| تحديث أصل | API يطلب حقول الاقتناء المقفلة ويرفض تغييرها | **REMOVE P1** الحقول من عقد update؛ **MERGE P2** نموذج create/edit |
| موظف | `/hr` → `employee.*` → `employeeService` | **KEEP** الإنهاء الرسمي؛ **MERGE P2** create/createWithAccount |
| تحديث موظف | فحص الأجر ثم update ثم audit خارج معاملة واحدة | **MERGE/FIX P1** داخل transaction |
| رواتب | generate → draft update → approve → pay → return/cancel | **KEEP**؛ الاستحقاق غير الدفع والعكس حدث مستقل |
| قراءات رواتب داعمة | branchId فارغ يعرض ملخصات عبر الفروع بخلاف الحارس الموحد | **MERGE/FIX P0** نطاق فرع موحد |

## القرارات الحرجة مرتبة للتنفيذ

### P0 — تصحيح قبل أي توسع جديد

1. **التوصيل:** لا تُنشأ فاتورة و`SALE/AR` عند مجرد إسناد المندوب؛ اجعل الأثر عند الحدث المادي، وأضف عكساً ذرياً لإلغاء ما قبل التسليم. الأدلة: `delivery/dispatch.ts`، `delivery/cancellation.ts`، `workOrder/cancel.ts`، `reverseDelivery.ts`.
2. **الإنتاج وأمر الشغل:** احذف `linkedWorkOrderId` من الواجهة مؤقتاً؛ الربط الحالي لا يمنع الخصم المزدوج. الأدلة: `ProductionNew.tsx`، `production/create.ts`، `workOrder/lifecycle.ts`.
3. **عزل الفروع:** أصلح تقارير الأمانة وقراءات الرواتب الداعمة قبل تحسين واجهاتهما. الأدلة: `consignmentRouter.ts`، `noteService.ts`، `payrollRouter.ts`.
4. **روابط تشغيل مكسورة:** `/ar-reminders`، `/store-admin/orders/:id` ثم روابط `/dashboard` و`/hr/advances` و`/reports/tools` المولدة خادمياً.
5. **Android purchases.receive:** **أُغلق في هذه الشريحة**؛ لم يعد هناك استدعاء runtime للـendpoint المحذوف.

### P1 — إزالة الازدواج عالي الخطر

1. منع إعادة إدخال بنود المرتجع عند الاعتماد؛ اعرض طلب الموظف المخزن فقط.
2. تخصيص دفعات المورد العامة لأوامر الشراء أو تسميتها دفعات مقدمة صراحة.
3. SOD لتسوية مورد الصيرفة وتمويل الخزينة والرصيد الافتتاحي للصيرفة.
4. دمج مدخل المصروف التشغيلي ومنع فئات المصروف من سند OTHER العام.
5. توحيد هوية العميل في المتجر والاستقبال، ودمج إنشاء/ربط عميل المحادثة.
6. توحيد note/task في متابعة العميل، وحمل `conversationId` في تثبيت الاستقبال.
7. توحيد مصدر عتبات إعادة الطلب، وربط مزامنة نطاق الجرد بمعاملة الكتالوج.
8. تبسيط عروض الأسعار إلى حفظ مسودة حقيقي وإرسال يوسم `SENT`.

### P2/P3 — تنظيف بعد قياس الاستخدام

- إزالة endpoints القديمة واليتيمة بعد فحص سجلات الوصول، لا بمجرد بحث ساكن.
- توحيد أغلفة الجرد وتقارير المبيعات/Aging مع Redirects تحفظ الروابط القديمة.
- إصلاح حارس orphan ليفحص `router.procedure` كاملاً؛ نجاحه الحالي قد يخفي يتامى متشابهة الأسماء.
- إبقاء Redirect `/purchases/:id/receive` دورة توافق واحدة ثم حذفه إن لم تعد هناك زيارات.

## ترتيب العمل المقترح

1. شريحة P0 للتوصيل/العكس، مستقلة باختبارات مالية ومخزنية كاملة.
2. شريحة P0 لعزل الأمانة والرواتب وروابط التشغيل المكسورة.
3. شريحة P1 للمرتجعات ودفعات المورد والصيرفة/التمويل.
4. شريحة P1 لـCRM وهوية العميل ومتابعاته.
5. حملة P2/P3 لإزالة العقود اليتيمة بعد telemetry ومهلة توافق.

كل شريحة يجب أن تحافظ على: معاملة ذرية، idempotency، قفل/ترتيب أقفال، عزل فرع، سجل تدقيق، واختبار أثر المال والمخزون قبل الدمج.
