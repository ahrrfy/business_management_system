#!/usr/bin/env node
/**
 * حارس إسناد الصفّ — يمنع عودة **التسمية المبهمة** لعمود الفاعل في جداول العمليات.
 *
 * السبب (بلاغ المالك ١/٩/٢٦): «الجداول لا تظهر المعلومات المرادة والمتفق عليها: مَن نفّذ
 * ومَن قام ومَن المستفيد والجهة الأخرى». المسح أثبت أنّ سجلّات العمليات إمّا **بلا فاعل
 * أصلاً** (سجلّ المبيعات يعرض العميل ولا يعرض البائع)، وإمّا بعمودٍ اسمه «المستخدم» لا
 * يقول أهو الفاعل أم المستفيد.
 *
 * ما يُمسَك هنا **تحديداً**: تسميةٌ مبهمة لعمود فاعلٍ في رأس جدولٍ داخل شاشةٍ مسجَّلة
 * كجدول عمليات. القياسُ ضيّقٌ عمداً:
 *
 *   ⛔ لا نُحاسب «الموظف» في شاشات الموارد البشرية — هناك الموظّفُ **موضوع** السجلّ لا
 *      مَن نفّذه (سلفة الموظّف · إجازته · حضوره). تسميتُه «نفّذها» تجعل البيانات تكذب،
 *      وهو عكسُ غرض الحارس. لذلك القائمة **صريحة بالملفّات** لا بالنمط.
 *
 * التسمية المعتمدة تُقرأ من `ATTRIBUTION_LABELS` في `shared/uiContracts.ts` وحده.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * شاشاتُ **العمليات** التي يجب أن يحمل صفُّها فاعلاً مسمّىً بالعقد.
 * تُوسَّع مع كل موجة؛ ولا تُضاف إليها شاشةٌ يكون فيها الشخصُ موضوعَ السجلّ لا فاعلَه.
 */
const OPERATION_SCREENS = [
  "client/src/pages/SalesRegister.tsx",
  "client/src/pages/PurchaseRegister.tsx",
  "client/src/pages/Vouchers.tsx",
  "client/src/pages/InventoryMovements.tsx",
];

/** تسميات مبهمة لا تقول أيّ دورٍ يعرضه العمود. */
const AMBIGUOUS = ["المستخدم", "بواسطة", "أنشأها", "المنشئ", "المسؤول"];

const fails = [];
const notes = [];

for (const rel of OPERATION_SCREENS) {
  const abs = path.join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    fails.push(`${rel}: مفقود — حدِّث قائمة OPERATION_SCREENS`);
    continue;
  }
  const src = readFileSync(abs, "utf8");

  // (١) يجب أن تقرأ الشاشة التسمية من العقد لا أن تكتبها.
  if (!src.includes("ATTRIBUTION_LABELS")) {
    fails.push(`${rel}: لا يقرأ ATTRIBUTION_LABELS ⇒ عمود الفاعل مكتوبٌ يدوياً أو غائب`);
    continue;
  }

  // (٢) لا تسمية مبهمة في رأس جدول.
  for (const word of AMBIGUOUS) {
    const re = new RegExp(`<th[^>]*>\\s*${word}\\s*</th>`);
    if (re.test(src)) {
      fails.push(`${rel}: رأسُ عمودٍ مبهم «${word}» ⇒ استعمل ATTRIBUTION_LABELS`);
    }
  }
  notes.push(rel);
}

/**
 * (٣) الطرفُ الخادميّ: الحقل الذي تعرضه الشاشة يجب أن يبقى مُنتَقىً في الاستعلام.
 * بلا هذا يكفي حذفُ سطرٍ من SQL ليُفرَّغ العمودُ على الشاشة **بلا أيّ خطأ** — العمود
 * يبقى ويُظهر «غير موثّق» في كل صفّ، وهو أسوأ من غيابه لأنّه يبدو بياناً.
 */
const SERVER_CONTRACTS = [
  // ⚠️ `projection` يقيس **انتقاء SQL** لا مجرّد ورود الاسم: حذفُ سطر `AS soldByName`
  //    يُبقي الاسم في تعريف النوع، فحارسٌ يبحث عن الاسم وحده يمرّ وهو أعمى (جُرّب فعلاً).
  { file: "server/services/reportsSalesService.ts", projection: "AS soldByName", join: "LEFT JOIN users su ON su.id = i.createdBy" },
  { file: "server/services/reportsPurchasesService.ts", projection: "AS orderedByName", join: "LEFT JOIN users ou ON ou.id = po.createdBy" },
  { file: "server/services/voucher/queries.ts", projection: "createdByName: sql", join: null },
];

for (const c of SERVER_CONTRACTS) {
  const abs = path.join(REPO_ROOT, c.file);
  if (!existsSync(abs)) { fails.push(`${c.file}: مفقود`); continue; }
  const src = readFileSync(abs, "utf8");
  if (!src.includes(c.projection)) {
    fails.push(`${c.file}: انتقاء «${c.projection}» مفقود ⇒ عمود الفاعل يُفرَّغ صامتاً ويعرض «غير موثّق» في كل صفّ`);
  }
  if (c.join && !src.includes(c.join)) fails.push(`${c.file}: الوصلة «${c.join}» مفقودة`);
}

// (٤) العقد نفسه: الأدوار الأربعة موجودة ومتمايزة.
const contract = readFileSync(path.join(REPO_ROOT, "shared/uiContracts.ts"), "utf8");
for (const role of ["performedBy", "beneficiary", "counterparty", "approvedBy"]) {
  if (!contract.includes(`${role}:`)) fails.push(`shared/uiContracts.ts: الدور ${role} مفقود`);
}

if (fails.length) {
  console.error(`✗ حارس إسناد الصفّ — ${fails.length} انتهاك:\n`);
  for (const f of fails) console.error(`  ${f}`);
  console.error(`
القاعدة: جدولُ عملياتٍ يعرض **مَن نفّذ** بتسميةٍ من العقد لا باجتهاد الشاشة:

  import { ActorCell } from "@/components/data-table/ActorCell";
  import { ATTRIBUTION_LABELS } from "@shared/uiContracts";

  <th>{ATTRIBUTION_LABELS.performedBy}</th>          // «نفّذها»
  <td><ActorCell actor={{ name: r.createdByName }} /></td>

الأدوار الأربعة متمايزة ولا تُخلط: نفّذها · المستفيد · الطرف الآخر · اعتمدها.
⛔ ولا تُضِف إلى OPERATION_SCREENS شاشةً يكون فيها الشخصُ موضوعَ السجلّ (موظّف/عميل)
   لا فاعلَه — تسميتُه «نفّذها» تجعل البيانات تكذب.
`);
  process.exit(1);
}

console.log(`✓ إسناد الصفّ محفوظ — ${notes.length} شاشة عمليات تعرض «${"نفّذها"}» من العقد.`);
