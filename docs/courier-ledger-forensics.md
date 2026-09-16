# فحصٌ جنائيّ: مصادر رصيد جهة التوصيل — إثباتٌ أو تفنيد

> **النطاق:** قراءةٌ محضة على شجرة العمل `silly-ishizaka-157539` عند `HEAD = 898deef6` (2 سبتمبر 2026).
> **بلا قسم توصياتٍ تصميميّة** — الحكم للمالك بعد قراءة الأدلّة.
>
> ⚠️ **عن أرقام السطور:** كلّ مرجعٍ أدناه مأخوذٌ من **محتوى `HEAD`** (`git show HEAD:<path>`) لا من ملفّات
> القرص، لأنّ أربعةً من الملفّات المستشهَد بها كانت تُعدَّل من موجاتٍ أخرى أثناء الفحص
> (`delivery/courier.ts` · `delivery/queries.ts` · `reconcileService.ts` · `superAppRouter.ts` ظهرت `M`
> في `git status`). فإن اختلف الرقم عندك، ابحث عن **اسم الدالّة والرمز** المذكورَين — كلاهما مُثبَتٌ في كلّ بند.

---

## الخلاصة التنفيذية — الحكم

# **مؤكَّدة جزئياً**

الفرضية **صحيحةٌ في نتيجتها ومغلوطةٌ في سببها المزعوم**، والفرق بينهما جوهريّ لأنّ البناء على السبب الخاطئ
يعالج ما ليس مريضاً:

**١) ما فُنِّد — «عمودٌ يكتبه 18+ موضعاً وتتجاوزه أربعة وتكتب عليه استيراد»:** غير صحيح.
`deliveryParties.currentBalance` له **مَعبرٌ واحدٌ حصريّ** هو `adjustDeliveryBalance`
(`server/services/ledgerService.ts:297`) بـ **9 مستدعين لا غير**، كلُّهم داخل `withTx`، وكلُّهم يقفلون صفّ
الجهة `.for("update")` قبل الكتابة. **لا يوجد** أيّ `UPDATE` مباشر على العمود، ولا مسار استيراد، ولا رصيدٌ
افتتاحيّ: `createDeliveryParty` لا يقبل `currentBalance` أصلاً (`delivery/parties.ts:148-161`)، والأربعة
`update(deliveryParties)` الأخرى تكتب `isActive` أو `userId` أو حزمة تعديلٍ لا تحوي العمود
(`parties.ts:276` · `parties.ts:303` · `parties.ts:557` · `deliveryLegacyRepairService.ts:828`).
**جانبُ الكتابة مُحكَم.**

**٢) ما أُكِّد — «ثلاثة مصادرَ لا تسوية بينها»:** صحيحٌ حرفياً، لكنّ الجرح في **جانب القراءة والتزامن** لا في
تعدّد الكُتّاب. وجدتُ **13 صيغةً مختلفةً** لمفهوم «عهدة الجهة/تعرّضها» موزّعةً على ثلاث قواعد بيانات دلاليّة
(العمود المخزَّن · `deliveryLedgerEntries` · أعمدة `deliveryConsignments`) + رابعةٍ للمطابقة
(`accountingEntries`). ولا واحدةَ منها مشتقّةٌ من أخرى، ولا دالّةَ توفيقٍ بينها.

**٣) الدليل القاطع أنّ الشيفرة نفسها لا تثق بأيّ مصدر:** حارس سقف الإسناد يأخذ **الأكبر** من الاثنين بدل
اشتقاق أحدهما من الآخر:

```ts
// server/services/delivery/parties.ts:49-51 (assertFloatLimitTx)
const legacyCash = money(party.currentBalance ?? "0");
const after = DecimalMax(committed, legacyCash).plus(codAmount).toDecimalPlaces(2);
```

`DecimalMax` اعترافٌ مكتوبٌ بأنّ المصدرين قد يفترقان، وأنّ لا أحدَ يعرف أيُّهما الصادق.

**٤) الجذر البنيويّ — «مصدرا الحقيقة» المُعلَنان ميّتان:** الوحدتان اللتان أُنشئتا في Slice DFP1/DFP2
لتوحيد هذا المفهوم بالضبط **لا يستوردهما أيُّ ملفٍّ إنتاجيّ**:

| الوحدة | المستوردون في `server/**` أو `client/**` | حالة الاختبار |
|---|---|---|
| `computePartyExposure` (`shared/partyExposure.ts:70`) | **صفر** | 21 اختباراً يمرّ |
| `shared/deliveryOpenParcel.ts` بأكمله (`OPEN_PARCEL_SQL_FILTER` · `OPEN_CONSIGNMENT_STATUSES` · `isDeliveredAwaitingRemittance` · `isOpenConsignmentStatus`) | **صفر** | `deliveryOpenParcel.test.ts` يمرّ |

المستورَد من `shared/partyExposure.ts` هو **قاموس التسميات وحده** (`PARTY_EXPOSURE_LABEL_AR` في
`client/src/pages/DeliveryHub.tsx:50`)؛ أمّا **الحساب** فمنسوخٌ SQL يدوياً في موضعين مستقلَّين
(`parties.ts:376-389` و`queries.ts:731-744`).
⇒ الاختباران الأخضران يحرسان شيفرةً لا تعمل، والشيفرة العاملة بلا حارس. هذا **بالضبط** نمط «الأخضر الكاذب»
المسجَّل في `CLAUDE.md §٨`.

**٥) الحصيلة:** أثبتُّ **7 انحرافاتٍ حتميّة** (لا احتماليّة) موصوفةً خطوةً خطوة أدناه؛ **5 منها** واقعةٌ في
المسار اليوميّ الطبيعيّ ومرئيّةٌ للمستعمِل، و**1** يتطلّب استدعاءَ الإجراء مباشرةً (الواجهة تحجبه اليوم
ولا يحجبه الخادم)، و**1** يقفل مالاً ولا يُظهره. وفنّدتُ ستّة أشياء كان يسهل عدُّها انحرافاً وهي **فروقٌ مقصودة**.

---

## ١) جدول الكُتّاب — `deliveryParties.currentBalance`

**المَعبر الوحيد:** `server/services/ledgerService.ts:297-309` — `adjustDeliveryBalance(tx, partyId, delta)`
بزيادةٍ نسبيّة `SET currentBalance = currentBalance + ?` (ذرّيّة على مستوى SQL؛ لا قراءة-ثمّ-كتابة).

| # | الموضع (HEAD) | الدالّة | الاتّجاه | داخل `withTx`؟ | قيد `deliveryLedgerEntries` مقابل | قيد `accountingEntries` مقابل |
|---|---|---|---|---|---|---|
| 1 | `delivery/courier.ts:474` | `confirmCourierDelivery` (طلب متجر) | `+ collected` | نعم | `COD_COLLECTED` (`:479`) | `DELIVERY_DISPATCH` بمفتاح `ONLINE_COD_CUSTODY:{inv}` ✅ |
| 2 | `delivery/courier.ts:849` | `confirmConsignmentDelivery` | `+ (cod + shortage)` | نعم | `COD_COLLECTED` (`:856`) **+** `SHORTFALL_ASSIGNED` (`:867`) | `DELIVERY_DISPATCH` بمفتاح `DELIVERY_CUSTODY:{cn}` بمبلغ `custodyRise` ✅ |
| 3 | `delivery/courier.ts:1374` | `recordSupplementaryStatementCollection` | `+ delta` | نعم | `COD_COLLECTED` (`:1380`) | `DELIVERY_DISPATCH` بمفتاح `DELIVERY_CUSTODY_SUPP:…` ✅ |
| 4 | `delivery/remittance.ts:660` | `recordDeliveryRemittance` | `− w.collected` | نعم | `COD_REMITTED` (`:582`) | `DELIVERY_REMIT` (`:661`) ✅ |
| 5 | `delivery/settle.ts:138` | `settleDeliveryBalance` (تسوية حرّة) | `− amount` | نعم | `COD_REMITTED` (`:139`) | `DELIVERY_REMIT` (`:148`) ✅ |
| 6 | `delivery/settle.ts:442` | `writeOffDeliveryShortfallInTx` (شطبٌ موجَّه) | `− amount` | نعم | `COD_WRITTEN_OFF` (`:443`) | `DELIVERY_WRITEOFF` (`:469`) ✅ |
| 7 | `delivery/settle.ts:499` | `writeOffDeliveryShortfallInTx` (شطبٌ سائب) | `− amount` | نعم | `COD_WRITTEN_OFF` (`:500`) | `DELIVERY_WRITEOFF` (`:509`) ✅ |
| 8 | `delivery/returns.ts:464` | `returnConsignment` | `− legacyCustody` | نعم | `COD_REMITTED` (`:465`) | ⛔ **لا شيء** — `postEntry` في هذا الملفّ يكتب `RETURN`/`GIFT_OUT`/`PURCHASE`/`PAYMENT_OUT`/`DELIVERY_FEE_HELD` فقط |
| 9 | `delivery/declaredReturn.ts:159` | `declareConsignmentReturn` | `− legacyCustody` | نعم | `COD_REMITTED` (`:160`) | ⛔ **لا شيء** — الملفّ **لا يستورد `postEntry` أصلاً** (استيرادُه الوحيد من `ledgerService` هو `adjustDeliveryBalance`، `:26`) |

**قراءةُ الجدول:** الذرّية والقفل سليمان في المواضع التسعة. العطبُ في **العمودين الأخيرَين**: موضعان يُنقصان
النقدَ المسجَّل بلا قيدٍ محاسبيّ ⇒ يكسران المطابقة الوحيدة القائمة (انظر **ن-٤**).

**وكُتّابٌ يكتبون الدفتر ولا يمسّون العمود إطلاقاً** (بعضها **مقصود** وبعضها مسكوتٌ عنه):

| الموضع | ما يُكتب | العمود المخزَّن | ملاحظة |
|---|---|---|---|
| `delivery/dispatch.ts:537` · `dispatchInvoice.ts:323` | `COD_ASSIGNED` | لا يتحرّك | **مقصود** — نموذج المرحلة الثانية: العهدة لا ترتفع عند الإسناد |
| `delivery/cancellation.ts:163` | `COD_RELEASED` | لا يتحرّك | مقصود (لم ترتفع أصلاً) |
| `delivery/counterCollection.ts:168` | `COD_RELEASED` | لا يتحرّك | **مقصود ومُوثَّق** — النقد دخل الدرج ولم يمرّ بيد الجهة (`counterCollection.ts:10-12`) |
| `delivery/fees.ts:60` | `FEE_PAID` | لا يتحرّك | مقصود — الأجرة لا تمسّ العهدة |
| `delivery/courier.ts:930` | `FEE_EARNED` | لا يتحرّك | مقصود |
| `delivery/settle.ts:611` | `COD_RECOVERED` | لا يتحرّك | ⚠️ استرداد الشطب يكتب `COD_RECOVERED` + `DELIVERY_WRITEOFF` عكسيّاً + `DELIVERY_REMIT`، ولا يعيد رفع العهدة — متّسقٌ مع «المال دخل الدرج»، لكن **`COD_RECOVERED` لا تظهر في أيّ صيغةٍ من الـ 13 أدناه** |
| `storeAdmin/dispatchOnlineOrder.ts:240` | **لا شيء** (يضبط `deliveryPartyId` + `SHIPPED` فقط) | لا يتحرّك | ⛔ انظر **ن-٦** |

---

## ٢) جدول القرّاء — 13 صيغةً لمفهومٍ واحد

كلُّ صفٍّ يُجيب على سؤال «كم على هذه الجهة؟» بصيغةٍ مختلفة. لا اشتقاقَ بينها ولا اختبارَ تكافؤ.

| # | الموضع (HEAD) | المصدر | الصيغة | يشمل `SHORTFALL_ASSIGNED`؟ |
|---|---|---|---|---|
| A | `deliveryParties.currentBalance` (عمود) | مخزَّن | حاصلُ جمع حركات جدول الكُتّاب أعلاه | **نعم** |
| B | `parties.ts:42-47` — `assertFloatLimitTx` | دفتر | `ASSIGNED − (REMITTED + RELEASED + WRITTEN_OFF)` ثمّ `max(., A)` | لا |
| C | `lifecycle.ts:301-315` — `cashInCustody` | دفتر | `COLLECTED − REMITTED − WRITTEN_OFF` | لا |
| D | `lifecycle.ts:346` — `codOutstandingRaw` | دفتر | `ASSIGNED − COLLECTED − RELEASED` | لا |
| E | `queries.ts:658-666` — `awaitingCustodyScope` (لكلّ إرسالية) | دفتر | `COLLECTED − (REMITTED + WRITTEN_OFF + RELEASED) > 0` | لا |
| F | `counterCollection.ts:138-146` — `pendingCustody` | دفتر | `COLLECTED − (REMITTED + WRITTEN_OFF)` | لا |
| G | `settle.ts:430-437` (شطبٌ موجَّه) | دفتر | `COLLECTED − REMITTED` | لا |
| H | `reports/courierPerformance.ts:271-276` | دفتر | `COLLECTED − REMITTED − WRITTEN_OFF` | لا |
| I | `reportsFinancialService.ts:1285-1295` — `deliveryFloat` (**الميزانية**) | دفتر | `COLLECTED − (REMITTED + WRITTEN_OFF)` ثمّ يُطرح المدعومُ بعميلٍ مسجَّل | لا |
| J | `accounting/shadowOpening.ts:634-660` (الرصيد الافتتاحيّ للدفتر المزدوج) | دفتر | `COLLECTED − (REMITTED + WRITTEN_OFF)` | لا |
| K | `delivery/guards.ts:61-71` — `consignmentBackedBalance` | أعمدة الطرد | `Σ(codAmount − collectedAmount − counterSettledAmount)` على `moneyStatus ∈ (UNSETTLED, PARTIAL)` | — |
| L | `superAppRouter.ts:1183` (تطبيق أندرويد) | أعمدة الطرد | `Σ(codAmount − collectedAmount)` على `status ∈ (DISPATCHED, DELIVERED, PARTIAL)` — **بلا** `counterSettledAmount` وبلا قصٍّ عند صفر | — |
| M | `reconcileService.ts:676-712` — `reconcileDeliveryFloat` (**المطابقة**) | `accountingEntries` | `DELIVERY_DISPATCH − DELIVERY_REMIT − DELIVERY_WRITEOFF` | نعم (ضمناً) |

وأعمدةُ التعرّض الأربعة التي يراها المالك مبنيّةٌ من **ثلاثة** من هذه المصادر معاً:

| العمود على الشاشة | مصدره | الموضع |
|---|---|---|
| «بذمته» | **A** (العمود المخزَّن) | `parties.ts:337` ← `DeliveryParties.tsx:186` |
| «طرود بالطريق» | أعمدة الطرد | `parties.ts:378-379` · `queries.ts:731-734` |
| «سلم لم يحصل» | أعمدة الطرد | `parties.ts:380-386` · `queries.ts:735-744` |
| «أجور له» | الدفتر | `parties.ts:400-412` (بلا فلترة طرد/فرع) **≠** `queries.ts:704-715` (بفلترة `parcelStatus='DELIVERED'` + الفرع) |

⚠️ **وثلاثةُ تعريفاتٍ متزامنة لِـ«الطرد المفتوح»** رغم وجود وحدةٍ مخصَّصةٍ لتوحيدها (الميّتة):
`consignmentStatus IN ('DISPATCHED','PARTIAL')` في `parties.ts:362` و`queries.ts:647` ·
`moneyStatus IN ('UNSETTLED','PARTIAL')` في `guards.ts:69` و`assertNoStaleOpenParcelsTx` (`parties.ts:88`) ·
`parcelStatus NOT IN (…) OR moneyStatus IN (…)` في `parties.ts:24` و`parties.ts:294`.

---

## ٣) سيناريوهات الانحراف الحتميّ

### ن-١ · «بذمته» و«سلم لم يحصل» يعرضان **نفس الدينار مرّتين** — كلّ يوم، على شاشتين

**الدرجة: حتميّ · واقعٌ في المسار الطبيعيّ · مرئيّ للمالك.**

**الجذر:** `confirmConsignmentDelivery` — وهو **المسار الوحيد** لكلّ إثباتات التسليم الثلاثة (بوّابة المندوب ·
`recordStaffDeliveryConfirmation` في `companyStatement.ts:483` · `recordManualDeliveryProof` في
`companyStatement.ts:534`) — يفعل ما يلي عند التسليم:

```ts
// courier.ts:744-752 — الأعمدة التي تُكتب على الإرسالية عند التسليم
.set({
  courierDeliveredAt: deliveredAt,
  parcelStatus: "DELIVERED",
  ...(cod.gt(0) && cn.custodyRecognizedAt == null ? { custodyRecognizedAt: deliveredAt } : {}),
  ...(originalCodIsZero ? { status: "DELIVERED" as const } : {}),
})
// ⛔ لا collectedAmount.   ⛔ لا moneyStatus.
```

ثمّ يرفع العمود المخزَّن: `courier.ts:849` → `adjustDeliveryBalance(+custodyRise)`.

`deliveryConsignments.collectedAmount` **لا يُكتب إلّا في ثلاثة مواضع** — ولا واحدَ منها هو التسليم:
`remittance.ts:566` (التوريد) · `settle.ts:413` (شطبٌ باسترداد جزئيّ) · `courier.ts:1462` (كشفٌ متمِّم).
أي أنّ اسم العمود يقول «المُحصَّل» ودلالتُه الفعليّة «**المُورَّد**».

**الإثبات بالثابت لا بالتجربة** — من حرّاس التوريد نفسها (`remittance.ts:258-289`): يُقبَل سطرُ التوريد فقط إذا
كان `parcelStatus = 'DELIVERED'` **و** `moneyStatus ∈ (UNSETTLED, PARTIAL)` **و**
`codAmount − collectedAmount − counterSettledAmount > 0`. وهذه **بالحرف** شروطُ عمود «سلم لم يحصل»
(`queries.ts:739-744`). ⇒ **كلُّ دينارٍ قابلٍ للتوريد معروضٌ بالضرورة في العمود الثالث، وموجودٌ بالضرورة في
العمود الأول (لأنّ التسليم رفعه هناك).**

**التسلسل على طردٍ `cod = 20,000`:**

| الخطوة | «بذمته» (A) | «طرود بالطريق» | «سلم لم يحصل» |
|---|---|---|---|
| `dispatchToDelivery` | 0 | 20,000 | 0 |
| المندوب يقبل الطرد (`ACCEPTED`) | 0 | **0** ⚠️ (ن-٧-ب) | 0 |
| `OUT_FOR_DELIVERY` | 0 | 20,000 | 0 |
| **«تم التسليم» بـ 20,000** | **20,000** | 0 | **20,000** ⛔ |
| `recordDeliveryRemittance` بـ 20,000 | 0 | 0 | 0 |

بين السطرَين الموسومَين — وهي **بالضبط** النافذة التي وُجدت لوحةُ المناديب لأجلها — يُعرَض 40,000 لمالٍ قدرُه
20,000. و`shared/partyExposure.ts:98` يجمع الأربعة في `netResponsibility` بلا أيّ خصم، فالدالّة «مصدر الحقيقة»
**تُقنّن الازدواج** — ولولا أنّها ميّتة لظهر الرقم المضاعف على الشاشة صراحةً.

**ولا اختبارَ يمسكه:** لا موضعَ في `server/services/__tests__/deliveryProof.test.ts` يؤكّد
`deliveryConsignments.collectedAmount` بعد التسليم، ولا موضعَ يقارن العمود الأول بالثالث.

---

### ن-٢ · `SHORTFALL_ASSIGNED` يرفع العمود المخزَّن **ولا تعرفه أيُّ صيغةٍ دفتريّة**

**الدرجة: حتميّ · قائمٌ منذ نشر Slice DFP1 (30 أغسطس 2026) · يصيب الميزانية.**

```ts
// courier.ts:848-849
const custodyRise = round2(cod.plus(shortfallReason ? shortage : money(0)));
await adjustDeliveryBalance(tx, membership.partyId, custodyRise);
```

العمود **A** يرتفع بـ `cod + shortage`. والدفتر يستقبل قيدَين منفصلَين: `COD_COLLECTED = cod`
(`courier.ts:856`) و`SHORTFALL_ASSIGNED = shortage` (`courier.ts:867`).

**راجع جدول القرّاء:** الصيغ **B · C · D · E · F · G · H · I · J** — تسعُ صيغ — لا تذكر `SHORTFALL_ASSIGNED`
إطلاقاً. ⇒ لحظةَ حفظ أوّل عجزٍ مصنَّف:

```
A (currentBalance)  −  C/F/H (عهدة الدفتر)  =  Σ العجوزات غير المسوّاة      ← ثابتٌ لا يزول
```

والأخطر أنّ **الميزانية العموميّة** (`reportsFinancialService.ts:1285-1295`، حقل `deliveryFloat` الموصوف في
`:901` بأنّه «أصلٌ صريح — لا دينار بلا تبويب») تُبنى على الصيغة **I** ⇒ **أصلُ «عهدة مناديب التوصيل» في
الميزانية أقلُّ من الرقم الذي تعرضه شاشةُ العمليات بمقدار كلّ عجزٍ قائم**. وكذلك الرصيد الافتتاحيّ للدفتر
المزدوج (الصيغة **J**، `shadowOpening.ts:636-637`).

بينما القيد المحاسبيّ نفسه **يشمل** العجز: `postEntry(DELIVERY_DISPATCH, amount: custodyRise)` و
`deliveryCustomerCollectionIntent(customerSettleAmount)` حيث `customerSettleAmount = cod + shortage`.
⇒ **ثلاثةُ أرقامٍ لأصلٍ واحد:** العمود = `cod+shortage` · حساب `DELIVERY_FLOAT` في الدفتر المزدوج =
`cod+shortage` · بند الميزانية التشغيليّ = `cod` فقط.

**والمخارج مسدودةٌ أو مُلوِّثة:**

- **سدادُ العجز عبر سطر توريد** بمبلغ `cod + shortage`: يُنقص العمود إلى الصفر ✅ لكنّه يكتب
  `COD_REMITTED = cod + shortage` بينما `COD_COLLECTED = cod` ⇒ **عهدة الدفتر تصير سالبة** بمقدار العجز،
  فيشتعل `hasFinancialAnomaly` (`lifecycle.ts:355`) إلى الأبد. ويصير `collectedAmount > codAmount` ⇒ الصيغتان
  **K** و**L** تُنتجان قيماً سالبة (**K** بلا `GREATEST` أصلاً).
- **عدمُ سداده:** يبقى العمود موجباً بـ`shortage`، وتبقى الإرسالية `PARTIAL`، وتصير «العهدة السائبة»
  `loose = A − K` صفراً أو أقلّ ⇒ `settleDeliveryBalance` يرفض (`settle.ts:125-130`).

---

### ن-٣ · `consignmentBackedBalance` يطرح مبالغَ **لم تدخل العمود أصلاً** ⇒ عهدةٌ سائبةٌ سالبة تقفل التسوية

**الدرجة: حتميّ · يقفل مالاً حقيقياً · والرسالة المعروضة تشرح سبباً غير السبب.**

```sql
-- guards.ts:61-71 — consignmentBackedBalance
Σ(codAmount − collectedAmount − counterSettledAmount)  WHERE moneyStatus IN ('UNSETTLED','PARTIAL')
```

**لا فلترةَ على `parcelStatus`.** فالطرد الذي ما زال `ASSIGNED` — ولم يُحصَّل منه فلسٌ ولم يرفع العمود بمليم —
يدخل هذا المجموع بكامل `codAmount`. وفي `settle.ts:123-130`:

```ts
const backed = await consignmentBackedBalance(tx, input.partyId);
const loose  = round2(balance.minus(backed));   // balance = A (نقدٌ مقبوض)، backed = K (تعرّضٌ متوقَّع)
if (amount.gt(loose)) throw …
```

**طرحُ مقدارٍ من قاعدةٍ لا يشترك معها في التعريف.**

**سيناريو حتميّ قابل لإعادة الإنتاج:**

1. جهةٌ تُسلّم طلبَ متجرٍ وتُحصّل 5,000 عبر `confirmCourierDelivery` ⇒ `A = 5,000` (نقدٌ حقيقيّ بيد المندوب،
   وهو **عهدةٌ سائبةٌ بطبيعتها**: لا إرساليةَ له — انظر ن-٦).
2. يُسنَد لها طردُ استقبالٍ واحد `cod = 20,000` عبر `dispatchToDelivery` ⇒ `K = 20,000`، و`A` لا يتحرّك.
3. المندوب يأتي بالـ 5,000 نقداً. الكاشير يفتح «تسوية»:
   `loose = 5,000 − 20,000 = −15,000` ⇒ **أيُّ مبلغٍ موجب يُرفَض**.
4. الرسالة المعروضة (`settle.ts:127`) تقول «المبلغ يتجاوز العهدة السائبة (−15,000.00) — 20,000.00 من العهدة
   مرتبطة بإرساليات مفتوحة» — وهي **جملةٌ خاطئة**: لا شيءَ من الـ 5,000 مرتبطٌ بتلك الإرسالية.
5. ولا مخرجَ آخر: مسارُ التوريد بالإرسالية يشترط `parcelStatus = 'DELIVERED'` (`remittance.ts:258`) وطردُ
   الاستقبال ما زال `ASSIGNED`؛ والشطب يشترط سبباً وإثباتاً ويُقيَّد **خسارةً** لمالٍ لم يُفقَد.

⇒ 5,000 دينارٍ حقيقيّة عالقةٌ بيد المندوب بلا بابٍ مشروع، حتى يُسلَّم طردٌ لا علاقة له بها.

وزِد: `settleDeliveryBalance` يشترط `party.branchId === input.branchId` (`settle.ts:112`) بينما بقيّةُ القرّاء
يقبلون الجهة المشتركة (`branchId = NULL`).

---

### ن-٤ · مساران يُنقصان العمود **بلا قيدٍ محاسبيّ** ⇒ المطابقة الوحيدة تُنذر كذباً إلى الأبد

**الدرجة: حتميّ · يُعطِّل الحارس الوحيد القائم.**

`reconcileDeliveryFloat` (`reconcileService.ts:676-712`) هي **المطابقة الآليّة الوحيدة** الموجودة لهذا العمود:

```
expected = Σ(DELIVERY_DISPATCH) − Σ(DELIVERY_REMIT) − Σ(DELIVERY_WRITEOFF)   [accountingEntries]
actual   = deliveryParties.currentBalance
drift    = |expected − actual| > 0.01  ⇒  بلاغ
```

الموضعان **8** و**9** في جدول الكُتّاب يُنقصان `actual` ولا يمسّان `expected`:

- `declaredReturn.ts:159` — الملفّ **لا يستورد `postEntry`** (سطر `:26` يستورد `adjustDeliveryBalance` وحده).
- `returns.ts:464` — `postEntry` مستوردٌ لكنّ أنواعه المكتوبة هي `RETURN` (`:345`) · `GIFT_OUT` (`:372`) ·
  `PURCHASE` (`:397`) · `PAYMENT_OUT` (`:518`) · `DELIVERY_FEE_HELD` (`:599`).
  **لا `DELIVERY_REMIT` ولا `DELIVERY_WRITEOFF`.**

⇒ بعد أوّل إعلانِ رجوعٍ أو إرجاعٍ يمسّ العهدة، تُبلِّغ المطابقة انحرافاً قدرُه `legacyCustody` **لا يزول أبداً**
مهما صحّحت، لأنّ الطرفين يقيسان شيئين مختلفين. وحارسٌ يُنذر كذباً يُتجاوَز — وهي قاعدةٌ مكتوبة في
`CLAUDE.md §٧-٤ج` ذاتها.

**وشرطُ إطلاق الفرع الخاطئ صار عاماً بلا انتباه:** التعليق فوقه يقول «الصفوفُ **المرحّلة** وحدها تحمل
`custodyRecognizedAt`» (`returns.ts:449-451` و`declaredReturn.ts:153-155`)، لكنّ `confirmConsignmentDelivery`
يَسِم `custodyRecognizedAt` على **كلّ** تسليمٍ بـ`cod > 0` (`courier.ts:749-750`). فالتعليق كان صحيحاً قبل
المرحلة الثانية وصار كاذباً بعدها، والشرط `cn.custodyRecognizedAt == null` لم يعد يميّز «مرحّلاً» عن «حديث».

---

### ن-٥ · `declareReturn` على طردٍ **سُلِّم وحُصِّل** يمسح العهدة ويكتب `COD_REMITTED` كاذباً

**الدرجة: حتميّ عند استدعاء الإجراء · ⚠️ الواجهةُ الحاليّة تحجبه، والخادمُ لا يحجبه.**

نتيجةٌ مباشرة لـ**ن-١** (`collectedAmount` لا يُكتب عند التسليم). حرّاس `declareConsignmentReturn`
(`declaredReturn.ts:126-143`) بعد تسليمٍ ناجحٍ بـ`cod > 0`:

| الحارس | الحالة الفعليّة بعد التسليم | يمرّ؟ |
|---|---|---|
| `cn.returnDeclaredAt != null` | `NULL` | ✅ يمرّ |
| `cn.status !== "DISPATCHED"` | `status` **يبقى `DISPATCHED`** — `courier.ts:751` لا يضبطه `DELIVERED` إلّا حين `originalCodIsZero` | ✅ يمرّ |
| `cn.parcelStatus === "RETURNED" \|\| "CANCELLED"` | القيمة `DELIVERED` — **غير مذكورة** | ✅ يمرّ |
| `money(cn.collectedAmount).gt(0)` | `collectedAmount = "0.00"` (لم يُكتب عند التسليم) | ✅ يمرّ |

ثمّ (`declaredReturn.ts:146-160`):

```
outstanding   = codAmount − collectedAmount = codAmount              (كامل المبلغ)
legacyCustody = min(outstanding, currentBalance) = codAmount          (لأنّ custodyRecognizedAt مضبوط)
adjustDeliveryBalance(−codAmount)  +  appendDeliveryLedgerEntry(COD_REMITTED, codAmount)
```

**النتيجة:** النقد في جيب المندوب · العمود صفر · الدفتر يشهد بأنّه **وُرِّد** · الفاتورة `PAID` (سُدّدت لحظة
التسليم) · ذمّة العميل مصفّاة · الدرج لم يستلم شيئاً · ولا قيدَ محاسبيّ (ن-٤) ⇒ لا حتى بلاغَ انحرافٍ مفهوم.
خرقٌ مباشرٌ للمبدأ المالي الحاكم (`CLAUDE.md §٥`): دينارٌ يختفي بلا مسار.

**نطاقُ الوصول — بأمانة:** زرّ «الشركة تُرجعه» في `DeliveryHub.tsx:841` مشروطٌ بـ`viewKey === "FAILED"`،
والوصول إلى `FAILED` مغلقٌ على الطرد المُسلَّم من الطريقين: `assertParcelTransition` يجعل `DELIVERED: []`
(`lifecycle.ts:229`)، و`FAILABLE_FROM` في `staffTransition.ts:44-49` يستثني `DELIVERED`.
⇒ **غير قابلٍ للوصول بالنقر اليوم**؛ يلزمه استدعاء `delivery.declareReturn` مباشرةً (`storeFulfillProcedure`،
`deliveryRouter.ts:786`). أُدرجه لأنّ `CLAUDE.md §٢` ينصّ أنّ **الإنفاذ النهائيّ خادميّ دائماً**، ولأنّ أيّ
توسيعٍ لاحقٍ لحالات `FAILABLE_FROM` أو للوحة يفتحه فوراً.

---

### ن-٦ · مسار المتجر يتجاوز **بوّابة السقف وبوّابة SLA والدفتر** كلَّها

**الدرجة: حتميّ · يُبطل الحارس الرئيس لِـ Slice DFP1.**

`storeAdmin/dispatchOnlineOrder.ts:240` هو كلُّ ما يفعله إسنادُ طلب المتجر:

```ts
await tx.update(onlineOrders).set({ deliveryPartyId: input.partyId, status: "SHIPPED" })…
```

مقابل مسار الاستقبال/المطبعة الذي يستدعي `assertNoStaleOpenParcelsTx` ثمّ `assertFloatLimitTx` ثمّ
`appendDeliveryLedgerEntry(COD_ASSIGNED)` (`dispatch.ts:206-209, 537` · `dispatchInvoice.ts:317-330`).

⇒ **أربع نتائج حتميّة:**

1. **حظرُ SLA لا وجود له في هذا الباب.** قرارُ المالك في Slice DFP1 كان «حظرٌ ثابت بلا تجاوُز إداريّ» — جهةٌ
   لديها طرودٌ عمرها 21 يوماً تُرفض في شاشة الاستقبال وتُقبَل في شاشة المتجر بلا حدّ.
2. **سقف `floatLimit` لا يُفحَص** في هذا الباب أصلاً.
3. **لا صفّ `deliveryConsignments`** ⇒ COD المتجر **غائبٌ كلّياً** عن عمودَي «طرود بالطريق» و«سلم لم يحصل»
   (كلاهما يقرأ من `deliveryConsignments`)، بينما نقدُه **يظهر** في العمود الأول لحظة التحصيل
   (`courier.ts:474`). عمودٌ واحدٌ من أربعةٍ يعرف بوجوده.
4. **`hasFinancialAnomaly` كاذبٌ دائم:** الصيغة **D** (`lifecycle.ts:346`)
   `codOutstandingRaw = ASSIGNED − COLLECTED − RELEASED` تصير `0 − X − 0 = −X` لأيّ جهةٍ حصّلت طلبَ متجر
   (لا `COD_ASSIGNED` قطّ) ⇒ `hasFinancialAnomaly = true` (`lifecycle.ts:355`) بلا سببٍ حقيقيّ، على شاشة
   المندوب نفسها.

وحتى `assertFloatLimitTx` حين يعمل، يقرأ الصيغة **B** التي لا تحوي `COD_COLLECTED` ⇒ على جهةٍ خدمت طلبات
متجرٍ فقط، `committed` يصير سالباً؛ ولولا `DecimalMax(committed, legacyCash)` لَما حرس شيئاً.

---

### ن-٧ · الأجرة: تُستحقّ عند التسليم، ولا مخرجَ لها إن عُكس التسليم

**الدرجة: حتميّ · يترك التزاماً شبحاً بلا سقفٍ زمنيّ.** التفصيل في §٥.

### ن-٧-ب · «طرود بالطريق» يُصفَّر بينما البضاعة بيد المندوب فعلاً

**الدرجة: حتميّ · مرئيّ.**
العمود الثاني يعدّ `parcelStatus IN ('ASSIGNED','OUT_FOR_DELIVERY')` فقط (`parties.ts:378` ·
`queries.ts:731-734`). لكنّ `assertParcelTransition` (`lifecycle.ts:222-231`) يعرّف السلسلة
`ASSIGNED → ACCEPTED → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED` و`FAILED` منفذاً من كلٍّ منها.
⇒ الطرد في حالتَي `ACCEPTED` و`PICKED_UP` — **وهما الحالتان اللتان تعنيان حرفياً أنّ البضاعة صارت بيده** —
قيمتُه **صفرٌ** في العمود؛ وكذلك `FAILED` (بيده، لم يُسلَّم، لم يُرجَع). والصفوف تخرج وتعود مع كلّ ضغطة زرٍّ
في بوّابة المندوب (`transitionConsignmentParcel`).

---

## ما ليس انحرافاً — فروقٌ مقصودة لا تُحسَب علينا

| الملاحظة | لماذا هي مقصودة |
|---|---|
| العمود لا يرتفع عند الإسناد | نموذجُ المرحلة الثانية المُعلَن: العهدة نقدٌ مقبوض لا تعرُّضٌ متوقَّع (`parties.ts:30-33`) |
| `counterCollection` لا يمسّ العمود ويكتب `COD_RELEASED` | صحيحٌ ومُبرهَنٌ في ترويسة الملفّ: النقد دخل الدرج ولم يمرّ بيد الجهة (`counterCollection.ts:10-12`) |
| `DecimalMax(committed, legacyCash)` في حارس السقف | ليس عطباً بل **عَرَضاً**: حارسٌ يدافع عن نفسه ضدّ مصدرين لا يثق بأيّهما. أثبتُّ به الفرضية ولم أعُدّه انحرافاً |
| `feeDue` مقصوصٌ عند الصفر | قرارٌ صريح موثَّق في Slice DFP2 مع `feeDueRaw` للتنبيه (`lifecycle.ts:337-344`) |
| رصيدٌ سالب من الدفع الزائد | مسموحٌ بقرار المالك — لم أُدرج أيّ حالةٍ جذرُها هذا |
| `status` يبقى `DISPATCHED` بعد التسليم | مقصود: الإغلاق ماليٌّ لا فيزيائيّ (`deliveryOpenParcel.ts:22-27`). أُدرج ضمن ن-٥ كـ**شرطٍ ممكِّن** لا كعطبٍ بذاته |

---

## ٤) دورة حياة فاتورةٍ مُسنَدة — صفّاً صفّاً

المسار الكامل لأمر شغلٍ بـ `cod = 20,000` وأجرة `fee = 3,000` بـ`feeCollection = 'SHOP'`.
كلُّ خطوةٍ داخل معاملةٍ واحدة (`withTx`).

| # | الانتقال | `deliveryConsignments` | `deliveryLedgerEntries` | `deliveryParties` | `accountingEntries` | `invoices` |
|---|---|---|---|---|---|---|
| 1 | `dispatchToDelivery` | إدراج: `parcelStatus=ASSIGNED` · `status=DISPATCHED` · `moneyStatus=UNSETTLED` · `collectedAmount=0` · `custodyRecognizedAt=NULL` | `COD_ASSIGNED 20,000` | — | `SALE` (`dispatch.ts:390`) | تُنشأ |
| 2 | `ACCEPTED` / `PICKED_UP` | `parcelStatus` + طابعٌ زمنيّ | — | — | — | — |
| 3 | `OUT_FOR_DELIVERY` | `parcelStatus` | — | — | — | — |
| 4 | **التسليم** (`confirmConsignmentDelivery`) | `parcelStatus=DELIVERED` · `custodyRecognizedAt` · ⛔ `collectedAmount` **يبقى 0** · ⛔ `moneyStatus` **يبقى UNSETTLED** | `COD_COLLECTED 20,000` (+`SHORTFALL_ASSIGNED` عند العجز) · `FEE_EARNED 3,000` | `+20,000` | `DELIVERY_DISPATCH 20,000` · `PAYMENT_IN 20,000` · `DELIVERY_FEE 3,000` | `paidAmount += 20,000` ⇒ `PAID` |
| 5 | **التوريد** (`recordDeliveryRemittance`) | `collectedAmount=20,000` · `moneyStatus=SETTLED` · `status=DELIVERED` · `remittanceId` · `settledAt` | `COD_REMITTED 20,000` | `−20,000` | `DELIVERY_REMIT 20,000` + إيصال `IN` | `invoiceCredit = 0` (لا ازدواج ✅) |
| 6 | **صرف الأجرة** (`payPartyDeliveryFees`) | `feeSettledAt` | `FEE_PAID 3,000` | — | `DELIVERY_FEE 3,000` (تسويةُ التزام) | — |

**هل يعود مجموعُ أحداث الفاتورة إلى الصفر عند إغلاقها؟**

- **`currentBalance`: نعم.** `+20,000` ثمّ `−20,000` = 0 ✅
- **دفتر COD: نعم** بالصيغة **C/F/H** (`COLLECTED − REMITTED − WRITTEN_OFF = 0`) ✅ — **بشرط** ألّا يقع عجز
  (ن-٢) وألّا يمرّ الطرد بـ`declareReturn` (ن-٥).
- **معادلة التعرّض (الصيغة D):** `ASSIGNED − COLLECTED − RELEASED = 0` ✅ للاستقبال؛ و`−X` أبديّةً لطلب
  المتجر (ن-٦).
- **الأجرة: نعم** `FEE_EARNED − FEE_PAID = 0` ✅ — ما لم يُعكَس التسليم (§٥).
- **⛔ لكن بين الخطوتَين 4 و5 يظلّ أثرٌ معلَّقٌ مضاعف:** العمودان «بذمته» و«سلم لم يحصل» يعرضان 20,000 كلٌّ
  منهما (ن-١). والصفر النهائيّ لا يُبرّئ نافذةً هي مجالُ عمل اللوحة كلِّه.

**المسارات البديلة عند الخطوة 4:**

| البديل | يُقبَل؟ | الأثر |
|---|---|---|
| `cancelDeliveryAssignment` | من `ASSIGNED`/`FAILED` فقط، وبـ`collectedAmount = 0`، وبلا `remittanceId` (`cancellation.ts:133-148`) | `COD_RELEASED` + الحالات الثلاث `CANCELLED`. **لا يمسّ العمود** ✅ متّسق |
| `returnConsignment` | يرفض `DELIVERED` صراحةً (`returns.ts:126`) ويرفض `moneyStatus ∈ (PARTIAL, SETTLED)` (`returns.ts:123`) | `COD_REMITTED` (للمرحَّل) + `COD_RELEASED` للباقي — **بلا قيدٍ محاسبيّ** (ن-٤). ⚠️ ويحسب `outstanding = codAmount − collectedAmount` **بلا** `counterSettledAmount` (`returns.ts:457`) خلافاً لكلّ الصيغ الأخرى ⇒ تحريرٌ يتجاوز المتبقّي الحيّ إن سبقه سدادٌ كاونتريّ |
| `declareConsignmentReturn` | يقبل `DELIVERED` (ن-٥) · ويحسب `outstanding` بنفس الخلل (`declaredReturn.ts:146`) | كما في ن-٥ |
| `reverseWorkOrderDeliveryInTx` | يشترط الإرسالية **مُسوَّاةً** أصلاً (`reverseDelivery.ts:493-503`) | يضبط `RETURNED/RETURNED/CANCELLED` (`:711-715`) و**لا يكتب في دفتر التوصيل ولا في العمود شيئاً** ⇒ §٥ |
| `recordSupplementaryStatementCollection` | يشترط `parcelStatus = 'DELIVERED'` | يكتب `collectedAmount = newTotal` (`:1462`) ويرفع العمود (`:1374`). **مصيدة:** حين `newTotal = codAmount` يصير المتبقّي في `remittance.ts:281` صفراً، والسطر الصفريّ يُتخطّى (`remittance.ts:277`) ⇒ **النقد المرفوع في العمود لا يمكن توريدُه عبر الإرسالية أبداً**؛ ومخرجُه الوحيد `settleDeliveryBalance` الذي يكتب `COD_REMITTED` **بلا `consignmentId`** ⇒ تبقى الإرسالية محسوبةً في `deliveredAwaitingRemitCount` (الصيغة **E**) للأبد |

---

## ٥) الأجرة — متى تُستحقّ، وماذا يحدث إن رجع الطرد بعدها

**متى تُستحقّ اليوم: عند التسليم لا عند الإسناد.** الموضع الوحيد الذي يكتب `FEE_EARNED` في شيفرة التشغيل هو
`confirmConsignmentDelivery` (`courier.ts:930`)، داخل `if (fee.gt(0))` بعد ختم `parcelStatus = 'DELIVERED'`.
(الموضع الآخر `deliveryLegacyRepairService.ts:658` إصلاحٌ للبيانات الموروثة لا مسارُ تشغيل.) وقيدُ الاستحقاق
`deliveryFeeAccrualIntent` (`posting.ts:86`) يوثّقه صراحةً: يتحمّل العملُ الأجرةَ حين ينجح التوصيل، قبل دفع
النقد. ⇒ **الاستحقاق سليمٌ ومتّسق.**

**وماذا لو رجع الطرد بعد الاستحقاق؟**

الطريق الوحيد لإرجاع طردٍ **بعد** ختمه `DELIVERED` هو `reverseWorkOrderDeliveryInTx`
(`workOrder/reverseDelivery.ts:711-715`) — والطريقان الآخران يرفضان `DELIVERED` (`returns.ts:126` ·
`FAILABLE_FROM` في `staffTransition.ts:44`). وهذا الطريق:

1. **لا يكتب سطراً واحداً في `deliveryLedgerEntries`** — الملفّ يستورد `appendDeliveryEvent` فقط، لا
   `appendDeliveryLedgerEntry` ولا `adjustDeliveryBalance`. ⇒ `FEE_EARNED = 3,000` **يبقى قائماً**.
2. **ولا يمكن دفعُها بعدها:** `payPartyDeliveryFees` يختار مرشّحيه بـ
   `eq(deliveryConsignments.parcelStatus, "DELIVERED")` (`fees.ts:277-284`) — والطرد صار `RETURNED`.
3. **ولا يمكن عكسُها:** بحثٌ شاملٌ في `server/**` أثبت أنّ `FEE_REFUNDED` **ليس له كاتبٌ واحد** في المستودع
   كلِّه. هو قيمةٌ في enum المخطّط، ومطروحةٌ في **سبع** صيغِ تجميع (`lifecycle.ts:307` · `fees.ts:24` ·
   `parties.ts:404-406` · `queries.ts:142` و`:708` · `reportsAlertsService.ts:269` ·
   `reportsFinancialService.ts:1351`) — **ولا يُنتجها شيء.**

**النتيجة الحتميّة:** التزامٌ شبحٌ بلا مخرج — لا يُدفَع ولا يُعكَس.

**وأسوأ منه أنّ الشاشتين تختلفان عليه:**

| الشاشة | المصدر | بعد عكس التسليم |
|---|---|---|
| `DeliveryParties` — عمود «أجور له» | `parties.ts:400-412` — تجميعٌ على `partyId` **بلا أيّ فلترة طرد أو فرع** | **يبقى 3,000 ظاهراً للأبد** |
| `DeliveryHub` / `obligations` — `feeDueTotal` | `queries.ts:704-715` — مشروطٌ بـ`dc.parcelStatus = 'DELIVERED'` + الفرع | **يصير 0** |

⇒ رقمان دائمان مختلفان لالتزامٍ واحد، على شاشتين يفتحهما المديرُ نفسه.

**ملاحظتان أصغر على الأجرة:**

- أجرةُ `feeCollection = 'COURIER'` تُقفَل فوراً بـ`FEE_PAID` مقابلها في نفس المعاملة (`courier.ts` بعد
  `:930`) ⇒ متوازنة ✅
- أجرةُ `COUNTER` أمانةٌ تُبرَّأ بـ`DELIVERY_FEE_HELD` بإشارةٍ سالبة (`fees.ts:81-93`)، ويردّها
  `returnConsignment` عند الإرجاع قبل التسليم (`returns.ts:577-609`) ✅ — لكنّ هذا المسار **غير متاح** بعد
  التسليم، فتنطبق عليها نفس فجوة `reverseDelivery`.

---

## ٦) ما لم أستطع إثباته — بصراحة

1. **هل فهرس `uq_delivery_ledger_event` موجودٌ على قاعدة الإنتاج فعلاً؟** لم أستطع التحقّق (لا وصول للقاعدة).
   ما أعرفه: التعريف الوحيد لجدول `deliveryLedgerEntries` في المستودع كلّه هو
   `drizzle/migrations/extras/0178_delivery_phase2_state_and_ledgers.sql:247-269` وفيه
   `UNIQUE KEY uq_delivery_ledger_event (eventKey)` (`:261`)، وهو مسجَّلٌ في قائمة CI
   (`scripts/ci-apply-extra-migrations.mjs:119`). **لكنّ `prod:deploy` لا يشغّل هذه القائمة**
   (`deploy.mjs` → `db:migrate:safe` فقط، ولا استدعاء لـ`ci-apply-extra-migrations`)، **ولا توجد هجرةٌ
   مُرقَّمةٌ في `_journal.json` تُنشئ هذا الجدول** — الملفّان المُرقَّمان الوحيدان اللذان يذكرانه
   (`0286` و`0295`) يُعدّلانه فقط. ⇒ كيفيّة إنشائه على الإنتاج **مجهولةٌ لي**.
   **يُحسَم بأمرٍ واحد:**
   `SHOW INDEX FROM deliveryLedgerEntries WHERE Key_name = 'uq_delivery_ledger_event';`
   ولهذا وزنٌ عمليّ: **ثلاثة تعليقاتٍ في الشيفرة تبني منطقاً دفاعياً على أنّه غير موجود** —
   `returns.ts:453-455` · `declaredReturn.ts:16` · `cancellation.ts:130-131` («ولا فهرسَ فريد على `eventKey`
   يمنعه») — بينما `counterCollection.ts:103-104` في **نفس المجلَّد** يقول العكس: «الفهرس الفريد على
   `eventKey` هو الإنفاذ النهائيّ». أحدُ الطرفين يبني على حقيقةٍ خاطئة، والفرق في **نوع الفشل**: صمتٌ
   يُضاعف المبلغ (لو لا فهرس) مقابل `ER_DUP_ENTRY` يُسقط المعاملة كلَّها برسالةٍ غامضة (لو الفهرس قائم).
2. **المقادير الفعليّة على الإنتاج.** لا أعرف كم جهةً وكم ديناراً يقع عليها كلُّ انحراف. أثبتُّ **الحتميّة**
   لا **الحجم**. أيُّ رقمٍ أذكره هنا سيكون تخميناً.
3. **هل توجد صفوفٌ موروثة تحمل `custodyRecognizedAt` من backfill الهجرة 0178؟** الهجرة تضبطه
   (`extras/0178:149-152`) لكنّي لم أستطع عدّ الصفوف المتأثّرة.
4. **لم أشغّل أيّ اختبار ولا أيّ فحص** (`pnpm check` / `check:guards` / الحزمة) — محظورٌ بحدود المهمّة. كلُّ
   ما أعلاه استنتاجٌ من قراءة الشيفرة والثوابت المكتوبة فيها، لا من تشغيل.
5. **لم أفحص** `client/src/pages/DeliveryPartyDetail.tsx` ولا `DeliveryHub.tsx` بعمقٍ كافٍ لأحكم على
   `deriveConsignmentView`؛ حكمتُ على ن-٥ بأنّه «غير قابلٍ للوصول بالنقر» اعتماداً على `FAILABLE_FROM`
   و`assertParcelTransition` وحدهما، وقد أكون أغفلتُ مساراً ثالثاً.
6. **لم أتتبّع** `staleSweep.ts` ولا `writeoffRequests.ts` ولا `commissionComparison.ts` بنفس العمق؛ قد يحوي
   أحدُها صيغةً رابعة عشرة.

---

## ملحق — ملاحظتان جانبيّتان خارج نطاق السؤال (تُسجَّل ولا يُبنى عليها)

1. **`Number()` على مالٍ في وحدةٍ مُعلَنةٍ «مصدر حقيقة»:** `shared/partyExposure.ts:55-58` يحوّل كلّ مبلغٍ بـ
   `Number(v)` ويجمع بحساب `float` ثمّ `toFixed(2)` (`:62`)؛ ومثلُه `lifecycle.ts:333`
   (`const n = (v) => Number(v ?? 0)`) و`DeliveryParties.tsx:171-174`. القاعدة في `CLAUDE.md §٥`:
   ⛔ لا `Number`/`parseFloat` على مال — البديل `decimal.js` عبر `money.ts`.
2. **صيغةٌ إضافيّة للعهدة في تطبيق أندرويد:** `superAppRouter.ts:1183` →
   `Σ(codAmount − collectedAmount)` بلا `counterSettledAmount` وبلا `GREATEST(...,0)` ⇒ رقمٌ ثالثٌ يراه
   المندوب على هاتفه يختلف عن الرقمين على الويب.
