import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { expenseCategories, expenses } from "../../../drizzle/schema";
import {
  DEFAULT_EXPENSE_CATEGORIES,
  EXPENSE_BUCKETS,
  EXPENSE_BUCKET_LABEL,
  defaultCategoryNameForBucket,
  defaultExpenseCategoriesForBucket,
  expenseBucketLabel,
  isExpenseBucket,
} from "../../../shared/expenseCategories";

const migration = readFileSync(
  new URL(
    "../../../drizzle/migrations/0203_managed_expense_categories.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("الدلو المحاسبيّ للمصروف", () => {
  it("مرآةُ ENUM العمود حرفياً — لا بندٌ يزيد ولا ينقص", () => {
    const column = getTableConfig(expenses).columns.find(
      (c) => c.name === "expenseCategory",
    );
    expect([...(column?.enumValues ?? [])].sort()).toEqual(
      [...EXPENSE_BUCKETS].sort(),
    );
  });

  it("جدول الفئات يحمل نفس قائمة الدلاء (وإلّا صارت فئةٌ بدلوٍ لا يفهمه المصروف)", () => {
    const column = getTableConfig(expenseCategories).columns.find(
      (c) => c.name === "expenseCategoryBucket",
    );
    expect([...(column?.enumValues ?? [])].sort()).toEqual(
      [...EXPENSE_BUCKETS].sort(),
    );
  });

  it("لكل دلوٍ تسمية، والدوال تتعامل مع المجهول برشاقة", () => {
    for (const bucket of EXPENSE_BUCKETS) {
      expect(EXPENSE_BUCKET_LABEL[bucket]?.length).toBeGreaterThan(0);
      expect(isExpenseBucket(bucket)).toBe(true);
    }
    expect(isExpenseBucket("NOPE")).toBe(false);
    expect(expenseBucketLabel(null)).toBe("—");
    expect(expenseBucketLabel("NOPE")).toBe("NOPE");
    expect(expenseBucketLabel("RENT")).toBe("إيجار");
  });
});

describe("كتالوج فئات المصروفات الافتراضي", () => {
  it("أسماء فريدة وأوصاف غير فارغة وترتيب موجب وبلا محارف تكسر SQL", () => {
    const names = DEFAULT_EXPENSE_CATEGORIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const def of DEFAULT_EXPENSE_CATEGORIES) {
      expect(def.name.trim()).toBe(def.name);
      expect(def.description.trim().length).toBeGreaterThan(0);
      expect(def.sortOrder).toBeGreaterThan(0);
      expect(isExpenseBucket(def.bucket)).toBe(true);
      expect(`${def.name}${def.description}`).not.toContain("'");
      expect(`${def.name}${def.description}`).not.toContain("\\");
    }
  });

  it("لكل دلو فئةٌ احتياطية **واحدة بالضبط** — مهبط الطلبات التي تحمل الدلو وحده", () => {
    for (const bucket of EXPENSE_BUCKETS) {
      const inBucket = defaultExpenseCategoriesForBucket(bucket);
      expect(inBucket.length, `الدلو ${bucket} بلا فئات`).toBeGreaterThan(0);
      const defaults = inBucket.filter((c) => c.isBucketDefault === true);
      expect(
        defaults.length,
        `الدلو ${bucket} فيه ${defaults.length} احتياطية`,
      ).toBe(1);
      expect(defaultCategoryNameForBucket(bucket)).toBe(defaults[0].name);
    }
  });

  it("يوسّع التصنيف فعلياً فوق الدلاء الثمانية", () => {
    expect(DEFAULT_EXPENSE_CATEGORIES.length).toBeGreaterThan(
      EXPENSE_BUCKETS.length * 2,
    );
  });
});

describe("هجرة 0203 مرآةُ الكتالوج، وغير مُدمِّرة", () => {
  it("تُدرج كل فئة بنفس الدلو والوصف والترتيب وعلَم الاحتياطية", () => {
    for (const [index, def] of DEFAULT_EXPENSE_CATEGORIES.entries()) {
      const flag = def.isBucketDefault === true ? 1 : 0;
      const row =
        index === 0
          ? `SELECT '${def.name}' AS \`name\`, '${def.bucket}' AS \`bucket\`, '${def.description}' AS \`descr\`, ${def.sortOrder} AS \`ord\`, ${flag} AS \`isDefault\``
          : `UNION ALL SELECT '${def.name}', '${def.bucket}', '${def.description}', ${def.sortOrder}, ${flag}`;
      expect(
        migration,
        `سطر الفئة «${def.name}» مفقود أو مختلف في 0203`,
      ).toContain(row);
    }
  });

  it("الردم الرجعيّ لا يمسّ الدلو المحاسبيّ — إثراءُ تصنيفٍ لا إعادةُ تصنيف", () => {
    const backfill = migration.slice(migration.indexOf("UPDATE `expenses` e"));
    expect(backfill).toContain("SET e.`expenseCategoryId` = c.`id`");
    expect(backfill).toContain("WHERE e.`expenseCategoryId` IS NULL");
    // أي كتابةٍ على عمود الدلو نفسه في الردم = إعادة تصنيف تاريخٍ مُرحَّل.
    expect(backfill).not.toContain("SET e.`expenseCategory`");
    expect(backfill).not.toContain("e.`expenseCategory` =");
  });

  it("لا حذف ولا إدراج متساهل، ولكل مقارنة بالجدول المشتقّ COLLATE صريح", () => {
    const statements = migration
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/DELETE\s+FROM/i);
    expect(statements).not.toMatch(/DROP\s+TABLE/i);
    expect(statements).not.toMatch(/INSERT\s+IGNORE/i);
    expect(migration).toContain(
      "ON c.`name` COLLATE utf8mb4_unicode_ci = d.`name` COLLATE utf8mb4_unicode_ci",
    );
    expect(migration).toContain(
      "ON c.`expenseCategoryBucket` COLLATE utf8mb4_unicode_ci = e.`expenseCategory`",
    );
  });

  it("عمود الربط والفهرس وقيد الـFK كلّها محروسة idempotently", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS `expenseCategories`",
    );
    for (const guard of [
      "COLUMN_NAME = 'expenseCategoryId'",
      "INDEX_NAME = 'idx_expense_managed_category'",
      "REFERENCED_TABLE_NAME = 'expenseCategories'",
    ]) {
      expect(migration, `حارس مفقود: ${guard}`).toContain(guard);
    }
    // القيد يُضاف **بعد** الردم، وإلّا سقط على قيمةٍ يتيمة.
    expect(migration.indexOf("UPDATE `expenses` e")).toBeLessThan(
      migration.indexOf("fk_expenses_expcat"),
    );
  });

  it("مسجَّلة في السجلّ بعد 0202 وفي مُطبِّق CI بعد إنشاء الجدول", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL(
          "../../../drizzle/migrations/meta/_journal.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    const tags = journal.entries.map((e) => e.tag);
    const index = tags.indexOf("0203_managed_expense_categories");
    expect(index).toBeGreaterThan(0);
    expect(tags[index - 1]).toBe("0202_voucher_category_defaults");

    const extras = readFileSync(
      new URL(
        "../../../scripts/ci-apply-extra-migrations.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(extras).toContain(
      "drizzle/migrations/0203_managed_expense_categories.sql",
    );
  });
});

describe("عقد الراوتر والخدمة", () => {
  const routerSource = readFileSync(
    new URL("../../routers/expenseRouter.ts", import.meta.url),
    "utf8",
  );
  const serviceSource = readFileSync(
    new URL("../expenseCategoryService.ts", import.meta.url),
    "utf8",
  );
  const expenseServiceSource = readFileSync(
    new URL("../expenseService.ts", import.meta.url),
    "utf8",
  );

  it("القراءة بخريطة الوحدة والكتابة بقائمة الإدارة، وكلاهما بلا اشتراط فرع", () => {
    expect(routerSource).toContain("list: expensesGlobalReadProcedure");
    expect(routerSource).toContain("create: expensesGlobalProcedure");
    expect(routerSource).toContain("update: expensesGlobalProcedure");
    expect(routerSource).toContain("setActive: expensesGlobalProcedure");
    expect(routerSource).toContain("restoreDefaults: expensesGlobalProcedure");
    expect(routerSource).toContain("backfill: expensesGlobalProcedure");
    // المصروف نفسه يبقى مقصوراً بالفرع كما كان.
    expect(routerSource).toContain("create: expensesCashierProcedure");
  });

  it("الفئة تحكم الدلو: يُحلّان معاً قبل أي كتابة أو ترحيل", () => {
    expect(expenseServiceSource).toContain(
      "const resolvedCategory = await resolveExpenseCategory(",
    );
    expect(expenseServiceSource).toContain("category: resolvedCategory.bucket");
    expect(expenseServiceSource).toContain(
      "expenseCategoryId: resolvedCategory.expenseCategoryId",
    );
  });

  it("الفئة لا تُحذف، ولا يُنقل دلو فئةٍ مستعملة، ولا تُعطَّل الاحتياطية", () => {
    expect(serviceSource).not.toMatch(/\.delete\(expenseCategories\)/);
    expect(serviceSource).toContain(
      "لا يمكن تغيير الدلو المحاسبي لفئة مرتبطة بمصروفات",
    );
    expect(serviceSource).toContain("لا تُعطَّل فئة الدلو الاحتياطية");
  });

  it("قاعدةٌ بلا فئات لا تُعطّل تسجيل المصروف (يعود null ويبقى الدلو)", () => {
    expect(serviceSource).toContain(
      "expenseCategoryId: fallback ? Number(fallback.id) : null",
    );
  });
});
