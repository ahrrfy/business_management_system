import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOUCHER_CATEGORIES,
  RETIRED_VOUCHER_CATEGORIES,
  defaultVoucherCategoriesFor,
  isRetiredVoucherCategoryName,
  retiredVoucherCategory,
} from "../../../shared/voucherCategoryDefaults";
import {
  UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES,
  VOUCHER_CATEGORY_POSTING_ROLES,
  isVoucherCategoryRoleCompatible,
} from "../../../shared/voucherCategoryAccounting";

const migration = readFileSync(
  new URL(
    "../../../drizzle/migrations/0202_voucher_category_defaults.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("كتالوج فئات السندات الافتراضي", () => {
  it("كل فئة لها حساب مقابل متوافق مع اتجاهها (مرآة قيد CHECK في DB)", () => {
    for (const def of DEFAULT_VOUCHER_CATEGORIES) {
      expect(
        isVoucherCategoryRoleCompatible(def.direction, def.postingRole),
        `الفئة «${def.name}» بحساب ${def.postingRole} لا تتوافق مع اتجاه ${def.direction}`,
      ).toBe(true);
    }
  });

  it("أسماء فريدة وأوصاف غير فارغة وترتيب موجب", () => {
    const names = DEFAULT_VOUCHER_CATEGORIES.map((d) => d.name.trim());
    expect(new Set(names).size).toBe(names.length);
    for (const def of DEFAULT_VOUCHER_CATEGORIES) {
      expect(def.name.trim()).toBe(def.name);
      expect(def.description.trim().length).toBeGreaterThan(0);
      expect(def.sortOrder).toBeGreaterThan(0);
      // مطابقة SQL تعتمد اقتباساً مفرداً بلا تهريب ⇒ نمنع الاقتباس في المصدر أصلاً.
      expect(`${def.name}${def.description}`).not.toContain("'");
      expect(`${def.name}${def.description}`).not.toContain("\\");
    }
  });

  it("يغطّي كل دور محاسبي معتمد بمدخل واحد على الأقل — لا دور بلا باب", () => {
    const covered = new Set(
      DEFAULT_VOUCHER_CATEGORIES.map((d) => d.postingRole),
    );
    for (const role of VOUCHER_CATEGORY_POSTING_ROLES) {
      expect(covered.has(role), `الدور ${role} بلا فئة افتراضية`).toBe(true);
    }
  });

  it("يوفّر فئات جاهزة للقبض وللصرف معاً (البلاغ: القبض كان بفئتين فقط)", () => {
    expect(defaultVoucherCategoriesFor("IN").length).toBeGreaterThanOrEqual(8);
    expect(defaultVoucherCategoriesFor("OUT").length).toBeGreaterThanOrEqual(
      15,
    );
    // كل أدوار القبض الخمسة لها مدخل — كان ثلاثة منها بلا فئة إطلاقاً.
    const inRoles = new Set(
      defaultVoucherCategoriesFor("IN").map((d) => d.postingRole),
    );
    for (const role of [
      "OTHER_REVENUE",
      "CAPITAL",
      "OWNER_CURRENT",
      "LOAN_PAYABLE",
      "OTHER_LIABILITY",
    ]) {
      expect(inRoles.has(role as never), `دور القبض ${role} بلا فئة`).toBe(
        true,
      );
    }
  });

  it("الفئات المتقاعدة ليست جزءاً من الكتالوج ولكل منها بديل معلن", () => {
    const catalogNames = new Set(DEFAULT_VOUCHER_CATEGORIES.map((d) => d.name));
    for (const retired of RETIRED_VOUCHER_CATEGORIES) {
      expect(catalogNames.has(retired.name)).toBe(false);
      expect(retired.replacement.trim().length).toBeGreaterThan(0);
      expect(isRetiredVoucherCategoryName(retired.name)).toBe(true);
      expect(retiredVoucherCategory(` ${retired.name} `)?.replacement).toBe(
        retired.replacement,
      );
    }
    expect(isRetiredVoucherCategoryName("إيجار")).toBe(false);
    expect(retiredVoucherCategory(null)).toBeUndefined();
  });

  it("قائمة «تحتاج مساراً تخصصياً» في الواجهة = قائمة المتقاعدة حرفياً", () => {
    expect([...UNRESOLVED_DEFAULT_VOUCHER_CATEGORIES].sort()).toEqual(
      RETIRED_VOUCHER_CATEGORIES.map((c) => c.name).sort(),
    );
  });
});

describe("هجرة 0202 مرآةُ الكتالوج حرفياً", () => {
  it("تُدرج كل فئة من الكتالوج بنفس الاتجاه والحساب والترتيب", () => {
    for (const [index, def] of DEFAULT_VOUCHER_CATEGORIES.entries()) {
      const row =
        index === 0
          ? `SELECT '${def.name}' AS \`name\`, '${def.direction}' AS \`dir\`, '${def.postingRole}' AS \`role\`, '${def.description}' AS \`descr\`, ${def.sortOrder} AS \`ord\``
          : `UNION ALL SELECT '${def.name}', '${def.direction}', '${def.postingRole}', '${def.description}', ${def.sortOrder}`;
      expect(
        migration,
        `سطر الفئة «${def.name}» مفقود أو مختلف في 0202`,
      ).toContain(row);
    }
  });

  it("تُعطّل الفئات المتقاعدة غير المستعملة فقط ولا تحذف صفاً", () => {
    for (const retired of RETIRED_VOUCHER_CATEGORIES) {
      expect(migration).toContain(`'${retired.name}'`);
    }
    expect(migration).toContain("NOT EXISTS");
    expect(migration).toContain(
      "FROM `receipts` r WHERE r.`voucherCategoryId` = c.`id`",
    );
    // أوامر فعلية فقط (بداية سطر) — التعليقات العربية تشرح ما لم يُستعمل عمداً.
    const statements = migration
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/DELETE\s+FROM/i);
    // البذر لا يستعمل الإدراج المتساهل (يبتلع خرق CHECK صامتاً) بل إدراجاً مشروطاً بـLEFT JOIN.
    expect(statements).not.toMatch(/INSERT\s+IGNORE/i);
    expect(migration).toContain("LEFT JOIN `voucherCategories` c");
  });

  it("لا تلمس حساباً مقابلاً معيَّناً ولا تُعيد تصنيف اتجاهٍ غيّره المالك", () => {
    expect(migration).toContain("WHERE c.`postingRole` IS NULL");
    expect(migration).toContain(
      "AND c.`voucherCategoryDirection` = d.`dir` COLLATE utf8mb4_unicode_ci",
    );
  });

  it("كل مقارنة بالجدول المشتقّ لها COLLATE صريح (تفادي Illegal mix of collations)", () => {
    const comparisons = migration
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .filter((line) => /\bd\.`(name|dir|descr)`/.test(line))
      // أسطر الجدول المشتقّ نفسه (SELECT/UNION ALL) لا تقارن شيئاً.
      .filter((line) => !/^\s*(SELECT|UNION ALL SELECT)\b/.test(line.trim()));
    expect(comparisons.length).toBeGreaterThan(0);
    for (const line of comparisons) {
      // الإسناد في SET والإدراج لا يحتاجان COLLATE؛ المقارنات وحدها تحتاجه.
      if (!/[=<>]/.test(line) || /^\s*SET\b/.test(line.trim())) continue;
      expect(line, `مقارنة بلا COLLATE صريح: ${line.trim()}`).toContain(
        "COLLATE utf8mb4_unicode_ci",
      );
    }
  });

  it("مسجَّلة في سجلّ الهجرات بعد 0201 مباشرة", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL(
          "../../../drizzle/migrations/meta/_journal.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    const tags = journal.entries.map((entry) => entry.tag);
    const index = tags.indexOf("0202_voucher_category_defaults");
    expect(index).toBeGreaterThan(0);
    expect(tags[index - 1]).toBe("0201_night_shift_settings");
  });

  it("مُدرجة في مُطبِّق CI ليطابق مسار db:push مسارَ الهجرات", () => {
    const extras = readFileSync(
      new URL(
        "../../../scripts/ci-apply-extra-migrations.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(extras).toContain(
      "drizzle/migrations/0202_voucher_category_defaults.sql",
    );
    // الترتيب حاسم: 0036 تُنشئ الجدول وتبذر أسماء 0036، و0202 تكمّلها وتعيّن حساباتها.
    expect(extras.indexOf("0036_vouchers_pro.sql")).toBeLessThan(
      extras.indexOf("0202_voucher_category_defaults.sql"),
    );
  });
});
