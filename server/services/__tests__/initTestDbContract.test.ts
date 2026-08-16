import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("fresh test database initialization", () => {
  it("verifies the physical schema before announcing success", () => {
    const source = readFileSync("scripts/init-test-db.mjs", "utf8");
    const push = source.indexOf('"② db:push');
    const extras = source.indexOf('"③ هجرات إضافية');
    const verify = source.indexOf('"④ التحقق الفيزيائي من اكتمال المخطط"');
    const success = source.lastIndexOf("جاهزة:");

    expect(push).toBeGreaterThanOrEqual(0);
    expect(extras).toBeGreaterThan(push);
    expect(verify).toBeGreaterThan(extras);
    expect(success).toBeGreaterThan(verify);
  });

  it("treats drizzle DDL errors as fatal even when db:push exits zero", () => {
    const source = readFileSync("scripts/init-test-db.mjs", "utf8");

    expect(source).toContain('import { spawnSync } from "node:child_process"');
    expect(source).toContain("options.rejectOutput?.find");
    expect(source).toContain("/(?:^|\\r?\\n)Error:/m");
    expect(source).toContain("/\\bER_[A-Z0-9_]+\\b/");
  });

  it("applies the complete immutable month-close trigger contract after db:push", () => {
    const runner = readFileSync(
      "scripts/ci-apply-extra-migrations.mjs",
      "utf8",
    );
    const sql = readFileSync(
      "drizzle/migrations/extras/0192_0197_month_close_triggers.sql",
      "utf8",
    );
    expect(runner).toContain(
      '"drizzle/migrations/extras/0192_0197_month_close_triggers.sql"',
    );
    const required = [
      "trg_period_predecessor_bi",
      "trg_period_predecessor_bu",
      "trg_year_supersedes_bi",
      "trg_year_supersedes_bu",
      "trg_mcc_supersedes_bi",
      "trg_mcc_supersedes_bu",
      "trg_mcc_no_update",
      "trg_mcc_no_delete",
      "trg_mcce_no_update",
      "trg_mcce_no_delete",
      "trg_mce_no_update",
      "trg_mce_no_delete",
      "trg_year_snapshot_no_update",
      "trg_year_snapshot_no_delete",
      "trg_yerr_guard_update",
      "trg_yerr_no_delete",
      "trg_advrep_alloc_no_update",
      "trg_advrep_alloc_no_delete",
      "trg_accrual_event_no_update",
      "trg_accrual_event_no_delete",
    ];
    for (const trigger of required) {
      expect(sql).toContain(`DROP TRIGGER IF EXISTS \`${trigger}\``);
      expect(sql).toContain(`CREATE TRIGGER \`${trigger}\``);
    }
  });
});
