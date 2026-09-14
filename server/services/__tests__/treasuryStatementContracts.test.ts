import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../reportsTreasuryService.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("async function queryTreasuryStatement");
const end = source.indexOf(
  "/* ============================ تقرير المصروفات",
  start,
);
const statementSource = source.slice(start, end);

describe("عقد لقطة كشف الخزينة", () => {
  it("يقرأ الافتتاحي والإجماليات والتفاصيل في معاملة read-only repeatable-read صريحة", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(statementSource).toContain("db.transaction(async (tx) =>");
    expect(statementSource.match(/await tx\.execute\(/g)).toHaveLength(3);
    expect(statementSource).not.toContain("await db.execute(");
    expect(statementSource).toContain('isolationLevel: "repeatable read"');
    expect(statementSource).toContain('accessMode: "read only"');
  });

  it("يفصل حد العرض عن التصدير الكامل", () => {
    expect(statementSource).toContain("const limitSql = rowLimit == null");
    expect(statementSource).toContain("return queryTreasuryStatement(opts, null)");
  });
});
