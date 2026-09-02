#!/usr/bin/env node
/**
 * حارس تناظر النموذج — «شاشة التعديل = شاشة الإنشاء» قانوناً ميكانيكياً لا نيّةً.
 *
 * السبب (فحصٌ شامل ٢/٩/٢٦، محور D5 في مقياس الاحتكاك): لكلّ كيانٍ شاشتان مستقلّتان
 * (`XNew.tsx` و`XEdit.tsx`) تُصانان بيدَين مختلفتَين في أوقاتٍ مختلفة، فتنجرفان حتماً.
 * والانجرافُ ليس تجميلياً: القياس الأوّل أثبت أنّ **حقولاً كاملةً موجودةٌ في إحداهما دون
 * الأخرى** — لا `whatsapp` ولا `email` في إنشاء المورّد (فيُنشأ المورّد ثمّ يُفتح تعديلُه
 * فوراً لإكماله)، ولا `whatsapp` في إنشاء العميل، و`allowBackorder`/`isService`/
 * `showInReception`/`showInPrintPos` في تعديل المنتج وحده (فالصنف يُولَد بتصنيفٍ لا يمكن
 * إعلانه عند ولادته). كلُّ واحدةٍ من هذه أُدخلت في شاشةٍ ونُسيت في أختها، ولا شيء منعها.
 *
 * ⭐ البصمة المختارة: **الحقلُ المربوط في `value`/`checked`/`defaultValue`/`defaultChecked`**
 * داخل جسم المكوّن المُصدَّر افتراضياً. أي: ما يصل فعلاً إلى عنصر تحكّم يراه المستعمل.
 *
 * ولماذا لا البصمتان الأُخريان — القياسُ حسم الاختيار لا الذوق:
 *
 *   • `<Label htmlFor>` + `id="…"` — **مرفوضة**: انضباطُ الوسم في هذا المستودع غير متناظرٍ
 *     أصلاً. `AssetNew` فيه صفرُ `htmlFor` بينما `AssetEdit` فيه ١٥؛ و`ProductNew`/
 *     `ProductEdit` صفرٌ وصفر رغم عشرات الحقول؛ و`UserNew` صفرٌ و`UserEdit` تسعة. ⇒ الحارس
 *     كان سيُعلن «شاشةُ إنشاء الأصل بلا حقول» ويرفع ١٥ انحرافاً لا وجود لأيٍّ منها. بصمةٌ
 *     تقيس **انضباط الوسم** لا **وجود الحقل** ماكينةُ إنذارٍ كاذب، والحارس الذي يُنذر كذباً
 *     يُتجاوَز فيصير مسرحياً (CLAUDE.md §٤-ج).
 *
 *   • مفاتيح `useState` الخام — **مرفوضة أيضاً**، لسببين: (١) تبتلع حالةَ الواجهة العابرة
 *     التي **يُفترَض** أن تختلف بين الإنشاء والتعديل (`loaded` · `baseline` · `hydrated` ·
 *     `clientRequestId` · `importOpen` · `resetMsg`)، فيصير نصفُ الإنذار عن أشياءَ ليست
 *     حقولاً. (٢) لا تلتقط النموذج الكائنيّ إلّا بمُحلٍّ إضافيّ: `AssetNew` يكتب
 *     `useState(emptyForm)` بمصنعٍ منفصل بينما `AssetEdit` يكتب الكائن سطرياً — شكلان
 *     لمفهومٍ واحد. أمّا الربطُ بعنصر التحكّم فيُوحّد الشكلين مجّاناً (`value={form.name}`
 *     و`value={name}` كلاهما «حقلُ name»)، ويُسقط الحالةَ العابرة بلا قائمةِ منعٍ يدوية:
 *     `loaded` لا يصل إلى `value=` أبداً.
 *
 * ⚠️ ما **لا** يمسكه — وحارسٌ يدّعي أكثر ممّا يفعل أسوأ من حارسٍ متواضعٍ صادق:
 *   ١) حقلاً لا يمرّ بـ`value`/`checked`: مجموعةُ أزرارٍ مخصّصة بـ`onClick` (تقييمُ المورّد
 *      بالنجوم مثالاً حيّ) غير مرئيّةٍ له بتاتاً.
 *   ٢) تعبيرَ ربطٍ مركّباً: يُقشَّر غلافُ `String()`/`Number()`/`Boolean()` ثمّ يُؤخذ **أوّل
 *      مسارٍ بسيط**؛ وما لا مسارَ فيه يُهمَل. الاتجاه تحت-إحصاءٌ (فشلٌ مفتوح) لا فوقه.
 *   ٣) المقارنةُ **بالأسماء**: حقلٌ واحد باسمين (`productName` في الإنشاء و`originalName` في
 *      التعديل) يُعدّ انحرافين. انحرافُ تسميةٍ حقيقيّ — لكنّه أضعف من غياب حقل، فلا تقرأ
 *      الرقم على أنّه «حقولٌ مفقودة» بل «مواضعُ اختلاف».
 *   ٤) داخلَ المكوّن المشترك: `UserNew` يفوّض حقولَه إلى `<AccountFields value={account}>`
 *      فيُرى حقلاً واحداً اسمه `account`. عدمُ التناظر يظهر صحيحاً، لكن لو تبنّت الشاشتان
 *      المكوّنَ نفسَه صار الحارس أعمى عن داخله — وهو المطلوب: المكوّن الواحد هو العلاج.
 *   ٥) الشاشةَ بلا قرين: `RoleEdit` بلا `RoleNew` و`EmployeeNew` بلا `EmployeeEdit` خارج
 *      القياس أصلاً — لا ثنائيةَ تُقارَن.
 *   ٦) **مشروعيّةَ** الانحراف: `revisionReason` في تعديل الشراء وحده مشروعٌ تماماً، و`whatsapp`
 *      الغائب عن إنشاء العميل عطبٌ صريح — وكلاهما رقمٌ واحد هنا. المشروعُ يُجمَّد في خطّ
 *      الأساس، والباقي يُرحَّل فينزل الرقم.
 *   ٧) الترتيبَ ولا التسميةَ العربية ولا الإلزام: حقلٌ في الشاشتين بترتيبٍ مختلفٍ أو مطلوبٌ
 *      في إحداهما فقط يمرّ بلا ملاحظة.
 *
 * ⚠️ التعليقات تُجرَّد قبل المطابقة، والسلاسلُ النصّية تُقنَّع قبل موازنة الأقواس: النثرُ
 * العربيّ في هذا المستودع يذكر أسماء الحقول توثيقياً، ونصٌّ فيه قوسٌ معقوف كان يقطع جسمَ
 * المكوّن قبل أوانه فيُنقص القياس صامتاً.
 *
 * المِسنَنة **تنازلية** (scripts/ratchet-core.mjs): الأساس يُخفَّض أو يبقى، ولا يُرفَع.
 * التحديث بعد الترحيل: node scripts/check-form-parity.mjs --update-baseline
 * التقرير وحده (بلا حجب):  node scripts/check-form-parity.mjs --report
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMonotonicDescent } from "./ratchet-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(REPO_ROOT, "client", "src", "pages");
const BASELINE_PATH = path.join(__dirname, "form-parity-baseline.json");
const BASELINE_REL = "scripts/form-parity-baseline.json";
const UPDATE = process.argv.includes("--update-baseline");
const SELFTEST_ONLY = process.argv.includes("--selftest");
/** وضعُ التقرير: يطبع اللوحة ويخرج بـ0 دائماً — للعرض قبل تجميد الأساس. */
const REPORT_ONLY = process.argv.includes("--report");

const BASELINE = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : {};

// ───────────────────────────── الكواشف (دوالُّ نقيّة) ─────────────────────────────

/**
 * يجرّد التعليقات (سطرية/كتلية/JSX) قبل المطابقة.
 * بسيطٌ عمداً: لا يحلّل السلاسل النصّية — ولو ابتلع تعليقاً داخل نصّ، فالاتجاه آمن
 * (تقليل الإنذار الكاذب) لا العكس.
 */
export function stripComments(source) {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ") // {/* ... */}
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* ... */
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 "); // // ...  (يتجنّب https://)
}

/**
 * يُقنّع محتوى السلاسل النصّية بفراغاتٍ **مع حفظ الإزاحات والأسطر**.
 * الغرضُ الوحيد: موازنةُ الأقواس أدناه. نصٌّ مثل `"{"` أو قالبٌ فيه `${…}` كان يُخِلّ
 * بالعدّ فيُقتطع جسمُ المكوّن مبكّراً ويسقط نصفُ الحقول من القياس بصمت.
 */
export function maskLiterals(code) {
  const out = code.split("");
  let i = 0;
  while (i < code.length) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < code.length) {
      if (code[j] === "\\") {
        j += 2;
        continue;
      }
      if (code[j] === quote) break;
      // سلسلةٌ مفردة/مزدوجة لا تعبر سطراً — وقفةٌ تمنع ابتلاع بقيّة الملفّ عند اقتباسٍ شاذّ.
      if (code[j] === "\n" && quote !== "`") break;
      j += 1;
    }
    for (let k = i + 1; k < Math.min(j, code.length); k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
    i = j + 1;
  }
  return out.join("");
}

/**
 * جسمُ المكوّن المُصدَّر افتراضياً وحده.
 * السبب: مكوّناتٌ مساعدة تعيش في نفس الملفّ (`BarcodeAliasDialog` في `ProductEdit`) ولها
 * حقولُها الخاصّة — عدُّها ضمن النموذج يرفع انحرافاً لا علاقةَ له بتناظر الشاشتين.
 * وحين يتعذّر التحديد (بلا تصدير افتراضيّ، أو أقواسٌ غير متوازنة) يعود الملفّ كاملاً:
 * فشلٌ مفتوحٌ لا يُعطّل القياس.
 */
export function defaultComponentBody(code) {
  const masked = maskLiterals(code);
  const head = /export\s+default\s+function\s+\w*\s*\([\s\S]*?\)\s*(?::[^{;]*)?\{/.exec(masked);
  if (!head) return code;
  const start = head.index + head[0].length - 1;
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    if (masked[i] === "{") depth += 1;
    else if (masked[i] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return code;
}

/**
 * ربطُ حقلٍ في عنصر تحكّم. اللَّحظُ الخلفيّ `(?<![-\w.])` مقصود: بدونه كان `aria-checked={…}`
 * يُطابَق فيُنتج حقلاً وهمياً من كلّ مجموعةِ أزرارٍ بـ`role="radio"`.
 */
const BIND_RE = /(?<![-\w.])(?:value|checked|defaultValue|defaultChecked)\s*=\s*\{([^{}]*)\}/g;

/** عناصرُ الخيارات: `value` فيها قيمةُ خيارٍ لا حقلَ نموذج. */
const OPTION_TAGS = /<(?:option|SelectItem|ToggleGroupItem|TabsTrigger|TabsContent)\b[^>]*>/g;

/** يقشّر أغلفة التحويل ثمّ يُرجع آخرَ مقطعٍ من أوّل مسارٍ بسيط؛ `null` حين لا مسار. */
export function normalizeBinding(expression) {
  let expr = expression.trim();
  let previous;
  do {
    previous = expr;
    expr = expr.replace(/^(?:String|Number|Boolean)\s*\(([\s\S]*)\)$/, "$1").trim();
  } while (expr !== previous);
  const hit = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(expr);
  if (!hit) return null;
  const segments = hit[0].split(".");
  return segments[segments.length - 1];
}

/** مجموعةُ الحقول الظاهرة في شاشةٍ واحدة. */
export function collectFormFields(source) {
  const scope = defaultComponentBody(stripComments(source)).replace(OPTION_TAGS, " ");
  const fields = new Set();
  for (const match of scope.matchAll(BIND_RE)) {
    const name = normalizeBinding(match[1]);
    if (name) fields.add(name);
  }
  return fields;
}

/**
 * مكوّناتُ النماذج المشتركة التي **تُفوَّض** إليها حقولُ الشاشة.
 *
 * ⭐ سببُ وجود هذه الدالّة عطبٌ حقيقيّ أمسكته مراجعةٌ عدائية (٢/٩/٢٦): `UserNew` يُفوّض كلّ
 * حقوله إلى `<AccountFields>`، فكان الحارس يرى فيه **حقلاً واحداً اسمه `account`** ويُبلّغ عن
 * تسعة حقولٍ «في التعديل وحده» **وهي موجودةٌ في الشاشتين**. فكان أعلى رقمٍ في التقرير كذباً —
 * وحارسٌ أعلى أرقامِه كاذبةٌ يُتجاوَز فيصير مسرحياً، وهو أسوأ من غيابه.
 *
* تُرجع مساراتِ الاستيراد لكلّ مكوّنٍ من **`@/components/form/**` وحدها** يُصيَّر فعلاً في
 * الجسم. فاستيرادُ نوعٍ أو ثابتٍ لا يُتبَع، ومكوّنٌ مستوردٌ غير مُصيَّرٍ لا يُحسَب.
 *
 * ⚠️ **ولماذا هذا المجلّد وحده؟** جُرّب اتّباعُ `@/components/**` كلّها فانتفخ زوجُ المنتج من
 * ٨ إلى ٢٣: ابتلع القياسُ محرّرَ **تعريف الحقول** المتداخل (`fieldKey`/`fieldType`/`label`/
 * `dependencyKey`…) وهو نموذجٌ آخر داخل الشاشة لا حقولُ منتَج. فصار الحارس يُبلّغ عن انحرافٍ
 * لا يعرف قارئُه معناه — وهذا أوّلُ طريق التجاهل. `components/form/` هي حصراً مجموعاتُ حقولٍ
 * مشتركةٌ بين شاشات الإنشاء والتعديل، وهي المقصودة بالقياس.
 *
 * والاتّباعُ **متعدٍّ داخل هذا المجلّد**: `AccountFields` يستعمل `IntlPhoneInput` وكلاهما فيه.
 * وقفُه عند مستوًى واحد كان يُنتج لا تناظراً مصطنعاً — الشاشةُ التي تستورد الهاتف مباشرةً
 * تُظهر `dial`/`national` والأخرى تُخفيهما وراء الوسيط، والحقلُ واحد.
 */
export function delegatedFormModules(source) {
  const code = stripComments(source);
  const body = defaultComponentBody(code);
  const modules = new Set();
  for (const imp of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(@\/components\/form\/[^"]+)"/g)) {
    const names = imp[1]
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/).pop().trim())
      // المكوّنات وحدها (PascalCase) — لا الثوابت ولا الدوالّ المساعِدة.
      .filter((n) => /^[A-Z]/.test(n));
    // ⚠️ حدُّ الوسم بـ«ما ليس حرفاً ولا رقماً» **بلا أيّ هروبٍ عكسيّ**: أوّلُ صياغةٍ كتبت
    // `` `<${n}[\s/>]` `` في قالبٍ نصّيّ، و`\s` فيه ليست هروباً صالحاً فتنهار إلى `s` ⇒
    // النمط `<AccountFields[s/>]` يفوت كلَّ وسمٍ يليه سطرٌ جديد. انهيارٌ **صامت**: لا خطأ
    // ولا تحذير، فقط حارسٌ يقيس أقلّ ممّا يظنّ. ونمطٌ بلا هروبٍ لا يُعيدها.
    if (names.some((n) => new RegExp("<" + n + "(?=[^A-Za-z0-9])").test(body))) modules.add(imp[2]);
  }
  return [...modules].sort();
}

/**
 * حقولُ الشاشة **مع** ما تُفوّضه إلى مكوّنٍ مشترك.
 *
 * العمقُ مستوًى واحدٌ عمداً: يغطّي النمطَ القائم في المستودع (شاشةٌ ⇐ مكوّن نموذجٍ مشترك)،
 * ويبقى تتبّعُه ممكناً بالعين. تتبّعٌ أعمق يجعل سببَ الرقم لغزاً — والحارسُ الذي لا يُفهَم
 * رقمُه لا يُصلَح عليه شيء. `resolve(importPath)` يُرجع نصّ الوحدة أو `null`.
 */
export function collectFormFieldsDeep(source, resolve) {
  const fields = collectFormFields(source);
  const seen = new Set();
  const queue = delegatedFormModules(source);
  while (queue.length) {
    const mod = queue.shift();
    if (seen.has(mod)) continue; // دورةٌ في الاستيراد لا تُعلّق الحارس
    seen.add(mod);
    const delegated = resolve(mod);
    if (!delegated) continue;
    for (const f of collectFormFields(delegated)) fields.add(f);
    queue.push(...delegatedFormModules(delegated));
  }
  return fields;
}

/** الانحرافُ بين شاشتَي كيانٍ واحد: ما في إحداهما دون الأخرى. */
export function diffFormParity(newSource, editSource, resolve = () => null) {
  const inNew = collectFormFieldsDeep(newSource, resolve);
  const inEdit = collectFormFieldsDeep(editSource, resolve);
  const onlyNew = [...inNew].filter((f) => !inEdit.has(f)).sort();
  const onlyEdit = [...inEdit].filter((f) => !inNew.has(f)).sort();
  return { onlyNew, onlyEdit, count: onlyNew.length + onlyEdit.length, shared: inNew.size - onlyNew.length };
}

// ───────────────────────────── جمع القياس ─────────────────────────────

function* walkTsx(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "node_modules", "_legacy", "dist"].includes(entry.name)) continue;
      yield* walkTsx(full);
    } else if (entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

const relOf = (full) => path.relative(REPO_ROOT, full).replace(/\\/g, "/");

/**
 * `@/…` ⇐ `client/src/…` (نفس ما يضبطه `tsconfig` و`vite.config`). يُرجع `null` بلا رمي:
 * مكوّنٌ غير موجودٍ يعني قياساً أقلّ لا حارساً ساقطاً.
 */
function resolveClientModule(importPath) {
  const rel = importPath.replace(/^@\//, "");
  for (const ext of [".tsx", ".ts"]) {
    const full = path.join(REPO_ROOT, "client", "src", `${rel}${ext}`);
    if (existsSync(full)) return readFileSync(full, "utf8");
  }
  return null;
}

/**
 * المسحُ **دالّةٌ تُستدعى بعد الاختبار الذاتيّ** لا كتلةٌ عند التحميل: `--selftest` وحدةٌ
 * نقيّة يجب أن تعمل بلا شجرة `pages` أصلاً، ولو سبق المسحُ الاختبارَ لابتلع خطأُ قراءةِ
 * مجلّدٍ ناقصٍ نتيجةَ الاختبار وأعطى فشلاً لا علاقةَ له بالكواشف.
 *
 * @returns {Map<string, { count: number, onlyNew: string[], onlyEdit: string[] }>}
 */
function collect() {
  const found = new Map();
  for (const newFile of walkTsx(SCAN_ROOT)) {
    if (!/New\.tsx$/.test(newFile)) continue;
    const editFile = newFile.replace(/New\.tsx$/, "Edit.tsx");
    if (!existsSync(editFile)) continue; // شاشةٌ بلا قرين — لا ثنائيةَ تُقارَن (§«ما لا يمسكه» ٥)
    const stem = relOf(newFile).replace(/New\.tsx$/, "");
    const diff = diffFormParity(
      readFileSync(newFile, "utf8"),
      readFileSync(editFile, "utf8"),
      resolveClientModule,
    );
    if (diff.count > 0) found.set(stem, diff);
  }
  return found;
}

const displayOf = (stem) => `${stem}{New,Edit}.tsx`;

function printDashboard(current) {
  if (current.size === 0) {
    console.log("  لا انحراف — كلّ ثنائية إنشاء/تعديل متناظرة.");
    return;
  }
  console.log("\n  الانحراف  الثنائية");
  console.log("  ────────  " + "─".repeat(58));
  const rows = [...current.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [stem, diff] of rows) {
    console.log(`  ${String(diff.count).padStart(8)}  ${displayOf(stem)}`);
    if (diff.onlyNew.length > 0) console.log(`            ← الإنشاء وحده: ${diff.onlyNew.join(" · ")}`);
    if (diff.onlyEdit.length > 0) console.log(`            ← التعديل وحده: ${diff.onlyEdit.join(" · ")}`);
  }
  const total = rows.reduce((sum, [, d]) => sum + d.count, 0);
  console.log("  ────────  " + "─".repeat(58));
  console.log(`  ${String(total).padStart(8)}  الإجمالي عبر ${rows.length} ثنائية\n`);
}

// ───────────────────────────── الاختبار الذاتيّ ─────────────────────────────

function runSelfTest({ quiet }) {
  const fails = [];
  const eq = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`${name}: توقّعنا ${JSON.stringify(want)} فجاء ${JSON.stringify(got)}`);
    }
  };
  const has = (name, set, ...names) => {
    for (const n of names) if (!set.has(n)) fails.push(`${name}: غاب «${n}» عن ${JSON.stringify([...set])}`);
  };
  const lacks = (name, set, ...names) => {
    for (const n of names) if (set.has(n)) fails.push(`${name}: ظهر «${n}» وما كان ينبغي`);
  };

  // ── التقنيع: يحفظ الطول والأسطر، ويُفرِغ الأقواس داخل النصّ
  const masked = maskLiterals('const a = "{{{"; const b = 1;');
  eq("التقنيع يحفظ الطول", masked.length, 'const a = "{{{"; const b = 1;'.length);
  eq("التقنيع يُفرِغ الأقواس النصّية", /[{]/.test(masked), false);
  eq("التقنيع يحفظ الأسطر", maskLiterals('x = `a\nb`;').split("\n").length, 2);

  // ── جسمُ المكوّن: يقف عند نهاية التصدير الافتراضيّ ولا يبتلع المكوّن التالي
  const twoComponents = `
    export default function Page() {
      const o = { a: 1 };
      return <Input value={form.name} />;
    }
    function Helper() { return <Input value={code} />; }
  `;
  const body = defaultComponentBody(twoComponents);
  eq("جسمُ المكوّن يشمل حقل النموذج", /form\.name/.test(body), true);
  eq("جسمُ المكوّن يستبعد المكوّن المساعد", /value=\{code\}/.test(body), false);


  // ── اتّباعُ التفويض: الحالةُ التي كذَب فيها الحارس على أعلى ثنائيةٍ في تقريره
  const delegatingPage = `
import { Button } from "@/components/ui/button";
import {
  AccountFields,
  emptyAccountValue,
  type AccountFieldsValue,
} from "@/components/form/AccountFields";
import { FieldBuilder } from "@/components/products/FieldBuilder";
export default function Page() {
  return (
    <form>
      <AccountFields
        value={account}
      />
      <FieldBuilder value={rows} />
    </form>
  );
}
`;
  const delegated = delegatedFormModules(delegatingPage);
  // ⭐ الوسمُ يليه **سطرٌ جديد** لا مسافة — وهي الحالة التي أسقطها انهيارُ الهروب `\s` داخل
  //    قالبٍ نصّيّ، فأعطى الحارسَ صفرَ تفويضٍ **بصمت** وأبقى تسعةَ حقولٍ وهمية في أعلى التقرير.
  eq("يتبع مكوّن الحقول المشترك ولو كان الوسمُ متعدّد الأسطر", delegated, [
    "@/components/form/AccountFields",
  ]);
  eq(
    "ولا يتبع مكوّناً خارج components/form مهما صُيِّر",
    delegated.includes("@/components/products/FieldBuilder"),
    false,
  );
  eq(
    "ولا يتبع نوعاً مستورداً ولا مكوّناً غير مُصيَّر",
    delegatedFormModules(`
import { Unused } from "@/components/form/Unused";
export default function P() { return null; }
`),
    [],
  );

  // ── الجمعُ العميق: يضمّ المفوَّض، ويتعدّى داخل المجلّد نفسه، ولا تُعلّقه حلقةُ استيراد
  const sharedModules = {
    "@/components/form/AccountFields": `
import { IntlPhoneInput } from "@/components/form/IntlPhoneInput";
export default function AccountFields() {
  return (<><Input value={form.email} /><IntlPhoneInput value={p} /></>);
}
`,
    "@/components/form/IntlPhoneInput": `
export default function IntlPhoneInput() { return <Input value={national} />; }
`,
  };
  const deep = collectFormFieldsDeep(delegatingPage, (m) => sharedModules[m] ?? null);
  has("الحقولُ المفوَّضة تُضمّ", deep, "account", "email");
  has("والاتّباعُ متعدٍّ داخل components/form", deep, "national");

  const cyclicModules = {
    "@/components/form/A": `
import { B } from "@/components/form/B";
export default function A() { return <B value={x} />; }
`,
    "@/components/form/B": `
import { A } from "@/components/form/A";
export default function B() { return <A value={y} />; }
`,
  };
  has(
    "حلقةُ الاستيراد لا تُعلّق الاتّباع",
    collectFormFieldsDeep(
      `
import { A } from "@/components/form/A";
export default function P() { return <A value={z} />; }
`,
      (m) => cyclicModules[m] ?? null,
    ),
    "x",
    "y",
    "z",
  );

  // ── تطبيع الربط
  eq("التطبيع يقشّر String()", normalizeBinding("String(form.branchId)"), "branchId");
  eq("التطبيع يقشّر أغلفةً متداخلة", normalizeBinding("Number(String(x))"), "x");
  eq("التطبيع يأخذ أوّل مسارٍ في تعبيرٍ مركّب", normalizeBinding('form.city ?? ""'), "city");
  eq("التطبيع يُهمل ما لا مسارَ فيه", normalizeBinding('""'), null);

  // ── جمعُ الحقول: الشكلان الكائنيّ والمُفرد سواء
  const objectShape = `export default function P() { return (<div>
    <Input value={form.name} />
    <MoneyInput value={String(form.purchaseValue)} />
    <Checkbox checked={form.isActive} />
  </div>); }`;
  const scalarShape = `export default function P() { return (<div>
    <Input value={name} />
    <MoneyInput value={purchaseValue} />
    <Checkbox checked={isActive} />
  </div>); }`;
  eq(
    "الشكلُ الكائنيّ والمُفرد يُنتجان البصمة نفسها",
    [...collectFormFields(objectShape)].sort(),
    [...collectFormFields(scalarShape)].sort(),
  );
  has("جمعُ الحقول", collectFormFields(objectShape), "name", "purchaseValue", "isActive");

  // ── ما يجب ألّا يُلتقَط
  const noise = `export default function P() { return (<div>
    <button aria-checked={n === rating} />
    <AppSelect value={branchId}><option value={b.id}>x</option></AppSelect>
    <Input value={form.city} />
  </div>); }`;
  const noiseFields = collectFormFields(noise);
  has("لا يفوت الحقلَ الحقيقيّ وسط الضجيج", noiseFields, "branchId", "city");
  lacks("يتجاهل aria-checked و<option>", noiseFields, "n", "rating", "id");

  eq(
    "يتجاهل الحقلَ المذكور في تعليق",
    collectFormFields('export default function P() { /* value={whatsapp} */ return <Input value={name} />; }').has("whatsapp"),
    false,
  );

  // ── الفرق
  const diff = diffFormParity(
    'export default function P() { return (<><Input value={name} /><Input value={custodianId} /></>); }',
    'export default function P() { return (<><Input value={name} /><Input value={whatsapp} /></>); }',
  );
  eq("الفرق يفصل الجهتين", { onlyNew: diff.onlyNew, onlyEdit: diff.onlyEdit }, {
    onlyNew: ["custodianId"],
    onlyEdit: ["whatsapp"],
  });
  eq("الفرق يجمع الجهتين في رقمٍ واحد", diff.count, 2);
  eq(
    "الشاشتان المتطابقتان بلا انحراف",
    diffFormParity(
      'export default function P() { return <Input value={name} />; }',
      'export default function P() { return <Input value={form.name} />; }',
    ).count,
    0,
  );

  if (fails.length > 0) {
    console.error("✗ الاختبار الذاتيّ لحارس تناظر النموذج فشل:\n");
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  if (!quiet) console.log("✓ الاختبار الذاتيّ لحارس تناظر النموذج: كلّ الكواشف سليمة.");
}

// ───────────────────────────── التنفيذ ─────────────────────────────

runSelfTest({ quiet: !SELFTEST_ONLY });
if (SELFTEST_ONLY) process.exit(0);

const current = collect();

if (UPDATE) {
  const asObj = Object.fromEntries(
    [...current.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([stem, d]) => [stem, d.count]),
  );
  writeFileSync(BASELINE_PATH, JSON.stringify(asObj, null, 2) + "\n", "utf8");
  const total = [...current.values()].reduce((s, d) => s + d.count, 0);
  console.log(`✓ حُدِّث خطّ أساس تناظر النموذج: ${current.size} ثنائية · ${total} انحرافاً مجمَّداً.`);
  printDashboard(current);
  process.exit(0);
}

const findings = [];
for (const [stem, diff] of current) {
  const allowed = BASELINE[stem] ?? 0;
  if (diff.count <= allowed) continue;
  const detail = [
    diff.onlyNew.length > 0 ? `الإنشاء وحده: ${diff.onlyNew.join(" · ")}` : null,
    diff.onlyEdit.length > 0 ? `التعديل وحده: ${diff.onlyEdit.join(" · ")}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
  findings.push(
    allowed === 0
      ? `${displayOf(stem)}: ${diff.count} حقلاً غير متناظر (الأساس ٠) ⇒ ${detail}`
      : `${displayOf(stem)}: ${diff.count} (الأساس ${allowed}، +${diff.count - allowed}) ⇒ ${detail}`,
  );
}

const descent = assertMonotonicDescent({
  baselinePath: BASELINE_REL,
  baseline: BASELINE,
  label: "تناظر النموذج",
});

const stale = Object.keys(BASELINE).filter((s) => !current.has(s));

if (REPORT_ONLY) {
  console.log("تناظر النموذج — تقريرٌ (لا يحجب):");
  printDashboard(current);
  if (findings.length > 0) {
    console.log(`ℹ️  ${findings.length} ثنائية فوق خطّ الأساس:`);
    for (const f of findings) console.log(`   ${f}`);
  } else {
    console.log("✓ لا ثنائيةَ فوق خطّ الأساس.");
  }
  process.exit(0);
}

if (!descent.ok) {
  console.error(descent.message);
  process.exit(1);
}

if (findings.length === 0) {
  console.log(`✓ تناظر النموذج محفوظ — ${current.size} ثنائية ضمن خطّ الأساس.`);
  printDashboard(current);
  if (!descent.skipped) console.log(descent.message);
  if (stale.length > 0) {
    console.log(`ℹ️  ${stale.length} ثنائية نظيفة يمكن حذفها من ${BASELINE_REL}:`);
    for (const s of stale) console.log(`   - ${displayOf(s)}`);
  }
  process.exit(0);
}

console.error(`✗ تناظر النموذج مكسور — ${findings.length} ثنائية:\n`);
for (const f of findings) console.error(`  ${f}`);
printDashboard(current);
console.error(`
القاعدة: شاشةُ التعديل = شاشةُ الإنشاء. الحقلُ الذي يُملأ عند الإنشاء يُعدَّل، والذي
يُعدَّل يُملأ عند الإنشاء — وإلّا أُنشئ السجلّ ناقصاً ثمّ فُتح تعديلُه فوراً لإكماله.

العلاجُ الجذريّ (محور D5 في مقياس الاحتكاك): **محرّرٌ واحد بوضعين** لا شاشتان:

  <RecordForm mode="create" />   ⇔   <RecordForm mode="edit" recordId={id} />

فيصير الحقلُ مُعرَّفاً مرّةً واحدة، ويستحيل أن يُضاف في إحدى الشاشتين وحدها. وما دام
الفصلُ قائماً، فأيّ حقلٍ جديد يُضاف في الشاشتين معاً في **نفس** الـPR.

والانحرافُ المشروع (حقلٌ لا معنى له إلّا في التعديل، مثل سبب المراجعة) يُجمَّد في خطّ
الأساس مرّةً — الحارس يقيس الاختلاف ولا يحكم على مشروعيّته.

خطّ الأساس (تنازليّ — لا يُرفَع): ${BASELINE_REL}
التحديث بعد الترحيل: node scripts/check-form-parity.mjs --update-baseline
`);
process.exit(1);
