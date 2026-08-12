# خطة توصيل الدفتر المزدوج (P2) + الإقفال الشهري — دفتر عمل دائم

> **للوكلاء المنفّذين:** المهارة المُلزِمة لكل شريحة: `build-slice` (عقد → كتّاب متوازون → مراجعة عدائية عبر `review-module` → كشف نواقص → إصلاح → تكامل → بوّابة DoD). الخطوات بصيغة مربّعات شطب `- [ ]`. **لا تُعَدّ شريحةٌ منجزةً ما لم يكن `pass === true`.**

**التاريخ:** ١١ أغسطس ٢٠٢٦ · **الحالة:** مُعتمَدة للتنفيذ من ش٠ · **المالك:** جلسة `double-entry-p2`

---

## الهدف

توصيل محرّك القيود المزدوجة القائم (P1) بالدفتر الحيّ **بكتابةٍ ظليّة آمنة**، حتى يُخرِج النظام **ميزان مراجعة ودفتر أستاذ قياسيَّين** يقبلهما محاسبٌ قانونيّ أو جهةٌ ضريبية — و**إقفالاً شهرياً موحَّداً بزرٍّ واحد** — بصفر أثرٍ على أيّ عمليةِ أعمالٍ قائمة.

## المعمارية (في ثلاث جمل)

**إضافيّ بحت:** جدولان جديدان (`journalEntries` / `journalLines`) + خطّاف ظلّ داخل منفذ الكتابة الوحيد + علَمٌ ثلاثيّ الأوضاع `OFF → SHADOW → ACTIVE` افتراضُه `OFF`. الظلّ يكتب داخل **نفس معاملة** الحدث المالي (فلا حالةَ جزئيةٌ ممكنة) و**لا يرمي أبداً** في وضع SHADOW (الفجوة تُسجَّل صفّاً، ولا تُفشِل بيعاً — نفس مبدأ «الأتمتة لا تُفشِل عملية أعمال أبداً» في مركز واتساب). الانتقال إلى `ACTIVE` **بوّابةٌ بالأدلّة** (٣٠ يوماً ظلّاً بصفر فجوات وصفر انحراف) لا بالرأي.

## التقنية

Drizzle ORM (mysql2) · MySQL 8 · decimal.js عبر `server/services/money.ts` · tRPC v11 · React 19 + TanStack Query · vitest.

---

## الحقائق المُتحقَّقة من الكود (أساس الخطة — لا تُعِد اكتشافها)

| الحقيقة | الموضع | الأثر على الخطة |
|---|---|---|
| منفذ كتابة الدفتر **واحد** | `postEntry(tx, e: EntryInput)` — [ledgerService.ts:79](../server/services/ledgerService.ts#L79) | التوصيل = تعديل دالّةٍ واحدة، لا ٧٤ راوتراً |
| **تسريبٌ يتجاوز المنفذ** | `postOpeningEntry` يُدرج مباشرةً — [openingBalance.ts:69](../server/services/openingBalance.ts#L69) | **ش٠ تُصلحه أولاً**، وإلّا فات الخطّافَ الرصيدُ الافتتاحيّ صامتاً. ⚠️ **ليس عِلّةً حيّة**: الحارس متّسق (`assertPeriodOpen(localTodayDate())` و`entryDate = localTodayDate()` — نفس التاريخ). تجاوزٌ بنيويّ يصير عِلّةً **لحظة تركيب الخطّاف** فقط |
| **القيد ليس ملحقيّاً بالكامل** | `upsertOpeningEntry` **يُعدّل** ([:137](../server/services/openingBalance.ts#L137)) و**يحذف** ([:135](../server/services/openingBalance.ts#L135)) صفوف `accountingEntries` | **يُبطل افتراض «الدفتر ملحقيّ»**. بلا علاج: الحذف يُفشله FK، والتعديل يترك قيداً مزدوجاً **بائتاً يخالف الدفتر**. العلاج: `ON DELETE CASCADE` + `refreshJournal` عند التعديل (ش٠/ش١) |
| `EntryType` = **٣١ نوعاً** | [ledgerService.ts:8-50](../server/services/ledgerService.ts#L8) | التوثيق قال ٢٢ — خطأ. المتبقّي **٢٥** |
| المُخطَّط = **٦** فقط | `MAPPED_ENTRY_TYPES` — [postingEngine.ts:78](../server/services/accounting/postingEngine.ts#L78) | ش٢ تُكمِل الـ٢٥ على ٣ دفعات حسب الصعوبة |
| المحرّك **نقيّ لا يكتب** | [postingEngine.ts:1-3](../server/services/accounting/postingEngine.ts#L1) | لا يحتاج إعادة كتابة — يحتاج **موصِّلاً** فقط |
| يرمي `UnmappedEntryTypeError` على غير المُخطَّط | [postingEngine.ts:57](../server/services/accounting/postingEngine.ts#L57) | **خطر قاتل**: رميةٌ داخل معاملة البيع = ROLLBACK للفاتورة ⇒ الخطّاف يجب أن يبتلعها في SHADOW |
| `assertPeriodOpen` مطبَّق أصلاً | [ledgerService.ts:81](../server/services/ledgerService.ts#L81) | القيد المزدوج يرث حماية الفترة مجّاناً |
| شجرة الحسابات موجودة بـ`systemRole` فريد | `accounts` — [schema.ts:4743](../drizzle/schema.ts#L4743) | لا حاجة لجدولٍ جديدٍ للحسابات |
| مطابقةٌ ذاتيةٌ قائمة (٥ دوال) | [reconcileService.ts](../server/services/reconcileService.ts) + شاشة `Reconcile.tsx` | ش٤ **تُضيف إليها** لا تبني بديلاً |

---

## القيود العامّة (تسري على كل شريحة — لا استثناء)

- **الأموال:** `decimal.js` + `money.ts` (`round2` HALF_UP، `toDbMoney` نصاً). **ممنوع** `parseFloat`/`Number` على المال. حارس `check:money-schemas` يرفض `z.string()` العارية ⇒ استعمل `positiveMoneyString`.
- **الذرّية:** كل كتابةٍ داخل `withTx`. الظلّ يستعمل **نفس `tx`** المُمرَّر، ولا يفتح معاملةً ثانية أبداً.
- **الهجرات:** ملف SQL **يدويّ** (`db:generate` محرّم في هذا المشروع). **رقّم بعد فحص `origin/main`** (تصادم أرقام حدث مرّتين). أضِف مدخلاً في `_journal.json` بـ`when` **أكبر من آخر إدخال** وإلّا تجاهله الـmigrator صامتاً. `--> statement-breakpoint` بين كل جملتين.
- **أيّ `UNIQUE` جديد ⇒ مدخل في `UNIQUE_AR`** (`shared/errorMap.ar.ts`) وإلّا كسرت CI.
- **الفحص قبل الدفع:** `pnpm check` + **`pnpm test` كاملاً بـ`TZ=UTC`** (تشغيلٌ منتقى يُخفي حارسين ويُحمّر ١٨ اختبار تاريخ زوراً). قاعدةٌ مخصّصة عبر `TEST_DATABASE_URL` إن كانت حزمةٌ أخرى تعمل.
- **بلا إيموجي في `client/**`** — أيقونات `lucide-react` فقط (`check:emoji`).
- **الملفات الساخنة** (`server/routers.ts` · `client/src/App.tsx` · `client/src/components/AppLayout.tsx` · `drizzle/schema.ts` · `server/seed.ts`) **بيد قائد التكامل آخراً** — لا يلمسها كاتبٌ متوازٍ.
- **الفرع:** ابدأ من `origin/main` مُحدَّثاً. (فرع الجلسة الحالية `claude/system-pillars-value-a0e151` **١٨٥ التزاماً خلف main** — لا تبنِ عليه.)

---

## بوّابات السلامة الإنتاجية (سبب وجود هذه الخطة أصلاً)

| # | البوّابة | الإنفاذ |
|---|---|---|
| س١ | **إضافيّ بحت** — لا عمودٌ يُعدَّل ولا جدولٌ قائم يُمَسّ ولا سلوكُ قيدٍ حاليٍّ يتغيّر | مراجعة الهجرة: `CREATE TABLE` فقط + `ALTER` على جدول إعداداتٍ جديد |
| س٢ | **الافتراض `OFF`** — النشر بصفر أثر؛ التفعيل قرارٌ لاحقٌ منفصل | عمود `mode` افتراضه `'OFF'` + اختبار يثبت صفر صفوفٍ عند OFF |
| س٣ | **الظلّ لا يُفشِل عملاً أبداً** | `try/catch` شامل حول الخطّاف + اختبار يُجبر رميةً ويثبت نجاح البيع |
| س٤ | **نفس المعاملة** — لا حالة جزئية | الخطّاف يأخذ `tx` بارامتراً؛ اختبار: rollback البيع ⇒ لا قيد مزدوج يتيم |
| س٥ | **صفر ازدواج بنيوياً** | `UNIQUE(entryId)` على `journalEntries` |
| س٦ | **التوازن مفروضٌ عند الكتابة** | `assertBalanced` قبل الإدراج؛ سطرٌ غير متوازن ⇒ يُسجَّل فجوةً لا يُكتَب |
| س٧ | **بوّابة ACTIVE بالأدلّة** | ≥٣٠ يوماً SHADOW + `unmappedCount = 0` + انحراف المطابقة = `0.00` لكل دور — يفحصها الكود لا الإنسان |
| س٨ | **قابلية التراجع الفورية** | العودة إلى `OFF` تُوقف الكتابة فوراً؛ الجدولان يُفرَّغان بلا أثرٍ على أيّ رصيد |
| س٩ | **صلاحيات** | كل تقارير الدفتر خلف `reportViewerProcedure` (الخطّ الأحمر §٦ — لا `requireModule` عارياً) |
| س١٠ | **النشر** | `pnpm prod:deploy` حصراً (٧ خطوات ذرّية + `db:backup` + `db:verify`) — لا `db:push` عارياً |

---

## الشرائح

### ش٠ — سدّ التسريب + الأساس البنيويّ  ⟨صفر أثر · لا تحتاج قرار مالك⟩

**الملفات:**
- عدّل: `server/services/openingBalance.ts:61-90` (توجيه `postOpeningEntry` عبر `postEntry`)
- عدّل: `drizzle/schema.ts` (ساخن — بيد القائد): `journalEntries` · `journalLines` · `doubleEntrySettings`
- أنشئ: `drizzle/0XXX_double_entry_foundation.sql` (رقّم بعد فحص origin/main)
- أنشئ: `server/services/accounting/journalStore.ts`
- عدّل: `shared/errorMap.ar.ts` (مدخلا `UNIQUE_AR` للقيدين الجديدين)
- اختبار: `server/services/__tests__/journalFoundation.test.ts`

**العقد المُنتَج (يعتمد عليه ما بعده):**
```ts
// server/services/accounting/journalStore.ts
export type DoubleEntryMode = "OFF" | "SHADOW" | "ACTIVE";
export async function getDoubleEntryMode(tx: Tx): Promise<DoubleEntryMode>;
export async function writeJournal(
  tx: Tx,
  entryId: number,
  entryDate: Date,
  branchId: number | null,
  lines: JournalLine[],           // من postingEngine
): Promise<void>;                  // status='POSTED'
export async function writeJournalGap(
  tx: Tx, entryId: number, entryDate: Date, branchId: number | null, reason: string,
): Promise<void>;                  // status='UNMAPPED'، بلا أسطر
/** يحذف قيد الحدث المزدوج (إن وُجد) استعداداً لإعادة كتابته — لمسار تعديل مبلغ قيدٍ قائم. */
export async function dropJournal(tx: Tx, entryId: number): Promise<void>;
```

**المخطط (DDL — إضافيّ بحت):**
```sql
CREATE TABLE `journalEntries` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `entryId` BIGINT NOT NULL,                        -- accountingEntries.id
  `entryDate` DATE NOT NULL,
  `branchId` BIGINT NULL,
  `status` ENUM('POSTED','UNMAPPED') NOT NULL DEFAULT 'POSTED',
  `unmappedReason` VARCHAR(255) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `journalEntries_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_journal_entry` UNIQUE(`entryId`),   -- س٥: صفر ازدواج بنيوياً
  -- CASCADE إلزاميّ: `upsertOpeningEntry` يحذف قيوداً فعلاً ⇒ RESTRICT كان سيُفشل حذف رصيدٍ افتتاحيّ.
  CONSTRAINT `fk_journal_entry` FOREIGN KEY (`entryId`) REFERENCES `accountingEntries`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_journal_date_status` ON `journalEntries` (`entryDate`,`status`);
--> statement-breakpoint
CREATE TABLE `journalLines` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `journalId` BIGINT NOT NULL,
  `role` VARCHAR(40) NOT NULL,                      -- accounts.systemRole
  `debit`  DECIMAL(15,2) NOT NULL DEFAULT '0.00',
  `credit` DECIMAL(15,2) NOT NULL DEFAULT '0.00',
  CONSTRAINT `journalLines_id` PRIMARY KEY(`id`),
  CONSTRAINT `fk_journal_line` FOREIGN KEY (`journalId`) REFERENCES `journalEntries`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_journal_line_role` ON `journalLines` (`role`);
--> statement-breakpoint
CREATE TABLE `doubleEntrySettings` (
  `id` INT NOT NULL DEFAULT 1,
  `mode` ENUM('OFF','SHADOW','ACTIVE') NOT NULL DEFAULT 'OFF',
  `shadowStartedAt` TIMESTAMP NULL,
  `updatedBy` INT NULL,
  `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `doubleEntrySettings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
INSERT INTO `doubleEntrySettings` (`id`,`mode`) VALUES (1,'OFF');
```
> ⚠️ `accountId` **غير مخزَّن عمداً** (YAGNI): الأسطر تحمل `role`، والتقارير تصل بـ`JOIN accounts ON systemRole` — يُجنّب بحثَ حسابٍ في مسار البيع الساخن. يُعاد النظر في ش٤ فقط إن لزم.

**الخطوات:**

> **ملاحظة TDD:** توجيه `postOpeningEntry` عبر `postEntry` **إعادةُ هيكلةٍ بصفر تغيير سلوكيّ** — لا يمكن أن يكون له اختبارٌ فاشلٌ صادق. اختبارُه الحقيقيّ في ش١ (خطوة ٣ج: قيد OPENING يُنتج قيداً مزدوجاً في SHADOW) — وهو **يفشل حتماً إن بقي التجاوز**. هذه هي وضعيّته الصحيحة، ولا نصطنع له اختباراً هنا.

- [ ] **١. أضِف الجداول الثلاثة** إلى `drizzle/schema.ts` (ساخن — أنا القائد) + ملف الهجرة أعلاه + مدخل `_journal.json` بـ`when` أكبر من آخر إدخال. **رقّم بعد `git log origin/main -- drizzle/`.**
- [ ] **٢. أضِف `uq_journal_entry` إلى `UNIQUE_AR`** برسالة «قيدٌ مزدوجٌ مكرّرٌ لنفس الحدث المالي».
- [ ] **٣. اختباراتٌ فاشلة في `journalFoundation.test.ts`** (اكتبها قبل `journalStore.ts`):
  - أ) `getDoubleEntryMode` يعيد `"OFF"` على قاعدةٍ طازجة.
  - ب) `writeJournal` بأسطرٍ متوازنة ⇒ رأسٌ `status='POSTED'` + أسطرٌ بالعدد الصحيح و`Σdebit = Σcredit`.
  - ج) `writeJournal` بأسطرٍ **غير** متوازنة ⇒ **يرمي** (`assertBalanced`) وصفر صفوفٍ مكتوبة.
  - د) `writeJournal` مرّتين لنفس `entryId` ⇒ `ER_DUP_ENTRY` (يُثبت س٥ على مستوى القاعدة).
  - هـ) `writeJournalGap` ⇒ رأسٌ `status='UNMAPPED'` بلا أسطر و`unmappedReason` محفوظ.
  - و) **CASCADE:** اكتب قيداً مزدوجاً ثم احذف صفّ `accountingEntries` ⇒ الرأس والأسطر تُحذف تلقائياً وصفر صفوفٍ يتيمة. **هذا اختبار حالة `upsertOpeningEntry`.**
  - ز) `dropJournal` يحذف الرأس وأسطره ويصمت على `entryId` بلا قيد.
- [ ] **٤. شغّل ⇒ تأكّد فشل السبعة.** `TZ=UTC pnpm vitest run server/services/__tests__/journalFoundation.test.ts`
- [ ] **٥. اكتب `journalStore.ts`** بالعقد أعلاه. `writeJournal` يستدعي `assertBalanced` **قبل** الإدراج ويرمي إن اختلّ — الابتلاع مسؤولية الخطّاف (ش١) لا المخزن.
- [ ] **٦. شغّل ⇒ السبعة تمرّ.**
- [ ] **٧. وجّه `postOpeningEntry` عبر `postEntry`** — احذف `tx.insert(accountingEntries)` المباشر واستبدله بـ`await postEntry(tx, { entryType: "OPENING", customerId…, entryDate: localTodayDate(), dedupeKey… })` **بنفس الحقول حرفياً**. لا تغيّر قيمةً واحدة. (يُسقط `assertPeriodOpen` المكرّر — `postEntry` يفعله.)
- [ ] **٨. صفر انحدار:** `TZ=UTC pnpm vitest run server/services/__tests__/openingBalance* server/services/__tests__/*import*` ⇒ كلها خضراء بلا تعديل.
- [ ] **٩. `pnpm check` + `TZ=UTC pnpm test` كاملاً.**
- [ ] **١٠. التزم:** `feat(accounting): أساس الدفتر المزدوج — جدولا القيد وعلَم الأوضاع + توحيد منفذ الكتابة`

**DoD:** خلفية ✅ · واجهة ⛔ (لا واجهة لهذه الشريحة — أساسٌ بنيويّ مُعلَن) · `pnpm check` ✅ · ٧ اختبارات ✅ · صفر صفوفٍ مكتوبة والوضع OFF ✅ · صفر انحدار في الرصيد الافتتاحي والاستيراد ✅

---

### ش١ — خطّاف الظلّ  ⟨صفر أثر · لا تحتاج قرار مالك⟩

**الملفات:**
- عدّل: `server/services/ledgerService.ts:52-104` (حقل `cashRole` في `EntryInput` + التقاط `insertId` + نداء الخطّاف)
- عدّل: `server/services/voucher/**` + `server/services/sale/create.ts` (تمرير `cashRole` عند القبض/الدفع بالبطاقة)
- أنشئ: `server/services/accounting/shadowHook.ts`
- اختبار: `server/services/__tests__/shadowHook.test.ts`

**العقد المُستهلَك:** `journalStore.ts` (ش٠) · `postingLinesFor`/`MAPPED_ENTRY_TYPES`/`UnmappedEntryTypeError` (P1 قائم).

> ⚠️ **ثغرةٌ كشفتها المراجعة الذاتية للخطة — تُعالَج هنا لا لاحقاً:** `PostingInput` يقبل `cashRole: "CASH" | "CARD_BANK"`، لكن **`EntryInput` لا يحمل طريقة الدفع إطلاقاً** ([ledgerService.ts:52-75](../server/services/ledgerService.ts#L52)). فالخطّاف بلا معلومةٍ إضافية سيُرحّل **كل** قبضٍ إلى `CASH` — فتُضخَّم الخزينة ويُصفَّر البنك صامتاً في ميزان المراجعة.
>
> **العلاج المُعتمَد (نُقِّح بعد قراءة المواضع التسعة فعلياً):** حقلٌ اختياريّ **`paymentMethod?: string | null`** في `EntryInput` — يُمرَّر **خاماً** كما تملكه المواضع أصلاً، **ولا يُخزَّن** (لا عمود له في `accountingEntries`؛ يستهلكه الخطّاف وحده). الترجمة إلى دلوٍ محاسبيّ تبقى في **مكانٍ واحد** داخل طبقة المحاسبة (`cashRoleFor` في `shadowHook.ts`) بدل منطقٍ محاسبيٍّ مكرَّرٍ في تسعة ملفات.
>
> **طرق الدفع سبعٌ لا اثنتان** ([schema.ts:1928](../drizzle/schema.ts#L1928)): `CASH → CASH` · `CARD`/`TRANSFER`/`CHECK` → `CARD_BANK` · و**`WALLET`/`EXCHANGE`/`TELECOM` ⇒ `null` = فجوة**. هذه الثلاث ليست نقداً ولا بنكاً بل أصولٌ مستقلّة، والكود يقرّ بذلك صراحةً (الصيرفة «لا تمسّ الخزينة»، رصيد زين «لا يلمس الدرج أبداً») — حشرُها في أيٍّ من الدلوين إفسادٌ صامت. تُخصَّص لها أدوارُها في الدفعة ٢أ.
>
> **وغيابُ الطريقة على `PAYMENT_IN`/`PAYMENT_OUT` ⇒ فجوة أيضاً، لا افتراضَ نقدٍ** (قرار المالك ١١/٨: «الفجوة الموسومة صحيحة»). فأيّ موضعِ قبضٍ يُغفَل عن التمرير يظهر **صارخاً** بدل أن يُصنَّف نقداً خطأً. لذلك تُمرَّر `"CASH"` **صراحةً** حتى في المواضع النقدية بطبيعتها (تحصيل COD، التوريد، تسوية الشطب).
>
> البديل المرفوض: قراءة `receipts` بـ`receiptId` داخل الخطّاف — استعلامٌ إضافيّ في مسار البيع الساخن.

**الكود الجوهريّ:**
```ts
// server/services/accounting/shadowHook.ts
/** يكتب القيد المزدوج ظلّاً. **لا يرمي أبداً** (س٣): أيّ فشلٍ يُسجَّل فجوةً، والعمل التجاريّ يمضي. */
export async function shadowPost(tx: Tx, entryId: number, e: EntryInput): Promise<void> {
  try {
    const mode = await getDoubleEntryMode(tx);
    if (mode === "OFF") return;                                   // س٢
    const entryDate = e.entryDate ?? new Date();
    if (!MAPPED_ENTRY_TYPES.has(e.entryType)) {
      await writeJournalGap(tx, entryId, entryDate, e.branchId ?? null, `نوعٌ غير مُخطَّط: ${e.entryType}`);
      return;
    }
    const lines = postingLinesFor({
      entryType: e.entryType,
      revenue: e.revenue?.toString(), cost: e.cost?.toString(),
      amount: e.amount?.toString(),  taxAmount: e.taxAmount?.toString(),
      party: e.customerId ? "CUSTOMER" : e.supplierId ? "SUPPLIER" : null,
    });
    await writeJournal(tx, entryId, entryDate, e.branchId ?? null, lines);
  } catch (err) {
    try {
      await writeJournalGap(tx, entryId, e.entryDate ?? new Date(), e.branchId ?? null,
        err instanceof Error ? err.message.slice(0, 255) : "خطأٌ غير معروف");
    } catch { /* الفجوة نفسها فشلت ⇒ اصمت. لا شيء يُفشِل عملية أعمال. */ }
  }
}
```
```ts
// ledgerService.ts — التعديل الوحيد داخل postEntry (التوقيع لا يتغيّر ⇒ صفر أثر على ٧٤ راوتراً)
const res = await tx.insert(accountingEntries).values({ /* … كما هو حرفياً … */ });
await shadowPost(tx, Number((res as unknown as { insertId: number }).insertId), e);
```

**الخطوات:**
- [ ] **١. اختبارٌ فاشل — الوضع OFF يكتب صفراً:** فعّل بيعاً وتأكّد `SELECT COUNT(*) FROM journalEntries = 0`.
- [ ] **٢. اختبارٌ فاشل — الوضع SHADOW يكتب قيداً متوازناً لبيعٍ نقديّ:** `Σdebit = Σcredit` و`AR` مدينٌ بالإجمالي و`PAYMENT_IN` منفصلٌ يُدائنه.
- [ ] **٢ب. اختبارٌ فاشل — القبض بالبطاقة يُرحَّل إلى `CARD_BANK` لا `CASH`:** فاتورةٌ مدفوعةٌ ببطاقة ⇒ سطرٌ مدينٌ على `CARD_BANK` وصفرٌ على `CASH`. (يفشل قبل إضافة حقل `cashRole` — انظر التحذير أعلاه.)
- [ ] **٣. اختبارٌ فاشل — نوعٌ غير مُخطَّط لا يُفشِل البيع:** فعّل `GIFT_OUT` في SHADOW ⇒ الفاتورة تنجح **و**صفٌّ `status='UNMAPPED'` موجود. **هذا اختبار س٣ الحاسم.**
- [ ] **٣ج. اختبارٌ فاشل — قيد `OPENING` يُنتج قيداً مزدوجاً في SHADOW:** أنشئ رصيداً افتتاحياً لعميل ⇒ رأسٌ `POSTED` بسطرَي AR/`OPENING_EQUITY`. **هذا هو الاختبار الحقيقيّ لتوجيه ش٠-خطوة٧** — يفشل حتماً إن بقي التجاوز.
- [ ] **٣د. اختبارٌ فاشل — تعديل الرصيد الافتتاحي يُحدّث القيد المزدوج:** استدعِ `upsertOpeningEntry` بمبلغٍ جديد على طرفٍ له قيد ⇒ أسطر القيد المزدوج تطابق **المبلغ الجديد** لا القديم. **العلاج:** في مسار `tx.update` استدعِ `dropJournal(tx, existing.id)` ثم أعِد `shadowPost` بالمبلغ الجديد. بلا هذا يبقى القيد بائتاً يخالف الدفتر.
- [ ] **٤. اختبارٌ فاشل — الذرّية (س٤):** أفشِل البيع عمداً بعد `postEntry` داخل نفس `withTx` ⇒ صفر صفوفٍ في `journalEntries` (لا قيدٌ يتيم).
- [ ] **٥. شغّل الأربعة ⇒ تأكّد فشلها.**
- [ ] **٦. اكتب `shadowHook.ts`** بالكود أعلاه، ووصّله في `postEntry`.
- [ ] **٧. شغّل ⇒ الأربعة تمرّ.**
- [ ] **٨. اختبار انحدار حاسم:** `TZ=UTC pnpm test` كاملاً **مرّتين** — مرّةً والوضع `OFF` ومرّةً `SHADOW`. **الحزمة كلها يجب أن تبقى خضراء في الحالتين.** أيّ اختبارٍ يتغيّر سلوكه بين الوضعين = خرقٌ لـس١/س٣ ⇒ قف وأصلح.
- [ ] **٩. التزم:** `feat(accounting): خطّاف الظلّ — كتابة القيد المزدوج بلا أيّ أثرٍ على الأعمال`

**DoD:** خلفية ✅ · اختبارات ٤+ ✅ · صفر تغيير في توقيع `postEntry` ✅

#### ما نُفِّذ فعلاً في ش١ وما تُرك عمداً (١١/٨)

**مُوصَّلة (طريقة الدفع صريحةٌ في الكود):** `printSaleService` · `workOrder/create` · `workOrder/deliver`.

**فجواتٌ متعمَّدة — لن تُخمَّن:**
| الموضع | السبب |
|---|---|
| `sale/create` · `sale/payment` · `reception/deposits` | **مملوكةٌ لجلسةٍ حيّة** (`claude/cashier-permissions-invoices-794d9d` تدّعي `server/services/sale/**` و`reception/**`). تُوصَّل في متابعةٍ بعد تحرّرها — سطرٌ واحدٌ لكلٍّ. |
| `delivery/courier` · `delivery/remittance` | تحصيل COD والتوريد: نقدٌ ظاهراً، لكن وجهته (درج/خزينة/عهدة) غير مؤكَّدةٍ من الكود ⇒ تُحسم في الدفعة ٢أ مع أدوار العهدة. |
| `delivery/settle` | **الأخطر لو خُمِّن**: يُسدّد فاتورة العميل من **عهدة المندوب** لا من درجٍ نقديّ — تمرير `"CASH"` كان سيضع نقداً وهمياً في الدرج. |
| `assets/dispose` · `expenseService` · `purchaseReturnsService` | `PAYMENT_IN` بلا عميل (أو بمورّد) ⇒ يرفضها المحرّك أصلاً بتصميمه. |

**بوّابةٌ مؤجَّلة بوعيٍ (ليست إغفالاً):** تشغيل الحزمة الكاملة في وضع **SHADOW** يتطلّب تجاوزاً بيئياً (`doubleEntrySettings` صفٌّ في القاعدة تمسحه الاختبارات ⇒ تعود OFF). **شرطٌ قبل تفعيل SHADOW، لا قبل الالتزام** — الحزمة تُشغَّل الآن في وضع OFF وهو حالةُ الإنتاج الفعلية. خطر السلوك في SHADOW **محصورٌ بنيوياً** بـ`try/catch` الشامل في الخطّاف، ويُثبته الاختبار ٦.

**انحرافٌ عن TDD يُذكر بأمانة:** اختبارات ش١ العشرة كُتبت **بعد** `shadowHook.ts` لا قبله (كُتب الخطّاف أثناء انتظار حزمة ش٠ استثماراً للوقت). ش٠ التزمت الترتيب الصحيح.

---

### ش٢ — إكمال الخرائط الـ٢٥  ⛔ **محجوبة بقرار المالك (انظر أدناه)**

تُقسَّم ثلاث دفعات حسب الوضوح المحاسبيّ — **لا تُخمَّن أيّ خريطة** (المبدأ الحاكم في رأس `postingEngine.ts`: «لا تخمين على النواة المالية»).

| الدفعة | الأنواع | الصعوبة |
|---|---|---|
| **٢أ — نقلُ أصلٍ صفريّ** (١٣ نوعاً) | `CASH_HANDOVER` · `CASH_TRANSFER_OUT/IN` · `SHIFT_FLOAT_OUT` · `TREASURY_FUNDING` · `DELIVERY_DISPATCH/REMIT` · `EXCHANGE_DEPOSIT/WITHDRAW/FX_BUY` · `DIGITAL_WALLET_DEPOSIT/WITHDRAWAL/CONSUMPTION` | **سهلة** — مدينُ أصلٍ ودائنُ أصل، بلا P&L. تحتاج أدواراً جديدة (`TREASURY_CASH`, `SHIFT_DRAWER`, `DELIVERY_FLOAT`, `EXCHANGE_WALLET`, `DIGITAL_WALLET`) |
| **٢ب — مصروفٌ بلا نقد** (٧ أنواع) | `INTERNAL_USE` · `WASTAGE` · `DELIVERY_FEE` · `DELIVERY_WRITEOFF` · `EXCHANGE_FEE` · `GIFT_OUT` · `DIGITAL_WRITEOFF` | **متوسطة** — Dr مصروف / Cr مخزون أو نقد. الأدوار قائمة (`LOSSES`, `OPERATING_EXPENSE`) |
| **٢ج — المحمَّلة بأكثر من معنى** (٥ أنواع) | `ADJUST` · `RETURN`(مورّد) · `EXCHANGE_SETTLE` · `EXCHANGE_FX_DIFF` · `DIGITAL_WALLET_REVERSAL/ADJUSTMENT` | **صعبة — تلزمها مراجعةٌ محاسبيةٌ بشريّة.** `ADJUST` وحده يخدم تقريب IQD وفروقاً أخرى بمعانٍ مختلفة |

كل دفعةٍ: خريطة + اختبار توازنٍ صارم لكل نوع + تشغيل ظلٍّ أسبوعاً + مراجعة `review-module`.

---

### ش٣ — ميزان المراجعة ودفتر الأستاذ  ⟨قراءة فقط⟩

- أنشئ: `server/services/reports/trialBalance.ts` · `generalLedger.ts`
- عدّل: `server/routers/reportsRouter.ts` (**`reportViewerProcedure` — س٩**)
- أنشئ: `client/src/pages/TrialBalance.tsx` · `GeneralLedger.tsx` + مدخلٌ في `ReportsCenter.tsx`
- ساخن (القائد): `App.tsx` (مساران) · `AppLayout.tsx` (تنقّل)

**المحتوى:** ميزان مراجعة بنطاق تاريخ (رصيد افتتاحيّ / مدين / دائن / رصيد ختاميّ لكل حساب، مع **سطر تحقّق Σمدين=Σدائن بارز**) · دفتر أستاذ لحسابٍ واحدٍ بحركةٍ زمنيّة مرتبطة بالقيد المصدر · **لافتة صريحة** في وضع SHADOW: «للمطابقة فقط — الدفتر المُعتمَد ما زال المبسّط». تصدير Excel عبر `DataTable`.

### ش٤ — المطابقة المزدوجة + بوّابة ACTIVE

- عدّل: `server/services/reconcileService.ts` — أضِف `reconcileDoubleEntry()` سادسةً: يقارن Σ(مدين−دائن) لكل `role` بالرصيد المشتقّ القائم (AR ↔ `customers.currentBalance` · AP ↔ `suppliers.currentBalance` · INVENTORY ↔ `branchStock`×التكلفة · CASH ↔ الخزينة).
- عدّل: `client/src/pages/Reconcile.tsx` — بطاقةٌ سادسة + عدّاد فجوات.
- أنشئ: `server/services/accounting/activationGate.ts` — `canActivate()` تُعيد `{ ok, blockers[] }` وتفحص **آلياً** (س٧): ≥٣٠ يوماً SHADOW · `unmappedCount = 0` · انحراف كل دور `= 0.00`. الانتقال إلى ACTIVE **يرفضه الكود** ما لم تمرّ.

### ش٥ — بوّابة الإقفال الشهريّ

> **⚠️ تصحيحٌ لهذه الخطة (١١/٨):** كتبتُ ابتداءً أنّ «الإقفال الشهريّ الموحَّد غير موجود». **خطأ.** التحقّق من الكود أظهر منظومةً كاملة: [`monthlyClosePack.ts`](../server/services/reports/monthlyClosePack.ts) + `reports.monthlyClosePack` (خلف `reportsBranchScoped`) + شاشة [`MonthlyClosePack.tsx`](../client/src/pages/MonthlyClosePack.tsx) (٢٩٧ سطراً) + اختبارات. تُعيد استعمال خدمات التقارير القائمة بمصدر حقيقةٍ واحد، وتغطّي: المبيعات · الربح الإجمالي · المشتريات · المصروفات · الخزينة · لقطة الذمم · أوامر الشغل المُسلَّمة.
>
> **لا يُعاد بناء أيٍّ من ذلك.** الشريحة تتحوّل من «ابنِ الإقفال الشهري» إلى «**حوِّل الحزمة القارئة إلى بوّابة تُقفِل**» — أصغر بكثير، وكلّها فوق ما هو قائم.

**الفجوة الفعليّة (مُتحقَّقٌ منها):** الحزمة **تعرض ولا تُقفِل**. ينقصها شيئان:
1. **قائمة جاهزيةٍ آليّة** — لا شيء يمنع إقفال شهرٍ فيه ورديةٌ مفتوحة أو سندٌ معلَّق أو مطابقةٌ منحرفة.
2. **فعلُ الإقفال** — `periodLockService` قائمٌ ويعمل، لكن لا يصل إليه المالك من هذه الشاشة.

#### ✅ قرار المالك (١١/٨) — تصنيف البنود والصلاحية

| البند | التصنيف |
|---|---|
| **وردياتٌ مفتوحة** في الشهر | 🔴 **يحجب** |
| **سنداتٌ بانتظار الاعتماد** | 🔴 **يحجب** |
| انحراف المطابقات الستّ · فجوات الدفتر المزدوج · جلسات جردٍ نشطة · طلبات تسوية مخزونٍ معلّقة | 🟡 **تنبيهٌ فقط** |

**الصلاحية — نُقِّحت بعد اكتشافٍ في الكود (١١/٨):** كنت سأضع `closeMonth` على `managerProcedure`. **اكتشافٌ أوقف ذلك:** `periodLockRouter.lock` قائمٌ على **`adminProcedure`**، و`lockPeriod` **عامٌّ لكل الفروع** (`financialPeriods` بلا `branchId`) ⇒ فتحُه للمدير كان سيجعل مديرَ فرعٍ واحدٍ يقفل الشهر على الشركة كلّها — **إضعافُ ضابطٍ قائم**. عُرِض على المالك فحسم:

> **المدير يطلُب، والمالك/الأدمن يُقفل** (Maker-Checker، نفس نمط النظام) · **ولا تجاوز للحاجز إطلاقاً.**

**الأثر:** مسار `isOwner`/التجاوز **مُلغى كليّاً** — لا حقل سببٍ ولا استثناء. والحاجزان مطلقان، وهو الأسلم: سندٌ معلَّقٌ تُرك خلف قفلٍ يصير **غير قابلٍ للاعتماد أبداً** (`assertPeriodOpen` يرفضه) ⇒ التجاوز كان سيخلق سنداً ميّتاً.

#### ش٥أ — الجاهزية ✅ مُنفَّذة (١١/٨)

- أنشئ: [`server/services/reports/monthCloseReadiness.ts`](../server/services/reports/monthCloseReadiness.ts) — تُعيد `{ key, label, status, count, detail }[]` + `blocked`.
- عدّل: `server/routers/reportsRouter.ts` — `monthCloseReadiness` على `reportsBranchScoped` (قراءةٌ محضة، خلف بوّابة التقارير — مُسجَّلٌ في جرد الصلاحيات: `reports READ · manager|accountant|auditor · asserted`).
- عدّل: `client/src/pages/MonthlyClosePack.tsx` — بطاقة الجاهزية فوق الحزمة.
- **بلا هجرة.** ١٠ اختبارات خضراء + `check` + `build` + الحرّاس التسعة.

**قرارٌ تقنيّ:** أُسقِط بند «انحراف المطابقات» من الجاهزية — دوالّ `reconcileService` غير مُنطَّقةٍ بشهرٍ ولا فرع، فبندٌ مُنطَّقٌ بهما مبنيٌّ عليها **لا يعني ما يقول**. يُضاف في ش٤ عبر `reconcileDoubleEntry` حين يُنطَّق بحقّ.

#### ش٥ب — طلب الإقفال واعتماده ⬜ التالية

- **هجرة جديدة:** `monthCloseRequests` (`month` · `branchId` · `requestedBy/At` · `status` PENDING/APPROVED/REJECTED · `decidedBy/At` · `note` · **لقطة الجاهزية وقت الطلب**).
- `requestMonthClose` على **`managerProcedure`** — يرفض إن كان `blocked` (يُعيد الفحص **خادمياً تحت المعاملة**، لا يُصدَّق ادّعاء الواجهة).
- `approveMonthClose` على **`adminProcedure`** — يُعيد فحص الجاهزية تحت المعاملة **ثم** يفوّض إلى `lockPeriod` القائم + قيد تدقيق. **الطالب ≠ المعتمِد** (نمط SOD المعتمَد).
- الشاشة: زرّ «طلب إقفال» للمدير (مُعطَّلٌ عند وجود حاجز) + طابور اعتمادٍ للأدمن.

**اختبارات مُلزِمة:** وردية مفتوحة تحجب · سند معلَّق يحجب · تنبيهٌ لا يحجب · **مديرٌ يستدعي `approveMonthClose` ⇒ `FORBIDDEN`** · طلبٌ مُلفَّقٌ بحواجز قائمة يُرفض خادمياً · الطالب نفسه يعتمد ⇒ يُرفض · الاعتماد يقفل الفترة فعلاً ويكتب تدقيقاً · **لا مسار تجاوزٍ موجودٌ إطلاقاً** (اختبارٌ سلبيّ صريح).

**قيدٌ معروفٌ يُصرَّح به:** `receivablesSnapshot` **لقطةٌ حاليّةٌ لا تاريخية** — الكود يقرّ صراحةً أنّ الأرصدة الجارية لا تُعاد بناؤها لتاريخٍ ماضٍ. أي أنّ إقفال شهرٍ متأخّرٍ يعرض ذمم **اليوم** لا ذمم نهاية الشهر. **الدفتر المزدوج يحلّ هذا بنيوياً** (قيودٌ مؤرَّخة ⇒ رصيدٌ لأي تاريخ) — فهذه فائدةٌ ثانيةٌ لـP2 لم تكن في حسباني، وتُنجَز في ش٣ لا هنا.

---

## قرارات المالك

### ✅ محسوم (١١/٨/٢٠٢٦)

**١. مستوى الطموح = ميزان مراجعة رسميّ كامل** يقبله محاسبٌ قانونيّ أو جهةٌ ضريبية. **الأثر الملزِم:**
- الـ**٢٥** خريطة كلّها في النطاق — **لا يُقبَل إبقاء أيّ نوعٍ فجوةً دائمة**.
- الدفعة **٢ج** (`ADJUST` · `RETURN` مورّد · `EXCHANGE_SETTLE` · `EXCHANGE_FX_DIFF` · `DIGITAL_WALLET_REVERSAL/ADJUSTMENT`) **تلزمها مصادقةُ محاسبٍ بشريٍّ مكتوبة** قبل الدخول في ACTIVE — تُرفَق في هذا الملف.
- بوّابة س٧ تُشدَّد: `ACTIVE` تتطلّب `MAPPED_ENTRY_TYPES.size === 31` (كل أنواع `EntryType`) إضافةً إلى شروطها الحالية. **يفحصها الكود.**
- التزامٌ تابع: القوائم المالية الرسمية (ميزانية/دخل) تصير امتداداً منطقياً بعد ACTIVE، لا نطاقاً مستقلّاً.

### ⬜ ما زالت مطلوبة (تحجب ش٢ج فقط)
2. **الضريبة:** الافتراض الحالي في المحرّك أن `amount − revenue` يُدائن **التزاماً ضريبياً**. بنشاطٍ بلا VAT هو صفرٌ دائماً — نُبقيه أم نُسقط الحساب؟
3. **فصل إيراد التوصيل:** التعليق في `postingEngine.ts:12` يقول إن `sale/create` **يخلط** أجرة التوصيل في `revenue`. فصلها في P2 يغيّر تبويب الإيراد (لا مجموعه). نفصل الآن أم بعد ACTIVE؟
4. **`ADJUST`:** يخدم اليوم تقريب IQD وفروقاً أخرى بمعنى واحد. نشقّه لنوعين مميَّزين (هجرة enum) أم نُبقيه فجوةً موسومة؟

---

## المهارات المُفعَّلة لكل طور

| الطور | المهارة | الغرض |
|---|---|---|
| التخطيط | `writing-plans` ✅ مُفعَّلة | هذه الوثيقة |
| كل شريحة | `build-slice` ✅ مُفعَّلة | عقد → كتّاب → تحقّق → نواقص → تكامل + بوّابة DoD آلية |
| كل شريحة | `test-driven-development` | اختبارٌ فاشلٌ أولاً — كل خطوةٍ أعلاه بهذا النمط |
| بعد ش١ وش٢ وش٤ | `review-module` | مراجعةٌ عدائيةٌ متعددة العدسات (أموال/ذرّية/أمان) |
| قبل ACTIVE | `financial-integrity-audit-fresh` | تدقيقٌ عدائيّ مستقلّ **من الكود فقط** — البوّابة الأخيرة قبل اعتماد الدفتر |
| قبل كل التزام | `verification-before-completion` | لا ادّعاء إنجازٍ بلا دليل |

---

## ما هو **خارج** النطاق صراحةً

إعادة كتابة الدفتر المبسّط · حذف أو تعديل أيّ قيدٍ تاريخيّ · تغيير أيّ رصيدٍ مشتقّ قائم · الترحيل الرجعيّ للقيود التاريخية (يُدرَس بعد ACTIVE بقرارٍ منفصل) · القوائم المالية الرسمية (ميزانية/دخل/تدفّق نقديّ بالشكل القانونيّ — تأتي بعد ميزان المراجعة).

---

## سجلّ التنفيذ

| الشريحة | الحالة | PR | منشور | ملاحظات |
|---|---|---|---|---|
| ش٠ الأساس | 🟩 مُنفَّذة ومتحقَّقة | — | — | ٨/٨ اختبارات · **الحزمة الكاملة ٤٢٠٣/٤٢٠٣ في ٣٨٤ ملفاً خضراء (TZ=UTC)** · `check:guards` التسعة |
| ش١ الظلّ | 🟩 مُنفَّذة (تنتظر الحزمة + الالتزام) | — | — | ١٠/١٠ اختبارات · `pnpm check` نظيف · `check:guards` التسعة · ٣ مواضع مُوصَّلة و٦ فجواتٍ متعمَّدة (الجدول أعلاه) |
| ش٢ الخرائط | 🔒 محجوبة | — | — | تنتظر قرارَي المالك ١ و٤ |
| ش٣ التقارير | ⬜ لم تبدأ | — | — | تعتمد ش١ (تعمل ولو ناقصة الخرائط) |
| ش٤ المطابقة | ⬜ لم تبدأ | — | — | تعتمد ش٣ |
| ش٥ الإقفال | ⬜ لم تبدأ | — | — | مستقلّة — يمكن تنفيذها بالتوازي مع ش٣ |
