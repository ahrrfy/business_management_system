#!/usr/bin/env node
// حارس واجهة موحّد: يمنع إعادة حقول المال والهاتف الخام إلى شاشات النظام.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(root, "client", "src");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const moneyName = /(?:^|\.)(?:\w*(?:Amount|Price|Cost|Fee|Salary|Wage|Budget|Balance|Credit|Deposit|Paid|Payment|Refund|Settlement|Bonus|Allowance|Shipping|Expenses|Revenue|Discount|Total)|amount|price|cost|fee|salary|wage|budget|balance|credit|deposit|paid|payment|refund|settlement|bonus|allowance|shipping|expenses|revenue|discount|total)$/i;
const notMoney = /(?:annual|sick)LeaveBalance$/i;
const phoneSignal = /value=\{[^}]*(?:phone|Phone|whatsapp|WhatsApp|mobile)|id=(?:"|\{`)[^\s>]*(?:phone|Phone)|autoComplete="tel"|inputMode="tel"/;
const violations = [];

for (const file of walk(clientRoot).filter((name) => name.endsWith(".tsx"))) {
  const source = readFileSync(file, "utf8");
  const tagPattern = /<(?:Input|input)\b[\s\S]*?\/>/g;
  let match;
  while ((match = tagPattern.exec(source))) {
    const tag = match[0];
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    const location = `${path.relative(root, file)}:${line}`;
    const valueName = tag.match(/value=\{\s*([\w.]+)/)?.[1] ?? "";

    if (valueName && moneyName.test(valueName) && !notMoney.test(valueName) && !tag.startsWith("<MoneyInput")) {
      violations.push(`${location}: الحقل المالي «${valueName}» يجب أن يستخدم MoneyInput`);
    }

    if (
      phoneSignal.test(tag) &&
      !file.endsWith(`${path.sep}IntlPhoneInput.tsx`) &&
      !/phoneNumberId/.test(tag) &&
      !tag.startsWith("<IntlPhoneInput") &&
      !tag.includes("+964")
    ) {
      violations.push(`${location}: حقل الهاتف يجب أن يستخدم IntlPhoneInput أو يثبت +964 في الواجهة المخصصة`);
    }
  }
}

if (violations.length) {
  console.error("فشل حارس حقول المال والهاتف:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log("نجح حارس حقول المال والهاتف: لا توجد حقول خام مخالفة.");
