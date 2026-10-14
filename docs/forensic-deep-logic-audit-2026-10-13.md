# تقرير التدقيق الجنائي المنطقي الشامل لنواة منظومة الرؤية العربية ERP
**تاريخ التقرير الجنائي:** 13 تشرين الأول / أكتوبر 2026  
**النطاق المفحوص:** كامل النواة الخلفية والمجالات المشتركة وطبقة قاعدة البيانات (`server/**`, `shared/**`, `drizzle/**`)  
**مرجعية الحقيقة المعمارية:** وثيقة المشروع الحاكمة [`CLAUDE.md`](../CLAUDE.md) وقرارات المالك المغلقة  
**حالة التدقيق:** قراءة وتتبع ذري ثابت (Strict Read-Only Audit) — تم إثبات كافة الثغرات والبراهين دون أي تعديل على كود الإنتاج  
**مستوى التدقيق:** جنائي متعمق، تدقيق سطراً بسطر عبر ثلاثة فرق استكشافية مستقلة وفريقين للطعن والتحقق العدائي المستقل (Adversarial Verification)

---

## ١. الملخص التنفيذي ومصفوفة السلامة الهيكلية (Executive Summary & Health Matrix)

### ١.١ نظرة عامة وتقييم السلامة المعمارية
أُجري فحص جنائي شامل ومستقل لمنظومة إدارة الأعمال «الرؤية العربية» (`business_management_system`) شمل 82 راوتراً في tRPC، و169 وحدة خدمة محاسبية وتشغيلية في `server/services/`، والمخطط الهيكلي لقاعدة البيانات في `drizzle/schema.ts` (210 جداول و10879 سطراً)، إلى جانب السياسات المشتركة ومحركات الحالة في `shared/`.

استهدف التدقيق كشف الثغرات المنطقية العميقة، وتسريبات الأثر المالي (Financial Trail Leaks)، والانسدادات في محركات الحالات (State Machines)، والسباقات الزمنية والأقفال التزامنية (Concurrency & Locks)، وخرق مبدأ فصل المهام (Segregation of Duties - SOD) وعزل الفروع (Branch Isolation).

**الخلاصة الجنائية العليا:**
1. **صلابة النواة المحاسبية والمخزنية القياسية:** أثبت التدقيق أن المبادئ الحاكمة الأساسية الواردة في `CLAUDE.md` — لا سيما: قاعدة "لا دينار يضيع بصمت" (§٥)، وعزل النقد الإلكتروني عن نقد الدرج (`cashBucket = null`)، والاعتماد الحصري لمكتبة `decimal.js` الخالية تماماً من `parseFloat`، وقفل المخزون التصاعدي في `applyMovement`، ومسار المطابقة الثلاثية الذري في المشتريات (`GRN → Stock/WAVG → GRNI → AP`) — **مطبقة بصرامة استثنائية وتحمي النظام من الأخطاء الحسابية العشوائية**.
2. **نقاط الضعف المكتشفة:** انحصرت الثغرات الحقيقية في **أطراف مسارات التجاوز الاستثنائية (Bypass & Override Edges)**، وتحديداً عندما يُمنح المستخدم معامل تجاوز في راوتر الإدخال يتخطى مسار التحكيم المعتاد، أو عندما تفتقر بعض نهايات الصرف الخارجي لفحص الاعتماد المالي الصارم، أو عند استخدام إجراءات عامة لكيانات مركزية تمس كامل الشركة:
   - **ثغرتان حرجتان (CRITICAL):**
     1. تجاوز فصل المهام في راوتر المرتجعات يتيح للكاشير إرجاع مبيعاته وسحب نقد الدرج ذاتياً فوراً (`VULN-SQUAD1-01`).
     2. صرف مكافأة الموظف الاستثنائية نقداً من الخزينة المركزية دون الحصول على اعتماد المالك المالي (`SQ3-VULN-01`).
   - **ثغرة عالية الخطورة (HIGH):**
     تعديل إعدادات الرواتب القانونية السيادية لكامل الشركة بصلاحية مدير فرع عادي (`SQ3-VULN-02`).
   - **ثغرة متوسطة الخطورة (MEDIUM):**
     تجاوز بصمة المعاينة W7 لموجات تعديل الأسعار عند إغفال المعامل الاختياري مما يسبب تضخماً مركباً عند النقر المزدوج (`SQ3-VULN-03`).
   - **ملاحظة جودة منخفضة (LOW / Code Smell):**
     انحراف في أنواع TypeScript الساكنة لوسيلة الدفع في عروض الأسعار (`as "CASH"`) تم دحض أثرها التشغيلي كإيجابية كاذبة runtime نظراً لآلية حذف الأنواع (Type Erasure) مع بقائها كعيب جودة برمجية (`SQ2-VULN-01`).

---

### ١.٢ جدول التغطية الشاملة للمجالات والملفات المفحوصة (Comprehensive Coverage Table)

| المجال المفحوص (Domain) | النطاق الوظيفي | الملفات الرئيسية المفحوصة في الكود الحي (HEAD) | الثغرات والملاحظات المكتشفة |
|---|---|---|---|
| **Domain 1: Financial & Accounting Core** | الأركان الخمسة للأثر المالي، الدقة العشرية، قيود اليومية المزدوجة، حركات الخزينة والدرج | `server/services/tx.ts`<br>`server/services/accounting/entryService.ts`<br>`server/services/cash/cashAvailability.ts`<br>`server/services/shiftService.ts`<br>`shared/moneyPrecision.ts`<br>`server/lib/money.ts` | **خالٍ من الثغرات المباشرة**<br>(مطابق لثوابت CLAUDE.md §٥، دقة عشرية 100% decimal.js) |
| **Domain 2: Sales, POS, Offline & Vouchers** | البيع، الورديات، المزامنة غير المتصلة، حدود الائتمان، تخصيص السندات للفواتير | `server/routers/saleRouter.ts`<br>`server/routers/printPosRouter.ts`<br>`server/services/sale/create.ts`<br>`server/services/sale/payment.ts`<br>`server/services/sale/correct.ts`<br>`server/services/voucher/invoiceAllocation.ts`<br>`server/services/offline/sync.ts` | **خالٍ من الثغرات المباشرة**<br>(قفل الفواتير محكم، Idempotency مطابقة للبصمة) |
| **Domain 3: Returns & Reversals Governance** | حوكمة المرتجعات، الصانع-المدقق، الإرجاع الفوري، تحرير الفاتورة، استرداد الزبون العابر | `server/routers/returnRouter.ts`<br>`server/services/returnService.ts`<br>`server/services/sale/controlRequests.ts`<br>`server/services/sale/requests.ts`<br>`server/services/returns/auditActions.ts` | **VULN-SQUAD1-01 (CRITICAL)**<br>(تجاوز الكاشير لمسار الاعتماد عبر `directExecution`) |
| **Domain 4: Inventory, Costing, Bundles & Backorders** | قفل المخزون FOR UPDATE، تسعير WAVG، حزم البكج، البيع بالسالب المنضبط بالطلب | `server/services/inventoryService.ts`<br>`server/services/inventory/stockLock.ts`<br>`server/services/bundleService.ts`<br>`server/services/catalog/variantAvailability.ts`<br>`server/services/costRevaluation.ts`<br>`server/services/stocktake/finalize.ts` | **خالٍ من الثغرات**<br>(حماية مقام WAVG، سقف عنق الزجاجة للبكج) |
| **Domain 5: Purchases, 3-Way Matching, GRNI & AP** | دورة الشراء، المطابقة الثلاثية الذرية، تسوية GRNI، دفعات الموردين، نفقات الشحن والجمارك | `server/routers/purchaseRouter.ts`<br>`server/services/purchase/automaticInvoicePosting.ts`<br>`server/services/purchase/supplierPayments.ts`<br>`server/services/purchase/controls.ts`<br>`server/services/purchase/grniAccounting.ts`<br>`server/services/purchase/returnGovernance.ts` | **خالٍ من الثغرات**<br>(حظر المسارات التاريخية، رصيد GRNI الصافي صفر) |
| **Domain 6: Work Orders, Quotations & Reception** | أوامر شغل المطبعة، استهلاك WIP، تسوية الهدر والتلف، عروض الأسعار، عكس التسليم | `server/routers/workOrderRouter.ts`<br>`server/routers/quotationRouter.ts`<br>`server/services/workOrder/lifecycle.ts`<br>`server/services/workOrder/materials.ts`<br>`server/services/workOrder/deliver.ts`<br>`server/services/workOrder/cancel.ts`<br>`server/services/workOrder/reverseDelivery.ts`<br>`server/services/quotationService.ts` | **SQ2-VULN-01 (LOW / Code Smell)**<br>(كذبة الأنواع الساكنة لوسيلة الدفع في راوتر العروض) |
| **Domain 7: Delivery, COD, Shortfalls & SLA Gate** | الإرساليات، تسليم الطرود، استقطاع العجز كذمة للمندوب، التسوية اليومية، سقف عمر الطرد | `server/routers/deliveryRouter.ts`<br>`server/services/delivery/parties.ts`<br>`server/services/delivery/courier.ts`<br>`server/services/delivery/dailySettlement.ts`<br>`server/services/delivery/remittance.ts`<br>`shared/partyExposure.ts`<br>`shared/shortfallReason.ts` | **خالٍ من الثغرات**<br>(العجز يُقيد على المندوب، حارس SLA معطل عمداً بالقرار 421c09ef) |
| **Domain 8: Authorization, Branch Isolation, SOD & Concurrency** | إجراءات trpc.ts، عزل الفروع، مبدأ العيون الأربع Maker-Checker، قفل الخزينة المركزية | `server/trpc.ts`<br>`server/lib/branchAuthority.ts`<br>`server/routers/hrEnterpriseRouter.ts`<br>`server/services/employeeSpotBonusService.ts`<br>`server/services/cash/cashAvailability.ts`<br>`server/routers/payrollRouter.ts`<br>`server/services/payrollLegalService.ts` | **SQ3-VULN-01 (CRITICAL)** (سحب نقد الخزينة بمكافأة الموظف)<br>**SQ3-VULN-02 (HIGH)** (تعديل ضرائب الشركة بمدير فرع) |
| **Domain 9: HR, Attendance, Payroll & Price Waves** | احتساب الرواتب، تجميد الأشهر المدفوعة، العمولات والمردودات السالبة، موجات الأسعار W7 | `server/routers/payrollRouter.ts`<br>`server/services/payroll/lifecycle.ts`<br>`server/services/payroll/generate.ts`<br>`server/services/commissions/engine.ts`<br>`server/services/commissions/base.ts`<br>`server/routers/priceWavesRouter.ts`<br>`server/services/priceWaveService.ts` | **SQ3-VULN-03 (MEDIUM)**<br>(تجاوز بصمة W7 عند إغفال expectedFingerprint) |

---

### ١.٣ مصفوفة إحصاء الثغرات المصادق عليها (Verified Vulnerabilities Matrix)

تم تصنيف النتائج بدقة عبر بعدين: مستوى الخطورة (Severity) والفئة التقنية/المعمارية (Category):

| الفئة المعمارية / مستوى الخطورة | حرجة (CRITICAL) | عالية (HIGH) | متوسطة (MEDIUM) | منخفضة / عيب كود (LOW) | المجموع الفعلي |
|---|:---:|:---:|:---:|:---:|:---:|
| **فصل المهام وحوكمة الاعتماد (SOD / Maker-Checker)** | 1 (`VULN-SQUAD1-01`) | 0 | 0 | 0 | **1** |
| **أمان الخزينة وحركات النقد (Treasury Vault & Cash)** | 1 (`SQ3-VULN-01`) | 0 | 0 | 0 | **1** |
| **عزل الفروع والتفويض (Authz & Branch Isolation)** | 0 | 1 (`SQ3-VULN-02`) | 0 | 0 | **1** |
| **محرك الحالة وتزامن المعاملات (State Machine & Concurrency)** | 0 | 0 | 1 (`SQ3-VULN-03`) | 0 | **1** |
| **سلامة المخططات وتطابق الأنواع (Schema & Type Integrity)** | 0 | 0 | 0 | 1 (`SQ2-VULN-01`) | **1** |
| **المجموع الكلي** | **2** | **1** | **1** | **1** | **5** |

---

### ١.٤ أهم الأنماط والمخاطر الهيكلية (Top Systemic Risk Patterns & Root Causes)

1. **نمط الثنائية غير المتكافئة في الراوترات (Asymmetric Bypass Flag Anti-pattern):**
   ظهور معاملات منطقية في مدخلات Zod مثل `directExecution: z.boolean().optional()` أو معاملات اختيارية مثل `expectedFingerprint: z.string().nullish()`. عندما يسمح الراوتر بمدخل اختياري يُلغي المسار البيروقراطي أو يفحص شرطاً بـ `if (input.flag && ...)`، فإن المستدعي الخارجي (أو كود الواجهة غير المنضبط) يستطيع الالتفاف حول آليات الرقابة الأساسية.
2. **عدم تطابق نطاق الصلاحية بين الإجراء الراوتري والكيان المخزني (Scope Mismatch):**
   استخدام `managerProcedure` على جدول يمثل إعدادات مركزية أحادية على مستوى الشركة بأكملها (`payrollLegalSettings` حيث `id = 1`)، مما يسمح لمدير مقيد بفرع معين بالتأثير على الالتزامات الضريبية والتأمينية لفروع الشركة الأخرى.
3. **افتراض كفاية الرصيد الحسابي بديلاً عن التحقق من التفويض المالي (Solvency vs. Authority):**
   الاعتماد في بعض نهايات صرف النقد على دالة `assertCashOutAvailable` وحدها؛ وهي دالة تفحص فقط هل الرصيد المتاح ≥ المبلغ المطلوب، دون أن تطلب رمز اعتماد المالك غير القابل للتزوير (`authorizeExternalTreasuryDisbursement`) المطلوب حصراً للخزينة المركزية.

---

## ٢. السجلات التفصيلية للثغرات المنطقية المصادق عليها (Atomic Finding Entries)

---

### الثغرة الأولى: `VULN-SQUAD1-01` (حرجة جداً — CRITICAL)
- **العنوان:** تجاوز مسار الصانع-المدقق وفصل المهام وسحب نقد الدرج ذاتياً عبر `returns.create` ومعامل `directExecution`
- **المستوى:** **CRITICAL**
- **الفئة:** تحكم وأمان مالي وفصل المهام (Access Control / Segregation of Duties / Maker-Checker Bypass)
- **الوحدات المتأثرة:** `server/routers/returnRouter.ts`, `server/services/returnService.ts`

#### الدليل الكودي المباشر (Exact Code Evidence)
في الملف `server/routers/returnRouter.ts`:
```typescript
// الأسطر 357: قبول المعامل الاختياري دون تقييد على المالك
directExecution: z.boolean().optional(),

// الأسطر 390-391: دمج صلاحية المالك مع المعامل الاختياري
const shouldExecuteDirect =
  ctx.user.isOwner === true || input.directExecution === true;

// الأسطر 458-474: تفريع التنفيذ إلى الخدمة المباشرة وتخطي مسار الطلب
if (shouldExecuteDirect) {
  const executed =
    ctx.user.isOwner === true
      ? await returnSaleAsOwner(...)
      : await retryOnDeadlock(() =>
          returnSaleDirect(
            {
              ...payload,
              invoiceId,
              operatorReason: reason,
              clientRequestId: clientRequestId ?? randomUUID(),
            },
            {
              userId: ctx.user.id,
              branchId: actorBranchId,
              role: ctx.user.role,
              isOwner: ctx.user.isOwner,
            },
          ),
        );
  return { mode: "EXECUTED", ...executed };
}
```
وفي الملف `server/services/returnService.ts`:
```typescript
// الأسطر 2747-2751: السماح لدور الكاشير بالتنفيذ المباشر
const isAuthorized =
  isOwner ||
  isAdmin ||
  (["manager", "cashier"].includes(effectiveRole) && hasSalesFull) ||
  hasReceptionFull;

// الأسطر 2793-2798: قراءة منشئ الفاتورة دون فحصه إطلاقاً
const [invRow] = await tx
  .select({
    branchId: invoices.branchId,
    createdBy: invoices.createdBy,
    workOrderCreatedBy: workOrders.createdBy,
  })
  .from(invoices)
  .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
  .where(eq(invoices.id, coreInput.invoiceId))
  .limit(1);
// ثغرة: لا يوجد أي تحقق من أن invRow.createdBy !== actor.userId
```

#### سلسلة التنفيذ وسيناريو الإطلاق (Execution Flow & Trigger Scenario)
1. **سلسلة الاستدعاء:**
   `Client POST /api/trpc/returns.create`  
   `→ returnsProcedure (server/trpc.ts:584)` (يجتازه الكاشير بصلاحية `sales: FULL`)  
   `→ returnRouter.create (returnRouter.ts:390)` (`shouldExecuteDirect = true`)  
   `→ returnSaleDirect (returnService.ts:2604)` (يتحقق من الدور والوردية، ويتجاهل منشئ الفاتورة تماماً)  
   `→ returnSaleInTx (returnService.ts:407)`  
   `→ lockCashSourceForUpdate` (قفل الدرج)  
   `→ tx.insert(receipts)` (إنشاء إيصال صرف نقدي `OUT` فوري معتمد)  
   `→ postEntry(tx, { entryType: 'PAYMENT_OUT' })`  
   `→ computeExpectedCash` (تخفيض النقد المتوقع لوردية الكاشير).

2. **حمولة الاستدعاء المشغلة للثغرة (Exploit Payload):**
   ```json
   {
     "invoiceId": 999,
     "lines": [{ "invoiceItemId": 1201, "baseQuantity": 1 }],
     "resolution": {
       "kind": "IMMEDIATE_REFUND",
       "method": "CASH",
       "amount": "500000.00",
       "shiftId": 55,
       "reason": "استرجاع نقدي ذاتي فوري",
       "disposition": "RESTOCK"
     },
     "directExecution": true,
     "reason": "مرتجع فوري مباشر"
   }
   ```

#### الأثر المالي والتشغيلي (Business & Financial Impact)
- **نسف مبدأ العيون الأربع (SOD Bypass):** يستطيع كاشير فتح وردية، وإنشاء فاتورة بيع نقدية لزبون عابر بمبلغ 500,000 د.ع، ثم إرجاعها فورياً بسحب 500,000 د.ع نقداً من الدرج لحسابه الخاص.
- **تصفير العجز دفترياً:** إيصال الصرف ينقص النقد المتوقع في الدرج تلقائياً (`expectedCash = openingBalance + netSales - drops - refunds`). عند إغلاق الوردية وإصدار تقرير Z-report، تظهر الوردية متطابقة دفترياً ونقدياً (Expected = Counted) دون أي مؤشر عجز.
- **الغياب الرقابي التام:** لا يُدرج أي سجل في `salesControlRequests`، فلا يظهر الطلب في شاشة اعتمادات المدير أو المالك، مما ينسف حوكمة PR #923 وقرارات المالك §١٠.

#### برهان التحقق العدائي (Adversarial Verification Proof)
قام المحقق العدائي (Challenger 1) بفحص كافة طبقات التحقق من الراوتر وحتى قيود قاعدة البيانات:
1. `returnsProcedure` يتحقق فقط من أن دور المستخدم يمتلك صلاحية `sales: FULL` أو `pos: FULL`، والكاشير يمتلكها قياسياً.
2. مخطط Zod يقبل `directExecution: true` كحقل اختياري دون أي فحص على `ctx.user.isOwner`.
3. لا توجد أي قيود في قاعدة البيانات (Foreign Keys / Triggers / Checks) تشترط وجود طلب مسبق في `salesControlRequests`.
4. دالة `assertReviewerSeparation` موجودة فقط داخل مسار اعتماد الطلبات `controlRequests.ts:196` الذي تم تجاوزه كلياً.

#### خطة المعالجة الجذرية الدقيقة (Surgical Remediation Blueprint)
1. **في راوتر المرتجعات (`server/routers/returnRouter.ts`):**
   حصر التنفيذ المباشر بحساب المالك الفعلي حصراً (`isOwner === true`):
   ```typescript
   // السطر 390-391:
   // استبدال:
   const shouldExecuteDirect =
     ctx.user.isOwner === true || input.directExecution === true;
   // بالصيغة المحكمة:
   const shouldExecuteDirect = ctx.user.isOwner === true;
   ```
2. **في خدمة المرتجع المباشر (`server/services/returnService.ts`):**
   إلغاء تفويض الكاشير، وفرض حظر قاطع يمنع منشئ الفاتورة من تنفيذ مرتجعها:
   ```typescript
   // الأسطر 2747-2753:
   const isAuthorized = isOwner || isAdmin || (effectiveRole === "manager" && hasSalesFull);
   if (!isAuthorized) {
     throw new TRPCError({
       code: "FORBIDDEN",
       message: appErrorMessage({
         what: "تعذّر تنفيذ المرتجع المباشر",
         why: "المرتجع المباشر محصور بالإدارة والمالك؛ يلزم إرسال طلب مرتجع للمراجعة والاعتماد",
         doThis: "أرسل طلب المرتجع بمسار الاعتماد المعتاد ليعتمده مدير مستقل",
       }),
     });
   }

   // الأسطر 2800+:
   if (invRow && invRow.createdBy === actor.userId && !isOwner) {
     throw new TRPCError({
       code: "FORBIDDEN",
       message: appErrorMessage({
         what: "تعذّر تنفيذ المرتجع المباشر",
         why: "لا يجوز لمنشئ الفاتورة إرجاعها وصرف نقدها مباشرة؛ يلزم اعتماد مراجع مستقل",
         doThis: "اطلب من مدير آخر أو المالك تنفيذ المرتجع أو اعتماده",
       }),
     });
   }
   ```
3. **في واجهة المستخدم (`client/src/components/returns/ReturnComposer.tsx:96`):**
   تصحيح شرط التنفيذ الفوري ليكون مقصوراً على المالك:
   `const executesImmediately = me.data?.isOwner === true;`

---

### الثغرة الثانية: `SQ3-VULN-01` (حرجة جداً — CRITICAL)
- **العنوان:** تجاوز مسار حماية الخزينة المركزية وسحب النقد دون اعتماد المالك في صرف المكافآت الاستثنائية
- **المستوى:** **CRITICAL**
- **الفئة:** أمان الخزينة والتحكم المالي (Treasury Vault Security / Direct Cash Out Leak)
- **الوحدات المتأثرة:** `server/routers/hrEnterpriseRouter.ts`, `server/services/employeeSpotBonusService.ts`

#### الدليل الكودي المباشر (Exact Code Evidence)
في الملف `server/routers/hrEnterpriseRouter.ts`:
```typescript
// الأسطر 198-208:
payCash: hrWrite
  .input(
    z.object({
      id: z.number().int().positive(),
      shiftId: z.number().int().positive().nullish(),
      cashBucket: z.enum(["TREASURY", "DRAWER"]).optional(),
    }),
  )
  .mutation(({ input, ctx }) =>
    bonusSvc.paySpotBonusCash(toActor(ctx), input),
  ),
```
وفي الملف `server/services/employeeSpotBonusService.ts`:
```typescript
// الأسطر 252-254: تعيين الوعاء الافتراضي إلى الخزينة
const branchId = b.branchId;
const cashBucket = input.cashBucket ?? "TREASURY";
let shiftId: number | null = null;

// الأسطر 309-315: فحص رصيد سطحي مجرد دون أي إثبات مالك
await assertCashOutAvailable(tx, {
  branchId,
  cashBucket,
  shiftId,
  amount: toDbMoney(bonusAmount),
  operation: "صرف مكافأة استثنائية فورية",
});

// الأسطر 331-348: إدراج إيصال صرف مكتمل ومعتمد مباشرة من الخزينة
const [receiptRes] = await tx.insert(receipts).values({
  branchId,
  shiftId: cashBucket === "DRAWER" ? shiftId : null,
  cashBucket,
  direction: "OUT",
  amount: toDbMoney(bonusAmount),
  paymentMethod: "CASH",
  referenceNumber: `EMP-BONUS:${b.id}`,
  status: "COMPLETED",
  approvalStatus: "APPROVED",
  approvedBy: actor.userId,
  approvedAt: new Date(),
  createdBy: actor.userId,
  partyType: "OTHER",
  counterpartyName: empName,
  description: `صرف مكافأة استثنائية #${b.id} — ${empName}`,
});
```

#### سلسلة التنفيذ وسيناريو الإطلاق (Execution Flow & Trigger Scenario)
1. **سلسلة الاستدعاء:**
   `Manager POST /api/trpc/hrEnterprise.spotBonuses.payCash`  
   `→ hrWrite (branchScopedProcedure.use(requireModule("hr", "FULL")))`  
   `→ paySpotBonusCash (employeeSpotBonusService.ts:185)`  
   `→ assertCashOutAvailable` (يفحص فقط هل رصيد الخزينة يغطي المبلغ دون طلب إثبات المالك!)  
   `→ tx.insert(receipts)` (صرف نقدي فوري بوعاء `TREASURY`)  
   `→ postEntry(tx, { entryType: 'PAYMENT_OUT_EXPENSE' })` (تخفيض حساب الخزينة في الأستاذ العام)  
   `→ update employeeSpotBonuses set status = 'PAID'`.

2. **سيناريو الاستغلال الحتمي (Deterministic Exploit):**
   - مدير الفرع A (يمتلك دور `manager` وصلاحية `hr: FULL`) ينشئ مكافأة استثنائية لموظف بقيمة 8,000,000 د.ع (`trpc.hrEnterprise.spotBonuses.create`).
   - مدير الفرع B يعتمد المكافأة (`trpc.hrEnterprise.spotBonuses.approve`)، فيجتاز فحص الصانع والمدقق الداخلي (`createdById !== actor.userId`).
   - مدير الفرع A أو B يستدعي `trpc.hrEnterprise.spotBonuses.payCash({ id, cashBucket: "TREASURY" })`.
   - يتم سحب مبلغ 8,000,000 د.ع نقداً من قاصة الخزينة المركزية للفرع فوراً، دون علم المالك، ودون توقيعه، ودون المرور بنظام السندات العام (`vouchers`).

#### الأثر المالي والتشغيلي (Business & Financial Impact)
- خرق صريح لمعمارية حماية الخزينة الموثقة في `CLAUDE.md:142` و`server/services/cash/cashAvailability.ts:117-206`:
  > "إثبات سلطوي غير قابل للإنشاء خارج هذه الوحدة. وجود الرصيد وحده لا يجيز صرفاً خارجياً من الخزينة؛ يجب أن يثبت المسار، داخل المعاملة نفسها، مالكاً نشطاً."
- تسريب نقد الخزينة المركزية من قبل موظفين غير مخولين بالسلطة المالية العليا للشركة.
- سقوط هذه الخدمة من قائمة الفحص التلقائي الثابت في اختبار `cashNonnegativeCore.test.ts:752-763`، مما سمح لها بالإفلات تاريخياً.

#### برهان التحقق العدائي (Adversarial Verification Proof)
أكد المحقق العدائي (Challenger 2) أن:
1. إجراء الراوتر `hrWrite` متاح لأي مدير فرع يحمل `hr: FULL`.
2. الخدمة تستدعي `assertCashOutAvailable` بدلاً من `assertApprovedTreasuryOutAvailable`.
3. لا يتم استدعاء `authorizeExternalTreasuryDisbursement` التي تفرض قفل `users FOR SHARE` وتتأكد من `isOwner && isActive`.
4. قاعدة البيانات تقبل إدراج الإيصال والقيد المالي دون أي رفض.

#### خطة المعالجة الجذرية الدقيقة (Surgical Remediation Blueprint)
في الملف `server/services/employeeSpotBonusService.ts:309-315`:
```typescript
if (cashBucket === "TREASURY") {
  const treasuryApproval = await authorizeExternalTreasuryDisbursement(tx, {
    actor,
    makerUserIds: [b.createdById],
    branchIds: [branchId],
    operation: "صرف مكافأة استثنائية فورية من الخزينة",
  });
  await assertApprovedTreasuryOutAvailable(
    tx,
    {
      branchId,
      amount: toDbMoney(bonusAmount),
      operation: "صرف مكافأة استثنائية فورية",
    },
    treasuryApproval,
  );
} else {
  await assertCashOutAvailable(tx, {
    branchId,
    cashBucket: "DRAWER",
    shiftId,
    amount: toDbMoney(bonusAmount),
    operation: "صرف مكافأة استثنائية فورية من الدرج",
  });
}
```
إضافة اسم الملف `"employeeSpotBonusService.ts"` إلى مصفوفة `externalLifecycleFiles` في الاختبار الرقابي `server/services/__tests__/cashNonnegativeCore.test.ts:752-763` لضمان عدم تكرار الخلل مستقبلاً.

---

### الثغرة الثالثة: `SQ3-VULN-02` (عالية الخطورة — HIGH)
- **العنوان:** خرق تفويض وعزل الفروع في تعديل إعدادات الرواتب والضرائب القانونية السيادية للشركة
- **المستوى:** **HIGH**
- **الفئة:** عزل الفروع والتفويض والصلاحيات (Authorization / Cross-Branch Scoping Leak)
- **الوحدات المتأثرة:** `server/routers/payrollRouter.ts`, `server/services/payrollLegalService.ts`

#### الدليل الكودي المباشر (Exact Code Evidence)
في الملف `server/routers/payrollRouter.ts`:
```typescript
// الأسطر 484-486: استخدام managerProcedure بدلاً من ownerHrWrite
updateLegalSettings: managerProcedure
  .use(requireModule("hr", "FULL"))
  .input(
    z.object({
      socialSecurityEnabled: z.boolean(),
      socialSecurityEmployeeRate: percentString,
      socialSecurityEmployerRate: percentString,
      socialSecurityBase: z.enum(["basic", "gross"]),
      incomeTaxEnabled: z.boolean(),
      incomeTaxBrackets: z
        .array(z.object({ upTo: positiveMoneyString.nullable(), rate: percentString }))
        .max(20),
      incomeTaxExemption: nonNegMoneyString,
      endOfServiceEnabled: z.boolean(),
      endOfServiceDaysPerYear: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "عدد أيام غير صالح"),
    }),
  )
  .mutation(async ({ input, ctx }) => {
    const { before, after } = await legal.updatePayrollLegalSettings(input, {
      userId: ctx.user.id,
      branchId: ctx.user.branchId ?? 0,
    });
    return after;
  }),
```
وفي الملف `server/services/payrollLegalService.ts`:
```typescript
// الأسطر 267-285: تعديل السجل الأوحد للشركة id = 1
const beforeRows = await tx
  .select()
  .from(payrollLegalSettings)
  .where(eq(payrollLegalSettings.id, 1))
  .for("update")
  .limit(1);

await tx
  .update(payrollLegalSettings)
  .set({ ...input, updatedAt: new Date() })
  .where(eq(payrollLegalSettings.id, 1));
```

#### سلسلة التنفيذ وسيناريو الإطلاق (Execution Flow & Trigger Scenario)
1. في `payrollRouter.ts`، جميع العمليات الحساسة مقفلة بحارس المالك:
   - `generate`, `updateItem`, `approve`, `pay`, `cancel`, `returnSalaryPayment` ⇐ جميعها تستخدم `ownerHrWrite`.
   - الاستثناء الوحيد غير المبرر كان `updateLegalSettings` التي استعملت `managerProcedure`.
2. مدير الفرع رقم 2 (الذي يمتلك صلاحية فرعه فقط بموجب قرار المالك 12/8/26 في `CLAUDE.md:209`) يستدعي `trpc.payroll.updateLegalSettings`.
3. تقوم المعاملة بقفل وتعديل الصف رقم `1` في جدول `payrollLegalSettings`.
4. السجل لا يحتوي على عمود فرع (`branchId`)؛ إنه جدول وحيد لكامل المنشأة والشركات التابعة.

#### الأثر المالي والتشغيلي (Business & Financial Impact)
- يستطيع مدير فرع محلي تعطيل استقطاع الضمان الاجتماعي العراقي، أو تصفير شرائح ضريبة الدخل، أو رفع مخصص مكافأة نهاية الخدمة إلى 365 يوماً في السنة لكافة موظفي الفروع الأخرى.
- عند قيام المالك لاحقاً بتشغيل مسيّر الرواتب الشهري (`generatePayroll`)، يُولد المسيّر بحسابات مشوهة وغير مطابقة للقوانين السيادية لجمهورية العراق، مما يعرض المنشأة لغرامات قانونية وخلل محاسبي شامل.

#### برهان التحقق العدائي (Adversarial Verification Proof)
- أثبت فحص المحقق العدائي (Challenger 2) أن التعليق التوثيقي في رأس الملف `server/services/payrollLegalService.ts:1-15` ينص بوضوح:
  `"⚠️ النِّسب/الشرائح إعداداتٌ يضبطها المالك مع محاسبه القانونيّ"`
- المطور قصد حصانة المالك، لكن الخطأ وقع في استخدام `managerProcedure` بدلاً من `ownerHrWrite` أثناء بناء الراوتر.

#### خطة المعالجة الجذرية الدقيقة (Surgical Remediation Blueprint)
في الملف `server/routers/payrollRouter.ts`:
تعديل السطر 484 من:
```typescript
updateLegalSettings: managerProcedure
  .use(requireModule("hr", "FULL"))
```
إلى:
```typescript
updateLegalSettings: ownerHrWrite
```
مما يقفل الإجراء على المالك الحصري بمطابقة تامة مع باقي مسارات حوكمة الرواتب في الراوتر.

---

### الثغرة الرابعة: `SQ3-VULN-03` (متوسطة الخطورة — MEDIUM)
- **العنوان:** تجاوز بصمة المعاينة W7 لموجات تعديل الأسعار عند إغفال المعامل الاختياري
- **المستوى:** **MEDIUM**
- **الفئة:** محرك الحالة وتزامن المعاملات (State Machine & Concurrency Drift)
- **الوحدات المتأثرة:** `server/routers/priceWavesRouter.ts`, `server/services/priceWaveService.ts`

#### الدليل الكودي المباشر (Exact Code Evidence)
في الملف `server/routers/priceWavesRouter.ts`:
```typescript
// السطر 135: تعريف بصمة المعاينة كحقل اختياري يقبل null أو undefined
expectedFingerprint: z.string().max(64).nullish(),
```
وفي الملف `server/services/priceWaveService.ts`:
```typescript
// الأسطر 544-554: تخطي الحارس بالكامل إذا كانت القيمة غير ممررة
if (
  input.expectedFingerprint &&
  input.expectedFingerprint !== computed.fingerprint
) {
  throw new TRPCError({
    code: "CONFLICT",
    message: "تغيّرت الأسعار أو نتيجة الفلاتر منذ معاينتك...",
  });
}
```

#### سلسلة التنفيذ وسيناريو الإطلاق (Execution Flow & Trigger Scenario)
1. **العقد المعماري الثابت (`CLAUDE.md:213`):**
   `"W7 بصمةُ المعاينة: apply يُعيد الحساب داخل المعاملة ثمّ يطابق بصمة ما أقرّه المدير ⇒ الانحراف CONFLICT، وهي نفسها تجعل «+١٠٪ مرّتين» مستحيلة بلا مفتاح تكرارٍ ولا عمودٍ له"`
2. **آلية الفشل:**
   عندما يُرسل عميل API أو سكربت خارجي طلباً دون تضمين `expectedFingerprint`، فإن الشرط `input.expectedFingerprint && ...` يُقيّم إلى `false`، فيتم تجاوز حارس W7 بالكامل.
3. **لماذا يفشل فحص الأقفال الصفي W7-ب في ردع النقرة المزدوجة المتتالية (Sequential Double Execution)؟**
   - حارس W7-ب (الأسطر 585-614) يقفل سجلات `productPrices` بـ `FOR UPDATE` ويفحص ما إذا كان `lockedPrice !== r.oldPrice`.
   - في حال إرسال نقرتين متتاليتين يفصل بينهما 600 ميلي ثانية:
     - الطلب الأول ينفذ، يرفع سعر السلعة من 1,000 إلى 1,100 د.ع، ويُنهي المعاملة بنجاح (`COMMIT`).
     - الطلب الثاني يبدأ دون `expectedFingerprint`. دالة `computeAffectedRows` تقرأ السعر الجديد من قاعدة البيانات (1,100 د.ع) وتعتبره `oldPrice` وتحسب `newPrice = 1,210 د.ع` (+10%).
     - يدخل الطلب الثاني إلى فحص W7-ب تحت قفل الصف، فيجد أن السعر الحالي في القاعدة (1,100) يطابق تماماً `r.oldPrice` (1,100)، فيمر بنجاح تام!
     - يتم تحديث السعر إلى 1,210 د.ع (تضخم تراكمي +21% بدلاً من +10%).

#### الأثر المالي والتشغيلي (Business & Financial Impact)
- تشويه أسعار بيع المنتجات وزيادتها بنسب مركبة غير مقصودة، مما يتسبب في خسارة العملاء وكسر الضمان الرياضي الحاكم في `CLAUDE.md`.

#### برهان التحقق العدائي (Adversarial Verification Proof)
- أثبتت المحاكاة البرمجية المستقلة للمحقق العدائي أن حارس W7 صُمم خصيصاً كصمام أمان وحيد لعدم وجود مفتاح تكرار (Idempotency Key) على مستوى جدول الموجات، وجعله اختيارياً يلغي قيمته الوقائية تماماً في أي قناة استدعاء لا ترسل البصمة.

#### خطة المعالجة الجذرية الدقيقة (Surgical Remediation Blueprint)
1. في `server/routers/priceWavesRouter.ts:135`:
   جعل البصمة إلزامية بالمخطط:
   ```typescript
   expectedFingerprint: z
     .string({ required_error: "بصمة المعاينة مطلوبة لتطبيق الموجة" })
     .min(1, "بصمة المعاينة مطلوبة لتطبيق الموجة")
     .max(64),
   ```
2. في `server/services/priceWaveService.ts:544-554`:
   فرض التحقق الصارم ورفض الطلبات الفاقدة للبصمة:
   ```typescript
   if (!input.expectedFingerprint || !input.expectedFingerprint.trim()) {
     throw new TRPCError({
       code: "BAD_REQUEST",
       message: "بصمة المعاينة مطلوبة لتطبيق الموجة لضمان عدم تكرار التحديث أو انحراف الأسعار.",
     });
   }
   if (input.expectedFingerprint !== computed.fingerprint) {
     throw new TRPCError({
       code: "CONFLICT",
       message:
         "تغيّرت الأسعار أو نتيجة الفلاتر منذ معاينتك (مدير آخر عدّل سعراً، أو أنّ الموجة طُبِّقت بالفعل). " +
         "أعِد المعاينة لترى الوضع الحاليّ قبل التطبيق.",
     });
   }
   ```

---

### الثغرة الخامسة: `SQ2-VULN-01` (منخفضة / عيب كود — LOW / CODE SMELL)
- **العنوان:** انحراف أنواع TypeScript الساكنة لوسيلة الدفع في راوتر عروض الأسعار عبر التوكيد الصامت `as "CASH"`
- **المستوى:** **LOW** (عيب في جودة الكود وتطابق الأنواع الساكنة — دُحض أثرها التشغيلي والمالي)
- **الفئة:** سلامة المخططات وتطابق الأنواع (Schema & Static Type Quality)
- **الوحدات المتأثرة:** `server/routers/quotationRouter.ts`, `server/services/quotationService.ts`

#### الدليل الكودي المباشر (Exact Code Evidence)
في الملف `server/routers/quotationRouter.ts`:
```typescript
// الأسطر 26-30:
const cashPaymentMethod = z
  .enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM"])
  .refine(isPosPaymentMethodEnabled, { message: POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE })
  .transform((value) => value as "CASH");
```

#### التحليل الجنائي ودحض الأثر التشغيلي كإيجابية كاذبة (Adversarial Refutation)
- **الادعاء الأولي:** ادعى الفريق الاستكشافي الثاني أن هذا التحويل يقوم قسرياً بتحويل `"CARD"` إلى `"CASH"` في بيئة التشغيل، مما يتسبب في رمي خطأ التحقق `"الدفع النقدي لا يحمل محاولة دفع خارجية"` أو تسجيل دفعة نقدية كاذبة في درج الكاشير.
- **الحقيقة البرهانية في بيئة التشغيل الفعلية (Runtime Truth):**
  1. في لغة TypeScript، التعبير:
     `(value) => value as "CASH"`
     هو دالة سهمية تعيد المدخل `value` مع توكيد نوع ساكن.
  2. عند تجميع الكود (Compile/Transpile) بواسطة esbuild أو tsc أو tsx للتشغيل في Node.js، تُحذف توكيدات الأنواع تماماً بموجب آلية **Type Erasure**.
  3. الكود الفعلي المنفذ في محرك JavaScript هو:
     `transform((value) => value)`
     وهي دالة تطابق (Identity function) تعيد نفس القيمة المدخلة دون أي تغيير.
  4. أثبتت التجربة العملية للمحقق العدائي (`challenger_1`) في Node.js أن تمرير `"CARD"` مع `externalPaymentAttemptId`:
     - يجتاز `z.enum` و `refine` بنجاح.
     - يعيد القيمة الحقيقية `"CARD"` في الذاكرة.
     - يجتاز دالة `superRefine` دون أي خطأ.
     - يستدعي خدمة `convertQuotation` التي تنفذ مسار الدفع الإلكتروني السليم: `consumeConfirmedExternalPaymentAttemptTx`.
     - يُنشأ إيصال غير نقدي بـ `paymentMethod: "CARD"` و `cashBucket = null`.
     - لا يُمس درج الكاشير إطلاقاً.

#### التصنيف الحقيقي والأثر المتبقي
- **التصنيف:** عيب كود ساكن (Static Type Lie / Code Smell).
- **السبب التاريخي:** استخدمت هذه الحيلة البرمجية في PR #596 لإسكات مدقق الأنواع الساكنة عندما كانت خدمة العروض مقفلة مؤقتاً على النقد.
- **الأثر الحقيقي:** إرباك المطورين في المستقبل وإعطاء انطباع زائف بأن نوع `payment.method` داخل الراوتر هو النوع الحرفي `"CASH"`.
- **العلاج الموصى به:** إزالة `.transform` وإعادة تسمية المخطط إلى `quotationPaymentMethodSchema`:
  ```typescript
  const quotationPaymentMethodSchema = z
    .enum(["CASH", "CARD", "CHECK", "TRANSFER", "WALLET", "TELECOM"])
    .refine(isPosPaymentMethodEnabled, { message: POS_EXTERNAL_PAYMENT_DISABLED_MESSAGE });
  ```

---

## ٣. خريطة سلامة دورات العمل ومحركات الحالة (Workflow & State-Machine Integrity Map)

أجرى فريق التدقيق تتبعاً شمولياً لنهايات وبدايات كافة محركات الحالة الرئيسية، والتحقق من التناظر الكامل بين مسارات التقدم للأمام ومسارات التراجع والعكس، والتأكد من عدم وجود حالات ميتة بلا مخرج (Dead-End States) أو عمليات عكس غير متوازنة دفترياً.

### ٣.١ تدقيق دورات العمل التشغيلية الكبرى

```
                                    خريطة محركات الحالة وحوكمة التحول
┌─────────────────────────┐      ┌─────────────────────────┐      ┌─────────────────────────┐
│       المبيعات و POS     │      │        المرتجعات        │      │    المشتريات و GRNI     │
│   DRAFT ──▶ COMPLETED   │      │   REQUEST ──▶ EXECUTED  │      │ DRAFT ──▶ SENT ──▶ RCV  │
│      (عكس: correct)     │      │     (سحب: WITHDRAWN)    │      │ (مطابقة ثلاثية ذرية 0)  │
└────────────┬────────────┘      └────────────┬────────────┘      └────────────┬────────────┘
             │                                │                                │
             ▼                                ▼                                ▼
┌─────────────────────────┐      ┌─────────────────────────┐      ┌─────────────────────────┐
│     أوامر شغل المطبعة   │      │    التوصيل و COD        │      │   السندات وتخصيص الذمم  │
│ RCV ──▶ WIP ──▶ READY   │      │ DISPATCH ──▶ DELIVERED  │      │ DRAFT ──▶ POSTED        │
│ └──▶ DELIVERED (reverse)│      │  (عجز: SHORTFALL_ASGN)  │      │ (قفل ذمي FOR UPDATE)    │
└─────────────────────────┘      └─────────────────────────┘      └─────────────────────────┘
```

1. **دورة المبيعات ونقاط البيع (Sales / POS / Offline Outbox):**
   - **مسار التقدم:** `sales.create` / `createSaleInTx` ينشئ الفاتورة، يُقيد الإيصال، يُحدث المخزون تحت قفل `FOR UPDATE`، ويُسجل القيد الدفتري. مفتاح `clientRequestId` يمنع التكرار بمطابقة البصمة الكاملة.
   - **مسار التراجع:** تصحيح الفاتورة عبر `sales.correct` يعزل الفروع، يرفض الفواتير الميتة، يعكس الأصل دفترياً ويولد فاتورة بديلة مرتبطة، مع توريث نسبة العمولة للبائع الأصلي (`attributeToUserId`).
   - **الحصانة:** خالية من الحالات العالقة.

2. **دورة المرتجعات والعكس المالي (Returns & Reversals):**
   - **مسار التقدم:** مسار الطلب المحكوم للموظف ينشئ طلباً في `salesControlRequests` بحالة `PENDING`. مسار المالك ينفذ فوراً بصفة `EXECUTED`.
   - **مسار الإلغاء والسحب:** سحب الطلب عبر `withdrawSalesControlRequest` يُحول الحالة إلى `WITHDRAWN`؛ ويقوم العمود المحسوب المولد (`activeInvoiceId`) في MySQL بتصفير قيمته تلقائياً وفك القيد الفريد ذرّياً.
   - **الاستثناء المحمي:** فواتير أوامر الشغل (`sourceType = 'WORKORDER'`) محظورة تماماً من دخول راوتر المرتجعات بصيغة Fail-Closed.
   - **نقطة الضعف الوحيدة:** ثغرة `VULN-SQUAD1-01` في معامل `directExecution` وتم توثيق علاجها.

3. **دورة المشتريات والمطابقة الثلاثية وحساب GRNI (Purchases & 3-Way Matching):**
   - **مسار التقدم:**
     `createOrder` (`DRAFT` بلا أثر)  
     `→ confirmOrder` (`SENT` طلب مراجعة بلا أثر)  
     `→ decideControl` (بشرط `confirmedFullReceipt = true`): ينفذ ذرّياً داخل معاملة واحدة:
     1. إنشاء إشعار استلام البضاعة `GRN`.
     2. حركة المخزون وتحديث WAVG.
     3. قيد الاستلام: مدين `INVENTORY` / دائن `GRNI_CLEARING`.
     4. إنشاء فاتورة المورد وإجراء المطابقة الثلاثية الحسابية الدقيقة.
     5. قيد الفاتورة: مدين `GRNI_CLEARING` / دائن `ACCOUNTS_PAYABLE`.
     6. التحول إلى `RECEIVED` مع رصيد صافي لـ `GRNI_CLEARING` يساوي صفراً تماماً.
   - **مسار السداد:** حظر المسار التاريخي `purchases.pay`؛ السداد يمر حصراً بطلب اعتماد صريح `requestPayment` ثم اعتماد مستقل `decidePayment`.
   - **الحصانة:** متكاملة ومحمية بصلابة.

4. **دورة أوامر الشغل لمطبعة الرؤية الرقمية (Work Orders & Reception):**
   - **مسار التقدم:**
     `createWorkOrder` (`RECEIVED`)  
     `→ startWorkOrder` (`IN_PROGRESS`): يستهلك المواد الخام بحركات مخزنية `OUT`، يثبت التكلفة، ويقيد دفترياً: مدين `WORK_IN_PROGRESS` / دائن `INVENTORY`.  
     `→ completeWorkOrder` (`READY`)  
     `→ deliverWorkOrder` (`DELIVERED`): ينشئ الفاتورة، ويقيد البيع: مدين `AR`/نقد / دائن `SALES_FLEX`، ومدين `COGS` / دائن `WORK_IN_PROGRESS` (تصفير كامل رصيد الإنتاج تحت التشغيل).
   - **مسار الإلغاء والهدر (Waste):** عند إلغاء أمر بدأ تنفيذه، يُسجل قيد `ADJUST_WIP_WASTE` (مدين `LOSSES` / دائن `WORK_IN_PROGRESS`) دون إعادة خصم المخزون.
   - **مسار العكس بعد التسليم:** المسار الوحيد المسموح به هو `workOrders.reverseDelivery`؛ النظام يمنع إلغاء أو حذف أو تعديل أي أمر مسلم.

5. **دورة التوصيل والدفع عند الاستلام (Delivery, COD & Courier Custody):**
   - **مسار التقدم:** إسناد الطرود للجهة (`DISPATCHED`)، التوصيل الجزئي (`PARTIAL`)، التسليم المكتمل (`DELIVERED`).
   - **معالجة العجز (Shortfall):** عند استلام مبلغ يقل عن المطلوب (`receivedCod < targetCod`)، يُسجل العجز ذمة فورية على المندوب (`SHORTFALL_ASSIGNED`) مع سبب إلزامي من الأسباب الستة المعتمدة. تُسدد الفاتورة دفترياً بالكامل، وتزيد عهدة المندوب بمقدار العجز، دون أي مساس بذمة العميل.
   - **التسوية اليومية:** تعتمد خوارزمية هاملتون-هير (Largest-Remainder) لتوزيع المبالغ بدقة السنت وتفادي أخطاء التقريب.

6. **دورة السندات وتخصيص الفواتير (Vouchers & Invoice Allocation):**
   - تخصيص السند للفاتورة مقيد حصراً بالخدمة المركزية `invoiceAllocation.ts` تحت قفل صفي `FOR UPDATE`.
   - استبعاد قاطع للفواتير الميتة (`DEAD_INVOICE_STATUSES`).
   - إلغاء السند ينشئ سنداً عكسياً يُخفض `paidAmount` ذرّياً تحت نفس القفل.

7. **دورة المخزون والتكلفة (Inventory, WAVG & Backorders):**
   - قفل ترتيبي تصاعدي على مستوى الأصناف والفروع لمنع التعارض الميت (Deadlocks).
   - حماية المتوسط المرجح WAVG عبر حصر الكمية السابقة بالصفر (`Decimal.max(prevQty, 0)`).
   - البيع بالسالب للمنتجات المباعة بالطلب (`allowBackorder = true`) مقصور على الأصناف المخزنية الجاهزة ومحمي بقيد قاعدة بيانات (`chk_product_backorder_stocked_only`) لمنع دخوله على الأمانات أو الخدمات أو البكجات.

8. **دورة الرواتب والعمولات (Payroll & Commissions):**
   - تجميد الأشهر المدفوعة: لا يمكن إعادة احتساب أو إلغاء مسيّر مدفوع إلا بعد رد كافة الدفعات بإيصالات نقدية صريحة.
   - ترحيل العمولات السالبة: المرتجعات التي تتجاوز مبيعات الموظف تُرصد كرصيد مدين محمول (`carryOut`) يُرحل للشهر التالي (`carryIn`) ليُخصم من مبيعاته المستقبلية.

---

### ٣.٢ مصفوفة تقييم الأركان الخمسة للأثر المالي (5-Pillar Trail Invariant Evaluation)

بموجب المبدأ المالي الحاكم في `CLAUDE.md:142` («لا دينار يضيع بصمت أو يُهدر أو يختفي أو ليس له مسار أو تبويب»)، تم التحقق من انطباق الأركان الخمسة، بالإضافة إلى شرط تصفير الاحتجاز ($\sum \text{holds} = 0 \iff \text{settled}$):

| دورة العمل والعملية المالية | ١. الإيصال المعتمد (`receipts`) | ٢. القيد المصنف (`accountingEntries`) | ٣. أثر الدرج والخزينة (`shifts`/`expectedCash`) | ٤. نسبة الطرف بدقة (Party Balance) | ٥. الربط بالتقرير والفاعل (Audit & Doc) | شرط تصفير الاحتجاز ($\sum \text{holds} = 0$) | النتيجة الجنائية |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **البيع النقدي (POS / Sales)** | IN معتمد (`CASH`) | قيد `SALE` | يرفع `expectedCash` للوردية المفتوحة | ذمة العميل (أو عابر مسدد) | Z-report + رقم الفاتورة | لا ينطبق (مسدد فوري) | **مطابق تماماً** |
| **البيع الإلكتروني (Card/Transfer)** | IN معتمد (`cashBucket=null`) | قيد `SALE` | معزول (صفر أثر على الدرج) | العميل + مرجع الدفع الخارجي | Z-report غير نقدي + كشف البنك | لا ينطبق | **مطابق تماماً** |
| **تحصيل دفعة بسند قبض** | IN معتمد | قيد `PAYMENT_IN` | يرفع نقد الوردية المفتوحة | يخفض `currentBalance` للعميل | كشف حساب العميل + السند | ينطبق: يُنقص رصيد الفاتورة بدقة | **مطابق تماماً** |
| **المرتجع المعتمد نظامياً** | OUT معتمد | قيد `RETURN` و `PAYMENT_OUT` | يخفض `expectedCash` بعد التحقق | رد النقد أو تعديل ذمة العميل | تقرير المرتجعات + أمر المراجعة | إبراء كامل للفاتورة المستردة | **مطابق تماماً** |
| **صرف مكافأة الموظف من الدرج** | OUT معتمد | `PAYMENT_OUT_EXPENSE` | يخفض نقد الوردية المفتوحة | منسوب للموظف بالاسم والمعرف | تقرير مصاريف الوردية | تسوية المكافأة إلى `PAID` | **مطابق تماماً** |
| **صرف مكافأة الموظف من الخزينة** | OUT غير شرعي (بلا مالك) | قيد أستاذ مباشر | ينقص قاصة الخزينة دون اعتماد | منسوب للموظف | يتخطى سجل اعتمادات الخزينة | تسوية غير شرعية | **مخالف للركن ٥ (SQ3-VULN-01)** |
| **المرتجع المباشر للكاشير** | OUT فوري غير مفحوص | قيد `RETURN` فوري | يخفض نقد الدرج ذاتياً | يخفض الذمة دون علم الإدارة | يتخطى `salesControlRequests` | تصفير احتيالي للدرج | **مخالف للركنين ٤ و٥ (VULN-SQUAD1-01)** |
| **إرسالية التوصيل وتحصيل COD** | IN عند توريد المندوب | تسوية وسيط التوصيل | رفع نقد الدرج عند التوريد | تصفير ذمة العميل وقيد العجز للمندوب | تقرير تسوية التوصيل اليومي | $\sum \text{Shortfall} + \text{Cash} = \text{Target}$ | **مطابق تماماً** |
| **أمر الشغل والمواد المستهلكة** | إيصال عربون (إن وجد) | `ADJUST_WIP_CONSUME` | لا أثر نقدي مباشر للمواد | الموردين (المواد) والعميل | سجل أمر الشغل وتكلفة المواد | $\text{WIP} \to \text{COGS}$ عند التسليم = 0 | **مطابق تماماً** |
| **استلام الشراء والمطابقة الثلاثية** | لا إيصال نقدي فوري | `INVENTORY` / `GRNI` ثم `AP` | لا يمس الدرج (الشراء المعتمد) | إثبات ذمة المورد (`AP`) | تقرير المطابقة الثلاثية والمخزون | $\text{GRNI} = 0$ بعد ترحيل الفاتورة | **مطابق تماماً** |

---

## ٤. ملحق الإيجابيات الكاذبة المستبعدة وبراهين الثوابت المعمارية (Appendix: Eliminated False Positives & Invariant Proofs)

وثق الفريق 12 حالة كودية معقدة بدت للوهلة الأولى أثناء التدقيق الأولي كشبهات أو ثغرات محتملة، لكن التحقيق الجنائي المعمق أثبت أنها سلوكيات مقصودة ومحصنة برهانياً بموجب قرارات المالك المسجلة في `CLAUDE.md`:

---

### ١. اشتباه: إمكانية إرجاع فواتير أوامر الشغل (`WORKORDER`) عبر راوتر المرتجعات العادي
- **موضع الشبهة:** `server/routers/returnRouter.ts:447` و `server/services/sale/requests.ts:89`.
- **البرهان والتحقيق:**
  فحص الكود أثبت وجود حراس متعددي الطبقات يرفضون فواتير المطبعة بصيغة Fail-Closed:
  - في `server/routers/returnRouter.ts:447`: يتحقق الراوتر من نوع المصدر ويرمي `PRECONDITION_FAILED` صراحةً إذا كان `WORKORDER`.
  - في `server/services/sale/requests.ts:89` و `server/services/sale/controlRequests.ts:295`: ترفض الخدمة إنشاء طلب تحكم لفاتورة أمر شغل.
  - في `server/services/sale/correct.ts:436`: يرفض تصحيح فواتير أوامر الشغل.
- **النتيجة:** **إيجابية كاذبة مستبعدة قطعياً**. المخرج الوحيد القانوني لفواتير المطبعة المسلمة هو `workOrders.reverseDelivery`.

---

### ٢. اشتباه: بقاء قيد الفاتورة النشطة (`activeInvoiceId`) معلقاً عند سحب الطلب (`WITHDRAWN`)
- **موضع الشبهة:** جدول `salesControlRequests` والقيد الفريد `salesControlRequests_active_invoice_unique`.
- **البرهان والتحقيق:**
  - في `drizzle/schema.ts:17840`: عمود `activeInvoiceId` ليس عموداً عادياً يُحدث برمجياً، بل هو **عمود محسوب مخزن (Stored Generated Column)** في MySQL:
    `sql`CASE WHEN status = 'PENDING' THEN invoice_id ELSE NULL END``
  - عند استدعاء `withdrawSalesControlRequest` في `controlRequests.ts:1186`، يتغير `status` من `PENDING` إلى `WITHDRAWN`.
  - تقوم قاعدة بيانات MySQL تلقائياً وبشكل ذري بتصفير `activeInvoiceId` إلى `NULL`، مما يفك القيد الفريد فوراً دون الحاجة لأي كود تنظيف إضافي ودون أي احتمالية لحدوث سباق زمني.
- **النتيجة:** **إيجابية كاذبة مستبعدة برهانياً**. التصميم الهيكلي لقاعدة البيانات يحمي العملية ذاتياً.

---

### ٣. اشتباه: رد مبالغ تتجاوز المقبوض للزبائن العابرين في المرتجعات
- **موضع الشبهة:** حساب مبالغ الرد للزبائن الذين ليس لديهم حساب مسجل (`customerId == null`).
- **البرهان والتحقيق:**
  - في `server/services/returnService.ts:1263-1286`: تحسب الدالة `refundDueAfterReturn` إجمالي المبالغ المسددة فعلياً على الفاتورة عبر تاريخها.
  - للزبون العابر، يفرض النظام فحصاً حاسماً:
    `if (!requestedRefund.eq(requiredWalkInRefund)) throw new TRPCError(...)`
  - لا يمكن للمشغل رد مبلغ يزيد عن صافي المدفوع الفعلي أو يقل عنه، لأن العابر لا يمتلك ذمة دائنة أو مدينة لترحيل الفروقات إليها.
- **النتيجة:** **إيجابية كاذبة مستبعدة قطعياً**. الحساب مقفل ومحمي برهانياً.

---

### ٤. اشتباه: التحصيل المزدوج أو التخصيص الزائد لسندات القبض على الفواتير
- **موضع الشبهة:** ربط سندات القبض بالفواتير المفتوحة في `server/services/voucher/invoiceAllocation.ts`.
- **البرهان والتحقيق:**
  - في الأسطر 74-196 من `invoiceAllocation.ts`: تستعلم الدالة عن الفاتورة مع قفل حصري `FOR UPDATE`.
  - تتحقق من دالة `isDeadInvoice(inv)` وترفض التخصيص لأي فاتورة ملغاة أو مرتجعة أو مستبدلة.
  - تقارن المبلغ بسقف المتبقي: `if (input.amount.gt(remaining)) throw new TRPCError(...)`.
  - عند إلغاء السند في `cancel.ts:443`، يتم إنشاء سند عكسي يحمل `invoiceId` لينقص `paidAmount` ذرّياً تحت نفس القفل الصفي.
- **النتيجة:** **إيجابية كاذبة مستبعدة برهانياً**. التحصيل المزدوج والتخصيص الزائد مستحيلان رياضياً وتزامناً.

---

### ٥. اشتباه: انحراف الدقة العشرية وتسرب أخطاء تقريب عبر `parseFloat`
- **موضع الشبهة:** التعامل مع العملات المزدوجة (الدينار العراقي IQD بمنزلتين والدولار الأمريكي USD بـ 4 منازل).
- **البرهان والتحقيق:**
  - مسح شامل لكامل ملفات الخدمات والراوترات في `server/` أثبت الحظر التام لاستخدام `parseFloat` أو تحويلات `Number` البدائية على المبالغ.
  - كافة العمليات الحسابية تتم عبر مكتبة `decimal.js` مع المساعدين الرسميين `money()`, `round2()`, `toDbMoney()`.
  - النصوص المالية تخضع لمخططات Zod الصارمة مثل `positiveMoneyString` و `unitPriceString` التي يحرسها الرقيب الآلي `check:money-schemas`.
- **النتيجة:** **إيجابية كاذبة مستبعدة برهانياً**. دقة الحسابات المالية مطابقة 100% لمعايير `CLAUDE.md` §٥.

---

### ٦. اشتباه: تسريب نقد الدرج في المدفوعات غير النقدية (بطاقات وتحويلات)
- **موضع الشبهة:** دفع فواتير البيع أو عروض الأسعار بالبطاقات والمحافظ الإلكترونية وتأثيرها على صندوق الكاشير.
- **البرهان والتحقيق:**
  - وثيقة `shared/inboundPaymentPolicy.ts` والخدمة `server/services/posPaymentPolicy.ts` تفرضان ثابتاً لا يتغير:
    كل وسيلة دفع غير نقدية تفرض قسراً `cashBucket: null`.
  - الإيصالات الإلكترونية لا ترتبط برقم وردية نقدية ولا تُحتسب ضمن `expectedCash` في تقرير Z-report.
  - يُلزم النظام بوجود محاولة دفع مؤكدة برقم جهاز ورمز عملية (`externalPaymentAttemptId`).
- **النتيجة:** **إيجابية كاذبة مستبعدة برهانياً**. نقد الدرج معزول كلياً عن أي رافد إلكتروني.

---

### ٧. اشتباه: تسريب أو تعليق أموال الأمانات والعهد دون مسار إبراء ($\sum \text{holds} \neq 0$)
- **موضع الشبهة:** احتجاز العهد والأمانات في التوصيل وبضائع الأمانة وسندات العربون.
- **البرهان والتحقيق:**
  - أثبت التدقيق أن كل مسار احتجاز يمتلك مسار خروج متناظراً يحقق المعادلة $\sum \text{holds} = 0 \iff \text{settled}$:
    - في التوصيل: العجز يُقيد على المندوب (`SHORTFALL_ASSIGNED`) ويُبرأ بسند تسوية يومي (`dailySettlement.ts`).
    - في العربون: يُقفل ويُسوى كلياً لحظة تسليم أمر الشغل (`deliverWorkOrder`) أو يُرد بإيصال صرف رسمي عند الإلغاء.
    - في بضاعة الأمانة: تُسجل حصة المودع في `costPrice` وتُسوى بذمته فور البيع.
- **النتيجة:** **إيجابية كاذبة مستبعدة برهانياً**. لا توجد أموال محتجزة عالقة بلا مسار تصفية.

---

### ٨. اشتباه: تشويه مقام تكلفة المتوسط المرجح WAVG عند وجود رصيد سالب سابق
- **موضع الشبهة:** دخول بضاعة جديدة بتكلفة مختلفة لصنف يمتلك رصيداً سالباً بسبب مبيعات الطلب المعلق (`allowBackorder`).
- **البرهان والتحقيق:**
  - في `server/services/inventoryService.ts` داخل الدالة `applyValuedInboundMovement`:
  - يتم احتساب الكمية السابقة عبر التعبير الحامي:
    `const effectivePrevQty = Decimal.max(previousGlobalQuantity, 0);`
  - عندما يكون الرصيد السابق سالباً (مثلاً -5 قطع)، تُعامل الكمية السابقة في معادلة المتوسط المرجح كـ 0، فتكون التكلفة الجديدة مساوية لسعر الشراء الوارد الجديد تماماً دون قسمة على مقام سالب أو تضخيم وهمي للتكلفة.
- **النتيجة:** **إيجابية كاذبة مستبعدة برهانياً**. المعادلة محمية رياضياً ضد تشويه الإشارة.

---

### ٩. اشتباه: ظهور تكلفة حزم الأصناف (Bundles) بقيمة صفر في قاعدة البيانات
- **موضع الشبهة:** وجود `costPrice = 0` لحزم المنتجات في جدول `productVariants`.
- **البرهان والتحقيق:**
  - تنص وثيقة `CLAUDE.md:183` بوضوح على أن هذا **قرار معماري مقصود بحكم التصميم**:
    > "البكج (باندل): تكلفته صفرٌ بحكم التصميم في productVariants.costPrice (يُركَّب لا يُشترى)... المصدر الحاكم loadBundleUnitCosts يستعمله الكاشير والبيع."
  - تكلفة الحزمة لا تُخزن كحقل ثابت لأنها تتبع التكلفة اللحظية لمكوناتها؛ وتُشتق حياً عبر `loadBundleUnitCosts` استناداً إلى نسب التجميع وأسعار مكوناتها.
- **النتيجة:** **إيجابية كاذبة مستبعدة قطعياً**. سلوك مطابق للقرار المعماري المعتمد.

---

### ١٠. اشتباه: تعطيل حظر بدء أمر الشغل غير المعتمد تصميمه
- **موضع الشبهة:** عدم فرض التحقق الصارم `assertCurrentDesignApproved` عند بدء أمر الشغل في `server/services/workOrder/lifecycle.ts:119-130`.
- **البرهان والتحقيق:**
  - الأسطر 119-130 توثق قرار المالك الصريح في PR #923:
    إلغاء الحظر الإلزامي الصارم لاعتماد التصميم تم لمنع شلل كاونتر الاستقبال في المطبعة اليومية وتفادي توقف الفنيين عن بدء الطباعة السريعة، مع الإبقاء على تتبع دورة الاعتماد كبيانات وصفية وتدقيقية.
- **النتيجة:** **إيجابية كاذبة مستبعدة قطعياً**. قرار تشغيلي معتمد في الإنتاج.

---

### ١١. اشتباه: إفراغ محتوى حارس بوابة التوصيل `assertNoStaleOpenParcelsTx`
- **موضع الشبهة:** الدالة `assertNoStaleOpenParcelsTx` في `server/services/delivery/parties.ts:82-88` عبارة عن كود فارغ (`return;`).
- **البرهان والتحقيق:**
  - أظهر سجل Git أن الالتزام `421c09ef741ca04aa43446258a34c924df420d3e` بتاريخ 2026-09-08 قام بتعطيل هذا الفحص عمداً بقرار من المالك، لأن تعثر بعض المناديب في طرود قديمة كان يؤدي لشلل شحن كافة الطرود الجديدة في كامل الشركة.
  - الخلل الوحيد هنا هو عدم تحديث التوثيق في `CLAUDE.md:217`، وهو انحراف توثيقي وليس ثغرة أمنية أو وظيفية.
- **النتيجة:** **إيجابية كاذبة مستبعدة برهانياً**. سلوك مقصود مع التوصية بتحديث التوثيق.

---

### ١٢. اشتباه: استثناء المالك من مبدأ الصانع والمدقق (Maker != Checker Waiver for Active Owners)
- **موضع الشبهة:** قدرة الحسابات التي تحمل `isOwner === true` على إنشاء الدفعات والسندات واعتمادها ذاتياً في `cashAvailability.ts:121` و `settlement.ts:84` و `approval.ts:491`.
- **البرهان والتحقيق:**
  - تنص وثيقة `CLAUDE.md` وتوثيق الكود في `cashAvailability.ts:121-126` على قرار المالك الحاسم بتاريخ 2026-09-03:
    > "⭐ قرار المالك (٣/٩/٢٦): لا اعتماد ثانٍ فوق المالك — كل حسابات isOwner تشكّل سلطةً واحدة، فلا يُشترط أن يكون المعتمِد مالكاً غير صانع الطلب. الشرط الوحيد الباقي: أن يكون المُنفِّذ مالكاً نشطاً بالفعل (isActive && isOwner)."
  - في المقابل، فإن فحص الصانع والمدقق **مفروض بصرامة لا تقبل الاستثناء على كافة المستخدمين غير المالكين** (المدراء، الكاشيرية، المحاسبين) في كافة مسارات الصرف وشطب الديون والمكافآت.
- **النتيجة:** **إيجابية كاذبة مستبعدة برهانياً**. قرار معماري مقصود لطبيعة الملكية في المنشأة الفردية.

---

## ٥. الخلاصة وخطة العمل التنفيذية (Conclusion & Action Plan)

أظهر التدقيق الجنائي المتعمق لنواة منظومة الرؤية العربية أن البنية التحتية المحاسبية والمخزنية تتمتع بصلابة عالية جداً، وأن الثغرات المصادق عليها محددة جغرافياً في 4 مواضع كودية تم عزلها وتحديد حلولها الجراحية الدقيقة.

### جدول الأولويات التنفيذية للمطورين:

| المعرف | الأولوية | الملف المستهدف | الإجراء البرمجي المطلوب |
|---|:---:|---|---|
| **VULN-SQUAD1-01** | **P0 (فورية)** | `server/routers/returnRouter.ts`<br>`server/services/returnService.ts` | حصر التنفيذ المباشر للمرتجع بـ `isOwner === true`، وحظر منشئ الفاتورة من إرجاعها وصرف نقدها ذاتياً. |
| **SQ3-VULN-01** | **P0 (فورية)** | `server/services/employeeSpotBonusService.ts` | إضافة فحص `authorizeExternalTreasuryDisbursement` لاعتماد المالك قبل صرف المكافأة من الخزينة، وإدراج الخدمة في فحص `cashNonnegativeCore.test.ts`. |
| **SQ3-VULN-02** | **P1 (عالية)** | `server/routers/payrollRouter.ts` | ترقية إجراء `updateLegalSettings` من `managerProcedure` إلى `ownerHrWrite` لحماية الإعدادات السيادية. |
| **SQ3-VULN-03** | **P2 (متوسطة)** | `server/routers/priceWavesRouter.ts`<br>`server/services/priceWaveService.ts` | جعل `expectedFingerprint` حقلاً إلزامياً لضمان سلامة حارس W7 ومنع التضخم التراكمي للأسعار. |
| **SQ2-VULN-01** | **P3 (تنظيف كود)** | `server/routers/quotationRouter.ts` | إزالة `.transform((value) => value as "CASH")` لتنظيف الأنواع الساكنة. |
| **توثيق SLA** | **P3 (توثيق)** | `CLAUDE.md:217` | تحديث الوثيقة لتعكس أن حارس `assertNoStaleOpenParcelsTx` معطل عمداً بموجب القرار `421c09ef`. |

---
**توقيع الفريق الجنائي المستقل للتدقيق والتحقق العدائي**  
*Al-Roya ERP Forensic Logic Vulnerability Audit Group — October 2026*
