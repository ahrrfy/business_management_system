# م٥ ق١ — عدّاد المستهلكين المحتملين للمسندات المشتركة

قياسٌ حرفيّ من `git grep` قبل الوصل (٣/٩/٢٦). الاستهلاكُ **لا يحصل في هذه الشريحة** — الأرقام
سطحُ الفرصة للشرائح اللاحقة تحت حارس `check:vocabulary`.

| المسند | نمط البحث | مستهلكون محتملون (files:lines) |
|---|---|---|
| `hasOpenBalance` | `currentBalance` (كل استعمال) | ~441 |
| `isDeadInvoice`  | `DEAD_INVOICE_STATUSES` / `isDeadInvoiceStatus` | ~35 |
| `isVoidedSale`   | `VOIDED_INVOICE_STATUSES` / `isVoidedInvoiceStatus` | ~12 |
| `canCrossBranches` | `canCrossBranches` + الأنماط اليدوية (`role === 'admin' && isOwner`) | ~119 |
| `invoiceRemaining` | `total.minus(paidAmount)` / `paidAmount).minus(returnedTotal)` | ~16 |

**ملاحظات:**
- الأرقام تشمل تعريفَ المسند نفسه وموضعَ الاختبار — العدُّ الصافي للاستبدال أقلّ (خصم ~5-10٪).
- `hasOpenBalance` رقمُه مضخَّم (`currentBalance` يُقرأ ويُكتب معاً، الاستبدال هو الشرط `!= 0` فقط).
  تقدير الاستبدال الفعليّ: ~25-30 موضعاً بحسب فحصٍ يدويّ (الأنماط: `Number(x.currentBalance) > 0`،
  `D(x.currentBalance).isPositive()`، `!x.currentBalance || x.currentBalance === "0"`).
- `canCrossBranches` رقمُه مضخَّم بأنماط RBAC عامّة — الاستبدال الحقيقيّ ~30-40 موضعاً.
- `invoiceRemaining` رقمٌ محافظ — الأنماط الحرفيّة ٩ (D2 في §٤)، والباقي مسارات تدفّق مختلفة.

**الفجوات المتروكة لشريحةٍ لاحقة:**
- بناء حارس `check:vocabulary` يمنع تعريفاً محلّياً جديداً لأيّ مسند/مصطلح مُصدَّر من هنا.
- وصل المستهلكين: يُوصَل كلٌّ منهم عبر PR منفصل (شريحة رأسيّة صغيرة) لتجنّب تعارض الدمج.
- إضافة `isSelfApproval(actor, doc)` كمسند سادس (رصدتُ ~7 مواضع منجرفة، عهدةُ D2 الأصلية).
