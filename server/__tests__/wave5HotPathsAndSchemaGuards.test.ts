import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeOwnerAuthority,
  resolveCustomRole,
  type AuthUser,
} from "../context";
import { operationDecision } from "@shared/operationPermissions";

describe("Wave 5 — Hot-path authorization memoization, 4-schema drift coverage & composite index DDL", () => {
  it("memoizes built-in role policies across requests while preserving exact operationDecision grants", async () => {
    const makeCashier = (): AuthUser =>
      ({
        id: 101,
        openId: "cashier-101",
        name: "Cashier",
        email: "c@example.com",
        role: "cashier",
        customRoleId: null,
        permissionsOverride: null,
        atomicPermissions: null,
        operationalCaps: null,
        operationPolicy: null,
        isOwner: false,
      }) as unknown as AuthUser;

    const u1 = makeCashier();
    const u2 = makeCashier();
    await resolveCustomRole(u1);
    await resolveCustomRole(u2);

    expect(u1.resolvedOperationPolicy).toBe(u2.resolvedOperationPolicy);
    expect(u1.inheritedOperationPolicy).toBe(u2.inheritedOperationPolicy);

    const firstKey = Object.keys(u1.resolvedOperationPolicy!.grants)[0]!;
    const dec = operationDecision(u1, firstKey);
    expect(typeof dec.allowed).toBe("boolean");
    expect(dec.key).toBe(firstKey);

    const ownerA = normalizeOwnerAuthority({
      ...makeCashier(),
      id: 1,
      isOwner: true,
    });
    const ownerB = normalizeOwnerAuthority({
      ...makeCashier(),
      id: 1,
      isOwner: true,
    });
    expect(ownerA.resolvedOperationPolicy).toBe(ownerB.resolvedOperationPolicy);
  });

  it("verifies zero schema/migration drift across all 4 Drizzle schema files including 0434 composite indexes", () => {
    const root = process.cwd();
    const out = execFileSync(
      process.execPath,
      [path.join(root, "scripts/check-migration-schema-drift.mjs")],
      { cwd: root, encoding: "utf8" },
    );
    expect(out).toContain("374 جدولاً");

    const ddl0434 = fs.readFileSync(
      path.join(
        root,
        "drizzle/migrations/0434_composite_indexes_hot_paths.sql",
      ),
      "utf8",
    );
    expect(ddl0434).toContain("ALGORITHM=INPLACE, LOCK=NONE");
    expect(ddl0434).toContain("idx_online_orders_branch_status_id");
    expect(ddl0434).toContain("idx_wo_branch_status_id");
    expect(ddl0434).toContain("idx_shift_branch_status_type_user");
    expect(ddl0434).toContain("idx_expense_branch_status_date");
    expect(ddl0434).toContain("idx_idem_op_created");
  });

  it("excludes heavy dynamic chunks (exceljs and onnxruntime mjs) from PWA Service Worker precache", () => {
    const viteCfg = fs.readFileSync(
      path.join(process.cwd(), "vite.config.ts"),
      "utf8",
    );
    expect(viteCfg).toContain('"**/exceljs-*.js"');
    expect(viteCfg).toContain('"**/ort*.mjs"');
  });
});
