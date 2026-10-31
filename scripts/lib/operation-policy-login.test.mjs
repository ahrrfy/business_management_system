import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
const ROOT = resolve(import.meta.dirname, "../..");
const TEMP_PREFIX = "operation-policy-login-";
const RETIRED_KEY = "operation.payroll.advanceThresholds";
const FIXTURE_STATE = `__operationPolicyLogin_${randomUUID().replaceAll("-", "")}`;
const contextFile = resolve(ROOT, "server/context.ts");
let fixtureDir, api;
before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const outfile = join(fixtureDir, "fixture.mjs");
  const virtualModules = {
    session: `export async function getSessionContext() { const state = globalThis[${JSON.stringify(FIXTURE_STATE)}]; return { user: structuredClone(state.user), sessionId: 7001, nativeClientId: null }; }`,
    role: `export async function loadActiveCustomRole(id) { const role = globalThis[${JSON.stringify(FIXTURE_STATE)}].role; return role?.id === id ? structuredClone(role) : null; }`,
    platform:
      "export async function getPlatformAdminFromRequest() { return null; }",
  };
  const replacements = {
    "./auth/session": "session",
    "./services/roleService": "role",
    "./tenancy/platformAuth": "platform",
  };
  await build({
    absWorkingDir: ROOT,
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    stdin: {
      loader: "ts",
      resolveDir: ROOT,
      contents: `export { createContext } from "./server/context.ts";
        export { operationDecision } from "./shared/operationPermissions.ts";
        export { ROLE_TEMPLATES } from "./shared/permissions.ts";`,
    },
    plugins: [
      {
        name: "operation-policy-login-fixtures",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (resolve(args.importer) !== contextFile) return;
            const replacement = replacements[args.path];
            return replacement
              ? { path: replacement, namespace: "fixture" }
              : undefined;
          });
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: virtualModules[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  api = await import(`${pathToFileURL(outfile).href}?fixture=${randomUUID()}`);
});
after(async () => {
  delete globalThis[FIXTURE_STATE];
  const target = resolve(fixtureDir);
  const unsafe =
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith(TEMP_PREFIX);
  if (unsafe) throw new Error(`Refusing unsafe fixture cleanup: ${target}`);
  await rm(target, { recursive: true, force: true });
});
function policy(removedGrant, returnsGrant = false) {
  const hasRemoved = removedGrant !== undefined;
  return {
    version: 1,
    grants: {
      "operation.sales.create": true,
      "operation.sales.list": true,
      "operation.returns.create": returnsGrant,
      ...(hasRemoved ? { [RETIRED_KEY]: removedGrant } : {}),
    },
    recordScopes: {
      "operation.sales.list": "BRANCH",
      ...(hasRemoved ? { [RETIRED_KEY]: "BRANCH" } : {}),
    },
    dataVisibility: { purchaseCost: false, profitMargin: false },
  };
}
function scenarios(removedGrant, unknown = false) {
  const active = policy(removedGrant);
  if (unknown) active.grants["operation.unrelated.unknown"] = true;
  const user = (customRoleId, operationPolicy) => ({
    id: 41,
    role: "cashier",
    isOwner: false,
    customRoleId,
    operationPolicy,
  });
  const role = (operationPolicy) => ({
    id: 71,
    key: "retail_cashier",
    label: "Fixture cashier",
    baseRole: "cashier",
    permissions: structuredClone(api.ROLE_TEMPLATES.cashier),
    operationPolicy,
    operationPolicyRevision: 3,
  });
  return [
    [user(71, null), role(active)],
    [user(71, active), role(policy(undefined, true))],
    [user(null, active), null],
  ];
}
async function contextFor([user, role]) {
  const state = { user, role };
  const original = structuredClone(state);
  globalThis[FIXTURE_STATE] = state;
  const context = await api.createContext({ req: { headers: {} }, res: {} });
  assert.deepEqual(state, original, "fixture inputs must remain immutable");
  return context;
}
test("retired policy keys cannot log cashiers out through the real catalog and context", async () => {
  for (const removedGrant of [true, false]) {
    for (const scenario of scenarios(removedGrant)) {
      const context = await contextFor(scenario);
      assert.ok(context.user, "cashier must remain authenticated");
      const decide = (path) => api.operationDecision(context.user, path);
      assert.equal(context.user.role, "cashier");
      assert.equal(context.sessionId, 7001);
      assert.equal(decide("sales.create").allowed, true);
      assert.equal(decide("returns.create").allowed, false);
      assert.equal(decide("sales.list").scope, "BRANCH");
      const retired = decide("payroll.advanceThresholds");
      assert.deepEqual([retired.allowed, retired.source], [false, "unknown"]);
      const resolved = context.user.resolvedOperationPolicy;
      assert.equal(resolved.grants[RETIRED_KEY], undefined);
      assert.equal(resolved.recordScopes[RETIRED_KEY], undefined);
      const visibility = resolved.dataVisibility;
      assert.equal(visibility.purchaseCost, false);
      assert.equal(visibility.profitMargin, false);
    }
  }
});
test("unrelated unknown policy keys still make every cashier path fail closed", async () => {
  for (const scenario of scenarios(true, true)) {
    const context = await contextFor(scenario);
    assert.equal(context.user, null, "unknown key must reject the session");
    assert.equal(context.sessionId, null);
  }
});
