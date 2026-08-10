# تصميم «تصحيح الفاتورة الموثَّق» (Documented Invoice Correction)

> **الحالة:** وثيقة تصميم — **لا كود بعد**. للمراجعة والحسم من المالك.
> **التاريخ:** ٢٠٢٦-٠٨-١٠.
> **القرار الحاكم (المالك):** الفاتورة **لا تُحرَّر بحرّية**. «التعديل» = **تصحيحٌ موثَّق** بأثرٍ تدقيقيّ كامل (مَن/متى/قبل/بعد) وعكسٍ متّسق للدفتر والمخزون والذمم، محكومٌ بالصلاحية.
>
> كل ادّعاء عن السلوك القائم أدناه مُوثَّق بدليل `file:line`. هذا نظامٌ ماليّ — الادّعاء غير المُتحقَّق خطر.

---

## ١. ما الذي تكتبه فاتورة البيع عند التثبيت بالضبط (الآثار الجانبية)

مسار التثبيت القانونيّ هو `createSaleInTx` (`server/services/sale/create.ts`)، ويُستدعى من ثلاث قنوات:
- **POS المباشر** عبر `createSale` → `withTx(createSaleInTx)` (`create.ts:950-951`).
- **كاشير الاستقبال** (سلّة مختلطة) عبر `checkoutReceptionInTx` → `buildSale` → `createSaleInTx` (`receptionCheckoutService.ts:292-326`)، ثم تثبيت المسوّدة `commitDraft` → `checkoutReceptionInTx` (`reception/commit.ts:418-419`).
- **البطاقات الرقمية** عبر `DIGITAL_SALE_CAPABILITY` (`create.ts:50-58`) — خارج نطاق التصحيح (محظور المرتجع أصلاً).

كلّ الآثار التالية تحدث **داخل معاملة `withTx` واحدة ذرّية** (`server/services/tx.ts`)؛ أي `throw` ⇒ ROLLBACK كامل (§٥ من `CLAUDE.md`).

| # | الأثر | الجدول / الدالة | الدليل | ملاحظات |
|---|------|-----------------|--------|---------|
| ١ | **رأس الفاتورة** | `invoices` insert | `create.ts:604-648` | يكتب `subtotal, taxAmount, taxRatePercent, discountAmount, total (=effectiveTotalD), costTotal (البنود المدفوعة فقط), cashRoundingAdjustment, deliveryFee, deliveryFree, deliveryWaivedAmount, status, paidAmount (=paidNow), paymentMethod, paymentDate, notes, contactName/Phone, originatedOffline/offlineReceiptNumber/capturedAt, salespersonNameSnapshot, posDeviceId, createdBy, sourceType, sourceId (=clientRequestId‖null), shiftId, customerId, priceTier, dueDate`. |
| ٢ | **بنود الفاتورة** | `invoiceItems` insert لكل سطر | `create.ts:657-692` | `variantId, productUnitId, quantity, baseQuantity, unitPrice, unitCost (لقطة WAVG), discountAmount, total, promotionId, promotionDiscount, isGift`. |
| ٣ | **لقطة مكوّنات البكج** | `invoiceItemBundleComponents` insert | `create.ts:681-691` | لكل سطر `BUNDLE` — يقرأها المرتجع بدل الوصفة الحيّة. |
| ٤ | **استهلاك الكوبون** | `couponRedemptions` (عبر `consumeCoupon`) | `create.ts:695-703` | لو وُجد كوبون مقفول. |
| ٥ | **خصم المخزون OUT** | `applyMovement` لكل متغيّر مُجمَّع | `create.ts:775-819` | يكتب `inventoryMovements` (نوع `OUT`، `referenceType='INVOICE'`, `referenceId=invoiceId`) + يحدّث `branchStock.quantity` تحت قفل `FOR UPDATE` نسبيّاً (`inventoryService.ts:127-176`). البكج يُوسَّع لمكوّناته (`create.ts:712-726`). |
| ٦ | **قيد SALE** | `postEntry` | `create.ts:821-835` | `dedupeKey='SALE:${invoiceId}'` (قيد SALE **واحد** لكل فاتورة، حارس فريد على القاعدة `uq_entry_dedupe` — `schema.ts:2197`). `revenue = subtotal − discount + deliveryFee`، `cost = costTotal`، `profit = revenue − cost`، `taxAmount`, `amount = total`. |
| ٧ | **قيد GIFT_OUT** (إن وُجدت هدايا) | `postEntry` | `create.ts:842-855` | `dedupeKey='GIFT:INV:${invoiceId}'`، `cost = giftCost`, `profit = −giftCost`, خارج وعاء العمولة. |
| ٨ | **قيد PURCHASE اليتيم للأمانة** (إن وُجدت أصناف أمانة) | `postEntry` + `adjustSupplierBalance` | `create.ts:860-879` | لكل مودِع: `dedupeKey='CONSIG:${invoiceId}:${cId}'`، `amount=الحصة`، ثم رفع `suppliers.currentBalance` (AP). |
| ٩ | **قيد ADJUST للتقريب النقدي** (إن وُجد) | `postEntry` | `create.ts:884-896` | `dedupeKey='ADJUST:IQD:${invoiceId}'`، `revenue=profit=amount=cashRoundingAdj`. |
| ١٠ | **إيصال قبض + قيد PAYMENT_IN** (إن `newMoneyD>0`) | `receipts` insert + `postEntry` | `create.ts:901-925` | `direction='IN'`، `cashBucket='DRAWER'` للنقد وإلا `NULL`، `status='COMPLETED'`. |
| ١١ | **ختم إيصالات المقبوض سلفاً** | `receipts` update (`invoiceId`) | `create.ts:927-932` | `UPDATE ... SET invoiceId WHERE id AND invoiceId IS NULL` (append-only، لا يمسّ إيصالاً مختوماً). |
| ١٢ | **ذمّة العميل (AR)** | `adjustCustomerBalance(customerId, total − paidNow)` | `create.ts:933-935` → `ledgerService.ts:111-117` | `currentBalance += delta` ذرّياً (SQL نسبيّ). العميل موجب = «لنا عليه». |

**آثار غير مباشرة مشتقّة من الدفتر (لا كتابة مستقلّة):**
- **وعاء العمولة**: يُشتقّ حيّاً بـ`INNER JOIN accountingEntries → invoices` على قيود `SALE`/`RETURN` (`commissions/base.ts:43-72`). لا يوجد صفّ عمولة يُكتب عند البيع؛ **العمولة = دالّة في قيود الدفتر**. ⚠️ تعليق صريح (`base.ts:17-18`): «لا يوجد مسار CANCELLED للفواتير... إن أُضيف إلغاءٌ يوماً **فيجب أن يقيّد عكساً دفترياً** وإلا انكسر هذا الاشتقاق». **هذا قيدٌ حاكمٌ للتصميم**: أيّ تصحيح لا بدّ أن يعكس/يعيد قيد الدفتر — لا يكفي تغيير `invoices.status`.
- **حدّ الفترة (Period Lock)**: كل `postEntry` يستدعي `assertPeriodOpen(tx, entryDate)` قبل الإدراج (`ledgerService.ts:83-85`)؛ يرفض `FORBIDDEN` أي قيد `entryDay(UTC) ≤ cutoffDate` لأحدث قفل `LOCKED` (`periodLockService.ts:46-58`).
- **الوردية**: البيع النقديّ يتطلّب وردية `OPEN` تخصّ الفرع تحت قفل `FOR UPDATE`، ويُرفض على وردية **مغلقة** (`create.ts:163-188`). الإقفال «حدّ محاسبيّ غير قابل للكتابة بأثر رجعيّ» (`create.ts:174-179`).

---

## ٢. كيف يعكس `returnService` كلّ ذلك باتّساق (القالب المرجعيّ)

`returnSale` (`server/services/returnService.ts:31`) هو أقرب سابقة موجودة لعكسٍ متّسق. مبدؤه الجوهريّ: **لا يُحرِّر قيد SALE ولا صفوف الفاتورة الأصلية — بل يُلحِق قيوداً عكسية ويحدّث عدّادات تراكمية**. هذا هو النمط الذي يجب أن يرثه التصحيح.

الضمانات المرجعية (بالترتيب):

1. **Idempotency**: `findIdempotentRefId('sale.return', clientRequestId)` + بصمة الأسطر/القيمة، ثم `recordIdempotencyKey` بعد النجاح (`returnService.ts:36-99, 649-651`).
2. **قفل الفاتورة** `FOR UPDATE` (`returnService.ts:101`) + **رفض** الملغاة/المرتجعة بالكامل (`returnService.ts:104-106`) + **عزل الفرع** (`returnService.ts:109-111`).
3. **WORKORDER ⇒ `restock=false`** حتماً (`returnService.ts:114`) — الأمر يبيع متغيّراً أساس لم يُضَف للمخزون فعلاً (المواد استُهلكت عند البدء).
4. **حظر البطاقات الرقمية** من المرتجع العام (`returnService.ts:137-152`).
5. **توزيع نسبيّ** للإيراد/الضريبة على أساس `item.total × (baseQuantity المُرجَع / baseQuantity الأصلي)` (`returnService.ts:168-174, 221-224`)؛ والمرتجع الكامل يعكس أجرة الشحن أيضاً كي يبقى `Σ(revenue)=Σ(profit)=0` (`returnService.ts:311-320`).
6. **تحديث عدّادات البند** `returnedBaseQuantity` / `returnedRestockedBaseQuantity` (`returnService.ts:253-263`) — تراكميّ، لا حذف.
7. **إعادة المخزون** عبر `applyMovement(movementType='RETURN', referenceType='RETURN')` بترتيب `variantId` تصاعديّ (`returnService.ts:267-286`) — **فقط** إن `restock`.
8. **قيد RETURN سالب** (`returnService.ts:340-352`): `revenue=−`, `cost=−(معكوسة فقط إن restock)`, `profit=−`, `taxAmount=−`, `amount=−`. عكس التكلفة مشروطٌ بعودة البضاعة للرفّ (`returnService.ts:327-332`) — التالف يبقى مصروفاً.
9. **عكس GIFT_OUT** سالب (`returnService.ts:357-371`) و**عكس استحقاق الأمانة** (`returnService.ts:377-414`) و**عكس تقريب النقد** عند المرتجع الكامل (`returnService.ts:419-432`).
10. **الاسترداد النقديّ** (اختياريّ): إيصال `OUT` + قيد `PAYMENT_OUT` بسقفٍ = `min(قيمة المرتجع, المقبوض فعلاً بهذه الطريقة)` وحدّ الدرج (`returnService.ts:435-572`).
11. **تحديث الرأس**: `paidAmount, returnedTotal (تراكميّ), status` (`returnService.ts:586-593`) عبر `computeInvoiceStatus(total, paid, returnedTotal)` (`ledgerService.ts:165-179`).
12. **ذمّة العميل**: `adjustCustomerBalance(returnedTotal − cashRefund, negated)` (`returnService.ts:596-598`) — الجزء غير المُسترَدّ نقداً يُسقَط من رصيد العميل.
13. **إعفاء عهدة المندوب** (COD) عند وجود إرسالية (`returnService.ts:606-646`).

**الخلاصة القالبية:** الاتّساق يتحقّق بـ**قيدٍ عكسيّ مُلحَق + عدّادات تراكمية + عكس مخزون مشروط + تعديل AR + سقف استرداد** — لا بتحرير القيد الأصليّ. التصحيح يبني فوق هذا حرفياً.

**الحالة القائمة اليوم لـ`sales.correct`** (`saleRouter.ts:452-627`، `salesManagerProcedure`): **محدودةٌ جداً** — تُعدّل حصراً:
- `notes` (`saleRouter.ts:531-534`)،
- `dueDate` (`saleRouter.ts:535-540, 600-602`)،
- **طريقة الدفع** لسندات القبض المرتبطة (`receiptMethods`) — تُحدَّث في `receipts.paymentMethod/cashBucket/shiftId` (`saleRouter.ts:560-589`) + عرض `invoices.paymentMethod` (`saleRouter.ts:593-605`).

**لا تمسّ**: البنود، الكميات، الأسعار، الخصومات، العميل، المبالغ، قيود الدفتر، أو المخزون. وتكتب أثراً تدقيقياً `sale.invoiceCorrect` عبر `logAuditTx` (`saleRouter.ts:617-623`)، ويُعرَض في `correctionHistory` (`saleRouter.ts:630-654`). أي أنّ التصحيح الحقيقيّ (بنود/مبالغ) **غير موجود اليوم** — هذا ما تصمّمه هذه الوثيقة.

---

## ٣. نموذج التصحيح المقترح

### ٣.١ الخياران المطروحان

**الخيار (أ): تعديلٌ في المكان بقيود دلتا (in-place delta).** إبقاء صفّ الفاتورة نفسه، وإلحاق قيود دلتا للدفتر + حركات مخزون دلتا + تعديل الأعمدة (`subtotal/total/costTotal/...`).
- ❌ **يصطدم بحارس `dedupeKey='SALE:${invoiceId}'`** (`create.ts:826`, `schema.ts:2197`): لا يمكن إدراج قيد SALE ثانٍ لنفس الفاتورة، فالدلتا يجب أن تكون قيد RETURN/SALE مصطنعاً بدلالة ملتوية.
- ❌ **يحرّر صفوف `invoiceItems`/الرأس في المكان** ⇒ يضيع «قبل/بعد» ما لم يُلقَط يدوياً، ويخالف روح النظام append-only (تعليق `base.ts:17-18` + سياسة «الحذف الإلحاقيّ» في تدقيق ٢٧/٧).
- ❌ منطق الدلتا (تكلفة، ضريبة، تقريب، ائتمان، أمانة، بكج) يجب أن يُعاد اشتقاقه يدوياً — تكرارٌ هشٌّ لمنطق `createSaleInTx` كامل.

**الخيار (ب) — الموصى به: عكسٌ كامل للأصل + إعادة ترحيلٍ كفاتورةٍ مصحّحة جديدة، ذرّياً في `withTx` واحدة.**
التصحيح = **(١) عكسٌ داخليّ كامل للفاتورة الأصلية** (بنمط المرتجع الكامل، لكن **بلا استرداد نقديّ** — تُنقَل المدفوعات المستلمة إلى الفاتورة الجديدة) **+ (٢) `createSaleInTx` للبنود المصحّحة** مع `preCollected` = المدفوعات المُعاد توطينها. الأصل يصير `SUPERSEDED`/`CANCELLED` مربوطاً بالجديدة، والجديدة هي مصدر الحقيقة.

### ٣.٢ لماذا الخيار (ب)

- يعيد استعمال **آليّة العكس المُختبَرة** (قيد RETURN سالب + عكس COGS/GIFT/أمانة/تقريب + إعادة مخزون + AR) و**آليّة الترحيل المُختبَرة** (`createSaleInTx` بكل حرّاسه: تسعير، تحت-التكلفة، ائتمان، أمانة، بكج، تقريب) — **صفر منطق ماليّ جديد**.
- **الدفتر يبقى متوازناً تلقائياً**: قيد SALE الأصليّ يبقى (مقفول الفترة إن كان)، يُلحَق قيد عكسٍ بتاريخ اليوم، ثم قيد SALE جديد للمصحّحة. مجموع `revenue`/`profit` عبر الثلاثة = قيمة الفاتورة المصحّحة الصحيحة، والعمولة تتعافى ذاتياً لأنّها تُشتقّ من قيود SALE/RETURN (`base.ts:43-72`).
- **العميل والمخزون** يتصحّحان دلتاً صافيةً (عكس الأصل ثم خصم المصحّح) دون منطقٍ خاص.
- **الأثر التدقيقيّ «قبل/بعد» طبيعيّ**: الأصل (بكل بنوده) محفوظٌ كما هو، والجديدة سجلٌّ مستقلّ، والرابط بينهما + السبب في `auditLogs`.

### ٣.٣ التدفّق التنفيذيّ المقترح (`correctSaleInTx` — خدمة جديدة، `withTx` واحدة)

```
correctSale(input, actor):
  withTx(tx =>
    0. idempotency: checkIdempotency('sale.correct', input.clientRequestId, hash(input))
       ⇒ replay ⇒ أعِد نتيجة التصحيح الأول.
    1. اقفل الأصل FOR UPDATE. تحقّق الأهليّة (§٥): ليست CANCELLED/RETURNED/SUPERSEDED،
       returnedTotal == 0، sourceType != 'WORKORDER'، ليست DIGITAL_CARD، عزل الفرع.
    2. اقرأ بنود الأصل + إيصالاته (receipts) — لقطة «قبل».
    3. ── العكس الكامل للأصل (بلا استرداد نقديّ) ──
       - لكل بند: applyMovement(RETURN) لإعادة المخزون (احترام restock=false لغير القابل).
       - postEntry(RETURN سالب) = عكس كامل الإيراد/التكلفة/الضريبة/التقريب (مرآة returnService).
       - عكس GIFT_OUT / استحقاق الأمانة إن وُجدت.
       - AR: adjustCustomerBalance بعكس مستحقّ الأصل غير المدفوع (صفّر ذمّة الأصل).
       - وسم الأصل: status=SUPERSEDED, returnedTotal=total (اختياريّ)، correctedByInvoiceId=<لاحقاً>,
         cancelledBy/cancelledAt (schema:1354-1361 موجودة).
    4. ── إعادة توطين المدفوعات ──
       - أعِد ختم إيصالات الأصل على الفاتورة الجديدة: UPDATE receipts SET invoiceId=<الجديدة>
         WHERE invoiceId=<الأصل> AND direction='IN' AND status='COMPLETED'
         (append-only للمبلغ نفسه — المال وصل فعلاً، يُطبَّق الآن على المصحّحة).
       - preCollectedTotal = Σ(IN) − Σ(OUT) لتلك الإيصالات.
    5. ── إنشاء الفاتورة المصحّحة ──
       createSaleInTx(tx, {
         ...البنود/الرأس المصحّحة من input,
         sourceType = الأصل.sourceType (POS/ORDER),
         shiftId = وردية اليوم المفتوحة للفرع (لا وردية الأصل المغلقة),
         preCollected = { amount: preCollectedTotal, receiptIds: [إيصالات الأصل] },
         payment = null (لا مال جديد يُقبض هنا؛ الفرق ذمّة/رصيد),
         clientRequestId = `${input.clientRequestId}-corrected`,
         priceOverrideApproved = input.priceOverrideApproved,
       }, actor)
       ⇒ يعيد الحساب: total المصحّح، due = total − preCollected.
    6. ── تسوية الفرق ──
       - total المصحّح > preCollected ⇒ due موجب: يتطلّب عميلاً (بيع آجل) + فحص ائتمان
         (createSaleInTx يفرضه تلقائياً، create.ts:567-598). بلا عميل ⇒ يُرفض إلا بقبض الفرق الآن.
       - total المصحّح < preCollected ⇒ overpay: (قرار المالك §٨) إمّا رصيد دائن للعميل
         (currentBalance سالب) أو استرداد نقديّ للفرق بسقف نمط returnService (input.refund).
    7. اربط: الأصل.correctedByInvoiceId = الجديدة.id، الجديدة.correctionOfInvoiceId = الأصل.id.
    8. logAuditTx(action='sale.invoiceCorrection', entityId=الأصل.id,
         oldValue=لقطة الأصل الكاملة, newValue={ reason, correctedInvoiceId, لقطة الجديدة }).
    9. recordIdempotencyKey('sale.correct', input.clientRequestId, الجديدة.id, hash).
  )
```

**ملاحظات ضمانيّة:**
- **الذرّية**: كلّ ما سبق في `withTx` واحدة — فشل أيّ خطوة ⇒ ROLLBACK كامل (لا فاتورة معلّقة، لا مخزون منحرف).
- **الفترة المقفلة**: قيود العكس والجديد **بتاريخ اليوم** (`postEntry` الافتراضي، `ledgerService.ts:84`) ⇒ تخضع لـ`assertPeriodOpen`. لو اليوم مقفل ⇒ يُرفض تلقائياً (كما المرتجع). تصحيح فاتورةٍ من شهرٍ مقفول = عكسٌ في الشهر الجاري (لا مسّ للكتب المقفلة) — نفس دلالة `returnService`. **قرار المالك §٨** يحسم إن كان هذا مقبولاً أم يُمنع التصحيح عبر الفترات.
- **ترتيب الأقفال**: قفل الأصل `FOR UPDATE` أولاً، ثم `createSaleInTx` يقفل الوردية/العميل/صفوف المخزون بترتيبها الحتميّ (`variantId` تصاعديّ) — لا تعارض جديد.
- **حارس `dedupeKey`**: الفاتورة الجديدة لها `invoiceId` جديد ⇒ `SALE:${newId}`/`GIFT:INV:${newId}`/`CONSIG:${newId}:*` فريدة، بلا اصطدام مع الأصل.

---

## ٤. مصفوفة الحقول القابلة للتصحيح

بما أنّ الخيار (ب) يُعيد تشغيل `createSaleInTx` بالكامل، **كلّ حقلٍ يقبله مسار البيع يصير قابلاً للتصحيح** — بشرط اجتيازه حرّاس الإنشاء نفسها من جديد.

| الحقل | قابل للتصحيح؟ | التبرير / الحارس |
|------|:---:|------|
| بنود الأسطر (إضافة/حذف/تبديل متغيّر) | ✅ | يُعاد بناء البنود في الجديدة؛ المخزون يتصحّح دلتاً (عكس OUT ثم OUT مصحّح). |
| الكمية | ✅ | `convertToBaseQuantity` + `applyMovement` يُعيدان الفحص؛ زيادةٌ تفوق الرصيد تُرفض (`inventoryService.ts:145-149`). |
| سعر الوحدة (`unitPriceOverride`) | ✅ | تحت حارس أقل-من-التكلفة (`create.ts:495-505`) — فوقها يلزم `priceOverrideApproved`. |
| الخصم (سطر/فاتورة) | ✅ | تحت حارس الخصم اليدويّ فوق العتبة (`create.ts:499-505`, `MANUAL_DISCOUNT_APPROVAL_THRESHOLD`). |
| أجرة الشحن / التوصيل المجّاني | ✅ | `deliveryFee/deliveryFree/deliveryWaivedAmount` — الحرّاس في `create.ts:472-487`. |
| نسبة الضريبة | ✅ | لقطة على الجديدة (`create.ts:618`). افتراض العراق 0%. |
| فئة السعر (`priceTier`) | ✅ | `resolveTier` (`create.ts:198`). |
| الملاحظات / تاريخ الاستحقاق | ✅ | حرّان (اليوم يدعمهما `sales.correct` أصلاً). |
| العميل | ⚠️ مشروط | يُعاد فحص حدّ الائتمان (`create.ts:570-598`)، وتُنقَل AR للعميل الجديد (تصفير القديم). **قرار مالك §٨**: هل يُسمح بتغيير العميل بعد البيع؟ (تحوّل نقديّ→آجل يفتح ذمّة جديدة.) |
| هدايا داخل الفاتورة (`isGift`) | ✅ | تحت عتبة اعتماد الهدايا (`create.ts:511-517`). |
| **رقم الفاتورة (`invoiceNumber`)** | ❌ مُجمَّد | هويّة المستند؛ الجديدة تأخذ رقماً جديداً (`nextInvoiceNumber`, `create.ts:601`) والأصل يُحفظ. |
| **الفرع (`branchId`)** | ❌ مُجمَّد | الفرع يربط الوردية/الدرج/النقد؛ نقلٌ بين فروع = تحريك نقدٍ بين أدراج. التصحيح داخل الفرع فقط (عزل الفرع، `returnService.ts:109-111`). |
| **وردية الأصل (`shiftId`) إن أُغلقت** | ❌ مُجمَّد | الكتابة بأثر رجعيّ على وردية مغلقة محظورة (`create.ts:173-179`). قيود التصحيح تسقط على **وردية اليوم المفتوحة**، لا وردية الأصل. |
| **قيد SALE الأصليّ** | ❌ لا يُحرَّر أبداً | append-only — يُعكَس بقيد RETURN لا يُعدَّل (تعليق `base.ts:17-18`). |
| **إيصالات القبض المستلمة** | ❌ لا تُحذف | المال وصل فعلاً — يُعاد **توطينه** على الجديدة، لا محوه (سلامة مسار المال). |
| منشأ الأوفلاين (`originatedOffline`, `offlineReceiptNumber`) | ❌ مُجمَّد | لقطة تاريخية للأصل؛ الجديدة فاتورة تصحيحٍ عاديّة أونلاين (يُشار للرقم المؤقّت في التدقيق). |
| `sourceType='WORKORDER'` | ❌ يُرفض التصحيح كلّياً | راجع §٥. |

---

## ٥. الحالات الحدّية ومعالجتها

| الحالة | القرار المقترح | التبرير / الدليل |
|------|------|------|
| **مدفوعة كاملاً / جزئياً** | مسموح. الإيصالات تُعاد توطينها على الجديدة، ويُعاد حساب المستحقّ (`due = totalمصحّح − preCollected`). فرقٌ موجب ⇒ ذمّة (يلزم عميل + فحص ائتمان)؛ فرقٌ سالب ⇒ رصيد دائن أو استرداد. | يحافظ على «المدفوعات تبقى» ويعيد حساب المستحقّ (متطلّب التصميم). |
| **مُرتجَعة جزئياً / كلياً** (`returnedTotal>0` أو `status=RETURNED`) | **يُرفض في v1** — عالِج عبر المرتجعات. | العكس فوق مرتجعٍ جزئيّ يضاعف تعقيد التوزيع النسبيّ؛ مرآة حارس `returnService.ts:104-106`. توسيعٌ لاحق ممكن (التصحيح على الصافي المتبقّي) — قرار مالك §٨. |
| **بأصناف بتكلفة (COGS / stock-tracked)** | مسموح. العكس يعيد المخزون (`applyMovement RETURN`)، والجديدة تخصمه (`OUT`) ⇒ الأثر الصافي = الدلتا. زيادةٌ تفوق الرصيد تُرفض من `createSaleInTx` (إلا نافذة الافتتاح/الأوفلاين). | يورث ضمانات `applyMovement` تحت القفل (`inventoryService.ts:145-176`). |
| **نشأت أوفلاين (`originatedOffline=true`)** | مسموح، لكن **الجديدة أونلاين عاديّة** (لا تُنسَخ أعلام الأوفلاين)؛ يُحفظ `offlineReceiptNumber` الأصليّ في التدقيق. | التصحيح فعلٌ مديريّ أونلاين؛ لا معنى لوسم الالتقاط (`create.ts:639-643`). قرار مالك §٨ على السلوك المرغوب. |
| **من تسليم أمر شغل (`sourceType='WORKORDER'`)** | **يُرفض التصحيح كلّياً في v1** — صحّح عبر تدفّق أمر الشغل. | المتغيّر الأساس «لم يُضَف للمخزون فعلاً» (المواد استُهلكت عند البدء) ⇒ `returnService` يفرض `restock=false` له (`returnService.ts:114`)، وإعادة الخصم عبر `createSaleInTx` تخلق خصماً مزدوجاً خاطئاً. كما أنّ العمولة تُسنَد لمنشئ الأمر لا للفاتورة (`base.ts:45`). |
| **ملغاة (`status=CANCELLED`) / بطاقة رقمية** | يُرفض. | لا شيء لتصحيحه؛ البطاقات لها مسار `digitalCards.reversal` حصراً (`returnService.ts:137-152`). |
| **عليها إرسالية توصيل (COD) قيد التنفيذ** | **يُرفض في v1** (أو يستلزم إلغاء الإرسالية أولاً). | العكس يحرّك عهدة المندوب (`returnService.ts:606-646`)؛ تصحيحٌ متزامنٌ مع إرساليةٍ حيّة يعقّد العهدة. قرار مالك §٨. |
| **الفترة المالية مقفلة (الأصل في شهرٍ مغلق)** | العكس + الجديد بتاريخ اليوم ⇒ يمرّان إن كان اليوم مفتوحاً. الكتب المقفلة لا تُمسّ. | `assertPeriodOpen` على القيود الجديدة فقط (`periodLockService.ts:46-58`). قرار مالك §٨: أهذا مقبول أم يُمنع التصحيح عبر الفترات؟ |
| **بها هدايا / أصناف أمانة** | مسموح — العكس يعالج `GIFT_OUT` والأمانة، والجديدة تعيد التقاطهما. | مرآة `returnService.ts:357-414` + `create.ts:842-879`. |

---

## ٦. بوّابات الصلاحية وفصل المهام (SOD)

- **من يُصحّح**: `salesManagerProcedure` — أي **مدير** (والأدمن يتجاوز عبر `moduleAccessAllowed`, `trpc.ts:162, 182-195`) — مطابقةً للمرتجعات (`returnRouter.ts:10, 21`) وللـ`sales.correct` الحاليّ (`saleRouter.ts:452`). الكاشير محجوب.
- **عزل الفرع**: مدير فرعٍ لا يصحّح فاتورة فرعٍ آخر (مرآة `returnService.ts:109-111`).
- **حرّاس مالية مُعادة الفرض**: البنود المصحّحة تمرّ ببوّابتي «تحت التكلفة» و«الخصم اليدويّ» في `createSaleInTx` (`create.ts:495-517`) ⇒ تصحيحٌ يهبط بالسعر تحت التكلفة يتطلّب `priceOverrideApproved` (تفويض مدير) تلقائياً.
- **SOD للتصحيحات عالية القيمة (موصى به)**: لتصحيحٍ يتجاوز صافي الدلتا فيه عتبةً معيّنة، أو يدفع الفاتورة تحت التكلفة، أو يقلب نقديّاً→آجلاً بمبلغٍ كبير — يُشترط **مُعتمِدٌ ثانٍ (مُنشئ ≠ مُعتمِد)** على نمط تسوية نهاية الخدمة/تسوية المخزون (سند `PENDING_APPROVAL`، ذاكرة `systemic-risks-campaign-2026-07-18`). المسار المقترح: التصحيح يُنشأ **معلّقاً** ويُطبَّق عند اعتماد مديرٍ آخر. **قرار مالك §٨** على العتبة وإلزاميّة الخطوة.

---

## ٧. ملاحظة الواجهة + شكل مدخل tRPC

**الواجهة**: تُعيد استعمال محرّر إنشاء البيع المألوف (نفس شبكة تحرير الأسطر في POS/الفاتورة الجديدة)، مملوءاً مسبقاً ببنود الفاتورة الأصلية، لكنّها عند الإرسال تستدعي **`sales.correctFull`** (إجراء جديد) بدل `sales.create`. تُعرَض بجانبها لوحة «قبل/بعد» (فرق البنود والمبالغ) + حقل «سبب التصحيح» إلزاميّ. زر الدخول من `InvoiceDetail.tsx` (حيث يعيش `sales.correct` الحاليّ).

**شكل المدخل المقترح** (`salesManagerProcedure`):

```ts
sales.correctFull: salesManagerProcedure.input(z.object({
  invoiceId: z.number().int().positive(),
  clientRequestId: z.string().uuid(),           // idempotency (مفتاح ثابت لكل فتح نموذج)
  reason: z.string().trim().min(3).max(500),    // إلزاميّ — يدخل auditLog
  // السلّة المصحّحة — نفس شكل أسطر sales.create (SaleLineInput):
  lines: z.array(saleLineSchema).min(1),        // variantId, productUnitId, quantity,
                                                //   unitPriceOverride?, discountPercent?/discountAmount?,
                                                //   isGift?, promotionId?
  invoiceDiscount: money.optional(),
  taxRatePercent: money.optional(),
  deliveryFee: money.optional(),
  deliveryFree: z.boolean().optional(),
  deliveryWaivedAmount: money.optional(),
  customerId: z.number().int().positive().nullable().optional(),
  priceTier: priceTierEnum.optional(),
  dueDate: ymd.nullable().optional(),
  notes: z.string().max(5000).optional(),
  priceOverrideApproved: z.boolean().optional(), // تفويض المدير للبنود تحت التكلفة/الخصم اليدويّ
  refund: z.object({ amount: money, method, shiftId: z.number().optional() })
            .nullable().optional(),              // عند total مصحّح < المقبوض ونريد ردّ الفرق
  approvedBy: z.number().int().positive().optional(), // مُعتمِد SOD الثاني (إن فُعّلت العتبة)
}))
```

النتيجة: `{ originalInvoiceId, correctedInvoiceId, correctedInvoiceNumber, newTotal, dueChange }`.

---

## ٨. أسئلة يجب أن يحسمها المالك

1. **الفرق الزائد (overpay)**: عند `total` المصحّح **أقلّ** من المقبوض — رصيد دائن للعميل (`currentBalance` سالب) أم **استرداد نقديّ** للفرق (بسقف نمط `returnService`)؟
2. **تصحيح عبر فترة مقفلة**: أنقبل عكساً بتاريخ اليوم لفاتورةٍ من شهرٍ مغلق (الكتب المقفلة لا تُمسّ — سلوك المرتجع الحاليّ)، أم **نمنع** تصحيح أيّ فاتورةٍ فترتها مقفلة؟
3. **الفاتورة المُرتجَعة جزئياً**: تبقى مرفوضة في v1، أم نطوّر تصحيحاً يعمل على الصافي المتبقّي؟
4. **تغيير العميل** بعد البيع: مسموح (مع فحص ائتمان + نقل AR) أم مُجمَّد (يُلغى ويُعاد كفاتورةٍ جديدة يدوياً)؟
5. **SOD للتصحيحات عالية القيمة**: ما العتبة (بالدينار / بنسبة الدلتا)؟ وهل تُلزَم خطوة اعتمادٍ ثانٍ (مُنشئ ≠ مُعتمِد) فوقها؟
6. **حالة المستند الأصليّ**: نضيف قيمة enum جديدة `SUPERSEDED` لتمييز «مُصحَّح» عن «ملغى»، أم نعيد استعمال `CANCELLED` مع الرابط `correctedByInvoiceId` فقط؟ (العمولة تُشتقّ من الدفتر لا من الحالة، فالخياران آمنان محاسبياً — الفرق عرضيّ/تقاريريّ.)
7. **فواتير أمر الشغل والتوصيل النشط**: تبقى مرفوضة في v1 (تُصحَّح من تدفّقها)، أم يُطلب دعمها لاحقاً؟
8. **رقم الفاتورة**: هل تكفي فاتورةٌ جديدةٌ برقمٍ جديد مربوطةٍ بالأصل (الموصى به)، أم يُصرّ المالك على «نفس الرقم» (يستلزم نموذج الدلتا في المكان، بكلفة الاتّساق المذكورة §٣.١)؟
9. **حدّ زمنيّ**: أنسمح بتصحيح فاتورةٍ قديمةٍ بلا حدّ، أم نقصره على نافذةٍ (مثلاً نفس اليوم/الأسبوع) بعدها يلزم قيدٌ يدويّ؟

---

## ٩. ملخّص القرار المعماريّ

- **النموذج**: عكسٌ كامل للأصل (بنمط المرتجع، بلا استرداد) + إعادة ترحيلٍ عبر `createSaleInTx` كفاتورةٍ مصحّحة جديدة، **ذرّياً في `withTx` واحدة**، مربوطةً بالأصل عبر `correctionOfInvoiceId`/`correctedByInvoiceId` (هجرة جديدة).
- **لماذا**: يورث كلّ ضمانات الاتّساق المُختبَرة (قيود عكسية append-only، عكس COGS/AR/أمانة/تقريب، حرّاس التسعير/الائتمان/المخزون) بصفر منطقٍ ماليّ جديد، ويعطي «قبل/بعد» تدقيقياً طبيعياً، وتتعافى العمولة ذاتياً لأنّها مشتقّةٌ من الدفتر.
- **الحدود الصلبة**: لا تحرير لقيد SALE، لا حذف إيصالات، لا كتابة على وردية/فترة مقفلة، رفض WORKORDER/RETURNED/CANCELLED/DIGITAL في v1، مدير-فأعلى + عزل فرع، وتفويض/SOD للحالات عالية القيمة.

---

## ١٠. قرارات المالك المحسومة (١٠/٨) — مواصفةٌ مقفولة

1. **الفرق الزائد (الإجمالي المصحّح < المدفوع) = هجين بخيار الموظّف:** إمّا **رصيد دائن للعميل** (يلزمه عميلٌ مسجّل) أو **استرداد نقديّ من الدرج** (يلزمه وردية/درجٌ مفتوح). للعميل النقديّ (بلا سجلّ) يبقى الاسترداد النقديّ الخيار الوحيد. ⇒ حقلٌ في العقد `overpayHandling: "CREDIT" | "CASH_REFUND"` مع حرّاسه.
2. **الاعتماد = مديريّ فقط** (مرآة `returnService` — `managerProcedure` + عزل فرع). **بلا اعتماد ثانٍ في v1** (لا SOD إجباريّ).
3. **الفترة المقفلة = عكسٌ في الشهر الجاري** كالمرتجع: الكتب المقفلة لا تُمسّ، والعكس/الجديد بتاريخ اليوم يخضعان لـ`assertPeriodOpen`. (لا «منع كليّ».)
4. **الترقيم = رقمٌ جديد مربوط:** الفاتورة المصحّحة تأخذ رقماً جديداً؛ الأصل يصير `SUPERSEDED` مع `correctedByInvoiceId`، والجديدة تحمل `correctionOfInvoiceId`. (لا «نفس الرقم».)

**مؤجَّلٌ صريحاً لـv1 (مرفوض بأمان، يُعالَج بمساره):** الفاتورة المُرتجَعة (كلياً/جزئياً)، منشأ `WORKORDER`، التوصيل النشط، البطاقات الرقمية. بلا حدٍّ زمنيّ للتصحيح (أيّ فاتورةٍ مؤهَّلة).
