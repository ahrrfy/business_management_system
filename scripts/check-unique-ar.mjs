#!/usr/bin/env node
/**
 * حارس: كل قيد UNIQUE مُسمّى في ملفات الهجرات له مدخلٌ عربيّ في `shared/errorMap.ar.ts`.
 *
 * **لماذا وُجد:** بدون المدخل يصل المستخدمَ نصُّ MySQL خاماً عند تصادم القيد بدل رسالةٍ
 * مفهومة. وكان هذا محروساً باختبارٍ يقرأ **قاعدة البيانات الحيّة** (`errorMap.ar.test.ts`)
 * — أي أنّه لا يعمل إلّا في حزمة الاختبار الكاملة بقاعدةٍ مُهيَّأة، فيمرّ الخطأ محلياً
 * ولا يظهر إلّا في CI بعد ~٢٦ دقيقة. سقطت الشاردة الأولى مرّتين متتاليتين لهذا السبب
 * وحده. هذا الحارس نصّيّ محض: يقرأ ملفات الهجرات ولا يحتاج قاعدةً، فيُمسك الخطأ في
 * ثوانٍ ضمن `pnpm check:guards` قبل الدفع.
 *
 * القراءة من **ملفات الهجرات** لا من `schema.ts`: الهجرات هي ما يُنفَّذ فعلاً على القاعدة
 * (قاعدة «الحارس يقرأ ممّا يُنفَّذ عليه»).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "drizzle/migrations";
const ERROR_MAP = "shared/errorMap.ar.ts";

/**
 * يطابق منطق `shared/errorMap.ar.test.ts` حرفياً — وهو المرجع. أهمّ ما فيه **تتبّع
 * الحذف**: قيدٌ أُضيف في هجرةٍ ثمّ أُسقط في أخرى ليس حيّاً، وإغفال ذلك يجعل الحارس
 * يُبلّغ عن قيودٍ ميتة فيصير إنذاراً كاذباً يُتجاوَز — وهو أسوأ من غياب الحارس.
 */
const CONTROL_ONLY = new Set(["uq_provision_active_code"]);

function liveUniqueKeys() {
  const files = readdirSync(MIGRATIONS_DIR, { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".sql"))
    .sort();
  const live = new Set();
  const token = /CONSTRAINT `?([A-Za-z0-9_]+)`? UNIQUE|UNIQUE (?:KEY|INDEX) `?([A-Za-z0-9_]+)`?|DROP (?:INDEX|KEY|CONSTRAINT) `?([A-Za-z0-9_]+)`?/g;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const match of sql.matchAll(token)) {
      const added = match[1] ?? match[2];
      if (added) live.add(added);
      else if (match[3]) live.delete(match[3]);
    }
  }
  live.delete("PRIMARY");
  return live;
}

function main() {
  const declared = liveUniqueKeys();
  const mapSource = readFileSync(ERROR_MAP, "utf8");
  // المفاتيح في UNIQUE_AR تُكتب عاريةً (uq_x:) أو مقتبسةً ("uq_x":).
  const mapped = new Set();
  for (const match of mapSource.matchAll(/^\s*"?([A-Za-z0-9_]+)"?\s*:\s*\{/gm)) mapped.add(match[1]);

  const missing = [...declared].filter((name) => !mapped.has(name)).sort();
  const stale = [...mapped].filter((name) => name.startsWith("uq_") && !declared.has(name) && !CONTROL_ONLY.has(name)).sort();
  if (missing.length > 0) {
    console.error(`✗ حارس UNIQUE_AR: قيود بلا مدخل تشخيصيّ في ${ERROR_MAP}:`);
    for (const name of missing) console.error(`  - ${name}`);
    console.error("  أضِف لكلٍّ رسالةً عربية مفهومة، وإلّا وصل المستخدمَ نصُّ MySQL خاماً.");
    process.exit(1);
  }
  if (stale.length > 0) {
    console.error("✗ حارس UNIQUE_AR: مدخلات لقيودٍ لم تعد موجودة:");
    for (const name of stale) console.error(`  - ${name}`);
    process.exit(1);
  }
  console.log(`✓ حارِس UNIQUE_AR: ${declared.size} قيداً حيّاً، كلٌّ له مدخل تشخيصيّ.`);
}

main();
