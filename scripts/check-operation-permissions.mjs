// Generation is the validation: unresolved gates, duplicate paths and stale catalog fail closed.
import {
  generateOperationPermissions,
  renderOperationPermissionFiles,
} from "./generate-operation-permissions.mjs";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--selftest")) {
  const fixture = mkdtempSync(resolve(tmpdir(), "operation-permissions-test-"));
  const generate = (args = []) =>
    execFileSync(
      process.execPath,
      [
        resolve(root, "scripts/generate-operation-permissions.mjs"),
        "--root",
        fixture,
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  const write = (name, value) => {
    const path = resolve(fixture, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  const routerSource = `import {router,salesReadProcedure,adminProcedure} from "../trpc";\nexport const voucherRouter = router({\n  list: salesReadProcedure.query(({ctx}) => ctx.scopedOwnerId),\n});\nexport const voucherCategoryRouter = router({\n  list: salesReadProcedure.query(() => []),\n});\nexport const digitalCardsRouter = router({\n  pricing: router({\n    get: adminProcedure.query(() => []),\n  }),\n});\n`;
  try {
    write(
      "scripts/authz-inventory.mjs",
      readFileSync(resolve(root, "scripts/authz-inventory.mjs"), "utf8"),
    );
    write(
      "shared/atomicPermissions.ts",
      `export const definitions = [{key:"pos.invoice.create"}];`,
    );
    write("shared/atomicPermissionExtensions.ts", ``);
    write(
      "server/trpc.ts",
      `export const salesReadProcedure = branchScopedProcedure;\nexport const branchScopedProcedure = protectedProcedure;`,
    );
    write("server/routers/fixture.ts", routerSource);
    write(
      "server/routers.ts",
      `import {router} from "./trpc";\nimport {voucherRouter as firstRouter,voucherCategoryRouter,digitalCardsRouter} from "./routers/fixture";\nexport const appRouter = router({vouchers:firstRouter,voucherCategories: voucherCategoryRouter,digitalCards: digitalCardsRouter});`,
    );
    generate();
    const generatedPath = resolve(
      fixture,
      "shared/operationPermissionCatalog.generated.ts",
    );
    const original = readFileSync(generatedPath, "utf8");
    const readOperations = () => [1, 2].flatMap((part) => readFileSync(resolve(fixture, `shared/operationPermissionCatalog.part${part}.generated.ts`), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("  {"))
      .map((line) => JSON.parse(line.trim().replace(/,$/, ""))));
    const operations = readOperations();
    assert.deepEqual(
      operations.map((e) => e.path),
      ["digitalCards.pricing.get", "voucherCategories.list", "vouchers.list"],
    );
    assert.equal(
      operations[0].delegable,
      false,
      "Admin-only nested operation must remain reserved",
    );
    assert.equal(
      operations[2].supportsRecordScope,
      true,
      "Owner scope requires procedure inheritance and handler consumption",
    );
    assert.equal(
      operations[1].supportsRecordScope,
      false,
      "A scoped procedure alone cannot promise owner filtering",
    );
    generate(["--check"]);
    writeFileSync(generatedPath, original + "// drift\n");
    assert.throws(() => generate(["--check"]), /catalog is stale/);
    writeFileSync(generatedPath, original);
    write(
      "server/routers/fixture.ts",
      routerSource.replace(/salesReadProcedure\.query/g, "newProcedure.query"),
    );
    assert.throws(() => generate(), /lacks gate classification/);
    write(
      "server/routers/fixture.ts",
      routerSource.replace(
        "list: salesReadProcedure.query",
        "untranslatedBusinessAction: salesReadProcedure.query",
      ),
    );
    assert.throws(() => generate(), /Arabic vocabulary/);
    write(
      "server/routers/fixture.ts",
      routerSource.replace(
        "list: salesReadProcedure.query",
        `list: salesReadProcedure.use(requireAtomicPermission("invented.permission.view")).query`,
      ),
    );
    assert.throws(() => generate(), /Undefined legacy atomic alias/);
    write("server/routers/fixture.ts", routerSource);
    write(
      "server/routers.ts",
      `import {router} from "./trpc";\nimport {voucherRouter} from "./routers/fixture";\nexport const appRouter = router({vouchers:voucherRouter,vouchers:voucherRouter});`,
    );
    assert.throws(() => generate(), /Duplicate mounted operation/);
    const rawServiceRouter = `import {router,protectedProcedure,deliveryManagerProcedure} from "../trpc";\nconst auditReadProcedure = protectedProcedure.use(({ctx,next}) => {\n  if (ctx.user.role !== "admin" && ctx.user.role !== "auditor") throw new Error("restricted");\n  return next({ctx});\n});\nexport const auditRouter = router({\n  list: auditReadProcedure.query(() => []),\n  other: auditReadProcedure.query(() => []),\n});\nexport const deliveryRouter = router({\n  cancelAssignment: deliveryManagerProcedure.mutation(() => null),\n});\n`;
    write("server/routers/serviceFixture.ts", rawServiceRouter);
    write(
      "server/routers.ts",
      `import {router} from "./trpc";\nimport {auditRouter,deliveryRouter} from "./routers/serviceFixture";\nexport const appRouter = router({audit:auditRouter,delivery:deliveryRouter});`,
    );
    generate();
    const blocked = readOperations();
    for (const entry of blocked) {
      assert.equal(
        entry.delegable,
        false,
        "Raw local or service role guard must never expose a selectable grant",
      );
      assert.equal(
        entry.reservedKind,
        "UNSUPPORTED",
        "Canonical middleware must distinguish unsupported business operations from fixed identities",
      );
      assert.equal(entry.requiresLegacyReview, true);
    }
    assert.equal(
      blocked.find((e) => e.path === "audit.list").requiresCostVisibility,
      true,
    );
    assert.equal(
      blocked.find((e) => e.path === "audit.list").navigationModule,
      "reports",
    );
    write(
      "server/services/delivery/cancellation.ts",
      `export async function authorize(tx,actor) { await assertOperationAuthorityTx(tx,actor,"delivery.returnConsignment"); }`,
    );
    generate();
    assert.equal(
      readOperations().find((e) => e.path === "delivery.cancelAssignment")
        .delegable,
      false,
      "A helper authorizing another operation is not proof for this key",
    );
    write(
      "server/services/delivery/cancellation.ts",
      `export async function authorize(tx,actor) { await assertOperationAuthorityTx(tx,actor,"delivery.cancelAssignment"); }`,
    );
    write(
      "server/routers/serviceFixture.ts",
      rawServiceRouter.replace(
        "if (ctx.user.role",
        "if (!canonicalOperationAllowed(ctx.user,path) && ctx.user.role",
      ),
    );
    generate();
    const supported = readOperations();
    assert.equal(
      supported.find((e) => e.path === "delivery.cancelAssignment").delegable,
      true,
    );
    assert.equal(
      supported.find((e) => e.path === "audit.list").delegable,
      true,
    );
    assert.equal(
      supported.find((e) => e.path === "audit.other").reservedKind,
      "UNSUPPORTED",
      "Reviewed override is exact: no whole-family role bypass",
    );
    // The real inventory exceeds a pipe buffer. Immediate process.exit used to
    // truncate --json on Linux while passing Windows-only catalog validation.
    const bulkCount = 400;
    write("server/routers/bulkFixture.ts", `import {router,salesReadProcedure} from "../trpc";\nexport const bulkRouter = router({\n${Array.from({ length: bulkCount }, (_, index) => `list${index}: salesReadProcedure.query(() => []),`).join("\n")}\n});\n`);
    const bulkOutput = execFileSync(process.execPath, [
      resolve(root, "scripts/authz-inventory.mjs"), "--json", "--root", fixture,
    ], { encoding: "utf8", maxBuffer: 20_000_000 });
    assert.ok(Buffer.byteLength(bulkOutput) > 65_536, "Fixture must exceed the asynchronous pipe buffer");
    assert.equal(JSON.parse(bulkOutput).endpoints.filter((entry) => entry.loc.startsWith("server/routers/bulkFixture.ts:")).length, bulkCount, "Large machine output must arrive completely before the process exits");
    console.log(
      "Operation catalog self-test passed: mounted aliases, multiple exports, nested routers, scopes, admin reservations, drift, unknown gates, Arabic labels, undefined aliases, duplicate paths, unsupported role/service guards, exact reviewed bridges, complete large pipe output.",
    );
  } finally {
    // Delete only the exact temporary directory created above, after checking its resolved parent.
    if (
      resolve(fixture).startsWith(resolve(tmpdir()) + sep) &&
      fixture.includes("operation-permissions-test-")
    )
      rmSync(fixture, { recursive: true, force: true });
  }
  process.exit(0);
}
const entries = generateOperationPermissions();
const companyStoreSettings = entries.filter((entry) => entry.procedure === "storeGlobalAdminProcedure");
assert.equal(companyStoreSettings.length, 25, "Review any change to the fixed company-store administration surface");
assert.ok(companyStoreSettings.every((entry) => !entry.delegable && entry.reservedKind === "AUTHORITY" && entry.authority === "admin"), "Company-store governance must not advertise ineffective operational grants");
assert.ok(entries.some((entry) => entry.path === "storeAdmin.catalog.setStock" && entry.delegable && entry.procedure === "storeFulfillmentManagerProcedure"), "Branch fulfillment remains independently delegable");
if (
  Object.entries(renderOperationPermissionFiles(entries)).some(([name, result]) => {
    const catalog = resolve(root, "shared", name);
    return !existsSync(catalog) || readFileSync(catalog, "utf8") !== result;
  })
) {
  console.error(
    "Operation permission catalog differs from mounted API paths or their guards. Run node scripts/generate-operation-permissions.mjs, review grants, and commit the result.",
  );
  process.exit(1);
}
console.log(
  `Operation permissions: ${entries.length} mounted paths verified; ${entries.filter((e) => e.delegable).length} independently delegable.`,
);
