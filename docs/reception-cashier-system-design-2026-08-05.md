# منظومة كاشير خدمة الزبائن — التصميم الحاكم (النسخة النهائية)

**التاريخ:** ٥ أغسطس ٢٠٢٦ · **الحالة:** نهائية بعد جولة هجومٍ عدائيّ (٣٣ ملاحظة، ٦ حاصرات) وتحقّقٍ مباشرٍ من الكود.
**القاعدة:** كل ادّعاءٍ أدناه مُتحقَّقٌ منه بقراءة الملف مع رقم السطر. ما لم يُتحقَّق منه مُعلَّمٌ صراحةً `[يُفحص قبل التنفيذ]`.
**المرجع الحاكم:** هذه الوثيقة تَجُبّ كل مسوّدةٍ تصميميةٍ سابقة لهذه المحطة.

---

## ١. الغاية وطلب المالك

محطة **خدمة الزبائن** (`Reception`) أربع وظائف في شاشةٍ واحدة:

1. **إنشاء طلباتٍ تحتاج تخصيصاً** (دروع، لوحات مكتبية) — أمر شغل بتصميمٍ وموعدٍ ومنفّذ.
2. **بيعٌ مباشر** مثل كاشير التجزئة (ملازم، كتب، قرطاسية).
3. **توصيلٌ للبيت** بربطٍ كامل بوحدة التوصيل.
4. **تثبيت وتجهيز طلبات المتجر.**

شكوى المالك: الشاشة ناقصة **شكلاً ومضموناً**. مطالبه الحرفية:

- أن يرى الموظّف **الفواتير** كما يراها كاشير التجزئة، ويقوم عليها بالإجراءات، ويعدّل ويضيف بنوداً ويثبّت المبالغ.
- **عربونٌ** على بعض الطلبات (تخصيص وغير تخصيص) بالبطاقة أو التحويل أو **برصيد اتصالٍ** يرسله الزبون.
- **ربطٌ بينيّ صارم:** محطة التنفيذ ← الطلبات ← المالية والنقدية والوردية ← معلومات العميل ← المخرجات الطباعية.
- تحسين الشاشة الرئيسية: **إزالة** عناصر حاسبة الكمية والسعر، و**إضافة** عناصر ترفع الإنتاجية.
- «**بسيطٌ وواضحٌ للموظّف، قويٌّ ومتينٌ وآمنٌ وصارمٌ في الخلفية**».

---

## ٢. قرارات المالك المحسومة (لا تُناقَش — يُبنى عليها)

| # | القرار | الأثر التصميميّ |
|---|---|---|
| **م١** | طلب خدمة الزبائن يُفتَح **مسوّدة** قابلة للتعديل الحرّ (إضافة/حذف بند، تغيير سعر ومبلغ) **بلا أيّ قيد محاسبيّ ولا خصم مخزون**. لحظة «التثبيت» تصير فاتورة. بعد التثبيت **لا تعديل** — العكس بمرتجعٍ أو إلغاءٍ موثَّق. | §٤ قاعدة ١، §٥.١، §٧.٣ |
| **م٢** | **العربون** يُقبَض نقداً أو بطاقةً أو تحويلاً أو رصيد اتصال. **توقيت الاعتراف بالربح لا يتغيّر** — يبقى عند التسليم كما هو اليوم. | §٤ قاعدة ٢ |
| **م٣** | **رصيد الاتصال** طريقة دفعٍ مستقلّة بحسابٍ خاصّ يُسوّى دورياً، **بطاقات شركة زين حصراً**. **لا تدخل درج الوردية.** | §٥.٤، ش٥ |
| **م٤** | **الخصم اليدويّ** يبقى لكن **داخل صفّ السلّة**؛ تُحذف أزرار «الكمية» و«٪» من لوحة الأرقام فتصير **لوحة مبلغٍ خالصة**. | §٧.٢، §٧.٤ |
| **م٥** | **لا شرطَ عربونٍ** لدخول طلب التخصيص للتنفيذ — تقدير الموظّف، مع **تذكيرٍ لطيفٍ غير مانعٍ** عند عربونٍ صفريٍّ على سلّةٍ فيها تخصيص. *(حُسم ٥/٨ بعد إقرار الوثيقة)* | §٨.٦ |
| **م٦** | **سقف الخصم اليدويّ نسبةٌ محدّدة وفوقها موافقة مديرٍ فورية** — يطابق تصميم §٨.٤ حرفياً (رقائق حتى ١٠٪، وما فوقها حوار اعتماد المدير استباقياً). *(حُسم ٥/٨)* | §٨.٤ |
| **م٧** | **المرتجع يبقى مديرياً.** موظّف الخدمة يرى زرّ «طلب إرجاع» **يستدعي المدير** (حوارٌ يشرح ذلك)، ولا ينفّذ المرتجع بنفسه؛ ولمن يملك الصلاحية يفتح `/returns` مباشرةً. *(حُسم ٥/٨)* | §٨.٥، §٩.١ |
| **م٨** | مبدآن حاكمان لكل شاشةٍ جديدة: **مصطلحاتٌ بسيطةٌ مألوفةٌ** للموظّف («طلب»/«تثبيت»/«عربون»/«المتبقّي» — لا لغة محاسبية؛ ومسرد `terminology-canon` مُلزِم)، و**أقلّ جهدٍ ممكن** (الحالة الشائعة بأقلّ نقرات وافتراضاتٍ ذكية، والنادر يُطوى خلف «خيارات إضافية»). *(حُسم ٥/٨)* | §٨ كلّه |
| **م٣-ب** | آلية رصيد زين المحسومة: الزبون يرسل **أرقام كروت شحن زين (أكواد)**. `referenceNumber` = رقم الكارت (يمنع قيده الفريد إدخال الكارت مرّتين)، و`telecomSenderPhone` = رقم المُرسِل. *(حُسم ٥/٨)* | §٥.٤، §٩.٤، ش٥ |

---

## ٣. حقائق الكود المُتحقَّق منها (أساس كل قرارٍ أدناه)

### ٣.١ ما هو قائمٌ اليوم

| # | الحقيقة | الدليل |
|---|---|---|
| F1 | **لا `receptionRouter`.** الشاشة مخدومة من `workOrderRouter` + `deliveryRouter` + `shiftRouter` + `offlineRouter`. خدمة الالتزام الوحيدة `receptionCheckoutService.ts` (`withTx` واحدة). | قراءة الملف كاملاً |
| F2 | نقطة الالتزام `workOrders.receptionCheckout` تقبل `regularSale` + `printSale` + `workOrders[]` وتوزّع `paidAmount` **جشعاً**: البيع المباشر أولاً ثم أوامر الشغل بالترتيب. | `receptionCheckoutService.ts:88-126` |
| F3 | حارسٌ صارم: يرفض الالتزام إن كانت الوردية ليست `shiftType==='RECEPTION'`. | `receptionCheckoutService.ts:81-83` |
| F4 | **لا تعديل فاتورة إطلاقاً** خادمياً؛ ولا إلغاء (void) في كودٍ إنتاجيّ. `sales.correct` مديريّ ويمسّ الملاحظات/الاستحقاق/طريقة الدفع فقط. العكس الوحيد = مرتجع عبر `/returns` (مدير). | مسحٌ على `server/` |
| F5 | **العربون:** عمود `workOrders.deposit` + `woPaymentMethod` (CASH\|CARD\|TRANSFER\|WALLET). يُسجَّل إيصال IN + قيد `PAYMENT_IN` بملاحظة `[WO_DEPOSIT:id]`، و`cashBucket='DRAWER'` للنقد فقط. **لا `paidAmount` على أمر الشغل** — حقلٌ واحد يُكتب مرّة ولا يُحدَّث. | `workOrder/create.ts:126-160` |
| F6 | الإيراد `SALE` لا يُكتب إلا عند التسليم أو الإرسال. | `workOrder/deliver.ts:108-118`, `delivery/dispatch.ts:153-166` |
| F7 | `receipts.paymentMethod` = CASH\|CARD\|CHECK\|TRANSFER\|WALLET\|EXCHANGE. الاستقبال يقبل أربعاً. **طريقة دفعٍ واحدة للسلة كلها — لا دفع مقسَّم.** | `drizzle/schema.ts:1891-1898`, `receptionCheckoutService.ts:22` |
| F8 | **لا وحدة حساب بنكيّ.** «حساب البطاقة» رصيدٌ **مُشتقّ** بالتجميع من `receipts` (CARD + APPROVED)، وجدوله الوحيد `cardReconciliations` — و**لا قيد UNIQUE عليه**، فهرسان فقط. | `cardAccountService.ts:59`, `schema.ts:2022-2048` |
| F9 | `expected = openingBalance + Σ(IN CASH) − Σ(OUT CASH)` حيث `shiftId` و`cashBucket='DRAWER'`. و`enforceCashGovernance:true` يُمرَّر **دائماً** ⇒ أيّ فرقٍ مهما صغُر يمنع الإغلاق. | `shiftService.ts:174-190`, `271-279` |
| F10 | `shiftIdForCashTx`: admin/manager ⇒ وردية إن وُجدت وإلا `TREASURY`؛ غيرهم ⇒ وردية إلزامية + `DRAWER`. | `shiftService.ts:590-607` |
| F11 | `delivery.receptionQueue` مصدره **invoices** لا workOrders، بـ`innerJoin(shifts)` واشتراط `shiftType='RECEPTION'`، وهو على `workordersCashierProcedure`. | `deliveryRouter.ts:176-199` |
| F12 | أجرة التوصيل **تمريرٌ لا إيراد** (`deliveryFeeCollection` = COURIER\|COUNTER\|SHOP + قيد `DELIVERY_FEE_HELD`). | `dispatchInvoice.ts:132-160`, `remittance.ts:210-222` |
| F13 | `Reception.tsx` (٢٤٧٠ سطراً): لوحة أرقام ثلاثية الأوضاع QTY/DISC/PAY. **`payInput` بلا أيّ حقل إدخالٍ نصّيّ** — مصادره `numPress`/`setQuickAmt`/`payAll` فقط. | `Reception.tsx:696-735, 2216-2240` |
| F14 | أوامر الشغل **لا تُلتقَط أوفلاين** (حدٌّ معلن). أمّا **السلّة نفسها فمحلّيةٌ بالكامل** ولها مسار التقاطٍ حيّ. | `offline/replayReception.ts:45-53`, `Reception.tsx:249, 531, 909, 1202-1281` |
| F15 | `receipts.reservationId` + `reservations.depositReceiptId` موجودان في المخطّط **بلا أيّ كاتب**. | مسحٌ على `server/` |

### ٣.٢ ما كشفه التحقّق في هذه الجولة (يُغيّر القرارات)

| # | الحقيقة | الدليل | الأثر |
|---|---|---|---|
| **V1** | `createSaleInTx` **يقبل** `cashRoundIQD` ويحسب `cashRoundingAdj` — الاستقبال لا يمرّره فقط. لكن `roundCashIQD` تقريبٌ **لأقرب** فئة (نصف لأعلى)، فقد **يرفع** الإجمالي. | `sale/create.ts:466-486`, `money.ts:59-69` | تمريرُ العلم وحده **يكسر** كل سلّةٍ يُقرَّب إجماليها لأعلى ⇒ ش٠ يجب أن تُقرّب في الواجهة أيضاً |
| **V2** | **لا فهرس على `invoices.shiftId`** بينما تعليق `delivery/queries.ts` يقول «مفهرَس» — تعليقٌ كاذب. | فهارس `invoices` في `schema.ts` | فهرس `idx_invoice_shift` في ش٠ |
| **V3** | **تصادم حيّ:** إيصال العربون وإيصال أجرة COUNTER **كلاهما** `workOrderId` + `IN` + `invoiceId NULL`. و`deliver.ts:145`, `cancel.ts:44`, `delivery/dispatch.ts:167` يلتقطون بـ`.limit(1)` بلا تمييز؛ و`cancel` يردّ `depRcpt.amount` ⇒ **قد يُردّ مبلغ الأجرة بدل العربون**. | الثلاثة | ثلاثة مواقع في ش٠ لا موقعان |
| **V4** | `createWorkOrderInTx` يحلّ ورديته بنفسه (`openShiftIdTx`) متجاهلاً `input.shiftId` المُتحقَّق منه في `checkoutReception`. | `workOrder/create.ts:132` | سلّةٌ قابلةٌ للانشطار على درجين |
| **V5** | `reconcileService` يستثني العرابين بـ`receipts.workOrderId IS NOT NULL` حصراً. | `reconcileService.ts:77-104` | أيّ إيصال عربونٍ جديدٍ بلا `workOrderId` ⇒ انحراف مطابقةٍ = مبلغه |
| **V6** | `arAging.customerPaymentLink` يلتقط `invoiceId IS NULL AND partyType='CUSTOMER'` ⇒ عربونٌ معلَّق يظهر دفعةً في الكشف بينما `currentBalance` لم يتحرّك. | `reports/arAging.ts:154-159, 197, 282` | المُحدِّد يجب أن يُشارَك بين ثلاثة قرّاء |
| **V7** | `print_operator`: **`sales:"NONE"`** و`treasury:"NONE"` و`workorders:"FULL"`. صاحب `sales:"READ"` هو `reception_clerk`. | `permissions.ts:200-214, 318-329` | `print_operator` **لا يستطيع فتح وردية بنيوياً** ⇒ لا يقبض ولا يثبّت |
| **V8** | **`reception_clerk` يفشل على `sales.pay`**: `salesCashierProcedure` يشترط `sales:"FULL"` وقالبه `READ`. | `trpc.ts:295`, `saleRouter.ts:373`, `permissions.ts:327` | **حاصرة** — أوّل مطلبٍ للمالك يسقط للدور المسمّى باسمه |
| **V9** | `workordersReadProcedure` بوّابة خريطة بلا قائمة أدوار ⇒ تفتح لـ`warehouse`/`user`/`auditor` (كلّهم `workorders:"READ"`). | `trpc.ts:368`, `permissions.ts:175, 242, 257` | لا تُستعمل لطابور الفواتير |
| **V10** | `pnpm prod:deploy` **٨ خطوات بلا `db:migrate:extra` إطلاقاً**. وقيمة enum الحيّة الأخيرة (`DELIVERY_FEE_HELD`) موضوعة في **الهجرة المرقّمة 0150** ونسخةٍ مكرّرة في extras لـCI. | `scripts/deploy.mjs:18-33`, `0150_delivery_fee_passthrough.sql` | **حاصرة**: قيمة enum في extras وحدها **لا تصل الإنتاج أبداً** |
| **V11** | `closeShift` أوّل عبارةٍ فيه `SELECT … shifts … FOR UPDATE`. | `shiftService.ts:217` | ترتيب أقفالٍ معكوسٌ لأيّ حارس «امنع الإغلاق عند مسوّدةٍ مموّلة» |
| **V12** | `openShiftIdTx` عند وردية واحدة مفتوحة **يستعملها أيّاً كان نوعها**، و`shiftIdForCashTx` افتراضه `RETAIL`. | `shiftService.ts:450-462, 594-607` | عربونٌ نقديّ قد يهبط على درج التجزئة |
| **V13** | `MANUAL_DISCOUNT_APPROVAL_THRESHOLD = 0.15` والمقارنة `gt` ⇒ **١٥٪ بالضبط تمرّ بلا اعتماد**، وسطر التدقيق مشروطٌ بـ`res.priceOverride` ⇒ خصم ١٥٪ لا يترك أثراً. | `billing.ts:119-128`, `saleRouter.ts:343` | رقاقة «١٥٪» تُعلِّم الموظّف السقف |
| **V14** | `remittance.ts` يرفع `invoices.paidAmount` ويُنقص عهدة المندوب و**لا يستدعي `adjustCustomerBalance` إطلاقاً**، بينما المسار الموازي `courier.ts:191` يستدعيه. | `remittance.ts:190-205`, `courier.ts:191` | فاتورةٌ آجلة لعميلٍ مسجَّل تُسنَد للتوصيل ⇒ ذمّته لا تُخفَّض أبداً |
| **V15** | الكاتب الوارد الوحيد لأمانة أجرة التوصيل هو `workOrder/create.ts:174-193`. `dispatchInvoice` يكتب **OUT فقط**. | مسحٌ على `DELIVERY_FEE_HELD` | أجرة COUNTER على فاتورةٍ بلا أمر شغل ⇒ الوردية لا تُغلق |
| **V16** | `check-orphan-endpoints.mjs` يطابق **الاسم الورقيّ** كأيّ مقطعٍ في سلاسل `trpc.*` الواجهية، وخطّ الأساس مكتوبٌ فيه «لا تُوسِّعها». | `scripts/check-orphan-endpoints.mjs:36-77` | نقلُ نقطة نهايةٍ بلا حذف القديمة ⇒ CI أحمر |
| **V17** | `getProductUsage` قائمةٌ يدويّةٌ من ١٥ مصدر ارتباط. | `entityUsage.ts:186-250` | جدولٌ مرجعيٌّ جديد يحتاج مدخلاً صريحاً |
| **V18** | `compactHeader = max-height:900px` يُخفي شريط التسلسل أصلاً، وسُلّم الاحتواء عتباته 700/580/520px مقاسةً بـ`ResizeObserver`. | `Reception.tsx:337-357, 1589` | شريط الطلبات إضافةٌ صافية تُقتطع من لوحة الدفع |
| **V19** | `paymentBreakdown.ts:64` يعدّ خمس طرقٍ بمصفوفةٍ ثابتة، و`reportsFinancialService.ts:630, 659, 775` يعدّ `WALLET` صراحةً، و`client/src/lib/paymentMethod.ts:12` نوعٌ من خمس قيم. | الثلاثة | `TELECOM` بلا هذه المواضع **يسقط صامتاً** |

---

## ٤. النموذج المالي الحاكم (سبع قواعد لا تُكسَر)

1. **المسوّدة صفرٌ ماليّ بنيوياً.** لا صفّ في `invoices`، ولا `accountingEntries`، ولا `inventoryMovements`، ولا مسّ `customers.currentBalance` أو `branchStock`. ليست فلترةً يتذكّرها أحد: الكيان **لا يكتب** في الثلاثة أصلاً ⇒ يخرج تلقائياً من وعاء العمولة (`commissions/base.ts` بـINNER JOIN على `invoices`)، ومن الأعمار، ومن Z-report، ومن `getShiftReport`.
2. **العربون التزامٌ لا إيراد، وتوقيت الاعتراف لا يتغيّر** (م٢). `PAYMENT_IN` عند القبض (صفر إيراد/تكلفة/ربح)، و`SALE` يبقى حيث هو اليوم. **صفر `EntryType` جديد وصفر حسابٍ جديد في هذه الحملة.**
3. **سلّةٌ واحدة ⇒ درجٌ واحد.** كل نقد سلّةٍ واحدة يهبط على **وردية RECEPTION واحدة مُتحقَّقٍ منها**، بما في ذلك عرابين أوامر الشغل (V4 يكسر هذا اليوم).
4. **الدفعة تبقى على وردية قابضها.** عربونٌ قُبض في وردية أ وطلبٌ يُثبَّت في وردية ب: إيصال العربون **لا يُعاد إصداره** — يُربَط ويُخصَّص فقط، ويُكتب إيصالٌ جديد **بالفارق المقبوض الآن حصراً**.
5. **لا يُنشَأ إيصالٌ ثانٍ لمالٍ سبق قبضُه.** حدّ التثبيت يقبل `preCollected` صراحةً، ويُحتسَب **قبل** حرّاس الائتمان والبيع الآجل لا بعدها (§٧.٢).
6. **لا مخرج نقديٍّ حرّ من المحطة.** ردّ العربون = `reception.refundDeposit` بطريقة القبض **حتماً** ومربوطاً بإيصاله الأصليّ، أو سند صرفٍ عبر `createVoucher` (يرث Maker-Checker). أيّ خروجٍ نقديّ آخر مديريٌّ موثَّق (`workOrders.cancel` القائم).
7. **إجماليّ المستند النهائيّ ≥ مجموع ما قُبض عليه.** يُفحَص **قبل أيّ كتابة** في التثبيت وفي كل تحريرٍ بعد أوّل قبض. لا قصَّ صامتاً لمالٍ مُوصَل.

---

## ٥. نموذج البيانات والهجرات

### ٥.١ `receptionDrafts` — رأس المسوّدة (ش٢)

| العمود | النوع | ملاحظة |
|---|---|---|
| `id` | BIGINT PK | |
| `draftNumber` | VARCHAR(40) NOT NULL | `DRF-{فرع}-{YYYYMMDD}-{NNNNN}` — **مسلسلٌ مستقلّ لا يمسّ `nextInvoiceNumber`** |
| `branchId` | BIGINT NOT NULL FK | |
| `createdByShiftId` | BIGINT NULL FK shifts | **إعلاميّ فقط — المسوّدة لا تنتمي لوردية** |
| `status` | ENUM('OPEN','COMMITTED','CANCELLED','EXPIRED') | افتراضي OPEN |
| `version` | INT NOT NULL DEFAULT 0 | قفلٌ تفاؤليّ |
| `commitRequestId` | CHAR(36) NOT NULL | **يولّده الخادم** عند الإنشاء ويعيش مع الصفّ |
| `moneyLocked` | BOOLEAN NOT NULL DEFAULT 0 | يُرفع عند أوّل قبض، **لا يُخفَض أبداً** |
| `customerId` / `contactName` / `contactPhone` | | زبونٌ عابر إلزاميّ الدعم |
| `priceTier` / `channel` / `notes` / `dueDate` | | |
| `subtotal` / `discountTotal` / `total` | DECIMAL(15,2) | **ذاكرة عرضٍ فقط — يُعاد حسابها خادمياً في كل كتابةٍ وعند التثبيت** |
| `committedInvoiceId` / `committedPrintInvoiceId` | BIGINT NULL | الأولى UNIQUE |
| `expiresAt` / `committedAt` / `cancelledAt` / `cancelReason` | | |
| `createdBy` / `updatedBy` / `createdAt` / `updatedAt` | | |

قيود: `uq_draft_number` · `uq_draft_commit_request` · `uq_draft_committed_invoice`.
فهارس: `idx_draft_branch_status_id(branchId,status,id)` · `idx_draft_creator(createdBy,status)` · `idx_draft_phone(contactPhone)` · `idx_draft_customer(customerId)`.

### ٥.٢ `receptionDraftLines` (ش٢)

`id` · `draftId` FK **ON DELETE CASCADE** · `lineKind` ENUM('GOODS','PRINT','CUSTOM') · `sortOrder` · `variantId` NULL **FK RESTRICT** · `productUnitId` NULL **FK RESTRICT** · `quantity` DECIMAL(15,3) · `unitPrice` DECIMAL(15,2) · `discountAmount` DECIMAL(15,2) DEFAULT 0 · `lineTotal` DECIMAL(15,2) · `title` · `customizationText` TEXT · **`designImages` MEDIUMTEXT NULL** · `printSpec` TEXT NULL · `dueDate` · `assignedTo` · `priceOverride` BOOL · `priceApprovedBy` BIGINT NULL · `lineRequestId` VARCHAR(64).
فهرس: `idx_dline_draft(draftId, sortOrder)`.

> **قرارٌ صريح (كان صامتاً):** المفاتيح الأجنبية على `variantId`/`productUnitId` **موجودة بـRESTRICT**، ويُضاف مدخلٌ في `getProductUsage` (V17) بعنوان «أسطر مسوّدات استقبال مفتوحة» **محصوراً بـ`status='OPEN'`** كي لا تمنع مسوّدةٌ ملغاةٌ الحذف للأبد.
>
> **قاعدة صلبة:** لا استعلام قائمةٍ ينتقي `designImages` ولا `printSpec`، ولا تحمل أيّ حمولة تدقيقٍ أيّاً منهما (حادثة `Out of sort memory`).

### ٥.٣ `orderPayments` — سجلّ المال السابق للفاتورة (ش٤)

**جدولٌ واحد بثلاثة أنواع صفوف** — يحلّ محلّ الاعتماد على مسحٍ ظنّيٍّ للإيصالات:

| العمود | النوع | ملاحظة |
|---|---|---|
| `id` | BIGINT PK | |
| `draftId` | BIGINT NOT NULL FK | كل مالٍ ينتمي لمسوّدة |
| `branchId` / `customerId` | | |
| `kind` | ENUM('COLLECTION','APPLICATION','REFUND') NOT NULL | |
| `amount` | DECIMAL(15,2) NOT NULL | **موجبٌ دائماً**؛ الاتجاه من `kind` |
| `method` | ENUM('CASH','CARD','TRANSFER','WALLET','TELECOM') NULL | لـCOLLECTION/REFUND فقط |
| `receiptId` | BIGINT NULL **UNIQUE** | إيصال القبض/الردّ؛ NULL لصفوف APPLICATION |
| `shiftId` | BIGINT NULL | وردية القبض (تبقى عليها أبداً — قاعدة ٤) |
| `parentPaymentId` | BIGINT NULL FK self | APPLICATION/REFUND ← COLLECTION |
| `appliedKind` / `appliedId` | ENUM('INVOICE','WORKORDER') / BIGINT | لـAPPLICATION فقط |
| `status` | ENUM('HELD','APPLIED','REFUNDED') | على صفوف COLLECTION |
| `referenceNumber` | VARCHAR(64) | إلزاميّ لغير النقد |
| `clientRequestId` | VARCHAR(80) **UNIQUE** | |
| `createdBy` / `createdAt` | | |

قيود: `uq_orderpay_receipt(receiptId)` · `uq_orderpay_request(clientRequestId)`.
فهارس: `idx_orderpay_draft(draftId,kind,status)` · `idx_orderpay_applied(appliedKind,appliedId)` · `idx_orderpay_parent(parentPaymentId)`.

> **لماذا `receiptId UNIQUE`؟** هو الإصلاح البنيويّ لعلّة V3: لا بحثَ ظنّيّاً بـ`.limit(1)` ولا حيلة `referenceNumber NOT LIKE`.
> **مكسبٌ مجّانيّ:** `method` تُنشَأ **مع الجدول** ⇒ قيمة `TELECOM` هنا لا تحتاج ملف extras؛ الـextras لازمٌ فقط لتوسيع `receipts.paymentMethod` القائم.

### ٥.٤ أعمدة على جداول قائمة

| العمود | الشريحة | السبب |
|---|---|---|
| `workOrders.depositReceiptId` BIGINT NULL + `idx_wo_deposit_receipt` | **ش٠** | ينهي التقاط `.limit(1)` الملتبس في **ثلاثة** مواقع (V3). backfill: أقدم إيصال `(workOrderId, IN, invoiceId NULL, referenceNumber NOT LIKE 'DLV-FEE-%')` |
| `invoices` ⇐ فهرس `idx_invoice_shift(shiftId, id)` | **ش٠** | الفهرس المفقود (V2)؛ العمودان معاً لأنّ الطابور يرتّب `id DESC` ويقطع بـ`id < cursor` ⇒ يلغي `filesort` |
| `receipts.paymentMethod` += `'TELECOM'` | **ش٥** | **في الهجرة المرقّمة** (V10) + نسخة extras مكرّرة |
| `cardReconciliations.accountKind` ENUM('CARD','TELECOM') NOT NULL DEFAULT 'CARD' | **ش٥** | **مُتحقَّق: لا قيد UNIQUE على هذا الجدول** (F8) ⇒ يكفي توسيع `idx_cardrecon_branch` إلى `(accountKind, branchId, asOfDate)` |
| `receipts.telecomSenderPhone` VARCHAR(32) NULL | **ش٥** | رقمٌ مُطبَّعٌ بـ`server/lib/phone.ts` بدل مرجعٍ نصّيٍّ حرٍّ يُختلَق (§٩.٤) |

### ٥.٥ الهجرات — بالتسلسل الصارم

| # | العنوان | `when` | المحتوى |
|---|---|---|---|
| **0151** | `reception_deposit_link_and_shift_index` | `1787879404000` | `workOrders.depositReceiptId` + backfill + `idx_invoice_shift` |
| **0152** | `reception_drafts` | `1787879405000` | الجدولان + الفهارس + القيود الثلاثة الفريدة + FKs |
| **0153** | `order_payments` | `1787879406000` | الجدول + الفهارس + القيدان الفريدان |
| **0154** | `telecom_payment_method` | `1787879407000` | `ALTER TABLE receipts MODIFY COLUMN paymentMethod ENUM(…,'TELECOM')` **داخل الهجرة المرقّمة** + `receipts.telecomSenderPhone` + `cardReconciliations.accountKind` |
| extras | `0154_receipt_payment_method_telecom.sql` | — | نسخةٌ مكرّرةٌ حرفياً لـCI، تُسجَّل **آخر** القائمة في `scripts/ci-apply-extra-migrations.mjs` بعد `extras/0150_delivery_fee_held_enum.sql` |

> **القاعدة المعمَّمة (V10):** كل قيمة enum جديدة على جدولٍ **قائم** = **سطران**: `MODIFY COLUMN` في الهجرة المرقّمة (مسار الإنتاج عبر migrator) + نسخة extras (مسار CI عبر push). واحدةٌ منهما وحدها = عطلٌ صامتٌ لا يمسكه CI.
> كل `when` **أكبر** من آخر مدخلٍ في `_journal.json` (`1787879403000`) وإلا تجاهله migrator صامتاً في الإنتاج.
> **مداخل `UNIQUE_AR` الإلزامية:** `uq_draft_number` · `uq_draft_commit_request` · `uq_draft_committed_invoice` · `uq_orderpay_receipt` · `uq_orderpay_request`.
> **`db:verify` يكتسب:** فحص وجود `'TELECOM'` في `INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE` لـ`receipts.paymentMethod`، وفحص `idx_invoice_shift` — فيفشل النشر **قبل** `pm2 reload` لا بعده.

---

## ٦. عقود tRPC

راوترٌ جديد **`reception`** يُسجَّل في `server/routers.ts` (**ملفٌ ساخن — القائد وحده**). **صفر بوّابةٍ جديدة، صفر مفتاح وحدةٍ جديد، صفر مدخلٍ جديد في `authz-inventory`.**

| فئة العمليات | البوّابة **القائمة** | مَن يمرّ |
|---|---|---|
| المسوّدة (بلا مال) قراءةً وكتابة | `workordersExecProcedure` | cashier + manager + **print_operator** |
| الطابور والفواتير وكل ما يمسّ المال | `workordersCashierProcedure` | cashier + manager |

> **`workordersReadProcedure` مرفوضةٌ هنا** (V9): بوّابة خريطة بلا قائمة أدوار ⇒ تفتح الطابور لـ`warehouse`/`user`/`auditor`. `print_operator` مغطّى بـ`workordersExecProcedure` أصلاً فلا حاجة لها.

```
# الطابور (ش١)
reception.invoiceQueue { branchId?, shiftIds?, from?, to?, q?,
    deliveryState?: 'ALL'|'NOT_DISPATCHED'|'DISPATCHED'|'DELIVERED',
    paymentState?:  'ALL'|'UNPAID'|'PARTIAL'|'PAID',
    cursor?, limit<=100 } -> { rows, hasMore, nextCursor }          [cashier]
reception.orderQueue  { ... }                                        [cashier]
reception.collectOnInvoice { invoiceId, amount, method, reference?,
                             clientRequestId }                       [cashier]

# المسوّدة (ش٢) — الترقية عند الحاجة، والمزامنة بالجملة
reception.draftPromote { branchId, shiftId?, clientRequestId,
                         header, lines[] } -> { draftId, draftNumber, version }  [exec]
reception.draftGet     { draftId } -> DraftDto                       [exec]
reception.draftList    { mine?: boolean, status?, q?, cursor?, limit<=100 }      [exec]
reception.draftSync    { draftId, version, header, lines[] }
                       -> { version, totals }                        [exec]
reception.draftCancel  { draftId, version, reason }                  [exec]

# التثبيت (ش٣)
reception.draftCommit { draftId, version, expectedTotal,
                        collectNow?: { amount, method, reference? } }
   -> { invoiceId?, printInvoiceId?, workOrderIds[], appliedPayments[] }  [cashier]

# المال (ش٤)
reception.collectDeposit { draftId, amount, method, reference?, clientRequestId }
   -> { paymentId, receiptId, collectedTotal }                       [cashier]
reception.refundDeposit  { paymentId, amount, reason, clientRequestId }
   -> { refundPaymentId, refundReceiptId }                           [cashier]
reception.paymentsOf     { draftId }                                 [cashier]
```

**قواعد العقود:**

- كل حقلٍ ماليٍّ بـ`positiveMoneyString`/`nonNegMoneyString` من `server/lib/schemas.ts` — `z.string()` العارية يرفضها `check:money-schemas`.
- **لا مدخل تاريخٍ في أيّ نقطة نهاية** (ثابت I16) — `check:date-boundaries` + `utcTodayStart()`.
- `expectedTotal` **إلزاميّ** في التثبيت: الخادم يعيد الحساب من الأسطر ويرفض إن خالف ما رآه الموظّف. يمسك ما لا يمسكه `version` وحده (تحديث صفحةٍ بين العرض والنقر).
- `collectDeposit` **بلا `version`** عمداً: قبضُ مالٍ لا يجوز أن يفشل لأنّ زميلاً أضاف سطراً. حمايته `clientRequestId` + `withIdempotency`.
- **`draftSync` بالجملة لا سطراً-سطراً** (ملاحظة الهجوم ٣.٣): إرسال المصفوفة كاملةً بـdebounce ~٨٠٠مث — نمط `updateProductVariants` القائم. تحريرٌ سطراً-سطراً بـ`version` يكسر مسح الباركود السريع (المسحة الثانية تحمل نسخةً قديمة ⇒ CONFLICT بينما الموظّف ينظر إلى البضاعة لا إلى الشاشة).
- **`couponCode` مرفوضٌ خادمياً على مسار `draftCommit`** في النسخة الأولى (§٧.٢، ملاحظة ١.٨).
- **`check:orphans`** (V16): نقلُ نقطة نهاية = **حذف القديمة في نفس الـPR**. `delivery.receptionQueue` تُحذف في PR ش١ نفسه (لا مستهلك آخر لها — مُتحقَّق).
- `delivery.dispatchInvoice` **يبقى مكانه** (فعلٌ توصيليّ). `receptionCheckoutService.ts` **يبقى باسمه وموضعه** — `offline/replayReception.ts` يستورده.

---

## ٧. بنية الخدمات ومسار التثبيت

```
server/routers/receptionRouter.ts            (جديد)
server/services/reception/
  index.ts      البرميل
  types.ts      عقود المسوّدة
  numbering.ts  nextDraftNumber (النقطة الوحيدة التي تأخذ قفلاً)
  draft.ts      promote/sync/cancel + إعادة الحساب الخادمية + logAuditTx
  deposits.ts   collectDeposit / refundDeposit / allocateAtCommit / resolveWorkOrderDeposit
  commit.ts     commitDraft
  queries.ts    invoiceQueue + orderQueue (paginateKeyset)
  holdReceipts.ts  isPreInvoiceHoldReceipt()  ← مُحدِّدٌ واحدٌ مُصدَّر (V5+V6)
```

### ٧.١ استخراج `checkoutReceptionInTx` (ميكانيكيّ، صفر تغييرٍ سلوكيّ)

`withTx` = `db.transaction(fn)` **غير قابلٍ لإعادة الدخول**، فلا يمكن لـ`commitDraft` أن «يلفّ» `checkoutReception` ويُكمل بعده بذرّية:

```
checkoutReceptionInTx(tx, input, actor)   ← الجسم الحاليّ كما هو
checkoutReception(input, actor) = withTx(tx => checkoutReceptionInTx(tx, input, actor))
```

| المستدعي | بعد الترحيل |
|---|---|
| `workOrders.receptionCheckout` | **يبقى** على الغلاف — بلا مسّ |
| `offline.replayReception` | **يبقى** — إلزاميّ (لا خادم لحظة الالتقاط ⇒ لا مسوّدة) |
| `reception.draftCommit` | يستدعي `…InTx` داخل معاملته |

### ٧.٢ توسعة حدّ الالتزام بـ`preCollected` (حلّ الحاصرتين ١.١ و١.٢)

**المشكلة المُثبَتة:** مدخل التثبيت الماليّ الوحيد `paidAmount`، ومنه **يُنشئ إيصالات جديدة**. فالمالُ المقبوض سلفاً إمّا يُمرَّر ⇒ **إيصالٌ ثانٍ لنفس النقد** فلا تُغلق الوردية أبداً؛ وإمّا لا يُمرَّر ⇒ **رفضٌ حتميّ** (`البيع الآجل يتطلب عميلاً محدداً` للزبون العابر، أو `تجاوز حدّ الائتمان` للعميل بحدّ `'0'` الافتراضيّ) بينما `moneyLocked` يمنع الإلغاء ⇒ المال محبوسٌ والبضاعة غير مُفوترة.

**العقد الجديد:**

```ts
ReceptionCheckoutInput += {
  preCollected?: {
    total: string;          // مجموع المقبوض سلفاً على هذه السلة
    receiptIds: number[];   // إيصالاتٌ تُربَط ولا تُنشَأ
    paymentIds: number[];   // صفوف orderPayments COLLECTION لتوليد صفوف APPLICATION
  } | null;
}

SaleInput / PrintSaleInput += { preCollected?: { amount: string; receiptIds: number[] } }
CreateWorkOrderInput      += { depositPreCollected?: string }   // جزءٌ من deposit سبق قبضُه
```

**التسلسل داخل `createSaleInTx` (وتوأمها للطباعة):**

1. `totalPaid = preCollected.amount + tendered` (مقصوصاً عند `effectiveTotal`).
2. `unpaid = effectiveTotal − totalPaid` — **ثمّ** تُطبَّق حرّاس «البيع الآجل يتطلب عميلاً» و`assertCreditLimit` عليها. هذا هو الترتيب الحاسم: الحساب **قبل** الحارس.
3. الإيصال الجديد يُنشَأ **للجزء النقديّ الجديد وحده** (`tendered` المقصوص) — صفر إيصالٍ إن كان صفراً.
4. `invoices.paidAmount = totalPaid`؛ `adjustCustomerBalance(effectiveTotal − totalPaid)`.
5. إيصالات `preCollected.receiptIds` تُحدَّث `invoiceId` فقط (نمط `deliver.ts:145-153` — append-only على الدفتر، لا مسّ `accountingEntries`).

**التوزيع في `checkoutReceptionInTx`:**

- `applied = paidAmount + preCollected.total`؛ الحارس يصير `applied >= directTotal` (كان `paidAmount` وحده) و`applied <= grandTotal`.
- التوزيع **جشعٌ بترتيب السلّة كما هو اليوم**، لكن **المال المقبوض سلفاً يُطبَّق أولاً**: البيع المباشر ⇒ أمر شغل ١ ⇒ ٢ …
- كل أمر شغلٍ يستقبل `deposit = P + N` حيث `P` سابقٌ و`N` نقدٌ جديد. `createWorkOrderInTx` يُنشئ إيصاله **لـ`N` وحدها** ويستمّ `depositReceiptId` فقط حين ينشئه.
- تُكتب صفوف `orderPayments` من نوع APPLICATION لكل هدف (INVOICE أو WORKORDER) بحصّته من `P`، وتصير صفوف COLLECTION الأمّ `status='APPLIED'`.

**حلّ الحاصرة ١.٢ (العربون لا يصل أمر الشغل):** بهذا يُكتب `workOrders.deposit` فعلياً ⇒ `deliver.ts:65` يقرأه ⇒ `totalPaid` صحيح ⇒ لا مطالبةٌ مزدوجة ولا ذمّةٌ منفوخة؛ و`cancel.ts` يجد ما يردّه.

### ٧.٣ تسلسل `commitDraft` داخل `withTx` واحدة

1. `SELECT … receptionDrafts WHERE id=? FOR UPDATE` ⇒ إن `status != 'OPEN'` **أعِد النتيجة الكاملة المُعاد بناؤها** (لا الأعمدة المخزَّنة وحدها — ملاحظة ٢.١٠).
2. تحقّق `version` و`expectedTotal` (مُعاد حسابه من الأسطر خادمياً).
3. **حارس القاعدة ٧:** `grandTotal >= Σ(orderPayments COLLECTION HELD)` وإلا رفضٌ برسالةٍ تطلب ردّ الفارق أولاً.
4. تجسيد الأسطر إلى `ReceptionCheckoutInput` + `preCollected`.
5. `checkoutReceptionInTx(...)` — كل الحرّاس القائمة تعمل كما هي.
6. كتابة صفوف APPLICATION + تحديث حالة COLLECTION.
7. `UPDATE receptionDrafts SET status='COMMITTED', committedInvoiceId, committedAt`.

**إعادة التشغيل (ملاحظة ٢.١٠):** لا تُقرأ النتيجة من أعمدة الرأس — تُعاد بناؤها من `commitRequestId` بنفس منطق `isCompleteReplay` القائم (`findIdempotentRefId(tx,"workOrder.create", "{uuid}-wo-{i}")` + `invoices.sourceId = "{uuid}-sale" / "-print"`). صفر عمودٍ إضافيّ وصفر انحرافٍ عن المسار القائم.

**حارس idempotency ثلاثيّ الطبقات:** (أ) `version` تفاؤليّ للتحرير؛ (ب) `FOR UPDATE` تشاؤميّ للتثبيت؛ (ج) `commitRequestId` **الخادميّ** يصير `sourceId='{uuid}-sale'` فيصطدم بـ`uq_invoice_source` القائم حتى لو سقط القفلان. المفتاح العميليّ يموت مع تبويب المتصفّح بينما المال يبقى ⇒ **المفتاح يُولَّد ويُخزَّن مع الكيان الذي يحميه**.

### ٧.٤ ترتيب الأقفال (حلّ ملاحظة ٢.٦)

**الترتيب الموحَّد في كل مسارٍ جديد: مسوّدة ← وردية ← أمر شغل.**
و`closeShift` يقفل الوردية أوّلاً (V11) ⇒ أيّ حارسٍ يقرأ المسوّدات **داخل** معاملة الإغلاق ينقلب عليه الترتيب. لذلك:

> **قرار: المسوّدة المموّلة لا تمنع إغلاق الوردية إطلاقاً.** المال في `receipts` بـ`cashBucket='DRAWER'` ⇒ الدرج **متّسقٌ بالفعل** ووجود المسوّدة لا يُخلّ به. المسوّدة المموّلة: (أ) **تمنع الكنّاس** من طيّها؛ (ب) تظهر **سطر إفصاحٍ في Z-report**: «عرابين على طلباتٍ لم تُثبَّت: ن طلباً بمبلغ س»؛ (ج) تظهر في تقرير مطابقة إقفال اليوم.

هذا يُسقط سبب الجمود من الجذر: لولاه لكان الموظّف ليلاً بلا تثبيت (لا اتفاق) ولا إلغاء (`moneyLocked`) ولا ردّ (لا مدير للاعتماد) ⇒ وردية مفتوحة طوال الليل، وصباحاً `CONFLICT: لديك وردية مفتوحة بالفعل` ⇒ المحطة معطّلة.

### ٧.٥ تقريب IQD — نطاقٌ مُضيَّقٌ ومصحَّح (V1)

`roundCashIQD` تقريبٌ **لأقرب** ٢٥٠ (نصفٌ لأعلى)، لا حذفٌ لأسفل. فتمريرُ العلم وحده يكسر كل سلّةٍ يُقرَّب إجماليها **لأعلى**: الواجهة ترسل ٤٧٬٤٠٠ والخادم يحسب ٤٧٬٥٠٠ ⇒ `unpaid = 100` ⇒ زبونٌ عابر ⇒ **رفض**؛ عميلٌ بحدّ `'0'` ⇒ **FORBIDDEN**؛ عميلٌ بحدٍّ موجب ⇒ **ذمّةُ ١٠٠ دينارٍ صامتة على من سدّد نقداً**.

**القرار (ش٠):**
- الواجهة تُقرّب أوّلاً بنفس `roundCashIQD` المشتركة وترسل `regularSale.amount` و`paidAmount` **مقرَّبَين** — نمط `POS.tsx:571-572, 1086` حرفياً — والخادم يستقبل العلم فيقيّد فرق `ADJUST`.
- النطاق: **البيع المباشر الخالص** (بلا `printSale` وبلا `workOrders`) والدفع **نقديٌّ كامل** فقط.
- **السلّة المختلطة تبقى بلا تقريبٍ في ش٠**، ويُكتب لها اختبارٌ يثبّت السلوك الحاليّ صراحةً كي لا «يُصلحها» أحدٌ صامتاً. علاجها الكامل بندٌ معلَنٌ في ش٦.
- **`createPrintSaleInTx` يقبل `cashRoundIQD` أصلاً** (`printSaleService.ts:77, 318`) — مُتحقَّق، فالتوسعة في ش٦ ممكنةٌ بلا تغيير عقد.

---

## ٨. الشاشات والتدفّقات

### ٨.١ الهيكل (ثلاث طبقاتٍ ثابتة وواحدة متغيّرة)

1. **شريط الطلبات** (أعلى): رقائق `طلب ١ · ٣ بنود · ٤٥٬٠٠٠` + `+`.
2. **الرأس** صفّان × ٤٤px: (عميل/قناة/فئة سعر) ثمّ (بحث/خدمة/طابعة/وردية/**آخر فاتورة**).
3. **عمود العمل** = ورشةٌ واحدة، وشريط تبويباتها يركب على رأس السلة القائم `h-12` ⇒ **صفر تكلفةٍ عمودية**: `[السلة] [الفواتير] [الطلبات] [طلبات المتجر]`. التبويب بلا صلاحيةٍ **لا يُعرَض**.
4. **لوحة الدفع (٤٠٨px) لا تُغطّى أبداً.** كل ورشةٍ تُركَّب داخل عمود العمل (`absolute inset-0` نسبةً للعمود) لا نسبةً للصفحة كما اليوم (`z-30/z-40` تُخفي زرّ التثبيت وشارة الوردية).

**مرفوضٌ صراحةً:** ريلٌ جانبيٌّ ثالثٌ دائم (على ١٣٦٦px بزوم ١٢٥٪ يبقى للسلة ~٣٤٠px وهي السطح الأساسيّ) · إبقاء الطبقات `inset-0` · فتح الفواتير بـ`window.open`.

**شريط الطلبات يدخل سُلَّم الاحتواء (ملاحظة ٣.٧):** شريط التسلسل **محذوفٌ أصلاً** تحت `compactHeader` (max-height:900px، V18) فلا يموّل شيئاً. القاعدة: تحت `compactHeader` ينكمش الشريط إلى **زرٍّ واحد** «٣ طلبات ▾» يفتح قائمةً منسدلة، ولا يبقى شريطاً أفقياً إلا فوق ٩٠٠px. **بوّابة القبول: ٧٦٨px ارتفاعاً فعلياً × ١٠٠/١٢٥/١٥٠٪ قبل الدمج**، بلقطةٍ تُثبت ظهور زرّي الفعل بلا تمرير.

### ٨.٢ السلّة محليّة والمسوّدة **مُرقّاة** (حلّ الحاصرة ٢.٢)

> **هذا أهمّ تعديلٍ على التصميم الأول.** جعلُ السلّة كياناً خادمياً يقتل **التقاط البيع أوفلاين** المدموج قبل يومين (#484): أوّل ضغطةٍ على `+` تصير مكالمةً خادمية ⇒ عند الانقطاع **لا تبويب ولا سلة ولا بيع إطلاقاً**، بينما اليوم يبحث الكاشير في Dexie ويبني السلة محلياً ويُلتقَط البيع في الطابور المشفَّر.

| الحالة | السلوك |
|---|---|
| الافتراض | السلّة **حالةٌ محليّة** (React + نسخةٌ خفيفة في `localStorage` تنجو من إعادة التحميل) — تماماً كنمط POS |
| **الترقية إلى مسوّدةٍ خادمية** | عند أوّل سببٍ حقيقيّ فقط: (أ) قبض عربون · (ب) فتح تبويبٍ ثانٍ متوازٍ · (ج) «احفظ الطلب / سلّمه لزميل» صراحةً · (د) إضافة **صور تصميم** (لا تُخزَّن base64 في `localStorage` — حصّةٌ محدودة) |
| التزامن | `draftSync` بالجملة مع debounce ~٨٠٠مث + `version` تفاؤليّ |
| الأوفلاين | الترقية مستحيلة؛ الرقاقة ترتدي شارة «لا يُلتقَط دون اتصال»، ومسار `captureOfflineReception` يبقى **بلا تغيير** |

**ملكية المسوّدات (ملاحظة ٣.١٣):** الشريط يعرض **مسوّدات المستخدم الحاليّ** بحدٍّ أقصى ~٥ مرئية، وما زاد خلف «طلباتٌ محفوظة» قابلةٍ للبحث بالاسم/الهاتف. فتحُ مسوّدةٍ أنشأها زميلٌ يتطلّب تأكيداً يسمّيه («طلبٌ أنشأه أحمد — هل تكمله؟»)، والرقاقة تحمل اسم صاحبها، والمسوّدة **المموّلة** موسومةٌ بصرياً قبل أيّ تحرير.

### ٨.٣ لوحة المبلغ (م٤)

- شاشة المبلغ تصير **`<input>` حقيقياً** (`inputMode="decimal"`, `dir="ltr"`, `tabular-nums`, **>=٤٤px**, `aria-label`). **إلزاميّ لا تحسين:** `payInput` بلا أيّ حقلٍ نصّيّ اليوم (F13)، فحذف اللوحة بلا بديلٍ **يشلّ المحطة**.
- تُحذف `الكمية` و`%`؛ العمود المُحرَّر يستقبل: **`000`** (أعلى مفتاحٍ عائداً في سوق الدينار) · **`= الكل`** · **`عربون ▾`**.
- **يُحذف السطر الذي يقلب الوضع عند نقر صفّ السلة** ⇒ تزول الوضعيّة الخفيّة نهائياً: اللوحة تعني المبلغ **دائماً**.
- **سُلَّم الاحتواء يبقى حرفياً** (`ResizeObserver`, `payDense<700`, `payUltra<580`, `payOverflowGuard<520`, `container-type:size`, `NUM_H`). ترتيب الحذف: التلميح ← بطاقتا التقسيم ← رقائق المبالغ ← الكوبون ← عنوان طرق الدفع ← كتلة العربون تنكمش لسطرٍ ثم شارة ← كتلة التوصيل تنكمش لشارة.
  **لا يُحذف ولا يُصغَّر أبداً:** حقل المبلغ · أزرار طرق الدفع · زرّا الفعل. **`transition: all` ممنوعٌ** على أيّ عنصرٍ بوحدات الحاوية.
- **طريقةُ دفعٍ خامسة (ملاحظة ٣.٩):** عند بلوغ خمسٍ يصير الصفّ **صفّين × <=٣**، أو تُطوى النادرتان (WALLET/TELECOM) خلف زرّ «طرق أخرى» بنمط الكوبون المطويّ القائم. وفي كل الأحوال تُعرض الطريقة المختارة **بالكلمات** في سطر التأكيد أعلى زرّ التثبيت — اللون وحده لا يكفي على شاشةٍ مضغوطة، وخطأُ الاختيار يُنتج عجزاً في الدرج يمنع الإغلاق.

### ٨.٤ الخصم داخل الصفّ (م٤)

خلية السعر تصير زرّاً يفتح Popover (~٢٤٠px): رقائق نِسَبٍ + نسبةٌ حرّة + **معاينةٌ حيّة** («١٢٬٠٠٠ ← ١٠٬٨٠٠ · وفّر ١٬٢٠٠») + «تطبيق»/«إزالة». إغلاقٌ صريحٌ فقط، وإعادة التركيز للخلية (WCAG 2.4.3). الكمية تصير `<input>` صغيراً في مكانها. **صفر عمودٍ جديد في الجدول.**

**سقف الرقائق ١٠٪ لا ٢٠٪ (ملاحظة ٣.٦ + V13):** العتبة `MANUAL_DISCOUNT_APPROVAL_THRESHOLD = 0.15` والمقارنة `gt` ⇒ **١٥٪ بالضبط تمرّ بلا اعتماد ولا سطر تدقيق**. رقاقةٌ بـ«١٥٪» بنقرةٍ واحدة تُعلّم الموظّف موضع السقف بالضبط. لذلك: **الرقائق تقف عند ١٠٪**؛ وأيّ نسبةٍ أعلى تُدخَل يدوياً وتفتح **حوار اعتماد المدير مباشرةً** (لا تنتظر رفض الخادم)؛ و`logAuditTx` يُكتب لأيّ خصم سطرٍ >=١٠٪ **حتى وهو مسموح** — الرقابة اللاحقة أرخص من المنع، لكنها مستحيلةٌ بلا سجلّ. ويظهر في «مطابقة إقفال اليوم» سطر «متوسط الخصم اليدويّ لكل موظّف».

**مرفوض:** حقلُ خصمٍ دائمٍ في كل صفّ (خصمٌ صامتٌ بنقرةٍ عابرةٍ على شاشة لمس) · الخصمُ بالمبلغ في النسخة الأولى · «أدخل السعر النهائي» (ينتج نسبةً كسريةً فينحرف المحسوب خادمياً عمّا قرأه الزبون).

### ٨.٥ ورشة الفواتير

افتراضٌ ذكيّ: **`[ورديتي]`** بدل `sinceDays:1` المثبَّت (نطاق الكاشير الصحيح ورديّته لا يومٌ تقويميّ — واليوم **فاتورة الأمس غير قابلةٍ للوصول إطلاقاً**). رقائق: ورديتي / اليوم / ٧ أيام / غير مسدّدة / بالبطاقة + بحث + مسح.

أعمدة: رقم · وقت · زبون · إجمالي · مدفوع · **متبقٍّ** · حالة · **التسليم** (كاونتر/إرسالية #X + المندوب) · **قَبَضَها** · إجراءات.

إجراءات الصفّ (`RowActions` + `gate`، والإخفاء مقدَّمٌ على الرفض في منتصف العملية):
إعادة طباعةٍ حرارية (`invoiceToReceipt`→`printReceipt`) · A4 · **تسديد دفعة** · إسناد توصيل · تفاصيل (درجٌ جانبيّ + رابط `/invoices/{id}`) · طلب مرتجع (يفتح `/returns`).

- **تسديد الدفعة عبر `reception.collectOnInvoice`** لا `sales.pay` (V8 — الحاصرة). حوارٌ يحمل **سطراً إلزامياً**: «سيدخل المبلغ **درجك أنت** — وردية #ن، الفرع س» (ملاحظة ٣.١٢: `shiftIdForCashTx` يفرض درج الفاعل، ولا شيء اليوم يعرض هذه الحقيقة). `clientRequestId` جديدٌ لكل فتح حوار، ومرجعٌ إلزاميٌّ لغير النقد مُطبَّقٌ واجهياً.
- **إعادة الطباعة تتبع نطاق القراءة (الفرع)** لا الملكية (ملاحظة ٣.١٠): `invoiceToReceipt` يعيد بناء إيصالٍ من لقطة فاتورة **بلا إنشاء بيع** — قراءةٌ محضةٌ لا تحرّك ديناراً. حصرُها بالمالك يجعل أكثر حالةٍ يومية (زبونٌ يطلب نسخةً وموظّفها في إجازة) مستحيلة.
- **سطرٌ ثابتٌ أسفل الدرج بدل زرٍّ يكذب:** «الفاتورة مُثبَّتة — التصحيح بمرتجعٍ أو بتصحيحٍ من المدير» (F4).

### ٨.٦ العربون والتوصيل والإخراج

- **كتلة العربون** تظهر تلقائياً متى حوت السلّة سطراً مخصَّصاً: «المطلوب الآن = الجاهز + العربون»، أزرار ٢٥٪/٥٠٪/حرّ، و**جدول توزيعٍ حيّ** يحسب **بنفس الخوارزمية الجشعة الخادمية** (`receptionCheckoutService.ts:110-125`) ⇒ ما يراه الموظّف هو ما يقع. سطرٌ يشرح «يُملأ الطلب الأول أولاً».
- **لا حقل عربونٍ لكل سطر في النسخة الأولى** — العقد يوزّع مبلغاً واحداً؛ حقلٌ يتجاهله الخادم = تكرارٌ لحقل `deposit` الميّت في `CustomizationDialog`. **يُحذف ذلك الحقل الميّت.**
- **كتلة التوصيل على مستوى الطلب** (لا داخل حوار التخصيص): مستلِم/هاتف/عنوان/أجرة/مَن يقبضها.
  - **`feeCollection='COUNTER'` محظورٌ خادمياً على مسار الفاتورة حتى ش٦** (V15): الكاتب الوارد الوحيد لأمانة الأجرة هو `workOrder/create.ts`، فأجرةٌ تُقبض في الاستقبال على فاتورةٍ بلا أمر شغل تُنتج **OUT بلا IN** ⇒ فائضٌ ثمّ عجز ⇒ الوردية لا تُغلق في الاتجاهين.
  - **لا تسلسلٌ تلقائيٌّ إلى `dispatchInvoice`** لفاتورةٍ بـ`customerId != null` و`cod > 0` حتى يُصلَح V14 (ش٠).
  - **حارسٌ إلزاميّ:** نجاح التثبيت وفشل الإسناد ⇒ الفاتورة تظهر فوراً موسومةً «بانتظار الإسناد» مع إعادة محاولة — **لا تُبتلَع بصمت**.
- **نافذة الإيصال بعد الإتمام**: الفكّة بخطٍّ ضخم + أرقام المستندات + **إعادة الطباعة** + لافتةٌ تسمّي ما لم يُطبَع إن `printFailures>0` (اليوم يُبتلَع في toast بلا أيّ سبيلٍ لإعادة الطباعة). `F9` يعيد طباعة آخر إيصالٍ من أيّ مكان. `F12` تفريغٌ بتأكيد. شارة «آخر فاتورة». **سحبٌ نقديّ** (`CashDropDialog` يُرفَع لمكوّنٍ مشترك) — درج الاستقبال يتراكم فيه بيعٌ + عرابين + أجرةٌ أمانة.
- **حارس سباقٍ يُنقَل من POS:** `Enter` في البحث يضيف `results[0]` بلا `searchSettled` ⇒ منتجٌ خاطئٌ من استعلامٍ أقدم. يتضاعف الخطر مع تسريع التدفّق.

### ٨.٧ الإتاحة

`<select>` الخامّان ⇐ `AppSelect` · `aria-label` لكل زرٍّ أيقونيّ · `role="tablist"`+`aria-selected`+تنقّلٌ بالأسهم · `aria-selected` على صفّ السلة المحدَّد · توكنز «صَفا» الدلالية حصراً (`--sem-warn`/`--sem-info`/`--money-positive`) لا ألوان خام (`check:colors`) · **صفر إيموجي** (`check:emoji`) · تحقّقٌ بصريّ عند ١٠٠/١٢٥/١٥٠٪ **قبل** الدفع، و`pnpm build` لا `check` وحده.

---

## ٩. مصفوفة الصلاحيات وفصل المهام (SOD)

### ٩.١ المصفوفة (صفر تغييرٍ في نظام الصلاحيات)

| العملية | البوّابة (**قائمة**) | print_operator | reception_clerk | cashier | manager |
|---|---|---|---|---|---|
| قراءة الطابور/الفواتير | `workordersCashierProcedure` | لا | نعم | نعم | نعم |
| قراءة/تحرير/إلغاء مسوّدة | `workordersExecProcedure` | نعم | نعم | نعم | نعم |
| **تثبيت** المسوّدة | `workordersCashierProcedure` + وردية RECEPTION مملوكة | **لا — بنيوياً** (`treasury:"NONE"` ⇒ لا يفتح وردية) | نعم | نعم | نعم |
| قبض/ردّ عربون | `workordersCashierProcedure` + وردية RECEPTION | لا | نعم | نعم | نعم |
| تسديد دفعةٍ على فاتورة | **`reception.collectOnInvoice`** (جديدة، بنفس البوّابة) | لا | **نعم** | نعم | نعم |
| إسناد توصيل | `delivery.dispatchInvoice` القائم | لا | نعم | نعم | نعم |
| مرتجع/إلغاء/تصحيح | `/returns` + `sales.correct` مديريّان قائمان | لا | لا | لا | نعم |
| رؤية التكلفة/الهامش | `canSeeCostForUser` | لا | لا | لا | نعم |

### ٩.٢ لماذا نقطة نهايةٍ جديدة للتسديد (V8 — حاصرة)

`sales.pay` على `salesCashierProcedure` = دور + **`sales:"FULL"`**، بينما قالب `reception_clerk` يخفض `sales` إلى `"READ"` عمداً. فالمصفوفة التي وعدت بالتسديد **تفشل بـFORBIDDEN للدور المسمّى باسم المحطة**، والزرّ لا يظهر له أصلاً (الإخفاء مقدَّم) فيستنتج المالك أنّ الميزة لم تُبنَ. الأسوأ: إن قبض الموظّف النقد ثم رُفض التسجيل ⇒ فائضٌ يمنع إغلاق الوردية.

**الخيارات الثلاثة وحكمها:**
- رفع `reception_clerk.sales` إلى `FULL` ⇒ **مرفوض**: يفتح المرتجعات ويخالف نيّة القالب المعلنة.
- شطب الإجراء ⇒ **مرفوض**: يكسر أوّل مطلبٍ للمالك حرفياً.
- **`reception.collectOnInvoice`** خلف `workordersCashierProcedure` تفوّض إلى **نفس خدمة `processPayment`** (`saleService`) بحصرٍ بنيويّ: الفاتورة في فرع الفاعل **وضمن نطاق طابور الاستقبال** (وردية `shiftType='RECEPTION'`) ⇒ ليست باباً خلفياً عاماً على مبيعات التجزئة. **مقبول.**

### ٩.٣ قواعد الإنفاذ

- **حجب التكلفة في الخدمة لا في الراوتر:** لا يُنتقى عمود تكلفةٍ في SQL أصلاً لمن لا يراه (لا تقنيعٌ بعد الجلب) — وإلا تسرّب عبر لقطة شبكة.
- **نطاقٌ موحَّد** `receptionScope(ctx) -> { branchId, actorId }` يستهلكه كل مسارٍ قراءةً وكتابةً، بديلاً عن `effectiveBranch`/`scopedBranchOf` المتوازيين. (تكثير اشتقاقات النطاق هو جذر بوّابتَي العزل المكسورتين في تدقيق ٢٧/٧.)
- **العزل داخل الفرع (مراجعة قرار C12):** **القراءة والإجراءات بنطاق الفرع** — لأنّ المالك طلب «أن يرى الموظّف الفواتير مثل كاشير التجزئة»، وكاشير التجزئة يرى فواتير الفرع. الضبطُ بالإفصاح لا بالمنع: **عمود «قَبَضَها»** يحمل اسم مُصدر الإيصال (لا مُصدر الفاتورة)، و`logAuditTx` يسمّي الفاعل في كل تسديد/إسناد. **المنع الصلب يبقى على ما يعكس المال فقط** (مرتجع/إلغاء/تصحيح = مديريّ، وهو قائمٌ اليوم).
- **`moneyLocked` (العمود الفقريّ):** بدونه يصير تقاطع م١ و م٢ باباً لإخراج نقدٍ بلا مستند (اقبض ٣٠٠ﻙ ⇒ احذف بندين ⇒ ثبّت بـ١٠٠ﻙ ⇒ الوردية تُغلق سليمةً لأنّ `computeExpectedCash` تجمع الإيصالات لا بنود المسوّدة).
- **تصحيح نصّ `reception_clerk`**: وصفه اليوم يدّعي أنّه «لا يستطيع إصدار مبيعات مستقلة» بينما `receptionCheckout` يقبل منه `regularSale` كاملاً. **يُصحَّح النصّ لا السلوك** — الكذبُ في التسمية لا في السلوك.
- **هويّة مُقِرّ السعر:** `priceOverrideApproved` رايةٌ مشتقّةٌ من الدور بلا هويّةِ مُقِرّ. حين تكون صادقة يُلزَم الراوتر بتمرير **هويّة المُقِرّ** (نفس حقل `managerOverrideByUserId` في مسار الائتمان) + `logAuditTx` داخل المعاملة يسمّي السطر والسعر المرجعيّ والنهائيّ والمُقِرّ. (جدول `priceApprovals` **مؤجَّل** — يخدم تفويضاً عن بُعدٍ لم يُطلَب.)

### ٩.٤ ضوابط رصيد الاتصال (م٣)

رصيد الاتصال هو **طريقة الدفع الوحيدة في النظام بلا أيّ مُثبِتٍ خارج كلمة الموظّف** (البطاقة لها قسيمة جهاز، والتحويل له سجلّ مصرف)، و`I15` يضمن أنّها **لا تُنتج `DRAWER` أبداً** ⇒ الدرج يُغلق بفارق صفرٍ حتى لو دفع الزبون نقداً وسجّلها الموظّف «رصيد اتصال» وأخذ النقد. لذلك تُشحن ش٥ **بضوابطها لا بعدها بشريحتين**:

- `receipts.telecomSenderPhone` عمودٌ أوّليٌّ مُطبَّعٌ بـ`server/lib/phone.ts` (لا مرجعٌ نصّيٌّ حرّ) + قيدٌ فريدٌ على (الرقم، التاريخ، المبلغ).
- **سقفٌ لكل عملية** و**سقفٌ يوميٌّ لكل مستخدم** (ENV بنمط `getApprovalThreshold`).
- **قفلٌ تلقائيّ عند تقادم المطابقة** (لا قبضَ جديدٌ إن تجاوز عمر آخر مطابقةٍ الحدّ).
- **كاشف «نسبة TELECOM من تحصيل موظّف»** في `reportsAlertsService` **داخل ش٥**.
- حارس «زين حصراً» **خادميٌّ لا نصّيّ**.
- تأكيدٌ ثانٍ حين يكون الزبون حاضراً في المحطة والطريقة TELECOM.

---

## ١٠. الطباعة

- إعادة استعمالٍ كامل: `printReceipt` · `printWorkOrderReceipt` · `invoiceToReceipt` · `printReadyOrderLabel`/`printDeliverySlip` · `printVoucherSmart`.
- **تغييرٌ إلزاميٌّ في المخرجات:** `WorkOrderReceiptData` يكتسب **«مدفوعٌ مقدماً»** و**«المتبقّي عند الاستلام»**. اليوم التذكرة تطبع `total` فقط ⇒ يخرج الزبون بورقةٍ **لا تُثبت عربونه** — أكثر ما يُتنازَع عليه بعد أسبوع.
- **قالبٌ منفصلٌ للمسوّدة لا يُشتقّ من `printReceipt` (ملاحظة ٣.٥):** المسوّدة تحمل رقماً معلَناً للزبون (`DRF-…`)، وإعادةُ استعمال قالب الإيصال تجعل أيّ طباعةٍ لها **ورقةً لا يميّزها الزبون عن الإيصال الحقيقيّ**. القالب الجديد: عرضٌ مختلف، وعبارة «**طلبٌ غير محاسَب — ليس إيصال دفع**» في الرأس والذيل، ومنعٌ بنيويٌّ لسطرَي «مدفوع» و«الفكّة». و**حارسٌ في `printReceipt` نفسه** يرفض أيّ حمولةٍ بلا `invoiceNumber` حقيقيّ (اختبار وحدة) — الاعتماد على انضباط المطوّر القادم هو ما يُنتج هذه الثغرات.
- **فرق التقريب:** إجمالي المسوّدة قد يفارق الفاتورة بـ<=١٢٥ ديناراً بعد ش٠ ⇒ **يُعرَض المقرَّب في شاشة الدفع قبل التثبيت** لا بعده.

---

## ١١. الأوفلاين (حدٌّ معلَنٌ لا يُخفى)

- **السلّة تعمل دون اتصالٍ بالكامل** (§٨.٢) — هذا شرطٌ لا تحسين.
- **المسوّدات والعرابين أونلاين حصراً.** عربونٌ يُلتقَط بلا إيصالٍ خادميّ = نقدٌ في الدرج بلا مصدر ⇒ يمنع إغلاق الوردية.
- `workOrders.receptionCheckout` المباشر **يبقى إلى الأبد** (مستهلكه `offline/replayReception.ts`). أيّ «استبدال» يقتل الأوفلاين المُعمَّم (`a06da49`).
- **الواجهة تُعلن الحدّ لا تُخفيه:** رقاقة التبويب ترتدي شارة «لا يُلتقَط دون اتصال» **فور** دخول سببٍ (أمر شغل · كوبون · توصيل مقبوض · غير نقديّ · دفعٌ جزئيّ) بدل مفاجأة الرفض عند الضغط.

---

## ١٢. ثوابت النظام (Invariants) وإثبات كلٍّ باختبار

| # | الثابت | الإثبات |
|---|---|---|
| **I1** | مسوّدة `OPEN` لا تظهر في أيّ رصيدٍ أو تقريرٍ أو إغلاق وردية | مسوّدةٌ بـ٣ بنودٍ بـ٣٠٠ﻙ ⇒ `COUNT(invoices)=0` و`COUNT(accountingEntries)=0` و`COUNT(inventoryMovements)=0` و`currentBalance` قبل=بعد و`getShiftReport` قبل=بعد و`commissionRun` قبل=بعد |
| **I2** | `Σ(orderPayments COLLECTION HELD/APPLIED لمسوّدة) <= إجماليّها المُعاد حسابه من الأسطر` | إدراجان **متزامنان** على نفس المسوّدة تحت قفل الصفّ ⇒ الثاني يُرفض (اختبار تزامنٍ حقيقيّ لا تسلسليّ) |
| **I3** | `moneyLocked=true` ⇒ يستحيل حذف بندٍ أو خفض إجماليٍّ دون المقبوض | اقبض ٣٠٠ﻙ ⇒ `draftSync` بحذف سطرٍ يرمي · بخفضٍ دون المقبوض يرمي · التثبيت بإجماليٍّ أقلّ يرمي **قبل أيّ كتابة** |
| **I4** | لكل فاتورة: `paidAmount = Σ(تخصيصات orderPayments إليها) + Σ(إيصالات IN مربوطةٍ بها بلا تخصيص)`، و`<= total` | بعد كلٍّ من: عربونٌ واحد · عرابين متعدّدة · عربون + دفعة تثبيت · تسديدٌ لاحق · مرتجع |
| **I5** | **لا إيصالٌ ثانٍ لمالٍ سبق قبضُه** | عربونٌ نقديٌّ ثم تثبيت ⇒ **عدد إيصالات IN المرتبطة بالفاتورة = ١ لا ٢**، و`expectedCash` بعد التثبيت = قبله + الفارق المقبوض الآن حصراً |
| **I6** | العربون يصل هدفه الحقيقيّ: `Σ(تخصيصات المسوّدة) = invoices.paidAmount + Σ(workOrders.deposit المتولّدة)` وقت التثبيت | مسوّدةٌ بعربون ⇒ تثبيت ⇒ تسليم ⇒ **إجمالي ما دفعه الزبون = سعر البيع بالضبط**؛ وإلغاء الأمر يردّ العربون كاملاً |
| **I7** | `expectedCash(وردية) = الافتتاحيّ + Σ(DRAWER IN) − Σ(DRAWER OUT)` بعد كل مسارٍ جديد | ستّة اختبارات: عربونٌ نقديّ · عربون بطاقة · عربون TELECOM · ردّ · تثبيتٌ عبر وردية أخرى · بيعٌ بإجماليٍّ غير مضاعفٍ لـ٢٥٠. **كلٌّ ينتهي بإغلاقٍ ناجح** |
| **I8** | التزامٌ واحدٌ لكل مسوّدة مهما تكرّر الطلب، **بنفس المخرجات** | تثبيتان متزامنان من جهازين ⇒ **نفس** `{invoiceId, printInvoiceId, workOrderIds}` بالضبط (`uq_draft_committed_invoice` + `uq_invoice_source`) |
| **I9** | تعديلان متزامنان لا يطمس أحدهما الآخر | `version` قديم ⇒ CONFLICT، والأسطر سليمة |
| **I10** | لا `EntryType` جديد ولا حسابٌ جديد في هذه الحملة | `git diff` على `ledgerService.ts` enum و`chartSeed.ts` = صفر |
| **I11** | `reconcile drift = 0` بعد أيّ عربون، **وكشف العميل لا يكذب** | عربونٌ لعميلٍ مسجَّل ⇒ `reconcileService` يعطي صفراً · `الكشف.summary.currentBalance = customers.currentBalance` · `openingBalance` مع `from` لاحق = ما كان قبله · والعربون يظهر **سطر إفصاحٍ منفصل** «عربونٌ قيد الاحتجاز — غير مُطبَّقٍ على فاتورة» |
| **I12** | إيصال العربون يبقى على وردية قابضه | عربونٌ في أ + تثبيتٌ في ب ⇒ `receipts.shiftId` لم يتغيّر، و`invoiceId` وحده تحدَّث، و`expectedCash(أ)` و`(ب)` صحيحان **وكلتاهما تُغلق** |
| **I13** | **إيصال العربون يُلتقَط بهويّته لا بالصدفة** | أمر شغلٍ بعربونٍ **وأجرة COUNTER معاً** ⇒ التسليم يربط **العربون**، والإرسال يَسِم **العربون**، والإلغاء يردّ **العربون** لا الأجرة (ثلاثة مواقع) |
| **I14** | **مسوّدةٌ مموّلةٌ لا تمنع إغلاق الوردية** لكنها لا تُطوى | إغلاقٌ **ناجح** مع مسوّدةٍ مموّلةٍ من نفس الوردية + سطر إفصاحٍ في Z-report · الكنّاس لا يمسّها · إغلاقٌ ناجحٌ مع ٣ مسوّدات فارغة |
| **I15** | `TELECOM` لا تُنتج `cashBucket='DRAWER'` أبداً | فحصٌ على كل مسارٍ يقبل TELECOM + إغلاق وردية ناجح + ظهورها في تفكيك الخزينة والتقارير بالعربية |
| **I16** | كل قيدٍ من الاستقبال بتاريخ لحظته | لا مدخل تاريخٍ في أيّ نقطة نهاية (فحصٌ على المخططات)؛ مسوّدةٌ فُتحت في فترةٍ مفتوحة وثُبِّتت بعد الإقفال ⇒ القيد **بتاريخ التثبيت** ويرفضه `assertPeriodOpen` إن كان اليوم مقفلاً |
| **I17** | **لا مخرج نقديٍّ حرّ**: كل `direction='OUT'` بـ`cashBucket='DRAWER'` على وردية RECEPTION يمرّ بسندٍ معتمَدٍ أو ردّ عربونٍ مربوطٍ بإيصاله أو إلغاءٍ مديريٍّ موثَّق | **مسحٌ ثابتٌ على `server/**` كلّه** (لا على مجلّد الاستقبال وحده — وإلا فالثابت يستحيل أن يفشل ويمنح طمأنينةً كاذبة، بينما `workOrder/cancel.ts:70-84` بابٌ قائمٌ فعلاً) + اختبار: ردٌّ بغير طريقة القبض ⇒ مرفوض |
| **I18** | **قطعُ الشبكة لا يمنع فتح سلةٍ ولا إتمام بيعٍ نقديٍّ كامل في المحطة** | جولة E2E بإيقاف خادمٍ فعليّ (نفس جولة #484): بحثٌ في الكتالوج المحلّيّ ← سلّةٌ ← دفعٌ نقديّ ← إيصال `OFF-…` ← عودة الاتصال ⇒ `INV` تلقائياً |
| **I19** | صفر تغييرٍ في نظام الصلاحيات | `PERMISSION_MODULES.length` قبل=بعد · `ROLE_TEMPLATES` diff = صفر · `authz-inventory` بلا مدخلٍ جديد · اختبار RBAC سلبيّ: `warehouse`/`user`/`auditor` يتلقّون FORBIDDEN على `reception.invoiceQueue` |
| **I20** | مسار `workOrders.receptionCheckout` المباشر يبقى صالحاً | حزمة اختبارات `offline.replayReception` خضراء بعد الاستخراج |
| **I21** | **فاتورةُ توصيلٍ لعميلٍ مسجَّل تُغلق ذمّتها عند التوريد** | فاتورةٌ آجلةٌ بعميل ⇒ إسنادٌ للتوصيل ⇒ توريدٌ كامل ⇒ `reconcile drift = 0` و`currentBalance` عاد إلى ما كان |
| **I22** | كل حدثٍ حاكم يحمل `oldValue` و`shiftId` وإلّا فشلت المعاملة، ولا حمولة تدقيقٍ تحمل `designImages` | `logAuditTx` بحمولةٍ ناقصة ⇒ ROLLBACK · فحصٌ ثابتٌ على حمولات التدقيق |
| **I23** | **كل قيمة enum جديدة تصل الإنتاج** | اختبارٌ يقرأ `INFORMATION_SCHEMA` بعد `db:migrate:apply` (لا `db:push`) ويؤكّد وجود `TELECOM`؛ و`db:verify` يفشل قبل `pm2 reload` إن غابت |
| **I24** | **كل قيمة طريقة دفعٍ لها ترجمةٌ عربية وعمودٌ في التفكيك** | اختبارٌ يمسح `PAY_METHOD_AR` (خادميّ ×٢) و`METHOD_LABEL`/`METHOD_CLS` (عميليّ) ويقارنها بقيم enum المخطّط ⇒ يفشل عند أيّ قيمةٍ بلا ترجمة (نمط حارس `UNIQUE_AR`) |

---

## ١٣. الشرائح الرأسية (مرتّبةً)

> **الملكية:** `pnpm coord:claim` على `client/src/pages/Reception.tsx` و`client/src/components/reception/**` و`server/services/reception/**` قبل أيّ كتابة. **الملفات الساخنة** (`routers.ts`, `App.tsx`, `AppLayout.tsx`, `drizzle/schema.ts`, `seed.ts`) يطبّقها **القائد وحده** تسلسلياً بعد فراغ كل شريحة.

### ش٠ — إصلاحاتٌ مانعةٌ حيّة [تُنفَّذ فوراً، بلا تبعيات]

**القيمة:** ورديات الاستقبال تُغلق بلا فرق، ولا يُردّ للزبون مبلغٌ خاطئ، ولا تبقى ذمّةٌ على من سدّد.
**الحجم:** متوسّط (~٢-٣ أيام) · **هجرة 0153**.

**النطاق:**
1. `workOrders.depositReceiptId` صريح + backfill؛ و**ثلاثة** مواقع تقرأه بدل `.limit(1)` العمياء: `deliver.ts:145-153`, `cancel.ts:41-70`, **`delivery/dispatch.ts:167-170`** (V3).
2. `remittance.ts`: `adjustCustomerBalance(customerId, −collected)` عند التوريد لفاتورةٍ بعميلٍ مسجَّل — مرآةً حرفيةً لـ`courier.ts:191` (V14).
3. تقريب IQD للبيع المباشر الخالص النقديّ الكامل: **الواجهة تُقرّب** + العلم للخادم؛ والسلّة المختلطة **بلا تقريبٍ** مُثبَّتةٌ باختبار (V1، §٧.٥).
4. تمرير `shiftId` المُتحقَّق منه إلى `createWorkOrderInTx` (V4) — سلّةٌ واحدة ⇒ درجٌ واحد.
5. `idx_invoice_shift` + تصحيح التعليق الكاذب «مفهرَس» (V2).
6. رفع `sinceDays` المثبَّت + حارس `searchSettled` على Enter.
7. حظرٌ خادميٌّ لـ`feeCollection='COUNTER'` على `dispatchInvoice` حتى ش٦ (V15).

**اختبارات:** I13 · I21 · بيع استقبالٍ نقديّ بإجماليّ **٤٧٬٤٠٠ ⇒ ٤٧٬٥٠٠** (تقريبٌ لأعلى) لزبونٍ عابر ⇒ **ينجح** والوردية تُغلق بفارق صفر · وبإجماليّ ٤٧٬٣٠٠ ⇒ ٤٧٬٢٥٠ (لأسفل) · سلّةٌ مختلطة ⇒ **بلا تقريب** (تثبيت السلوك) · مديرٌ يمرّر `shiftId` لوردية غيره ⇒ الفاتورة والعربون على **درجٍ واحد** · `EXPLAIN` يستعمل `idx_invoice_shift`.

**القبول:** جولة E2E حيّة: (أ) عربونٌ + أجرةٌ COUNTER ⇒ إلغاء ⇒ **المبلغ المردود = العربون بالضبط**؛ (ب) بيعٌ نقديٌّ بإجماليٍّ يقرَّب **لأعلى** ⇒ الإغلاق ينجح بفارق صفر؛ (ج) فاتورةٌ آجلةٌ بعميل ⇒ إسنادٌ ⇒ توريد ⇒ `reconcile drift = 0`.

---

### ش١ — ورشة الفواتير وشكل المحطة (بلا مالٍ جديد)

**القيمة:** «يرى الموظّف الفواتير مثل كاشير التجزئة ويقوم عليها بالإجراءات» — أوّل مطلبٍ للمالك يصل أولاً.
**الحجم:** كبير (~٥-٧ أيام) · **بلا هجرات** · **التبعيات:** لا شيء (ش٠ مفيدةٌ لا لازمة).

**النطاق:**
- `reception.invoiceQueue` (keyset + فلاتر + join التوصيل) على `workordersCashierProcedure`؛ و**حذف `delivery.receptionQueue` في نفس الـPR** (V16).
- **`reception.collectOnInvoice`** (حلّ V8) + حوارٌ يسمّي الدرج + عمود «قَبَضَها».
- تبويبات الورش على رأس السلة · لوحة الدفع لا تُغطّى · سُلَّم الاحتواء وبوّابة القبول عند ٧٦٨px × ١٠٠/١٢٥/١٥٠٪.
- **م٤:** حذف الكمية/٪ + حقل المبلغ النصّيّ + الخصم داخل الصفّ **برقائق تقف عند ١٠٪** + حوار اعتمادٍ استباقيّ + تدقيقٌ لكل خصمٍ >=١٠٪.
- نافذة الإيصال + F9/F12 + شارة آخر فاتورة + سحبٌ نقديّ + إجراءات الصفّ الستّ (كلّها إعادة استعمال) + `AppSelect` + الإتاحة.
- **`Reception.tsx` يُفكَّك** إلى `components/reception/*` — **شرطٌ للتنفيذ لا تحسينٌ لاحق** (٢٤٧٠ سطراً يُعاد بناء نصفها عبر أربع شرائح = مغناطيس تعارض).

**اختبارات:** keyset + عزل الفرع + `perf.explain.test.ts` · فاتورة أمس قابلةٌ للوصول · **`reception_clerk` ينجح في التسديد و`print_operator` لا يرى الزرّ** · `warehouse`/`user`/`auditor` ⇒ FORBIDDEN على الطابور (I19) · تسديدٌ بـ`clientRequestId` مكرَّرٍ لا يزدوج · `check:orphans` أخضر.

**القبول:** موظّف استقبالٍ بقالب `reception_clerk` يبحث عن فاتورةٍ من أمس، يعيد طباعتها، **ويسدّد عليها دفعةً فعلياً** بلا مغادرة المحطة وبلا فقد سلّته؛ ولوحة الدفع مرئيّةٌ طوال ذلك عند ٧٦٨px وزوم ١٥٠٪.

---

### ش٢ — المسوّدة المُرقّاة (صفر أثرٍ ماليّ)

**القيمة:** الطلب يُفتَح ويُعدَّل بحرّية، ينجو من إعادة التحميل، ويكمله موظّفٌ آخر من جهازٍ آخر — **بلا أن يفقد الكاشير قدرته على البيع دون اتصال**.
**الحجم:** كبير · **هجرة 0154** · **التبعيات:** ش١ (التفكيك).

**النطاق:**
- حزمة `server/services/reception/` + العقود الخمسة · `version` + إعادة الحساب الخادمية · `draftSync` بالجملة بـdebounce.
- **الترقية عند الحاجة** (§٨.٢): السلّة محليّةٌ بالافتراض؛ الترقية عند قبض/تبويبٍ ثانٍ/حفظٍ صريح/صور تصميم.
- شريط الطلبات داخل سُلَّم الاحتواء + ملكية المسوّدات في الواجهة (§٨.٢).
- **قالب طباعة المسوّدة المنفصل** + حارس `printReceipt` (§١٠).
- `logAuditTx` بقبل/بعد على كل تغيير سعرٍ أو مبلغٍ أو حذف بند · كنّاسٌ ليليٌّ لـ`EXPIRED` **لا يمسّ المموّلة**.
- مدخل `getProductUsage` (V17) + FKs صريحة.

**اختبارات:** I1 · I9 · I18 · I22 · تصادم `version` ⇒ CONFLICT بلا طمس · الإجماليات لا تُقرأ من الحمولة · Z-report للوردية لا يتغيّر · لا استعلام قائمةٍ ينتقي `designImages` · **مسحُ ١٢ باركوداً متتابعاً بإيقاع الماسح ⇒ ١٢ سطراً بلا CONFLICT**.

**القبول:** فتح مسوّدةٍ على جهاز أ، إكمالها على جهاز ب، وZ-report الوردية لم يتحرّك فلساً؛ **وقطعُ الشبكة أثناء ذلك لا يمنع بيعاً نقدياً جديداً**.

---

### ش٣ — التثبيت

**القيمة:** المسوّدة تصير مساراً إنتاجياً بذرّيةٍ كاملة.
**الحجم:** متوسّط · **بلا هجرات** · **التبعيات:** ش٢.

**النطاق:** استخراج `checkoutReceptionInTx` (ميكانيكيّ، صفر تغييرٍ سلوكيّ) · `draftCommit` بـ`FOR UPDATE` + `expectedTotal` + `commitRequestId` الخادميّ · **إعادة التشغيل تُعيد البناء من مفاتيح idempotency** (ملاحظة ٢.١٠) · **رفض `couponCode`** خادمياً على هذا المسار · حارس القاعدة ٧ · زرّ التثبيت.

**اختبارات:** I8 · نفس المدخل عبر المسارين (القديم/المسوّدة) يُنتج **مستنداتٍ متطابقة** · انحدار `offline.replayReception` أخضر (I20) · تثبيتٌ ووردية تُغلق متزامنَين ⇒ **لا deadlock** · كوبونٌ مع تثبيتٍ ⇒ رفضٌ صريح.

**القبول:** مسوّدة ⇒ تثبيت ⇒ فاتورة + أوامر شغلٍ صحيحة؛ وإعادة الطلب نفسه تُعيد **نفس** أرقام أوامر الشغل والفاتورة (لا مصفوفةً فارغة).

---

### ش٤ — العرابين (المال)

**القيمة:** عربونٌ بأيّ طريقةٍ على أيّ طلب، **يصل هدفه فعلاً**، موثَّقٌ في التذكرة، ولا يُخرج نقداً بلا سند.
**الحجم:** كبير · **هجرة 0155** · **التبعيات:** ش٣.

**النطاق:**
- `orderPayments` (§٥.٣) · `collectDeposit` بوردية **RECEPTION مُلزَمة** (V12، بما في ذلك المدير للنقد) · **`refundDeposit`** (بطريقة القبض حتماً، مربوطاً بإيصاله، بمبلغٍ <= المقبوض).
- **`preCollected` في `createSaleInTx`/`createPrintSaleInTx`/`createWorkOrderInTx`** (§٧.٢) — حلّ الحاصرتين.
- `allocateAtCommit` + `resolveWorkOrderDeposit` ⇒ `deliver.ts`/`cancel.ts` تقرآن الحقيقة لا الصدفة.
- **`moneyLocked`** وحرّاسه · إلغاء مسوّدةٍ مموّلةٍ ذات بنود `GOODS` **مديريٌّ بسببٍ يسمّي البنود**.
- **`isPreInvoiceHoldReceipt()`** دالّةٌ مُصدَّرةٌ واحدة يستهلكها **ثلاثة** قرّاء: `reconcileService` + `arAging.customerPaymentLink` + `customerOpeningBalance` (V5+V6) + سطر إفصاحٍ في الكشف.
- سطرا التذكرة (مدفوعٌ مقدماً / المتبقّي) · تصنيف `DRAFT_DEPOSIT` في حساب البطاقة · سطر إفصاح Z-report (I14).
- **كاشف «مسوّدات مموّلةٌ أُلغيت أو انتهت بلا تثبيت — لكل مُنشئ»** في `anomalyWatch` (نمط D7) — **يُشحن مع الميزة لا بعدها**.

**اختبارات:** I2 · I3 · I4 · I5 · I6 · I7 · I11 · I12 · I17 · حذف بندٍ بعد قبضٍ ⇒ مرفوض · خفض الإجمالي دون المقبوض ⇒ مرفوض · عربون بطاقة ⇒ `cashBucket=NULL` ⇒ خارج `computeExpectedCash` · ردّ غير نقديٍّ نقداً ⇒ مرفوض · عربونٌ نقديٌّ ووردية مفتوحةٌ نوعُها RETAIL ⇒ **مرفوض برسالةٍ صريحة** · مديرٌ بلا وردية يقبض نقداً ⇒ مرفوض.

**القبول:** E2E: عربون ٥٠٬٠٠٠ نقداً على مسوّدةٍ فيها بيعٌ مباشرٌ ودرعان ⇒ محاولة حذف بندٍ ترفض ⇒ تثبيت ⇒ **إيصالٌ واحدٌ لا اثنان** ⇒ الوردية تُغلق بفارق صفر ⇒ التسليم يُصدر فاتورةً بمتبقٍّ صحيح ⇒ مطابقة الذمم بانحرافٍ صفر.

---

### ش٥ — رصيد الاتصال (زين) [يتوازى مع ش٢–ش٤]

**القيمة:** طريقة دفعٍ خامسةٌ بحسابٍ يُطابَق دورياً، بلا أن تلمس الدرج، **وبضوابطها معها لا بعدها**.
**الحجم:** متوسّط · **هجرة 0156 + extras** · **التبعيات:** لا شيء (لا تلمس المسوّدة).

**النطاق:**
- `receipts.paymentMethod += 'TELECOM'` **في الهجرة المرقّمة** + نسخة extras آخر القائمة (V10) + فحصٌ في `db:verify`.
- `cardReconciliations.accountKind` + تعميم `cardAccountService` بمُعامل `accountKind` (لا مرآةٌ منسوخة — عقيدة النواة المشتركة: `similarMatch.ts`, `openingBalance.ts`).
- **ضوابط §٩.٤ كاملةً داخل هذه الشريحة**: `telecomSenderPhone` مُطبَّع + سقفٌ لكل عملية + سقفٌ يوميّ + قفلٌ عند تقادم المطابقة + **الكاشف** + حارس «زين حصراً» خادميّ + تأكيدٌ ثانٍ.
- **ستّة مواضع لا بدّ منها وإلّا اختفى المبلغ (V19):** `PAY_METHOD_AR` (خادميّ ×٢) · `treasury/paymentBreakdown.ts` (المصفوفة الثابتة ⇒ مشتقّةٌ من مصدرٍ واحد) · أعمدة التفكيك في `reportsFinancialService.ts` · `client/src/lib/paymentMethod.ts` · `components/invoice/types.ts` · كل `z.enum` في مسارات **القراءة**.
- تبويبٌ في شاشة حساب البطاقة + طيّ الطرق النادرة في لوحة الدفع (§٨.٣).

**اختبارات:** I15 · I23 · I24 · الرصيد المشتقّ = Σ الإيصالات − Σ التسويات · مرجعٌ مكرَّرٌ مرفوض · تجاوز السقف (لكل عملية ولليوم) مرفوض · التسوية بفرقٍ != صفر تُنشئ سنداً بـSOD.

**القبول:** قبضٌ برصيد اتصالٍ ⇒ الوردية تُغلق بفارق صفر ⇒ **يظهر بالعربية في تفكيك الخزينة وتقرير الخزينة المالي** ⇒ كشف حساب زين يعرضه ⇒ تسويةٌ نقدية تستنزفه ⇒ الكاشف ينذر عند تجاوز نسبة موظّف.

---

### ش٦ — الربط البينيّ والإنتاجية

**القيمة:** طلبٌ هاتفيٌّ واحدٌ بخطوةٍ واحدةٍ بدل ثلاث؛ وشذوذٌ يُنذَر لا يُسجَّل صامتاً.
**الحجم:** متوسّط · **بلا هجرات** · **التبعيات:** ش١ + ش٣ (+ش٤ للكواشف).

**النطاق:**
- **`deliveryFeeHeld` في `ReceptionCheckoutInput`**: إيصال IN مستقلٌّ عن الفاتورة + قيد `DELIVERY_FEE_HELD` بـ`dedupeKey DELIVERY_FEE_HELD:INV:{invoiceId}` — مرآةً حرفيةً لـ`workOrder/create.ts:174-193` ⇒ **يُرفَع حظر COUNTER** من ش٠ (V15).
- كتلة التوصيل على مستوى الطلب + تسلسل `dispatchInvoice` بعد التثبيت + وسم «بانتظار الإسناد» عند الفشل (مشروطٌ بإغلاق V14 في ش٠).
- **تقريب السلّة المختلطة** (`cashRoundingOverride` على مدخل البيع — فرقُ تقريب السلّة كلّها يُحمَّل على فاتورةٍ واحدة).
- هويّة مُقِرّ السعر + تدقيقه (§٩.٣).
- ثلاثة كواشف في `reportsAlertsService`: خفضُ إجماليٍّ بعد قبض · مسوّدةٌ مموّلةٌ `OPEN` >٢٤س · تركّز التسديدات على فواتير الغير لكل موظّف.
- سطرا «مسوّدات مموّلة» و«عرابين غير مُسلَّمة» في تقرير إقفال اليوم + «متوسط الخصم اليدويّ لكل موظّف».

**القبول:** طلبٌ بضاعةٍ خالصٌ بتوصيلٍ وأجرةٍ COUNTER ⇒ الوردية تُغلق **بفارق صفر** · وفشلُ الإسناد بعد تثبيتٍ ناجحٍ يظهر موسوماً بإعادة محاولة لا مبتلَعاً.

---

## ١٤. سجلّ الهجوم — الحكم على الملاحظات الثلاث والثلاثين

**المحصّلة:** ٣٣ ملاحظة · **٢٩ مؤكَّدةٌ كما وردت** · **٤ مؤكَّدةٌ بتشخيصٍ أو نطاقٍ مصحَّح** · **صفر مرفوضةٍ في الادّعاء** · **٥ وصفاتٍ علاجيةٍ مرفوضة** (الادّعاء صحيحٌ والعلاج المقترح لا). سبب علوّ النسبة أنّ الهجوم كُتب **مقابل الكود** لا مقابل الوثيقة.

### ١٤.١ الحاصرات الستّ — كلّها معالَجة

| # | الحاصرة | المعالجة | القسم |
|---|---|---|---|
| **ح١** | حدّ التثبيت بلا تمثيلٍ لمالٍ قُبض سلفاً ⇒ إمّا إيصالٌ ثانٍ يمنع إغلاق الوردية أبداً، وإمّا رفضٌ حتميّ والمال محبوسٌ بـ`moneyLocked` | مُعامل `preCollected` يُحتسَب **قبل** حرّاس البيع الآجل والائتمان، ولا يُنشئ إيصالاً بل يربط القائم | §٧.٢، I5 |
| **ح٢** | عربون المسوّدة لا يصل أوامر الشغل إطلاقاً ⇒ مطالبةٌ مزدوجة عند التسليم وصفرُ استردادٍ عند الإلغاء | `allocateAtCommit` يكتب `workOrders.deposit` فعلياً + `depositPreCollected` يمنع الإيصال المزدوج + `resolveWorkOrderDeposit` | §٧.٢، I6 |
| **ح٣** | قيمة enum `TELECOM` في extras وحدها **لا تصل الإنتاج أبداً** (`prod:deploy` بلا `db:migrate:extra`) وCI يبقى أخضر | الـenum في **الهجرة المرقّمة** + نسخة extras لـCI + فحصٌ في `db:verify` + قاعدةٌ معمَّمة | §٥.٥، I23 |
| **ح٤** | «التبويب = مسوّدةٌ خادمية» يقتل التقاط البيع أوفلاين المدموج قبل يومين | **السلّة محليّةٌ بالافتراض والمسوّدة مُرقّاةٌ عند الحاجة** + `draftSync` بالجملة | §٨.٢، I18 |
| **ح٥** | `reception_clerk` يفشل على `sales.pay` (`sales:"READ"` مقابل اشتراط `FULL`) ⇒ أوّل مطلبٍ للمالك يسقط للدور المسمّى باسم المحطة | `reception.collectOnInvoice` خلف `workordersCashierProcedure` تفوّض إلى `processPayment` بحصرٍ بنيويّ | §٩.٢ |
| **ح٦** | I14 تُجمّد الوردية ليلاً بلا مخرج (لا تثبيت، لا إلغاء، لا نقطة نهايةٍ للردّ) | **المسوّدة المموّلة لا تمنع الإغلاق** (المال في `receipts` أصلاً) + `refundDeposit` في ش٤ | §٧.٤، I14 |

### ١٤.٢ الملاحظات المصحَّحة التشخيص أو النطاق

| # | ما ادّعاه الهجوم | التصحيح بعد قراءة الكود | الحكم |
|---|---|---|---|
| ١.٤ | «ازدواج ذمّةٍ حقيقيّ: الفاتورة على العميل وعلى المندوب معاً» | **رصيد المندوب عهدةٌ لا ذمّة** — `dispatch.ts:110` يقول ذلك صراحةً، فليس ازدواجاً أثناء الترانزيت. **العلّة الدائمة الحقيقية:** `remittance.ts` لا يستدعي `adjustCustomerBalance` إطلاقاً (V14) بينما `courier.ts:191` يستدعيه ⇒ ذمّةٌ لا تُغلق أبداً | **مؤكَّدةٌ بتشخيصٍ مصحَّح** — العلاج في `remittance.ts` لا في حظر الإسناد (ش٠ بند ٢، I21) |
| ٢.٥ | «`depositReceiptId` المفرد متناقضٌ مع الدفعات المتعدّدة ⇒ استبدله بفلترة `referenceNumber NOT LIKE`» | العمود **صحيحٌ تماماً** للمسار الذي يُنشئ إيصالاً واحداً بالضبط (`createWorkOrderInTx`)، وهو أنظف إصلاحٍ فوريٍّ لـV3. والفلترةُ النصّية هشّةٌ (تعود مع أيّ رابطٍ رابع) | **مؤكَّدة جزئياً**: العمود يبقى في ش٠؛ وحقيقةُ الدفعات المتعدّدة تنتقل إلى `orderPayments` في ش٤ |
| ٢.٦ | «انقلاب ترتيب أقفال ⇒ deadlock حقيقيّ لا نظريّ» | `SELECT` بلا `FOR UPDATE` قراءةٌ اتّساقيةٌ بلا قفلٍ في InnoDB ⇒ لا جمودَ بالضرورة. لكن أيّ تنفيذٍ **صحيح** لـI14 (بلا سباق) يلزمه `FOR UPDATE` ⇒ الجمود يصير حتمياً | **مؤكَّدةٌ شرطياً** — والقرار (إسقاط الحظر) يمحو سببها من الجذر |
| ٣.٦ | «تسرّب ١٥٪ من إيرادٍ شهريٍّ ١٠٠ مليون = أكثر من نصف الهامش» | **الآلية مؤكَّدة** (V13: `gt` ⇒ ١٥٪ تمرّ بلا اعتماد ولا تدقيق). **الرقم مُختلَق** — لا مصدر لمبيعاتٍ شهريةٍ بـ١٠٠ مليون في الكود ولا في وثائق المشروع | **مؤكَّدةٌ في الآلية، مرفوضةٌ في التقدير** — العلاج (سقف ١٠٪ + تدقيق) مأخوذٌ بالكامل |

### ١٤.٣ باقي الملاحظات المؤكَّدة ومعالجتها

| # | العنوان | المعالجة |
|---|---|---|
| ١.٣ / ٢.٤ | `cashRoundIQD` بلا تقريبٍ عميليٍّ يرفض كل سلّةٍ تُقرَّب لأعلى | الواجهة تُقرّب أوّلاً + معيار قبولٍ في **الاتجاهين** + حالة الزبون العابر (§٧.٥، ش٠) |
| ١.٥ | أجرة COUNTER على مسار الفاتورة: OUT بلا IN | حظرٌ خادميٌّ في ش٠ + `deliveryFeeHeld` في ش٦ (V15) |
| ١.٦ | `collectDeposit` قد يهبط على درجٍ غير درج الاستقبال أو على الخزينة | وردية RECEPTION مُلزَمةٌ بـ`requireOpenShiftIdTx` بما في ذلك المدير للنقد (V12، ش٤) |
| ١.٧ | `delivery/dispatch.ts:169` موقعٌ ثالثٌ خارج نطاق ش٠ | أُضيف صراحةً (V3، ش٠ بند ١) |
| ١.٨ | الكوبون يُطبَّق داخل `createSaleInTx` فينسف `expectedTotal` وأرضية `moneyLocked` | **رفضٌ خادميٌّ للكوبون** على مسار `draftCommit` في v1 + حارس القاعدة ٧ المطلق (§٧.٣) |
| ١.٩ / ٢ | عربونٌ لعميلٍ مسجَّل يشوّه كشف الحساب أيضاً لا المطابقة وحدها | `isPreInvoiceHoldReceipt()` مُحدِّدٌ واحدٌ لثلاثة قرّاء + سطر إفصاح (V5+V6، I11) |
| ٢.٧ | نقل الطابور بلا حذف القديم يُحمّر `check:orphans` | حذف `delivery.receptionQueue` في نفس الـPR (V16، ش١) |
| ٢.٨ | خفض بوّابة الطابور إلى `workordersReadProcedure` توسيعٌ صامت | البوّابة تبقى `workordersCashierProcedure`؛ و`workordersReadProcedure` **لا تُستعمل إطلاقاً** (V9، §٦) |
| ٢.٩ | `getProductUsage` لا يعرف أسطر المسوّدة | مدخلٌ صريحٌ محصورٌ بـ`OPEN` + FKs معلَنة (V17، §٥.٢) |
| ٢.١٠ | إعادة التشغيل تُعيد `workOrderIds` فارغة | إعادة البناء من `commitRequestId` بمنطق `isCompleteReplay` (§٧.٣، I8) |
| ٢.١١ | `TELECOM` تسقط من التفكيك والتقارير والواجهة | ستّة مواضع + **اختبار مسحٍ آليّ** (V19، I24) |
| ٣.٣ | التحرير سطراً-سطراً بـ`version` يهدم المسح السريع | `draftSync` بالجملة بـdebounce + اختبار ١٢ مسحة (§٦، ش٢) |
| ٣.٤ | المسوّدة حاويةُ نقدٍ بلا مخزونٍ ولا فاتورة | ثلاثة ضوابط في ش٤: ردٌّ بطريقةٍ واحدةٍ مربوط · إلغاءٌ مديريٌّ بسببٍ يسمّي البنود · كاشفٌ يُشحن مع الميزة |
| ٣.٥ | طباعةُ مسوّدةٍ = إيصالٌ مزوَّرٌ فعلياً | قالبٌ منفصل + حارسٌ في `printReceipt` (§١٠) |
| ٣.٧ | شريط الطلبات «يُموَّل» بشريطٍ محذوفٍ أصلاً | يدخل سُلَّم الاحتواء + بوّابة قبولٍ عند ٧٦٨px (V18، §٨.١) |
| ٣.٨ | TELECOM تُشحن قبل كاشفها | كل ضوابط §٩.٤ داخل ش٥ |
| ٣.٩ | خامسُ زرِّ دفعٍ يخالف «لا يُصغَّر أبداً» | صفّان × <=٣ أو طيّ النادرتين + تأكيدٌ بالكلمات (§٨.٣) |
| ٣.١٠ | إعادة الطباعة ليست كتابةً فلا تُحكَم بالملكية | تتبع نطاق القراءة (§٨.٥) |
| ٣.١١ | I11 مُثبَتٌ بمسحٍ في مجلّدٍ فارغٍ ⇒ يستحيل أن يفشل | أُعيدت صياغته **بالأثر على `server/**`** مع تسمية `workOrder/cancel.ts` باباً قائماً (I17) |
| ٣.١٢ | التسديد يهبط في درج الفاعل بلا أن تقول الشاشة | سطرٌ إلزاميٌّ في الحوار + عمود «قَبَضَها» (§٨.٥) |
| ٣.١٣ | «عشرون مسوّدةً مفتوحة» بلا سقفٍ ولا ملكية | شريطٌ لمسوّداتي بحدّ ٥ + تأكيدٌ مسمّى عند فتح مسوّدة زميل + وسمٌ للمموّلة (§٨.٢) |

### ١٤.٤ وصفاتٌ علاجيةٌ مرفوضة (الادّعاء صحيحٌ والعلاج لا)

1. **حظر إسناد التوصيل لكل فاتورةٍ بعميلٍ مسجَّل** (١.٤) — يعطّل حالةً مشروعةً تماماً؛ العلاج في `remittance.ts`.
2. **استبدال `depositReceiptId` بفلترة `referenceNumber NOT LIKE 'DLV-FEE-%'`** (٢.٥) — تعود الهشاشة مع أيّ رابطٍ رابع.
3. **رفع `reception_clerk.sales` إلى `FULL`** (٢.٣/٣.١) — يفتح المرتجعات ويخالف نيّة القالب المعلنة.
4. **عمود على `shifts` أو JOIN لربط المسوّدة بالوردية داخل قفل الإغلاق** (٢.٦) — يبني الجمود بدل تجنّبه.
5. **جدولٌ ثانٍ `receptionOrderEvents` لسجلّ التغييرات** — `logAuditTx` يفعلها بلا جدولٍ ثانٍ ومع `ipAddress` وتوحيدٍ مع ٣٧ راوتراً.

### ١٤.٥ ما أُبطل من التصميم الأول بفعل الهجوم

| البند الأصليّ | الحكم النهائيّ |
|---|---|
| C1: «التبويب = مسوّدةٌ خادمية لا حالة متصفّح» | **أُبطل** ⇒ محليٌّ بالافتراض، مُرقّى عند الحاجة (ح٤) |
| C12: كتابةٌ محكومةٌ بالملكية (تسديد/إسناد/طباعة) | **أُبطل** ⇒ نطاق الفرع + إفصاحٌ يسمّي الفاعل؛ المنع الصلب للعكس الماليّ فقط |
| I14: «إغلاقٌ مرفوضٌ مع مسوّدةٍ مموّلة» | **أُبطل** ⇒ لا يمنع الإغلاق؛ يمنع الكنّاس ويُفصح في Z-report (ح٦) |
| I11: مسحٌ في `server/services/reception/**` | **أُبطل** ⇒ مسحٌ بالأثر على `server/**` (I17) |
| `workordersReadProcedure` لقراءة الطابور | **أُبطل** ⇒ توسيعٌ صامتٌ لثلاثة قوالب (V9) |
| إبقاء `delivery.receptionQueue` «للتوافق» | **أُبطل** ⇒ تُحذف في نفس الـPR (V16) |
| «رقائق ٥/١٠/١٥/٢٠٪» | **أُبطل** ⇒ تقف عند ١٠٪ (V13) |
| `cashRoundIQD` بتمرير العلم وحده | **أُبطل** ⇒ الواجهة تُقرّب أوّلاً (V1) |
| موقعان لإصلاح التقاط العربون | **أُبطل** ⇒ ثلاثة (V3) |
| الكوبون مسموحٌ على مسار التثبيت | **أُبطل** ⇒ مرفوضٌ خادمياً في v1 |
| «بند `targetType='WORKORDER'` قابلٌ للإسقاط إن ضاق الوقت» | **أُبطل** ⇒ إلزاميّ (ح٢) |

### ١٤.٦ ما بقي مُسقَطاً عمداً (حشوٌ لا يخدم المطلب)

`CUSTOMER_DEPOSIT`/`_APPLIED` + حساب 2400 (مفرداتُ دفترٍ جديدةٍ بنصف قطر انفجارٍ عبر كل قارئٍ يُبوِّب بـ`entryType`؛ ومطلب م٢ محقَّقٌ بـ`PAYMENT_IN`) · إحياء `receipts.reservationId` للعربون (الحجز دورةُ حياةٍ أخرى) · حجز ATP ناعمٌ من المسوّدة · `F6/F7/F8/Alt+1..9` · `airtimeAccountService` منسوخاً · `receipts.receptionDraftId` عموداً · مفتاح وحدة `reception` + أربع بوّاباتٍ جديدة · جدول `priceApprovals` · مسار إلغاء فاتورة (void) · ورشتا الحجوزات والرسائل داخل المحطة · عدّاد زمن انتظارٍ لكل طلب.

---

## ١٥. المخاطر المتبقّية (مرتّبةً)

1. **`enforceCashGovernance:true` يحوّل كل خطأٍ نقديٍّ إلى تعطيلٍ تشغيليّ.** كل مسارٍ نقديٍّ جديدٍ يلزمه سؤالٌ واحدٌ قبل الدمج: «هل تُغلق الوردية بفارق صفرٍ بعده؟» — **I7 هو الجواب المؤتمَت**.
2. **`preCollected` يمسّ ثلاث خدماتٍ ماليةٍ في آنٍ واحد** (`createSaleInTx`, `createPrintSaleInTx`, `createWorkOrderInTx`). سهوٌ في واحدةٍ ⇒ إيصالٌ مزدوجٌ أو ذمّةٌ منفوخة. التخفيف: I4+I5+I6 مع اختبارٍ لكلّ خدمةٍ على حدة، والمرآة الحرفية لـ`deliver.ts:145-153` في الربط.
3. **`isPreInvoiceHoldReceipt` مُحدِّدٌ بنيويٌّ هشّ** — أيّ رابطٍ رابعٍ مستقبليّ (حجز/بكج) يكسر المطابقة صامتاً مجدداً. لذلك دالّةٌ مُصدَّرةٌ واحدةٌ بتعليقٍ يُلزم من يضيف رابطاً بتحديثها، وثلاثةُ مستهلكيها مُسمَّون.
4. **`when` أصغر من آخر مدخلٍ ⇒ تجاهلٌ صامتٌ في الإنتاج بلا خطأٍ ولا CI يمسكه.** أربع هجراتٍ متسلسلةٍ هنا = أربع فرصٍ للفخّ.
5. **حرّاس CI:** `check:money-schemas` · `UNIQUE_AR` لخمسة قيود · `check:authz` (صفر مدخلٍ جديد — مكسبٌ مقصود) · `check:orphans` (نقلٌ = حذفٌ في نفس الـPR) · `check:date-boundaries` · `check:emoji` · `check:colors` · `check:form-inputs`.
6. **`Reception.tsx` ٢٤٧٠ سطراً يُعاد بناء نصفه عبر أربع شرائح** ⇒ مغناطيس تعارض. التفكيك في ش١ **قبل** التزاحم شرطٌ لا تحسين.
7. **الخطر الأكبر ليس تقنياً بل قبولياً:** `moneyLocked` وسقفُ الخصم ١٠٪ وإلزامُ وردية RECEPTION للعربون ستبدو تضييقاً مقارنةً بحرّية اليوم. إن لم تُشرَح كقواعد يوم الإطلاق، طُلب تخفيفها بعد أسبوع — وتخفيفُ ضابطٍ مانعٍ بعد التسليم أصعبُ سياسياً من عدم بنائه.
8. **رصيد الاتصال يبقى — حتى بضوابطه — أضعفَ طرق الدفع إثباتاً.** الضوابط تُصعّب لا تمنع؛ المطابقة الأسبوعية هي خطّ الدفاع الحقيقيّ.

---

## ١٦. قراراتٌ مؤجَّلةٌ تحتاج المالك (لا تُحسَم تقنياً)

| # | القرار | الوضع الحاليّ | لماذا يحتاج المالك |
|---|---|---|---|
| **ق١** | **إلغاء فاتورة (void)** | الأعمدة `invoices.cancelledBy/cancelledAt/cancelledByNameSnapshot` موجودةٌ **بلا سياسة**؛ لا مسارَ إنتاجيّ | بناؤه = اختراع سياسةٍ ماليةٍ بلا تفويض. الحاليّ: العكس بمرتجع (مدير) |
| **ق٢** | **سياسة COD لفاتورةٍ بعميلٍ مسجَّل** | ش٠ تُغلق الثغرة بخفض الذمّة عند التوريد؛ ويبقى السؤال: هل يُسمح أصلاً بإسناد فاتورةٍ **آجلة** لمندوب، أم COD مقصورٌ على الزبون العابر (نمط `dispatch.ts` الذي يُصفّر `customerId` عمداً)؟ | سياسةٌ ماليةٌ لا اختيارٌ تقنيّ |
| **ق٣** | **توزيع العربون على أوامر الشغل** | **مُعتمَدٌ افتراضياً (٥/٨، «اكمل حسب الخطة»):** جشعٌ بترتيب السلّة والواجهة تعرضه بأمانة — قابلٌ للنقض بقرار مالكٍ لاحق | البديل (بالنسب) يغيّر ما يراه الزبون على تذكرته |
| **ق٤** | **مدّة صلاحية المسوّدة** | **مُعتمَدٌ افتراضياً (٥/٨):** ٢٤ ساعةً للفارغة، والمموّلة لا تُطوى أبداً | قرارٌ تشغيليّ |
| **ق٥** | **سقف رصيد الاتصال** (لكل عملية ولليوم لكل موظّف) وعمر المطابقة الأقصى | مقترحٌ بـENV | أرقامٌ يملكها المالك وحده |
| **ق٦** | **عزل الموظّف في الطابور** | الافتراض المشحون: **قراءةٌ وإجراءاتٌ بنطاق الفرع + إفصاحٌ يسمّي الفاعل**؛ العكس الماليّ مديريّ | قابلٌ للانعكاس براية واحدة إن أراد المالك تضييقاً |
| **ق٧** | **`isOwner`** | يبقى المسار الوحيد الذي يُخرج مالاً بفاعلٍ واحد — **لا يُوسَّع هنا ولا يُغلق هنا** | مخالفةٌ مسجَّلةٌ في `docs/authz/08-sod-matrix.md:69` |
| **ق٨** | **إدراج `EXCHANGE` وطرق الدفع النادرة** في لوحة الاستقبال | خارج النطاق؛ الاستقبال يقبل خمساً بعد ش٥ | لا حاجةَ معلنة |

---

## ملحق أ — قائمة تحقّقٍ قبل كل دمج في هذه الحملة

1. `pnpm check` **و** `pnpm build` (الأخير يمسك أخطاء JSX التي لا يمسكها `check`).
2. `TZ=UTC pnpm test` **كاملةً** — لا ملفاتٍ منتقاة (`npx vitest run` بلا TZ يُحمّر اختبارات التاريخ زوراً ويُخفي الحرّاس).
3. `pnpm check:emoji` · `check:colors` · `check:money-schemas` · `check:authz` · `check:orphans` · `check:date-boundaries` · `check:form-inputs`.
4. `pnpm test:db:init` بعد أيّ تغيير مخطّط (لا `db:push` تزايديٌّ على قاعدةٍ منجرفة).
5. جولةٌ بصريةٌ حيّة على **٧٦٨px ارتفاعاً × ١٠٠/١٢٥/١٥٠٪** مع لقطةٍ تُثبت ظهور زرّي الفعل.
6. لكل هجرةٍ جديدة: `when` أكبر من آخر مدخل · مدخل `UNIQUE_AR` لكل قيدٍ فريد · قيمة enum في **الهجرة المرقّمة** + extras.
7. `gh pr checks` صراحةً — `watch exit 0` ليس CI أخضر؛ ولا يُحذف فرعٌ قبل تأكيد `state=MERGED`.
