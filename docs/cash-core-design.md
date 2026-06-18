# CASH-CORE — وثيقة التَصميم المَركزية

> **الحالة:** مُسوَّدة عَقد فَنّي مُعتمَدة | **التاريخ:** 18/6/2026 | **الفرع:** `claude/vigilant-ardinghelli-0807d1`
>
> **المالك المرجعي:** المَبادئ الـ١٠ + الرؤية المَركزية من `Workflow#wudwdcpr0` (٢٢ وكيلاً خَبيراً).

---

## 0. الرؤية المَركزية (Core Insight)

> **«كل دينار في النظام يَنتمي لقصة ذرّية مَحفوظة بثلاث مصادر متزامنة (`cashTx + journalEntry + auditLog`) مَربوطة بصندوق أب معروف، ومُولَّدة من نقطة دخول وَحيدة (`cashOps.execute`).»**

التَحوّل الفلسفي:
- **الآن:** «دَفتر يُسجّل ما يَتذكّره المُستخدِم»
- **بعد التَنفيذ:** «مُحاسِب رَقمي يَفرض الاتساق بنيوياً ويُرشد لأذكى خطوة تالية»

السلسلة الحاكمة: **الذرّية + الشَفافية = الثقة → استعمال يَومي → بَيانات نَظيفة → قَرارات ذكية**.

---

## 1. النَمَط البَرمجي (Programming Model)

### 1.1 نقطة الدخول الوَحيدة

```ts
// server/services/cashOps.ts

export type CashOpKind =
  | "SALE_CASH" | "REFUND_CASH"
  | "EXPENSE_CASH" | "EXPENSE_CANCEL_CASH"
  | "VOUCHER_RECEIVE" | "VOUCHER_PAY" | "VOUCHER_CANCEL"
  | "SHIFT_OPEN_FLOAT" | "SHIFT_CLOSE_TRANSFER"
  | "TRANSFER_OUT" | "TRANSFER_IN"
  | "SUPPLIER_PAYMENT" | "CUSTOMER_COLLECTION"
  | "ADJUSTMENT";

export interface CashOpInput {
  kind: CashOpKind;
  bucketId: number;             // الصندوق المَقصود (مَحسوب آلياً قبل الدخول)
  direction: "IN" | "OUT";
  amount: string;               // decimal.js string
  sourceType: string;           // 'invoice' | 'expense' | 'voucher' | ...
  sourceId: number | string;    // معرّف المصدر
  clientRequestId: string;      // idempotency
  reason?: string;              // إجباري لـADJUSTMENT/REFUND/CANCEL
  pairToken?: string;           // للتَحويلات: OUT + IN لهما نفس الـtoken
  reversalOfId?: number;        // للتَسوية: يُشير لـcashTx الأصلي
}

export interface CashOpResult {
  cashTxId: number;
  bucketId: number;
  balanceAfter: string;
  pairToken?: string;
  idempotent?: boolean;         // true ⇒ كانت موجودة مسبقاً
}

/**
 * نقطة الدخول الوَحيدة. كل insert على cashTransactions يَمر هنا.
 * - يَفرض idempotency قبل القَفل
 * - يَقفل الصندوق بـSELECT FOR UPDATE
 * - يَفحص RBAC + ownership داخل القَفل
 * - invariants (لا سالب بلا صلاحية)
 * - يُدرج cashTx + يُحدِّث bucket + يَكتب audit — كل ذلك في withTx
 */
export async function execute(
  input: CashOpInput,
  actor: Actor,
  tx?: Tx,  // اختياري: إن لم يُمرَّر، نُنشئ withTx جَديد
): Promise<CashOpResult>;

/**
 * تَحويل بين صَندوقَين — حركتان ذرّيتان بنفس pairToken.
 * - قَفل تَصاعدي للـid (min, max) لمَنع deadlock بين تَحويلَين مُتقاطعَين.
 * - يَفشل ROLLBACK لو فَشلت أيّ واحدة.
 */
export async function transfer(
  fromBucketId: number,
  toBucketId: number,
  amount: string,
  sourceType: string,
  sourceId: number | string,
  clientRequestId: string,
  reason: string,
  actor: Actor,
  tx?: Tx,
): Promise<{ outTxId: number; inTxId: number; pairToken: string }>;
```

### 1.2 الـInvariants المُختبَرة قَسرياً

| # | الـinvariant | كيف يُفرَض |
|---|---|---|
| I1 | **لا سَطر cashTx خارج cashOps** | حارس CI `lint-cash-direct-writes.mjs` يَرفض pre-commit |
| I2 | **كل cashTx يَحمل bucketId** | DB column `NOT NULL` + FK |
| I3 | **كل cashTx يَحمل clientRequestId** | DB column `NOT NULL` + UNIQUE(clientRequestId, actorId) |
| I4 | **balanceAfter snapshot صَحيح** | تَحديث ذرّي في withTx مع SELECT FOR UPDATE |
| I5 | **transfer = pair كامل أو لا شيء** | pairToken + UNIQUE(pairToken, direction) + withTx |
| I6 | **لا حركة على bucket مُغلَق** | فحص `isActive=1` داخل القَفل |
| I7 | **لا حركة بـshiftId مُغلَق** | فحص `shifts.status='OPEN'` لو bucket.shiftId موجود |
| I8 | **مَجموع IN-OUT == currentBalance** | invariant checker cron + reconcile report |
| I9 | **idempotent على نَفس clientRequestId** | فحص قبل الكتابة + قَيد فَريد كحارس |
| I10 | **rollback = صفر تَأثير** | كل withTx، لا writes خارج |

### 1.3 RBAC + Ownership

| الفاعل | يَكتب على bucket من نَوع | الشرط |
|---|---|---|
| cashier | DRAWER | bucketId مَرتبط بـshiftId المفتوحة لهذا الكاشير، branchId يطابق |
| warehouse | — | لا يَكتب على نقد POS |
| manager | DRAWER (تَغطية) + TREASURY (فرعه) | إن DRAWER: shiftId مفتوحة بـuserId=manager. إن TREASURY: branchId يطابق |
| admin | كل الأنواع | عَبر أيّ branch |

الفحص يَجري **داخل القَفل بعد SELECT FOR UPDATE** ⇒ لا TOCTOU.

---

## 2. هَيكل البَيانات (Schema)

### 2.1 جَدول `cashBuckets` (جَديد)

```sql
CREATE TABLE cashBuckets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('DRAWER','TREASURY','BANK','SAFE') NOT NULL,
  branchId BIGINT NOT NULL REFERENCES branches(id),
  ownerUserId INT REFERENCES users(id),   -- المتعهّد المسؤول (DRAWER=الكاشير، TREASURY=المدير)
  shiftId BIGINT REFERENCES shifts(id),   -- لـDRAWER فقط، NULL للأنواع الأُخرى
  name VARCHAR(120) NOT NULL,             -- "درج كاشير ١"، "خزينة MAIN"، "حساب CBI #1234"
  currentBalance DECIMAL(15,2) DEFAULT 0 NOT NULL,
  version INT DEFAULT 1 NOT NULL,         -- optimistic locking
  isActive BOOLEAN DEFAULT TRUE NOT NULL,
  metadata JSON,                          -- bank account number, SWIFT, etc.
  createdAt TIMESTAMP DEFAULT NOW(),
  updatedAt TIMESTAMP DEFAULT NOW() ON UPDATE NOW(),
  INDEX idx_bucket_branch_kind (branchId, kind),
  INDEX idx_bucket_shift (shiftId),
  INDEX idx_bucket_active (isActive)
);
```

### 2.2 ترقية `receipts` (الجَدول الحالي يَستمر)

> **قَرار تَصميمي:** نُبقي جَدول `receipts` الحالي كما هو. cashBuckets طَبقة فَوقه لتَتبّع الصناديق، لكن receipts يَبقى المَصدر للحركات الفِعلية (compatibility مع POS و reports الحالية).
>
> **التَوسعة:** إضافة عَمودَين لـreceipts:
> - `bucketId BIGINT` (FK لـcashBuckets، NULL مَسموح للتاريخي)
> - `pairToken VARCHAR(64)` (للتَحويلات)
> - `balanceAfter DECIMAL(15,2)` (snapshot رصيد الصندوق بعد هذا الـreceipt)
>
> **clientRequestId موجود بالفعل** على receipts (في idempotencyKeys).

### 2.3 ترحيل البَيانات القَديمة (`migrate-cash-to-buckets.mjs`)

```
الخُطَوات (idempotent بـcheckpoint):

١) لكل فرع: أَنشئ bucket واحد kind=TREASURY (المتعهّد=admin الافتراضي).
٢) لكل وردية: أَنشئ bucket واحد kind=DRAWER (shiftId مَربوط، ownerUserId=cashier).
٣) لكل receipt تاريخي:
   - إن shiftId IS NOT NULL ⇒ اربطه بـDRAWER bucket المُقابل.
   - إن shiftId IS NULL AND cashBucket='TREASURY' ⇒ اربطه بـTREASURY bucket الفرع.
   - إن shiftId IS NULL AND cashBucket IS NULL ⇒ اربطه بـTREASURY أيضاً + علِّمه legacy=true.
٤) احسب balanceAfter رِجعياً: مرَّ على كل bucket بترتيب id، اجمع IN واطرح OUT.
٥) حدِّث cashBuckets.currentBalance ليُطابق آخر balanceAfter.
٦) أَكِّد invariant: SUM(IN)-SUM(OUT) لكل bucket == currentBalance.
```

دائماً مع `--dry-run` أوَّلاً ⇒ تَقرير الترحيل ⇒ موافقة المالك ⇒ تَنفيذ فعلي.

---

## 3. الإشارة بين الطبقات

### 3.1 خَدمات حالية تَستدعي cashOps (الإنتاج الفِعلي)

| الخَدمة | الحَدث | استدعاء cashOps |
|---|---|---|
| `saleService.createSale` | بيع نقدي | `execute({kind:'SALE_CASH', direction:'IN', ...})` |
| `returnService.createReturn` | مرتجع نقدي | `execute({kind:'REFUND_CASH', direction:'OUT', reversalOfId:saleReceiptId})` |
| `expenseService.createExpense` | مصروف نقدي | `execute({kind:'EXPENSE_CASH', direction:'OUT', ...})` |
| `expenseService.cancelExpense` | إلغاء مصروف | `execute({kind:'EXPENSE_CANCEL_CASH', direction:'IN', reversalOfId})` |
| `voucherService.createVoucher` | سند قبض/صرف | `execute({kind:'VOUCHER_RECEIVE'/'VOUCHER_PAY', ...})` |
| `voucherService.cancelVoucher` | إلغاء سند | `execute({kind:'VOUCHER_CANCEL', reversalOfId})` |
| `shiftService.openShift` | فتح وردية | لا cashOps (فقط إنشاء bucket DRAWER) |
| `shiftService.closeShift` | إغلاق وردية | يَقترح `transfer(DRAWER → TREASURY)` بقيمة `countedCash` |

### 3.2 شَفافية الطَبقات

```
[POS/UI]
    │
    ▼  tRPC mutation
[Router] expenseRouter.create
    │
    ▼  validates + RBAC + audit
[Service] expenseService.createExpense
    │
    ▼  لا insert مُباشر على receipts! ⇒ يَستدعي:
[cashOps.execute] (نُقطة الدخول الوَحيدة)
    │
    ├─► idempotency check
    ├─► SELECT FOR UPDATE bucket
    ├─► RBAC + ownership
    ├─► invariants
    ├─► insert receipt + bucketId + balanceAfter
    ├─► update cashBuckets.currentBalance + version
    └─► insert auditLog
         │
         ▼  كل ذلك في withTx واحد
[DB] commit أو rollback
```

---

## 4. الاختبارات الإلزامية (DoD)

### 4.1 cashOps.test.ts (٢٠+ اختبار قَبل دَمج CASH-CORE)

```ts
describe("cashOps.execute", () => {
  it("سباق ١٠ نَقرات بنفس clientRequestId ⇒ صَفّ واحد فَقط (idempotency)");
  it("سحب يَتجاوز الرصيد بصلاحية كاشير ⇒ throw + رصيد ثابت");
  it("سحب يَتجاوز الرصيد بصلاحية admin + reason ⇒ مَسموح");
  it("حركة بـbucketId مُغلَق ⇒ throw");
  it("حركة بـshiftId مُغلَق على bucket DRAWER ⇒ throw");
  it("ROLLBACK كامل لو throw بَعد insert receipt قبل update bucket");
  it("balanceAfter يُحفَظ snapshot دقيق بَعد كل تَحويل");
  it("كاشير لا يَكتب على TREASURY bucket ⇒ FORBIDDEN");
  it("كاشير لا يَكتب على درج كاشير آخر ⇒ FORBIDDEN");
  it("admin يَكتب عَبر أيّ branch ⇒ مَسموح");
  it("audit log يُكتَب داخل withTx (لا فَقد لو DB انقَطع)");
});

describe("cashOps.transfer", () => {
  it("تَحويل ١٠٠٠ من A إلى B ⇒ A-1000 + B+1000 + pairToken مُتطابق");
  it("قَتل العَملية مُنتصف التَحويل ⇒ ROLLBACK كامل (لا OUT بلا IN)");
  it("تَحويلان مُتزامنان من A↔B و B↔A ⇒ لا deadlock (قَفل تَصاعدي)");
  it("تَحويل بين فرعَين بصلاحية manager فرع A ⇒ FORBIDDEN");
  it("نَفس clientRequestId مَرَّتَين ⇒ التَنفيذ الثاني idempotent");
});

describe("cashOps.invariants", () => {
  it("SUM(IN)-SUM(OUT) لكل bucket == currentBalance بعد ١٠٠ معاملة عَشوائية");
  it("لا cashTx بلا bucketId (DB constraint)");
  it("لا cashTx بلا clientRequestId (DB constraint)");
  it("pairToken دائماً يَأتي بزَوج (٢ صَفوف، اتجاهَان مُختلفَان)");
});

describe("lint guard", () => {
  it("scripts/lint-cash-direct-writes.mjs يَرفض insert على receipts خارج cashOps.ts");
});
```

### 4.2 بَوّابة DoD النِهائية

- [ ] `pnpm check` نَظيف
- [ ] `pnpm test` كامل ✓ (~٧٩٥+ اختبار)
- [ ] `cashOps.test.ts` كلها تَمر
- [ ] `node scripts/migrate-cash-to-buckets.mjs --dry-run` على نُسخة prod backup ⇒ صفر orphan
- [ ] جَولة بَصرية: شاشة `CashTransfers` تُظهر تَحويل ١٠٠٠ IQD لحظياً
- [ ] جَولة بَصرية: شاشة `/reports/cash-reconcile` تَكشف صفر انحراف بعد الترحيل
- [ ] `coord:release cash-core`

---

## 5. التَقسيم إلى ٣ مَراحل فِعلية (B → C → A)

### المَرحلة ب — وَثيقة التَصميم (هذا المستند)
**المدّة:** ٣٠ دقيقة. **الناتج:** هذا الملف. **القيمة:** عَقد فَنّي مَكتوب يَمنع الانحراف عن الرؤية.

### المَرحلة ج — POC (Proof of Concept)
**المدّة:** ٣-٤ ساعات. **النَطاق المُحدَّد:**
1. `cashBuckets` schema + migration generation
2. `cashOps.execute` skeleton (بلا full RBAC، يَقبل النَطاق المَحدود)
3. `cashOps.transfer` skeleton
4. `lint-cash-direct-writes.mjs` (يَعمل لكن لا يَحظر بَعد — warning فقط)
5. `cashReconcile` للقراءة (مَجموع IN-OUT لكل bucket)
6. **اختبارات POC فقط:** ٥ اختبارات حَرِجة (idempotency + ROLLBACK + balance + transfer + invariant)

**ما هو خارج POC:**
- ❌ استبدال الخدمات الحالية (تَبقى تَستدعي receipts مُباشرة كما هي الآن)
- ❌ UI (CashTransfers screen)
- ❌ ترحيل بَيانات إنتاج
- ❌ تَفعيل lint كـحظر

**القيمة بعد POC:** نَفهم العَقد فِعلياً، نَتأكد من سَلامة الـinvariants، نَختبر النَمَط البَرمجي قبل التَوسّع.

### المَرحلة أ — الكامل (Full CASH-CORE)
**المدّة:** ١٦-٢٠ ساعة موزَّعة على ٢-٣ commits. **النَطاق:**
1. استبدال ٨ خدمات لتَستدعي cashOps (كل خَدمة + اختبار retreat)
2. ترحيل البَيانات الفِعلي (مع `--dry-run` ثم `--apply`)
3. `CashTransfers` UI كاملة + route + nav
4. `CashReconcile` UI كاملة + route
5. تَفعيل lint كـحظر pre-commit
6. تَوسعة الاختبارات إلى ٢٠+
7. بَوّابة DoD كاملة

**ما يَبقى خارج CASH-CORE (مَراحل لاحقة):**
- المَرحلة ٢: SMART-DEFAULTS engine
- المَرحلة ٣: ALERTING
- المَرحلة ٤: SCHEDULER
- المَرحلة ٥: ANOMALY

---

## 6. المُخاطر والمُقايضات

| المُخاطرة | التَخفيف |
|---|---|
| ترحيل البَيانات الإنتاجية ⇒ خَطر فَقد | `--dry-run` إلزامي + backup قبل التَنفيذ + استرجاع جاهز |
| اعتماد ٨ خدمات على cashOps ⇒ كَسر مُحتمَل | كل خَدمة تَتغيّر في commit منفصل + اختبار retreat قبل المُتابعة |
| `lint-cash-direct-writes.mjs` يَرفض الكوميت | يَبدأ warning في POC، يَتحوّل error في commit الأَخير من المَرحلة أ |
| version field يَتطلَّب optimistic locking منفصل | لا — نَستعمل SELECT FOR UPDATE حصرياً (pessimistic). version فقط للتَدقيق |
| بَيانات تاريخية بلا bucketId | NULL مَسموح للتاريخي + علم `legacy=true` + تقرير reconcile يُميّزه |
| تَكلفة اختبار سباق ١٠ نَقرات | اختبار وحدة بـPromise.all ضدّ DB حَقيقية، إعدادات schema-level |

---

## 7. أُسس القَرار المُعتمَدة

١. **shifts ≠ buckets**: shifts للزَمن (متى)، buckets للمَكان (أين). كلاهما له دَور مُستقلّ.
٢. **receipts يَستمر**: لا نُنشئ جَدولاً جَديداً للحركات. receipts الحالي يَكتسب bucketId + pairToken + balanceAfter.
٣. **lint قَسري**: لا نَعتمد على «اتفاق المُطوّرين»؛ pre-commit يَفرض القاعدة.
٤. **withTx واحد لكل عَملية**: insert receipt + update bucket + audit — كلها أو لا شيء.
٥. **idempotency على clientRequestId**: لا nullable. كل راوتر يُولِّد UUID قبل الاستدعاء.
٦. **invariant checker cron**: يَعمل كل ١٥ دَقيقة بعد التَفعيل ⇒ يَكشف الانحراف قبل تَفاقمه.

---

## 8. خُطّة التَنفيذ الفِعلية

```
الآن:           اكتمل ب (هذه الوَثيقة) ✓
خِلال ٤ ساعات:  ج — POC مَدفوع + اختبار
خِلال ٣ أيام:   أ — الكامل مَدفوع + reconcile صفر orphan

كل مَرحلة لها commit مُستقلّ + DoD gate + push + merge to main.
بَعد كل دَمج: pnpm coord:release جُزئي للملفات المُكتمَلة.
```

---

**نُقطة الانطلاق:** هذه الوَثيقة مُعتمَدة كَعَقد. أَيّ انحراف لاحق عنها يَتطلَّب تَعديلها أوَّلاً ثم الكود.
