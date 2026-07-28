# تصميم منظومتَي الهدايا/المجانيات والحجوزات — الوثيقة الحاكمة

> **الحالة:** خطة معتمدة (٢٧ يوليو ٢٠٢٦) — لم يبدأ التنفيذ بعد. **v2**: مدموجة بمراجعة مقترح Codex (تصنيف أدق للوارد + جدول محجوز مجمّع + تعميم ATP على كل المسارات + التنفيذ الجزئي + قائمة «أبلغني عند التوفر»).
> **النطاق:** منظومتان مستقلّتان تقنياً تُبنيان **بالتوازي** (جلستان معزولتان). هذه الوثيقة = مصدر الحقيقة المشترك (نمط `docs/consignment-design-2026-07-20.md`).
> **مبنية على:** استكشاف بنيوي كامل للنظام القائم. أرقام الأسطر لحظة الكتابة — تحقّق منها قبل الاعتماد.

---

## ٠. القرارات المصيرية المحسومة (قرار المالك ٢٧/٧)

| # | القرار | الاختيار المحسوم | الأثر |
|---|---|---|---|
| ١ | أولوية البناء | **بالتوازي** — جلستان منفصلتان عبر coord | ملفات ساخنة + هجرات متتالية |
| ٢ | تقييم الهدايا الواردة | **صفر تكلفة دائماً** | يسقط تعقيد توزيع WAVG (رياضياً «صفر تُدمج في WAVG» = «توزيع مبلغ الصفقة على الإجمالي») |
| ٣ | إنفاذ الحجز على البيع | **ناعم** (تحذير + عرض ATP، بلا منع) | `createSale` لا يُلمَس؛ **نهج متدرّج** يسمح بترقية لاحقة للصارم (§٤.٦) |
| ٤ | العربون | **اختياري + مسترد بالكامل عند الإلغاء** | إلغاء نظيف بلا قيد غرامة |

**⚠️ توتر كشفه مقترح Codex (للعرض على المالك):** Codex يوصي بالإنفاذ **الصارم** ويجعل «لا يمكن بيع وحدة محجوزة لعميل آخر» **معيار نجاح**. قرار المالك (٣) هو **الناعم** ⇒ الحجز يبقى **قابلاً للاختراق بوعي** (تحذير لا منع)، فمعيار Codex هذا لا يتحقق في المرحلة الأولى. الحلّ المعتمد: **نهج متدرّج** — دالة ATP مركزية تُستدعى من كل مسار وتُظهر تحذيراً؛ الترقية للصارم لاحقاً = تبديل «تحذير» بـ«رفض» في نقطة واحدة، بلا إعادة هيكلة.

**الإعدادات الافتراضية الموصى بها (قابلة للضبط، دمج توصيات Codex):**
- مدة الحجز = **٢٤ ساعة** (Codex؛ كانت ٧٢ في v1)، تمديد حتى ٧٢ بموافقة مدير، قابلة للضبط بالفرع/نوع المنتج.
- الهاتف **إلزامي** في الحجز.
- سقف تكلفة الهدية قبل اعتماد مدير = يُضبط من الإعدادات (يبدأ محافظاً).
- الهدية الصادرة بند P&L مستقل «مصروف هدايا وترويج».
- **الوارد «منتج مختلف مجاناً»**: قرار المالك (صفر تكلفة) يحسمه؛ Codex اقترح خياراً صريحاً للمدير — مؤجَّل ما لم يطلبه المالك.

---

## ١. المشكلة والفلسفات

**المشكلة (بكلام المالك):** (أ) موردون يمنحوننا مجانيات/هدايا، ونمنح عملاءنا هدايا — بلا تتبّع/حوكمة. (ب) زبائن يتصلون لحجز منتج أو للتأكد من توفّره ثم حجزه — بلا نظام.

| المنظومة | الفلسفة العالمية | الجوهر |
|---|---|---|
| الهدايا | *Promotional expense recognition* + *Maker-Checker SOD* | الصادرة = مصروف ترويجي + شطب مخزون بالتكلفة بحوكمة اعتماد؛ الواردة = رفع مخزون بلا دين. |
| الحجوزات | *Available-to-Promise (ATP)* — *Soft Reservation* (SAP/Odoo/Shopify) | الحجز التزام منطقي لا حركة مخزون؛ المتاح = الفعلي − المحجوز. |

**المبدأ الحاكم:** لا تلاعب بالمخزون الفعلي عند الحجز، ولا هدية تخرج بلا أثر محاسبي وحوكمي مُتتبَّع.

---

## ٢. الوضع الحالي المكتشف (نقاط الربط الفعلية)

### ٢.١ المخزون
- `branchStock` (`drizzle/schema.ts` L757): عمود `quantity` int **واحد فقط** — **لا reserved/ATP**. `openedAt` لنافذة الافتتاح. `uq_stock_variant_branch`.
- `inventoryMovements` (L788): `movementType` = `[IN, OUT, ADJUST, RETURN, TRANSFER_IN, TRANSFER_OUT]` (اتجاه فقط). الدلالة في `referenceType varchar(24)` + `referenceId`.
- `inventoryService.applyMovement(tx, args)` (L103): يقفل `.for("update")`، يكتب حركة + يحدّث `branchStock` نسبياً. خيارات: `allowNegative / allowNegativeUnopened / stampOpened`.
- `convertToBaseQuantity(tx, productUnitId, quantity, variantId?)` (L188) — يُستدعى قبل `applyMovement`.
- **قراءة المتاح للكاشير:** `catalog/pos.ts` `baseSelect` (L58) — `stockBase = branchStock.quantity` **خام** (L75). **نقطة حقن ATP الوحيدة.**

### ٢.٢ الدفتر (`accountingEntries`)
- الجدول `accountingEntries` (L1470) — **لا** `sourceType/sourceId`، **لا** `businessDay`. `entryDate date`.
- `entryType` enum (L1484): `SALE, PURCHASE, PAYMENT_IN, PAYMENT_OUT, RETURN, ADJUST, OPENING, INTERNAL_USE, WASTAGE, CASH_*, DELIVERY_*, EXCHANGE_*`.
- `postEntry(tx, EntryInput)` (L58) — **يستدعي `assertPeriodOpen` داخلياً** (L60). أعمدة: `revenue/cost/profit/taxAmount/amount + FKs + dedupeKey` (unique nullable).
- `adjustCustomerBalance / adjustSupplierBalance` منفصلان.
- **قالب الشطب كمصروف** (الأهم للهدية الصادرة): `expenseService.createStockExpenseTx` (L65): `applyMovement(OUT, "EXPENSE")` + `postEntry({ entryType:"INTERNAL_USE"|"WASTAGE", cost, revenue:0, profit:−cost })`. جدول `expenses` فيه `source [CASH,STOCK]` + `stockReason [INTERNAL_USE,WASTAGE]` + category فيها `MARKETING`.
- **P&L** (`reportsFinancialService.ts`): الربح من `SALE/RETURN`، المصروفات النقدية من جدول `expenses`، خسارة المخزون من `INTERNAL_USE/WASTAGE` (L120). **⚠️ فخّ حرج: `entryType` جديد بلا إضافته لـ`LEDGER_ENTRY_TYPES` + bucket = يختفي صامتاً من صافي الربح.**
- **العمولات** (`commissions/base.ts` L40): **INNER JOIN على `invoices` عبر `invoiceId`** ⇒ قيد بلا `invoiceId` **غير مرئي للعمولة تلقائياً**.
- **قفل الفترة:** `periodLockService.assertPeriodOpen` (L46).

### ٢.٣ الحوكمة (قوالب SOD)
- **(أ) Maker-Checker `PENDING_APPROVAL`** (سندات): `voucher/create.ts` `needsApproval` (L163) صفٌّ بلا أثر؛ `approveVoucher` (L25) يطبّق الأثر + **SOD-04 (المعتمِد ≠ المنشئ، L43)** + `signatureHash`.
- **(ب) جدول طلبات مخصّص** (تسوية المخزون): `stockAdjustmentRequests` (L821) + `approveStockAdjustment` + فحص تفاؤلي.
- **(ج) تحقّق هوية مدير inline:** `saleRouter.verifyManagerApproval` (L63) + SOD-03.

### ٢.٤ العربون ودورة الحياة (قالب أمر الشغل)
- `workOrder/create.ts` (L101): `receipts(IN, workOrderId, invoiceId:NULL, cashBucket:DRAWER)` + `PAYMENT_IN [WO_DEPOSIT:x]`. `receipts.workOrderId` عمود nullable بلا FK. التسليم: `UPDATE receipts SET invoiceId` (القيد يبقى invoiceId=NULL، الدفتر إلحاقي، L138).
- **FSM:** `workOrders.status` = `[RECEIVED, IN_PROGRESS, READY, DELIVERED, CANCELLED]`. التحويل: `sourceType:"WORKORDER"` + `sourceId:"WO-<id>"` (idempotency عبر `uq_invoice_source`).

### ٢.٥ البنية العامة
- الراوترات: `appRouter = router({...})` مسطّح؛ ملفات `server/routers/<name>Router.ts`.
- الصلاحيات: `shared/permissions.ts` `PERMISSION_MODULES` + `ROLE_TEMPLATES` (١١ دوراً)؛ `moduleAccessAllowed` (L368). `trpc.ts`: `requireModule`, `requireModuleGate`, `moduleProcedure`, `reportViewerProcedure`, `branchScopedProcedure`. **مفتاح جديد = يُضاف لكل الأدوار الـ11.**
- التنقّل: `AppLayout.tsx` `NAV_LINKS` (L34) + `App.tsx` (wouter) + `RequireRole`. lucide (`Gift`, `CalendarClock`).
- الطباعة: `print.ts` `printDoc` (L40) + toolkit `docHtml.ts`. القالب الأمثل: `voucherPrint.ts` (حراري + A4).
- المهام/واتساب: `tasks/taskEvents/serviceTypes/waKeywordRules` (0107)، FSM + `autoCreate.maybeCreateTaskForInbound` + `flowNotify`.
- الهجرات: `drizzle/migrations/NNNN_*.sql` يدوية + `--> statement-breakpoint` + `_journal.json` يدوياً + مرآة `schema.ts`. **الأحدث `0113`.**
- **فجوات قائمة ذات صلة (كشفها Codex):**
  - **طلب المتجر** يفحص المخزون عند الإنشاء ويخصمه عند **الإرسال** فقط ⇒ الكاشير قد يبيعه قبل الإرسال (`docs/functional-audit-2026-07-17.md:816`). الحجز يجب أن يراعي هذا المعلّق.
  - **`customerNotes`** (`customerNoteRouter.ts:22`) تسجّل «العميل يريد المنتج» لكن **لا تحجز مخزوناً** — الحجز يسدّ هذه الفجوة فعلياً.

---

## ٣. المنظومة (أ) — الهدايا والمنتجات المجانية

### ٣.١ الوارد من المورد — خمس حالات (دمج تصنيف Codex)
| الحالة | المثال | المعالجة |
|---|---|---|
| كمية إضافية من نفس المنتج | اشترينا 10 + 2 مجاناً | المستلم 12، المستحق عن 10 (WAVG = 50,000÷12) |
| منتج مختلف كهدية | اشترينا دفاتر + أقلام مجاناً | سطر مجاني منفصل مرتبط بأمر الشراء، صفر تكلفة |
| هدية مستقلة بلا فاتورة | عيّنات/هدية من المورد | سند «استلام مجاني من مورد»، صفر تكلفة |
| **مواد للاستخدام الداخلي** | حامل عرض، قرطاسية موظفين | **لا تدخل مخزون البيع** — تُوجَّه لـ`INTERNAL_USE` |
| **عيّنة غير قابلة للبيع** | نموذج عرض / Tester | مخزون عيّنات منفصل أو استخدام داخلي — **`sellable=false`** |

> **اتساق «صفر تكلفة» (قرار ٢) مع توزيع Codex:** لنفس المنتج (10 مدفوعة + 2 مجاناً)، «إدخال الـ2 بصفر تُدمج في WAVG» = **رياضياً** «توزيع 50,000 على 12» — كلاهما يعطي قيمة دفترية ثابتة = المدفوع. لا تناقض. القرار يبسّط فقط الحالة النادرة «منتج مختلف».

**النموذج المحاسبي للوارد المستقل:** `applyMovement(IN, referenceType:"GIFT_IN")` بصفر تكلفة (يُدمج في WAVG فيخفّض المتوسط — سلوك مقصود)، **بلا قيد PURCHASE، بلا دين للمورد**. «اشترِ واحصل» لنفس المنتج = المدفوع عبر `receivePurchase` + المجاني عبر «هدية واردة». الاستخدام الداخلي/العيّنة ⇒ خارج مخزون البيع (`sellable=false` أو مسار `INTERNAL_USE`).

### ٣.٢ الصادر للعميل — سبعة أنواع (دمج تصنيف Codex)
مرتبطة بفاتورة · حملة تسويقية · عميل مميّز · تعويض عن مشكلة/تأخير · عيّنة مجانية · مستقلة بلا بيع · هدية موظف/إدارة (تتطلب موافقة).

**النموذج المحاسبي (يحاكي `createStockExpenseTx`):**
```
حركة: applyMovement(tx, { movementType:"OUT", referenceType:"GIFT_OUT", referenceId: giftVoucherId, ... })
قيد:  postEntry(tx, { entryType:"GIFT_OUT" (جديد), branchId, customerId?,
        cost: WAVG×baseQty, revenue: 0, profit: −cost, amount: cost,
        dedupeKey:`GIFT:${giftVoucherId}` })   // بلا invoiceId ⇒ خارج العمولة تلقائياً
```
- لا نقد للصندوق، لا ذمة على العميل، لا إيراد/مبيعات. تُسجَّل كمصروف «هدايا وترويج» ببند P&L مستقل.
- المرتبطة بفاتورة: تظهر على الإيصال «هدية مجانية»، ولا تُعامَل كخصم بيع عادي.
- صنف بتكلفة صفر ⇒ `cost=profit=0` (يُسجَّل كمّياً فقط).

### ٣.٣ المخطط الجديد
```sql
giftVouchers     (id, giftNumber [GFT-branch-YYYYMMDD-seq], direction ENUM('OUT','IN'),
                  branchId FK, customerId FK?, supplierId FK?, campaignId FK?,   -- ربط الحملة (Codex)
                  giftType ENUM(...), reason, sellable BOOL DEFAULT 1,           -- نوع + قابل للبيع (Codex)
                  supplierRef, estimatedValue DECIMAL(15,2)?,                    -- رقم عرض المورد + قيمة تقديرية للتقارير
                  status ENUM('DRAFT','PENDING_APPROVAL','APPROVED','DELIVERED','CANCELLED','REVERSED'),
                  totalCost, createdBy FK, approvedBy FK?, signatureHash?, createdAt)
giftVoucherLines (id, giftVoucherId FK, variantId FK, productUnitId FK,
                  quantity, baseQuantity, refSalePrice?, unitCostSnapshot, lineCost)
```
- توسعة `accountingEntries.entryType` بـ`GIFT_OUT` (migration) + `EntryType` union + **`LEDGER_ENTRY_TYPES` whitelist + bucket P&L**.

### ٣.٤ الحوكمة (منع الإساءة)
1. هدايا الحملات المعتمدة تُطبَّق ضمن شروط الحملة؛ اليدوية تحتاج سبباً.
2. هدية خارج حملة أو فوق سقف التكلفة ⇒ `PENDING_APPROVAL` بلا أثر، يعتمدها **مدير آخر** (SOD-04)؛ الموظف لا يعتمد هديته.
3. لا تعديل لسند مُسلَّم — يُعكَس بمستند معاكس (`REVERSED`).
4. `logAudit` + `signatureHash` + **كاشف شذوذ** (تركّز الهدايا لعميل/موظف).
5. مفتاح صلاحية `gifts`.

### ٣.٥ الشاشات/الطباعة/التقارير
- `GiftsHub`: تبويبات (صادرة/واردة/بانتظار اعتماد/تقرير).
- طباعة `giftVoucher.ts` (نمط `voucherPrint`) حراري + A4 + QR + توقيع.
- إشعار واتساب اختياري (`flowNotify`).
- تقارير (خلف `reportViewerProcedure`): الواردة (كميات/قيمة تقديرية/أثر WAVG/المباع لاحقاً/مقارنة الموردين)؛ الصادرة (بالفرع/الموظف/العميل/السبب/الحملة، نسبة التكلفة للمبيعات، مؤشرات الإساءة).

---

## ٤. المنظومة (ب) — الحجوزات

### ٤.١ العرض ثلاثيّ الأرقام (ATP)
الكاشير يرى ثلاثة أرقام لا رقماً واحداً:
```
الفعلي = branchStock.quantity      المحجوز = reservationStock.reservedBase      المتاح (ATP) = الفعلي − المحجوز
```
مثال: فعلي 10، محجوز 3، متاح 7.

### ٤.٢ جدول المحجوز المجمّع (دمج توصية Codex — أفضل من SUM لحظياً)
بدل حساب `SUM` عند كل قراءة، جدول تجميع لكل (variant×branch) على **نمط `branchStock` نفسه** — للأداء والتزامن:
```sql
reservationStock (id, variantId FK, branchId FK, reservedBase INT DEFAULT 0,
                  UNIQUE(variantId, branchId))
```
- يُحدَّث نسبياً (`reservedBase ± delta`) تحت قفل `.for("update")` مع كل تغيّر حجز — تماماً كما `applyMovement` يحدّث `branchStock`.
- **ثابت حرج:** `reservationStock.reservedBase` = `Σ(بنود الحجوزات النشطة)` دائماً (اختبار تسوية).
- نقطة حقن ATP في `catalog/pos.ts`: `availableBase = branchStock.quantity − COALESCE(reservationStock.reservedBase, 0)`.

### ٤.٣ دورة الحياة (FSM — دمج حالات Codex)
```
ACTIVE ──(استلام جزئي)──▶ PARTIALLY_FULFILLED ──▶ FULFILLED (نهائي)
   │                              │
   ├──────────────┬───────────────┘
   ▼              ▼
CANCELLED      EXPIRED (كنّاس تلقائي)      RELEASED (تحرير مدير يدوي لظرف مخزني)
```
- الحجز **`ACTIVE`** فور إنشائه (العربون **سمة اختيارية** لا حالة — قرار ٤). لا حذف نهائياً (تحليل/تدقيق).
- كل انتقال يكتب `reservationEvents` (append-only): حجز/تمديد/تحرير/انتهاء/تحويل.

### ٤.٤ المخطط الجديد
```sql
reservations     (id, reservationNumber [RES-branch-YYYYMMDD-seq], branchId FK,
                  customerId FK?, contactName, contactPhone NOT NULL,           -- الهاتف إلزامي (Codex)
                  channel ENUM('PHONE','WALK_IN','WHATSAPP','STORE'),
                  status ENUM('ACTIVE','PARTIALLY_FULFILLED','FULFILLED','EXPIRED','CANCELLED','RELEASED'),
                  expiresAt, depositReceiptId?, fulfilledInvoiceId FK?,
                  notes, createdBy FK, releasedBy FK?, cancelReason?, createdAt)
reservationLines (id, reservationId FK, variantId FK, productUnitId FK,
                  baseQuantity, fulfilledBase INT DEFAULT 0, remainingBase INT)   -- تنفيذ جزئي (Codex)
reservationEvents(id, reservationId FK, event, byUser FK, at, meta)               -- append-only
reservationStock (§٤.٢)
+ عمود receipts.reservationId (nullable، بلا FK — نمط receipts.workOrderId)
```
**بوحدة الأساس دائماً** (Codex): حتى لا يحجز أحدهم «درزناً» ثم يبيع آخر القطع مفردةً. **لا توسعة لـ`entryType`** (العربون = `PAYMENT_IN/OUT` القائمان).

### ٤.٥ العربون والتحويل (كليّ/جزئي) والإلغاء
```
العربون (اختياري): receipts(IN, reservationId, invoiceId:NULL) + PAYMENT_IN [RES_DEPOSIT:x]   // ليس إيراداً، خارج العمولة
التحويل (كليّ أو جزئي): createSale(sourceId:"RES-<id>") للكمية المستلمة + إعادة ربط الإيصال (بلا قيد جديد)
     ← جزئي: fulfilledBase += المستلَم، الحجز ⇒ PARTIALLY_FULFILLED؛ عند اكتمال الكل ⇒ FULFILLED
     ← تحرير reservationStock بمقدار المستلَم + خصم branchStock الفعلي في عملية واحدة (لا خصم مزدوج)
الإلغاء/الانتهاء/التحرير: reservationStock −= المتبقّي (مرة واحدة) + رد العربون كاملاً (receipt OUT + PAYMENT_OUT)
```
المتبقّي نقداً/آجلاً عبر `assertCreditLimit`.

### ٤.٦ تعميم ATP على كل المسارات (نقطة Codex الأهم — نهج متدرّج)
دالة ATP مركزية واحدة تُستدعى (عرضاً + تحذيراً ناعماً حالياً) من **كل مسار يخصم مخزوناً**، لا الكاشير فقط:
> كاشير التجزئة · خدمة العملاء · كاشير الطباعة (إن استهلك بضاعة قابلة للبيع) · طلبات المتجر · التحويل بين الفروع · مواد أوامر الشغل · الاستخدام الداخلي · الإنتاج · التالف/الهدر · أي خصم يدوي.

(استلام الشراء ومرتجع العميل يزيدان الفعلي ولا يتعارضان مع الحجز.) **الترقية للصارم** لاحقاً = تبديل «تحذير» بـ«رفض تحت القفل» في هذه الدالة المركزية فقط.

### ٤.٧ التزامن والانتهاء (أهمّ نقطة فنية)
- إنشاء الحجز يقفل `reservationStock` (و/أو `branchStock`) للـ(variant×branch) `.for("update")`؛ يفحص ATP تحت القفل؛ لا حجز فوق المتاح ولا سالب (منع صارم حتى في الوضع الناعم — الحجز نفسه لا يُنشأ فوق المتاح).
- التحويل يحرّر المحجوز ويخصم الفعلي في **عملية واحدة** (لا خصم مزدوج). الإلغاء/الانتهاء يحرّران **مرة واحدة** (idempotent — إعادة الضغط/انقطاع الشبكة لا يكرّر).
- **الانتهاء التلقائي:** كنّاس `node-cron` (نمط `waOutbox`) + **تنظيف كسول** عند أي بيع (لا ينتظر الكنّاس).
- **دمج الحجز المكرّر** (Codex): تكرار العميل لنفس المنتج ⇒ عرض السابق للدمج (نمط كاشف ازدواج الأطراف القائم) بدل حجز مخفيّ ثانٍ.

### ٤.٨ الاستعلام و«أبلغني عند التوفر» والشاشات
- **شاشة استعلام وحجز** (من خدمة العملاء/الكاشير/ملف العميل/صفحة المنتجات/بحث عام): صورة+باركود، الأرقام الثلاثة، التوفر بالفروع الأخرى، زر «حجز»، وزر **«سجّل طلب توفّر»** إن كان الرصيد صفراً.
- **قائمة «أبلغني عند التوفر»** (Codex — كيان منفصل، لأن رصيد الصفر لا يُحجَز):
  ```sql
  productWaitlist (id, variantId FK, branchId FK, customerId FK?, contactPhone, status, createdAt, notifiedAt?)
  ```
  عند دخول مخزون (استلام/تحويل) ⇒ إشعار واتساب لمن سجّل.
- **لوحة الحجوزات:** أقسام (اليوم/تنتهي قريباً/متأخرة/جاهزة/مستلمة جزئياً/منتهية/ملغاة)، بحث بالهاتف/الاسم/الرقم/الباركود/المنتج.
- **داخل الكاشير:** زر «استدعاء حجز» (بحث بالهاتف/QR) → تحميل البنود → منع تجاوز المتاح الجديد → دعم التنفيذ الجزئي → طباعة رقم الحجز.
- طباعة `reservationSlip.ts` (نمط `voucherPrint`) حراري + A4 + QR.

### ٤.٩ الإشعارات (مرحلة لاحقة — تكامل واتساب القائم)
تأكيد الحجز حتى وقت محدد · تذكير قبل الانتهاء · جاهز للاستلام · تمديد · انتهاء وتحرير · توفّر منتج مطلوب (من قائمة الانتظار). قد تتولّد «مهمة حجز» عبر `autoCreate` + `waKeywordRule` («احجز») أو `linkedReservationId`.

---

## ٥. التكامل مع الأنظمة القائمة
| النظام | نقطة الربط | ملاحظة |
|---|---|---|
| المخزون | `applyMovement` (هدايا)، `catalog/pos.ts` + دالة ATP مركزية (حجز) | لا تعديل enum الحركات |
| الدفتر | `postEntry` (يحرس الفترة) | ⚠️ `GIFT_OUT` يجب إضافته لـ P&L whitelist + bucket |
| العمولات | تلقائي | الهدية/العربون بلا `invoiceId` ⇒ مستثناة مجاناً |
| الصلاحيات | مفتاحان: `gifts`, `reservations` + الأدوار الـ11 | خدمة العملاء/الكاشير: إنشاء حجز؛ المدير: تمديد طويل/تحرير/تجاوز |
| الفروع | `branchScopedProcedure` | عزل صارم — الحجز والمخزون فرعيان |
| كل مسارات خصم المخزون | دالة ATP المركزية (§٤.٦) | تجزئة/خدمة/طباعة/متجر/تحويل/أوامر شغل/داخلي/إنتاج/تالف/يدوي |
| طلب المتجر | فجوة الخصم عند الإرسال (§٢.٥) | يجب أن يراعي المعلّق مع المحجوز |
| الأوفلاين | القراءة فقط | الحجز/الهدية أونلاين حصراً |

---

## ٦. المخاطر والفخاخ
1. **اختفاء الهدية من P&L**: `GIFT_OUT` دون whitelist + bucket ⇒ يُحذف صامتاً من صافي الربح.
2. **تسريب الهدايا**: بلا SOD/سقف = باب سرقة — الحوكمة إلزامية.
3. **اتساق `reservationStock` المجمّع**: يجب أن يساوي `Σ` البنود النشطة دائماً (ثابت اختباري + تحديث حصريّ تحت قفل).
4. **الخصم المزدوج / التحرير المكرّر**: التحويل والإلغاء idempotent تحت قفل.
5. **فجوة طلب المتجر** (قائمة): الخصم عند الإرسال لا الإنشاء — الحجز يجب أن يراعي المعلّق.
6. **نافذة الافتتاح**: الحجز لا يمسّ `openedAt` (لا حركة) ⇒ لا تعارض.
7. **الهجرة**: يدوية + `statement-breakpoint` + `_journal.json` + مرآة `schema.ts`؛ قيد UNIQUE جديد ⇒ مدخل `UNIQUE_AR`.

---

## ٧. خطة التنفيذ بالمراحل (دمج ترتيب Codex الخماسي؛ DoD = خلفية+شاشة+فحص+تحقّق+تنقّل)

**منظومة الهدايا (جلسة `gifts`):**
| مرحلة | المحتوى |
|---|---|
| **G-م١ الوارد** | توسعة أمر الشراء (كمية مدفوعة/مجانية، نوع، sellable، supplierRef، قيمة تقديرية) + سند استلام مجاني مستقل + WAVG صحيح + تقارير الموردين |
| **G-م٢ الصادر** | سند هدية عميل + الأنواع/الأسباب/الحملات + SOD + `GIFT_OUT` + **P&L bucket** + إظهار على الإيصال + الطباعة + تقارير + منع الإساءة |

**منظومة الحجوزات (جلسة `reservations`):**
| مرحلة | المحتوى |
|---|---|
| **R-م٣ النواة** | schema (reservations/Lines/Events/Stock + `receipts.reservationId`) + هجرة + الأرقام الثلاثة + شاشة الاستعلام والحجز + الإلغاء/الانتهاء/التمديد + **حماية التزامن** |
| **R-م٤ ربط القنوات** | دالة ATP المركزية عبر كل المسارات (§٤.٦) + تحويل الحجز لفاتورة + **التنفيذ الجزئي** + استدعاء الحجز بالكاشير |
| **R-م٥ التنبيهات والتحليلات** | واتساب + قائمة «أبلغني عند التوفر» + اللوحات والتقارير + (العربون مُدرَج ضمن النطاق بقرار ٤) |

**الملفات الساخنة المشتركة** (قائد الدمج تسلسلياً): `routers.ts`, `App.tsx`, `AppLayout.tsx`, `schema.ts`, `seed.ts`.

**بروتوكول التوازي:** جلستان (`session:new` + `coord:claim` قبل أي كتابة)؛ هجرتان متتاليتان (`0114`/`0115`)؛ لا تعارض enum (الهدايا تضيف `GIFT_OUT`، الحجوزات لا تضيف)؛ كل شريحة تُدمج فور تحقّقها ثم `git push`.

---

## ٨. معايير النجاح النهائية (ثوابت — دمج Codex)
1. لا يمكن أن يصبح المحجوز أكبر من الفعلي (`reservationStock ≤ branchStock` عند الإنشاء).
2. الإلغاء/الانتهاء يعيد المتاح **مرة واحدة فقط**؛ التحويل لا يخصم المخزون مرتين.
3. المجاني الوارد يزيد المخزون **دون تضخيم ذمة المورد**.
4. هدية العميل تخفض المخزون **دون إيراد أو نقد وهمي**؛ ولا تظهر في وعاء عمولة أي بائع (بلا `invoiceId`).
5. كل هدية تحمل سبباً ومصدراً ومُوافِقاً وتكلفة تاريخية؛ كل عملية قابلة للعكس، **لا حذف صامت**.
6. كل قيد `GIFT_OUT`: `revenue=0 ∧ profit=−cost`.
7. `reservationStock.reservedBase = Σ(البنود النشطة)` دائماً.
8. التحويل idempotent (`sourceId=RES-<id>` + `uq_invoice_source`)؛ إعادة الضغط لا تكرّر.
9. تقارير الربح/المخزون/الموردين/العملاء تبقى متطابقة.
10. **(معلَّق بقرار ٣ الناعم):** «لا بيع لوحدة محجوزة لعميل آخر» — لا يتحقق في المرحلة الأولى (تحذير لا منع)؛ يتحقق فقط عند الترقية للصارم (§٤.٦).

---

## ٩. القرارات المؤجَّلة (توسعات، ليست فجوات)
- ترقية الإنفاذ الناعم → الصارم (تبديل نقطة واحدة في دالة ATP).
- سياسة صريحة لتقييم «منتج مختلف مجاناً» (Codex) — ما لم يطلبها المالك (القرار الحالي: صفر تكلفة).
- BOGO/«اشترِ X تحصل Y» التلقائي في محرّك الترويج.
- العربون المتقدّم/الاسترداد الجزئي (الحالي: اختياري + رد كامل).
- برنامج ولاء يربط الهدايا الصادرة.
- تكامل واتساب الكامل للحجز والقائمة (مهمة حجز/أبلغني).
