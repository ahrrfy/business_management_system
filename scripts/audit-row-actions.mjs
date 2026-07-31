import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pagesDir = path.join(root, "client", "src", "pages");
const routersDir = path.join(root, "server", "routers");

function walk(dir, extensions) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, extensions);
    return extensions.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

const pageFiles = walk(pagesDir, [".tsx"]);
const routerFiles = walk(routersDir, [".ts"]);
const listScreens = pageFiles.filter((file) =>
  /<DataTable\b|<table\b|<Table(Header|Body)\b/.test(fs.readFileSync(file, "utf8")),
);

const kinds = [
  "view",
  "create",
  "edit",
  "print",
  "export",
  "duplicate",
  "pay",
  "approve",
  "reverse",
  "delete",
  "other",
];

const pageRows = listScreens.map((file) => {
  const source = fs.readFileSync(file, "utf8");
  const usesRowActions = /<RowActions\b/.test(source);
  const rowActionBlocks = [...source.matchAll(/<RowActions[\s\S]*?actions=\{\[([\s\S]*?)\]\}/g)]
    .map((match) => match[1]);
  const declared = rowActionBlocks.reduce(
    (sum, block) => sum + (block.match(/\bkey\s*:/g)?.length ?? 0),
    0,
  );
  // TypeScript يضمن أن القيمة من RowActionKind؛ نعدّ الخاصية نفسها كي تشمل النوع الشرطي
  // (مثل استلام أمر الشراء الذي يصبح view بعد بلوغ الحالة النهائية).
  const typed = rowActionBlocks.reduce(
    (sum, block) => sum + (block.match(/\bkind\s*:/g)?.length ?? 0),
    0,
  );
  const gated = rowActionBlocks.reduce(
    (sum, block) => sum + (block.match(/\bgate\s*:/g)?.length ?? 0),
    0,
  );
  return {
    file: path.relative(root, file).replaceAll("\\", "/"),
    usesRowActions,
    declared,
    typed,
    gated,
    // لا نعدّ زر طباعة تقرير أو أيقونة تعديل في نموذج «واجهة إجراءات صفوف».
    // الإشارة هنا عمود إجراء/إجراءات صريح في جدول ولا يستخدم العقد الموحد بعد.
    hasLegacyActionUi:
      !usesRowActions &&
      /(header\s*:\s*["'](إجراء|الإجراء|إجراءات|الإجراءات)["']|>\s*(إجراء|الإجراء|إجراءات|الإجراءات)\s*<\/)/.test(source),
  };
});

const allowedSelfServiceMutations = new Map([
  ["server/routers/authRouter.ts:twoFactorSetupStart", "إعداد المصادقة الثنائية للحساب الحالي"],
  ["server/routers/authRouter.ts:twoFactorSetupConfirm", "تأكيد المصادقة الثنائية للحساب الحالي"],
  ["server/routers/authRouter.ts:twoFactorDisable", "تعطيل المصادقة الثنائية بعد إثبات الهوية"],
  ["server/routers/authRouter.ts:twoFactorRegenerateCodes", "تجديد رموز الاسترداد للحساب الحالي"],
  ["server/routers/authRouter.ts:changePassword", "تغيير كلمة مرور الحساب الحالي"],
  ["server/routers/authRouter.ts:revokeMySessions", "إلغاء جلسات الحساب الحالي"],
  ["server/routers/authRouter.ts:revokeSession", "إلغاء جلسة مملوكة للحساب الحالي"],
  ["server/routers/userRouter.ts:changePassword", "مسار توافق لتغيير كلمة مرور الحساب الحالي"],
]);

let mutations = 0;
const rawProtectedMutationRows = [];
const directRawMutationPattern =
  /^\s{2}(\w+):\s*protectedProcedure(?:(?!^\s{2}\w+\s*:)[\s\S])*?\.mutation\s*\(/gm;
for (const file of routerFiles) {
  const source = fs.readFileSync(file, "utf8");
  mutations += source.match(/\.mutation\s*\(/g)?.length ?? 0;
  const relativeFile = path.relative(root, file).replaceAll("\\", "/");
  for (const match of source.matchAll(directRawMutationPattern)) {
    const endpoint = match[1];
    const key = `${relativeFile}:${endpoint}`;
    rawProtectedMutationRows.push({
      key,
      endpoint,
      file: relativeFile,
      reason: allowedSelfServiceMutations.get(key),
    });
  }
}

const withRowActions = pageRows.filter((row) => row.usesRowActions);
const legacy = pageRows.filter((row) => row.hasLegacyActionUi);
const declared = withRowActions.reduce((sum, row) => sum + row.declared, 0);
const typed = withRowActions.reduce((sum, row) => sum + row.typed, 0);
const gated = withRowActions.reduce((sum, row) => sum + row.gated, 0);

console.log("جرد تكامل إجراءات القوائم");
console.log(`- شاشات القوائم/الجداول: ${listScreens.length}`);
console.log(`- تستخدم RowActions الموحّد: ${withRowActions.length}`);
console.log(`- واجهات إجراءات قديمة تحتاج مراجعة: ${legacy.length}`);
console.log(`- إجراءات معلنة/مصنّفة/مرتبطة ببوابة: ${declared}/${typed}/${gated}`);
console.log(`- عمليات mutation خادمية: ${mutations}`);
const reviewedSelfService = rawProtectedMutationRows.filter((row) => row.reason);
const unreviewedRawMutations = rawProtectedMutationRows.filter((row) => !row.reason);
console.log(`- protectedProcedure خام مُراجع كخدمة ذاتية للحساب: ${reviewedSelfService.length}`);
console.log(`- protectedProcedure خام غير مُراجع: ${unreviewedRawMutations.length}`);

if (legacy.length) {
  console.log("\nأولوية الترحيل (أول 25 شاشة):");
  for (const row of legacy.slice(0, 25)) console.log(`- ${row.file}`);
}

const partial = withRowActions.filter((row) => row.declared > row.typed || row.declared > row.gated);
if (partial.length) {
  console.log("\nRowActions غير مكتملة العقد (معلن/مصنّف/مبوّب):");
  for (const row of partial) {
    console.log(`- ${row.file}: ${row.declared}/${row.typed}/${row.gated}`);
  }
}

if (unreviewedRawMutations.length) {
  console.log("\nعمليات protectedProcedure خام جديدة تحتاج بوابة وحدة أو استثناءً مبرّراً:");
  for (const row of unreviewedRawMutations) console.log(`- ${row.file}:${row.endpoint}`);
}

if (legacy.length || partial.length || unreviewedRawMutations.length) process.exitCode = 1;
