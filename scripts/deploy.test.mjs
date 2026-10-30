import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

{
  const source = fs.readFileSync(path.join(root, "scripts/deploy.mjs"), "utf8");
  const clientPreparation = source.indexOf("scripts/provision-backup-client.mjs");
  assert.ok(clientPreparation >= 0 && clientPreparation < source.indexOf('["db:backup"]'),
    "deployment must provision the pin-capable client before its safety backup");
}

const {
  cleanupWebCandidate,
  commitWebArtifact,
  defaultWebCandidateOperations,
  hasPendingWebActivation,
  installWebCandidate,
  isWebCandidateActive,
  normalizeWebHealthEnvironment,
  normalizeSentryBuildEnvironment,
  normalizeViteBuildEnvironment,
  normalizeInventoryControlEnvironment,
  prepareWebCandidate,
  pruneWebArtifactSnapshots,
  recoverPendingWebActivation,
  rollbackWebArtifact,
  restoreInventoryWebArtifact,
  snapshotWebArtifact,
  assertRemoteCiGreenForDeploy,
  assertInventoryPrePullReconciliationAllowed,
  reconcileCommittedBridge,
  settleReleasedInventoryBridgeBaseline,
  hasReleasedInventoryBridgeBaseline,
  finalizeReleasedInventoryWebArtifact,
  evaluateDeployCiCheckRuns,
  verifyRollbackWebArtifactCompatibility,
} = await import("./deploy.mjs");
const {
  chunkBudgetViolation,
  EXCEL_CHUNK_NAME,
  resolveViteEnvDir,
  VITE_DISABLE_DOTENV_ENV_KEY,
  VITE_DISABLE_DOTENV_ENV_VALUE,
} = await import("./vite-build-contract.mjs");

{
  assert.equal(typeof normalizeInventoryControlEnvironment, "function",
    "inventory backup credentials require an explicit isolated controller environment helper");
  const flag = "ERP_INVENTORY_CONTROL_USE_BACKUP_CREDENTIALS";
  const controlKey = "ERP_INVENTORY_CONTROL_DATABASE_URL";
  const applicationUrl = "mysql://erp_app:fake-app-password@127.0.0.1:3307/erp";
  const password = "fake-root-%2F /?@:#+&=éء!";
  const base = Object.freeze({ DATABASE_URL: applicationUrl, DB_ROOT_PW: password });
  const processBefore = JSON.stringify(process.env);
  for (const environment of [base, Object.freeze({ ...base, [flag]: "0" }),
    Object.freeze({ ...base, [controlKey]: "mysql://explicit-controller:fake@127.0.0.1:3307/erp" })]) {
    const output = normalizeInventoryControlEnvironment(environment);
    assert.notEqual(output, environment, "default and explicit-control paths must also clone");
    assert.deepEqual(output, environment, "without opt-in, existing credentials and fallback remain unchanged");
  }
  const input = Object.freeze({ ...base, [flag]: "1", DB_NAME: "other", DB_PORT: "9999" });
  const output = normalizeInventoryControlEnvironment(input);
  assert.equal(output.DATABASE_URL, applicationUrl);
  assert.equal(input[controlKey], undefined);
  assert.equal(output[flag], "1");
  const derived = new URL(output[controlKey]);
  assert.equal(derived.username, "root");
  assert.equal(decodeURIComponent(derived.password), password);
  assert.equal(derived.hostname, "127.0.0.1");
  assert.equal(derived.port, "3307");
  assert.equal(derived.pathname, "/erp");
  assert.equal(JSON.stringify(process.env) === processBefore, true,
    "controller credential derivation must not mutate process.env");
  assert.deepEqual(normalizeViteBuildEnvironment(output), {}, "root URL must not reach Vite");
  assert.deepEqual(normalizeSentryBuildEnvironment(output), {}, "root URL must not reach source-map upload");
  assert.deepEqual(normalizeWebHealthEnvironment(output), {
    PORT: "3000", REQUIRE_INTERNAL_PROXY_SECRET: "0",
  }, "root URL must not reach web probes");
  const buildCalls = [];
  defaultWebCandidateOperations(root, output, {
    parentEnvironment: output,
    execFileSync(command, args, options) { buildCalls.push({ command, args, environment: options.env }); },
  }).build(root);
  assert.equal(buildCalls.length, 1);
  for (const key of [flag, controlKey, "DB_ROOT_PW", "DATABASE_URL"]) {
    assert.equal(key in buildCalls[0].environment, false, `the actual build child must exclude ${key}`);
  }
  const policy = (await import("./hr-bridge-runtime-policy.cjs")).default;
  const createBridge = (await import("./hr-bridge-pm2-app.cjs")).default;
  for (const key of [flag, controlKey, "DB_ROOT_PW"]) {
    assert.equal(policy.allowedEnvironmentKeys.includes(key), false);
  }
  assert.throws(() => createBridge({ projectRoot: root, script: "/fake-bridge.cjs", policy,
    deploymentEnvironment: { ...output, NODE_ENV: "production", TZ: "UTC", HR_BRIDGE_LOAD_DOTENV: "0" },
  }), /HR_BRIDGE_PM2_ENVIRONMENT_INVALID/, "controller credentials must be refused by the actual HR app factory");
  for (const bad of ["", "true", "yes", "01", " 1", "1\n", 1, true]) {
    assert.throws(() => normalizeInventoryControlEnvironment({ ...base, [flag]: bad }),
      /INVENTORY_BACKUP_CONTROL_FLAG_INVALID/);
  }
  for (const bad of [undefined, "", " "]) {
    assert.throws(() => normalizeInventoryControlEnvironment({ ...input, DB_ROOT_PW: bad }),
      /INVENTORY_BACKUP_CONTROL_PASSWORD_REQUIRED/);
  }
  assert.throws(() => normalizeInventoryControlEnvironment({ ...input, [controlKey]: "mysql://explicit:fake@127.0.0.1:3307/erp" }),
    /INVENTORY_BACKUP_CONTROL_CONFIGURATION_AMBIGUOUS/);
  assert.throws(() => normalizeInventoryControlEnvironment({ ...input, CONTROL_DATABASE_URL: "mysql://tenant:fake@127.0.0.1/control" }),
    /INVENTORY_MULTI_DATABASE_CLASSIFICATION_REQUIRED/);
  for (const unsafe of [
    "mysql://erp_app:fake@localhost:3307/erp",
    "mysql://erp_app:fake@remote.example:3307/erp",
    "mysql://erp_app:fake@127.1:3307/erp",
    "mysql://erp_app:fake@127.0.0.1:3307/erp?host=remote.example",
    "mysql://erp_app:fake@127.0.0.1:3307/erp?socketPath=/tmp/mysql.sock",
    "mysql://erp_app:fake@127.0.0.1:3307/erp?charset=utf8mb4",
    "mysql://erp_app:fake@127.0.0.1:3307/erp#fragment",
    "mysql://erp_app:fake@127.0.0.1:3307/erp#",
    "mysql://erp_app:fake@127.0.0.1:3307/",
    "mysql://erp_app:fake@127.0.0.1:3307/erp%2Fother",
    "https://erp_app:fake@127.0.0.1:3307/erp",
    "invalid-fake-target",
  ]) {
    assert.throws(() => normalizeInventoryControlEnvironment({ ...input, DATABASE_URL: unsafe }),
      error => error.code === "INVENTORY_BACKUP_CONTROL_TARGET_INVALID" &&
        !error.message.includes(password) && !error.message.includes(unsafe));
  }
  const ipv6 = normalizeInventoryControlEnvironment({ ...input, DATABASE_URL: "mysql://app:fake@[::1]:3307/erp" });
  assert.equal(new URL(ipv6[controlKey]).hostname, "[::1]");
}

{
  assert.equal(
    resolveViteEnvDir(
      { [VITE_DISABLE_DOTENV_ENV_KEY]: VITE_DISABLE_DOTENV_ENV_VALUE },
      "/srv/erp",
    ),
    false,
    "the production candidate must disable Vite dotenv loading",
  );
  assert.equal(
    resolveViteEnvDir({}, "/srv/erp"),
    "/srv/erp",
    "local development must preserve the project dotenv directory",
  );
}

{
  assert.deepEqual(
    normalizeSentryBuildEnvironment({
      SENTRY_AUTH_TOKEN: "secret-build-token",
      SENTRY_ORG: "alroya",
      SENTRY_PROJECT: "storefront-web",
      SENTRY_RELEASE: "release-sha",
      DATABASE_URL: "mysql://must-not-reach-build",
      NODE_OPTIONS: "--require=/tmp/must-not-load.cjs",
      RANDOM_SECRET: "must-not-reach-build",
    }),
    {
      SENTRY_AUTH_TOKEN: "secret-build-token",
      SENTRY_ORG: "alroya",
      SENTRY_PROJECT: "storefront-web",
      SENTRY_RELEASE: "release-sha",
    },
    "the source-map uploader receives only the explicit Sentry build allowlist",
  );
  assert.deepEqual(
    normalizeSentryBuildEnvironment({}),
    {},
    "missing Sentry configuration must not break ordinary builds",
  );
}

{
  const previousDisableDotEnv = process.env[VITE_DISABLE_DOTENV_ENV_KEY];
  process.env[VITE_DISABLE_DOTENV_ENV_KEY] = VITE_DISABLE_DOTENV_ENV_VALUE;
  try {
    const { loadConfigFromFile } = await import("vite");
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      path.join(root, "vite.config.ts"),
      root,
      "silent",
    );
    assert.equal(
      loaded?.config.envDir,
      false,
      "the real Vite config must consume the production dotenv-disable flag",
    );

    const sentryKeys = [
      "VITE_SENTRY_DSN_CLIENT",
      "SENTRY_AUTH_TOKEN",
      "SENTRY_ORG",
      "SENTRY_PROJECT",
      "SENTRY_RELEASE",
    ];
    const previousSentry = Object.fromEntries(
      sentryKeys.map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, {
      VITE_SENTRY_DSN_CLIENT: "https://public@example.invalid/1",
      SENTRY_AUTH_TOKEN: "unit-test-build-token",
      SENTRY_ORG: "unit-test-org",
      SENTRY_PROJECT: "unit-test-project",
      SENTRY_RELEASE: "unit-test-release",
    });
    try {
      const sentryLoaded = await loadConfigFromFile(
        { command: "build", mode: "production" },
        path.join(root, "vite.config.ts"),
        root,
        "silent",
      );
      assert.equal(sentryLoaded?.config.build?.sourcemap, "hidden");
      assert.equal(
        sentryLoaded?.config.define?.["import.meta.env.VITE_SENTRY_RELEASE"],
        JSON.stringify("unit-test-release"),
      );
    } finally {
      for (const key of sentryKeys) {
        if (previousSentry[key] === undefined) delete process.env[key];
        else process.env[key] = previousSentry[key];
      }
    }
  } finally {
    if (previousDisableDotEnv === undefined) {
      delete process.env[VITE_DISABLE_DOTENV_ENV_KEY];
    } else {
      process.env[VITE_DISABLE_DOTENV_ENV_KEY] = previousDisableDotEnv;
    }
  }
}

{
  assert.deepEqual(
    normalizeViteBuildEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "mysql://must-not-reach-vite",
      VITE_PUBLIC_SITE_ORIGIN: "https://alarabiya.online",
      VITE_SENTRY_DSN_CLIENT: "",
      vite_lowercase: "ignored",
    }),
    {
      VITE_PUBLIC_SITE_ORIGIN: "https://alarabiya.online",
      VITE_SENTRY_DSN_CLIENT: "",
    },
    "the web candidate may inherit public VITE_* values only",
  );
}

{
  const calls = [];
  const operations = defaultWebCandidateOperations(
    "/srv/erp",
    {
      VITE_PUBLIC_SITE_ORIGIN: "https://alarabiya.online",
      DATABASE_URL: "mysql://must-not-reach-build-from-explicit-env",
      NODE_OPTIONS: "--require=/tmp/must-not-load-from-explicit-env.cjs",
      PATH: "/tmp/must-not-replace-parent-path",
    },
    {
      parentEnvironment: {
        HOME: "/home/deploy",
        PATH: "/usr/local/bin:/usr/bin",
        DATABASE_URL: "mysql://must-not-reach-build",
        NODE_OPTIONS: "--require=/tmp/must-not-load.cjs",
        SENTRY_AUTH_TOKEN: "secret-build-token",
        SENTRY_ORG: "alroya",
        SENTRY_PROJECT: "storefront-web",
        SENTRY_RELEASE: "release-sha",
      },
      execFileSync: (...args) => calls.push(args),
    },
  );
  operations.build("/srv/erp-candidate");
  const [command, args, options] = calls[0];
  assert.equal(command, "pnpm");
  assert.deepEqual(args, ["build"]);
  assert.equal(options.cwd, "/srv/erp-candidate");
  assert.equal(
    options.env[VITE_DISABLE_DOTENV_ENV_KEY],
    VITE_DISABLE_DOTENV_ENV_VALUE,
  );
  assert.equal(
    options.env.VITE_PUBLIC_SITE_ORIGIN,
    "https://alarabiya.online",
  );
  assert.equal(options.env.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(options.env.SENTRY_AUTH_TOKEN, "secret-build-token");
  assert.equal(options.env.SENTRY_ORG, "alroya");
  assert.equal(options.env.SENTRY_PROJECT, "storefront-web");
  assert.equal(options.env.SENTRY_RELEASE, "release-sha");
  assert.equal(Object.hasOwn(options.env, "DATABASE_URL"), false);
  assert.equal(Object.hasOwn(options.env, "NODE_OPTIONS"), false);
}

{
  const chunk = (name, bytes) => ({
    type: "chunk",
    name,
    fileName: `${name}.js`,
    code: "x".repeat(bytes),
  });
  assert.equal(chunkBudgetViolation({ type: "asset" }), null);
  assert.equal(chunkBudgetViolation(chunk("page", 500_000)), null);
  assert.match(
    chunkBudgetViolation(chunk("page", 500_001)),
    /CHUNK_BUDGET_EXCEEDED page\.js: 500001 > 500000/,
  );
  assert.equal(chunkBudgetViolation(chunk(EXCEL_CHUNK_NAME, 950_000)), null);
  assert.match(
    chunkBudgetViolation(chunk(EXCEL_CHUNK_NAME, 950_001)),
    /CHUNK_BUDGET_EXCEEDED exceljs\.js: 950001 > 950000/,
  );
}

{
  const current = "a".repeat(64);
  const previous = "b".repeat(64);
  assert.deepEqual(
    normalizeWebHealthEnvironment({
      PORT: "3000",
      REQUIRE_INTERNAL_PROXY_SECRET: "1",
      INTERNAL_PROXY_SECRET: current,
      INTERNAL_PROXY_SECRET_PREVIOUS: previous,
    }),
    {
      PORT: "3000",
      REQUIRE_INTERNAL_PROXY_SECRET: "1",
      INTERNAL_PROXY_SECRET: current,
    },
  );
  assert.equal(
    Object.hasOwn(
      normalizeWebHealthEnvironment({
        REQUIRE_INTERNAL_PROXY_SECRET: "1",
        INTERNAL_PROXY_SECRET: current,
        INTERNAL_PROXY_SECRET_PREVIOUS: previous,
      }),
      "INTERNAL_PROXY_SECRET_PREVIOUS",
    ),
    false,
    "the deploy health child must never inherit the previous proxy secret",
  );
  for (const invalidPrevious of [current, "short", "z".repeat(64)]) {
    assert.throws(
      () =>
        normalizeWebHealthEnvironment({
          REQUIRE_INTERNAL_PROXY_SECRET: "1",
          INTERNAL_PROXY_SECRET: current,
          INTERNAL_PROXY_SECRET_PREVIOUS: invalidPrevious,
        }),
      (error) => error?.code === "WEB_HEALTH_PROXY_PREVIOUS_SECRET_INVALID",
    );
  }
}

const ecosystemProbeEnvironment = {
  ...process.env,
  HR_BRIDGE_ECOSYSTEM_ARTIFACT_SMOKE: "1",
  REQUIRE_INTERNAL_PROXY_SECRET: "1",
  INTERNAL_PROXY_SECRET: "a".repeat(64),
};
delete ecosystemProbeEnvironment.INTERNAL_PROXY_SECRET_PREVIOUS;
const ecosystemProbe = spawnSync(
  process.execPath,
  [
    "-e",
    String.raw`
const config = require("./ecosystem.config.cjs");
const web = config.apps.find(({ name }) => name === "erp-server");
process.stdout.write(JSON.stringify({
  webExists: Boolean(web),
  webPrevious: typeof web?.env?.INTERNAL_PROXY_SECRET_PREVIOUS === "string"
    ? web.env.INTERNAL_PROXY_SECRET_PREVIOUS
    : null,
  nonWebAppsWithPrevious: config.apps
    .filter(({ name }) => name !== "erp-server")
    .filter(({ env }) => Object.hasOwn(env ?? {}, "INTERNAL_PROXY_SECRET_PREVIOUS"))
    .map(({ name }) => name),
}));
`,
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: ecosystemProbeEnvironment,
  },
);
assert.equal(
  ecosystemProbe.status,
  0,
  `${ecosystemProbe.stdout}\n${ecosystemProbe.stderr}`,
);
const ecosystemContract = JSON.parse(ecosystemProbe.stdout);
assert.equal(
  ecosystemContract.webExists,
  true,
  "the PM2 web app contract must exist",
);
const stickyPm2EnvironmentAfterDeploy = {
  INTERNAL_PROXY_SECRET_PREVIOUS: "b".repeat(64),
  ...(ecosystemContract.webPrevious === null
    ? {}
    : {
        INTERNAL_PROXY_SECRET_PREVIOUS: ecosystemContract.webPrevious,
      }),
};
assert.equal(
  stickyPm2EnvironmentAfterDeploy.INTERNAL_PROXY_SECRET_PREVIOUS,
  "",
  "deploy --update-env must explicitly clear a previous secret removed from disk",
);
assert.deepEqual(
  ecosystemContract.nonWebAppsWithPrevious,
  [],
  "non-web PM2 apps must not receive the web-only previous proxy secret",
);
const deploySource = fs.readFileSync(
  path.join(root, "scripts/deploy.mjs"),
  "utf8",
);
const ecosystemSource = fs.readFileSync(
  path.join(root, "ecosystem.config.cjs"),
  "utf8",
);
assert.match(
  ecosystemSource,
  /script:\s*"\.runtime\/web-current\/index\.js"/,
  "PM2 must boot the server through the atomically replaceable immutable-release link",
);

const liveContractIndex = deploySource.indexOf(
  'step("0/12 مطابقة عقد Nginx الحي',
);
const dependenciesIndex = deploySource.indexOf('step("1/12 تثبيت الاعتماديات');
const candidateIndex = deploySource.indexOf("prepareWebCandidate(PROJECT_ROOT");
const swapIndex = deploySource.indexOf(
  "installWebCandidate(webArtifact, webCandidate)",
);
const fenceIndex = deploySource.indexOf("await executeInventoryDeployment({");
const inventoryCall = deploySource.slice(fenceIndex, deploySource.indexOf("settleReleasedInventoryBridgeBaseline(releaseTools);", fenceIndex));
assert.match(inventoryCall,
  /environment:\s*normalizeInventoryControlEnvironment\(parsedDeploymentEnvironment\)/,
  "only the actual inventory host invocation may receive the derived controller clone");
assert.equal([...deploySource.matchAll(/\bnormalizeInventoryControlEnvironment\(/g)].length, 2,
  "the credential helper must have exactly one production call site plus its declaration");
assert.match(inventoryCall,
  /ERP_INVENTORY_CONTROL_DATABASE_URL:\s*""[\s\S]*DATABASE_URL:\s*parsedDeploymentEnvironment\.DATABASE_URL/,
  "the actual PM2 candidate receives the application URL and an explicitly empty controller URL");
assert.match(inventoryCall, /filter_env:[\s\S]*"ERP_INVENTORY_CONTROL_USE_BACKUP_CREDENTIALS"/,
  "the actual PM2 candidate must filter the controller-only opt-in from inherited environment");
assert.match(inventoryCall, /ERP_INVENTORY_CONTROL_USE_BACKUP_CREDENTIALS:\s*""/,
  "the actual PM2 candidate must shadow a dotenv-visible opt-in with an empty value");
const controlHelperSource = deploySource.slice(
  deploySource.indexOf("export function normalizeInventoryControlEnvironment"),
  deploySource.indexOf("function readWebHealthEnvironment"),
);
assert.doesNotMatch(controlHelperSource, /console\.|writeFile|process\.env|spawn\(|execFile/,
  "derivation must not write credentials, log them, mutate process.env, or spawn a child");
const smokeIndex = deploySource.indexOf(
  "verify-nginx-storefront-readiness.mjs",
);
const webCommitIndex = deploySource.indexOf("commitWebArtifact(webArtifact)");
const schemaVerifyIndex = deploySource.indexOf('run("pnpm", ["db:verify"]');
const rollbackWebPreflightIndex = deploySource.indexOf(
  "await verifyRollbackWebArtifactCompatibility(",
);
assert.ok(
  liveContractIndex >= 0 && liveContractIndex < dependenciesIndex,
  "live nginx drift must stop deployment before install/build/database steps",
);
assert.ok(
  candidateIndex > dependenciesIndex,
  "web must build in an isolated candidate after locked dependencies exist",
);
assert.ok(
  swapIndex > candidateIndex && fenceIndex > candidateIndex && fenceIndex < swapIndex,
  "candidate swap must run only inside the inventory activation fence",
);
assert.ok(
  rollbackWebPreflightIndex > schemaVerifyIndex &&
    rollbackWebPreflightIndex < swapIndex,
  "the previous web release must pass a real schema/API preflight after migrations and before any live swap",
);
assert.ok(fenceIndex >= 0, "deployment must use the process and database fence");
assert.ok(
  smokeIndex > fenceIndex,
  "external storefront smoke must run after the fenced activation",
);
assert.ok(
  webCommitIndex > fenceIndex && webCommitIndex < smokeIndex,
  "after the fence releases, smoke failure must not resurrect a prior binary",
);
assert.match(deploySource, /if \(inventoryStarted\) throw candidateError;/,
  "the activation state machine exclusively owns safe invalidation/rollback");
assert.match(deploySource, /restoreInventoryWebArtifact\(webArtifact, priorJournal\)/,
  "the inventory rollback callback must restore the manifest's original immutable target");
assert.ok(
  deploySource.indexOf("await recoverPendingWebActivationBeforePull();") <
    deploySource.indexOf(
      "const expectedHead = synchronizeAndMaybeReexec(releaseSyncLock)",
    ),
  "an interrupted web activation must recover before git pull or a new snapshot",
);
assert.ok(
  deploySource.indexOf('step("11/12 تثبيت خط أساس الجسر المفعّل تحت الحاجز"') >
    smokeIndex,
  "external storefront smoke must finish before the deployment is committed",
);
assert.doesNotMatch(deploySource, /activation\.activateBridgeRelease\(/,
  "after inventory release, bridge settlement must never run an old-binary rollback transaction");
assert.match(deploySource, /bridgeBaseline: \{ candidate, prior: committed, candidateSourceCommit: bridge\.sourceCommit \}/);
assert.match(fs.readFileSync(path.join(root, "scripts/lib/inventory-activation-host.mjs"), "utf8"),
  /bridgeBaseline: options\.bridgeBaseline/,
  "the transition proof must be present in the journal before PREPARED is persisted");
assert.ok(deploySource.indexOf("if (hasReleasedInventoryBridgeBaseline())") <
  deploySource.indexOf("assertImmutableBaselineOwnsBridge(current, allRows, dumpRows)"),
  "a released first activation must reach locked reconciliation before legacy adoption checks");
assert.match(deploySource, /if \(finalizeReleasedInventoryWebArtifact\(PROJECT_ROOT\)\) return;/,
  "pre-pull web recovery must finalize a proven released candidate without rolling it back");
assert.match(
  deploySource,
  /verify-nginx-abuse-controls\.mjs/,
  "deployment must run the static nginx contract before mutable steps",
);
assert.match(
  deploySource,
  /sourceRoot: webCandidate\.sourceRoot/,
  "HR bridge release must use the isolated candidate artifact",
);
assert.match(
  deploySource,
  /NGINX_LIVE_CONTRACT_DRIFT/,
  "ordinary deployment must diagnose live nginx drift without attempting sudo",
);
assert.match(
  deploySource,
  /WEB_STOREFRONT_SMOKE_FAILED_ROLLBACK_OK/,
  "smoke failure must have an explicit successful-rollback terminal state",
);
const rollbackPreflightEnvironmentBlock = deploySource.slice(
  deploySource.indexOf("function defaultRollbackPreflightOperations"),
  deploySource.indexOf(
    "export async function verifyRollbackWebArtifactCompatibility",
  ),
);
assert.match(
  rollbackPreflightEnvironmentBlock,
  /\.\.\.controlSubprocessEnvironment\(\)/,
  "the isolated rollback probe must receive only the deployment control allowlist",
);
assert.match(
  rollbackPreflightEnvironmentBlock,
  /\.\.\.forbiddenEnvironment/,
  "dotenv-visible privileged keys must be shadowed with empty values in the probe",
);
assert.doesNotMatch(
  rollbackPreflightEnvironmentBlock,
  /\.\.\.process\.env/,
  "the isolated rollback probe must not inherit privileged or preload environment keys",
);
for (const key of [
  "ERP_INVENTORY_CONTROL_USE_BACKUP_CREDENTIALS",
  "DB_ROOT_PW",
  "DB_CONTAINER",
  "DB_APP_PW",
  "DB_CONTROL_PW",
  "ADMIN_PASSWORD",
]) {
  assert.match(
    deploySource.slice(0, deploySource.indexOf("function codedError")),
    new RegExp(`"${key}"`),
    `rollback probe must fence ${key} before dotenv can populate it`,
  );
}

const selftest = spawnSync(
  process.execPath,
  ["scripts/verify-nginx-storefront-readiness.mjs", "--selftest"],
  {
    cwd: root,
    encoding: "utf8",
  },
);
assert.equal(selftest.status, 0, `${selftest.stdout}\n${selftest.stderr}`);

const artifactRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "web-artifact-rollback-test-"),
);
try {
  fs.mkdirSync(path.join(artifactRoot, "dist/public"), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "dist/index.js"), "previous-server");
  fs.writeFileSync(
    path.join(artifactRoot, "dist/public/index.html"),
    "previous-client",
  );
  const snapshot = snapshotWebArtifact(artifactRoot, {
    id: "web-100-previous",
  });
  const activeTarget = () =>
    path.resolve(
      path.dirname(snapshot.activeLinkPath),
      fs.readlinkSync(snapshot.activeLinkPath),
    );
  assert.equal(fs.lstatSync(snapshot.activeLinkPath).isSymbolicLink(), true);
  assert.equal(activeTarget(), snapshot.previousPath);
  const calls = [];
  const preflightEnvironment = {
    REQUIRE_INTERNAL_PROXY_SECRET: "0",
  };
  const preflightOperations = {
    reservePort: async () => 31_337,
    start: async () => {
      calls.push("preflight-start");
      return { fake: true };
    },
    probe: async (_child, context) => {
      calls.push(`preflight-probe:${context.port}`);
    },
    stop: async () => calls.push("preflight-stop"),
  };
  await verifyRollbackWebArtifactCompatibility(snapshot, preflightEnvironment, {
    operations: preflightOperations,
  });
  assert.deepEqual(calls, [
    "preflight-start",
    "preflight-probe:31337",
    "preflight-stop",
  ]);
  calls.length = 0;
  await assert.rejects(
    () =>
      verifyRollbackWebArtifactCompatibility(snapshot, preflightEnvironment, {
        operations: {
          ...preflightOperations,
          probe: async () => {
            calls.push("preflight-incompatible");
            throw new Error("old server cannot read the final schema");
          },
        },
      }),
    (error) => error?.code === "WEB_ROLLBACK_PREFLIGHT_FAILED",
  );
  assert.deepEqual(calls, [
    "preflight-start",
    "preflight-incompatible",
    "preflight-stop",
  ]);

  calls.length = 0;
  rollbackWebArtifact(snapshot, {
    reload: () => calls.push("reload"),
    health: () => calls.push("health"),
  });

  assert.deepEqual(calls, ["reload", "health"]);
  assert.equal(
    fs.readFileSync(path.join(activeTarget(), "index.js"), "utf8"),
    "previous-server",
  );

  const runtimeFailureSnapshot = snapshotWebArtifact(artifactRoot, {
    id: "web-150-runtime-failure",
  });
  assert.throws(
    () =>
      rollbackWebArtifact(runtimeFailureSnapshot, {
        reload: () => {
          throw new Error("pm2 failed");
        },
        health: () => {
          throw new Error("health must not run");
        },
      }),
    (error) => error?.code === "WEB_ARTIFACT_ROLLBACK_RUNTIME_FAILED",
  );
  assert.equal(
    fs.readFileSync(
      path.join(runtimeFailureSnapshot.previousPath, "index.js"),
      "utf8",
    ),
    "previous-server",
  );

  const swapFailureSnapshot = snapshotWebArtifact(artifactRoot, {
    id: "web-175-swap-failure",
  });
  const beforeSwapFailure = fs.readlinkSync(swapFailureSnapshot.activeLinkPath);
  if (process.platform !== "win32") {
    const realRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (
        path.basename(source).startsWith(".web-current-stage-") &&
        path.resolve(destination) === swapFailureSnapshot.activeLinkPath
      ) {
        throw new Error("atomic link replacement failed");
      }
      return realRename(source, destination);
    };
    try {
      assert.throws(
        () =>
          rollbackWebArtifact(swapFailureSnapshot, {
            reload: () => {},
            health: () => {},
          }),
        (error) => error?.code === "WEB_ARTIFACT_SWAP_FAILED",
      );
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(
      fs.readlinkSync(swapFailureSnapshot.activeLinkPath),
      beforeSwapFailure,
      "failed atomic link replacement must leave the complete prior release active",
    );
  } else {
    rollbackWebArtifact(swapFailureSnapshot, {
      reload: () => {},
      health: () => {},
    });
  }

  for (const id of ["web-200-two", "web-300-three", "web-400-four"]) {
    fs.mkdirSync(path.join(artifactRoot, ".runtime/web-releases", id), {
      recursive: true,
    });
  }
  fs.mkdirSync(
    path.join(
      artifactRoot,
      ".runtime/web-releases",
      ".tmp-web-stale-00000000-0000-0000-0000-000000000000",
    ),
  );
  const retention = pruneWebArtifactSnapshots(artifactRoot, {
    keepRecent: 3,
    protectedIds: [swapFailureSnapshot.id],
  });
  assert.equal(retention.kept, 3);
  assert.equal(retention.removed >= 3, true);
  assert.equal(
    fs.existsSync(swapFailureSnapshot.releaseDirectory),
    true,
    "explicitly protected release must remain available for diagnosis",
  );
} finally {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
}

const candidateRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "web-candidate-isolation-test-"),
);
try {
  fs.mkdirSync(path.join(candidateRoot, "dist/public"), { recursive: true });
  fs.writeFileSync(path.join(candidateRoot, "dist/index.js"), "live-server");
  fs.writeFileSync(
    path.join(candidateRoot, "dist/public/index.html"),
    "live-client",
  );
  const expectedSha = "a".repeat(40);
  const makeOperations = (build) => ({
    createWorktree: (sourceRoot) =>
      fs.mkdirSync(sourceRoot, { recursive: true }),
    linkDependencies: () => {},
    build,
    removeWorktree: (sourceRoot) =>
      fs.rmSync(sourceRoot, { recursive: true, force: true }),
  });

  assert.throws(
    () =>
      prepareWebCandidate(candidateRoot, {
        id: "candidate-build-failure",
        expectedSha,
        operations: makeOperations((sourceRoot) => {
          fs.mkdirSync(path.join(sourceRoot, "dist/public"), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(sourceRoot, "dist/index.js"),
            "partial-candidate",
          );
          throw new Error("injected build failure");
        }),
      }),
    (error) => error?.code === "WEB_CANDIDATE_BUILD_FAILED",
  );
  assert.equal(
    fs.readFileSync(path.join(candidateRoot, "dist/index.js"), "utf8"),
    "live-server",
  );
  assert.equal(
    fs.readFileSync(path.join(candidateRoot, "dist/public/index.html"), "utf8"),
    "live-client",
  );

  const candidate = prepareWebCandidate(candidateRoot, {
    id: "candidate-success",
    expectedSha,
    operations: makeOperations((sourceRoot) => {
      fs.mkdirSync(path.join(sourceRoot, "dist/public"), { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, "dist/index.js"),
        "candidate-server",
      );
      fs.writeFileSync(
        path.join(sourceRoot, "dist/public/index.html"),
        "candidate-client",
      );
    }),
  });
  const snapshot = snapshotWebArtifact(candidateRoot, {
    id: "web-500-candidate-swap",
  });
  installWebCandidate(snapshot, candidate);
  const activeArtifact = () =>
    path.resolve(
      path.dirname(snapshot.activeLinkPath),
      fs.readlinkSync(snapshot.activeLinkPath),
    );
  assert.equal(
    fs.readFileSync(path.join(activeArtifact(), "index.js"), "utf8"),
    "candidate-server",
  );
  assert.equal(
    fs.readFileSync(path.join(candidateRoot, "dist/index.js"), "utf8"),
    "live-server",
    "legacy dist must remain byte-for-byte while the immutable release link changes",
  );
  assert.equal(hasPendingWebActivation(candidateRoot), true);
  const activationJournal = JSON.parse(
    fs.readFileSync(
      path.join(candidateRoot, ".runtime", "web-activation-pending.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    {
      version: activationJournal.version,
      phase: activationJournal.phase,
      id: activationJournal.id,
      previous: activationJournal.previous,
      candidate: activationJournal.candidate,
    },
    {
      version: 1,
      phase: "pending",
      id: snapshot.id,
      previous: path.join("web-releases", snapshot.id, "previous"),
      candidate: path.join("web-releases", snapshot.id, "candidate"),
    },
  );
  commitWebArtifact(snapshot);
  assert.equal(
    hasPendingWebActivation(candidateRoot),
    false,
    "the journal clears only after explicit acceptance",
  );
  rollbackWebArtifact(snapshot, { reload: () => {}, health: () => {} });
  assert.equal(
    fs.readFileSync(path.join(activeArtifact(), "index.js"), "utf8"),
    "live-server",
  );
  cleanupWebCandidate(candidate);

  const crashAfterSwapCandidate = prepareWebCandidate(candidateRoot, {
    id: "candidate-crash-after-swap",
    expectedSha,
    operations: makeOperations((sourceRoot) => {
      fs.mkdirSync(path.join(sourceRoot, "dist/public"), { recursive: true });
      fs.writeFileSync(
        path.join(sourceRoot, "dist/index.js"),
        "unaccepted-server",
      );
      fs.writeFileSync(
        path.join(sourceRoot, "dist/public/index.html"),
        "unaccepted-client",
      );
    }),
  });
  const crashAfterSwapSnapshot = snapshotWebArtifact(candidateRoot, {
    id: "web-550-crash-after-swap",
  });
  installWebCandidate(crashAfterSwapSnapshot, crashAfterSwapCandidate);
  assert.equal(isWebCandidateActive(crashAfterSwapSnapshot), true);
  assert.equal(hasPendingWebActivation(candidateRoot), true);
  const crashRecoveryCalls = [];
  recoverPendingWebActivation(candidateRoot, {
    reload: () => crashRecoveryCalls.push("reload"),
    health: () => crashRecoveryCalls.push("health"),
  });
  assert.deepEqual(crashRecoveryCalls, ["reload", "health"]);
  assert.equal(isWebCandidateActive(crashAfterSwapSnapshot), false);
  assert.equal(hasPendingWebActivation(candidateRoot), false);
  assert.equal(
    fs.readFileSync(
      path.join(
        path.resolve(
          path.dirname(crashAfterSwapSnapshot.activeLinkPath),
          fs.readlinkSync(crashAfterSwapSnapshot.activeLinkPath),
        ),
        "index.js",
      ),
      "utf8",
    ),
    "live-server",
    "startup recovery must reject an unaccepted candidate after abrupt process loss",
  );
  cleanupWebCandidate(crashAfterSwapCandidate);

  if (process.platform !== "win32") {
    const interruptedCandidate = prepareWebCandidate(candidateRoot, {
      id: "candidate-interrupted-switch",
      expectedSha,
      operations: makeOperations((sourceRoot) => {
        fs.mkdirSync(path.join(sourceRoot, "dist/public"), { recursive: true });
        fs.writeFileSync(
          path.join(sourceRoot, "dist/index.js"),
          "complete-next-server",
        );
        fs.writeFileSync(
          path.join(sourceRoot, "dist/public/index.html"),
          "complete-next-client",
        );
      }),
    });
    const interruptedSnapshot = snapshotWebArtifact(candidateRoot, {
      id: "web-600-interrupted-switch",
    });
    const priorLink = fs.readlinkSync(interruptedSnapshot.activeLinkPath);
    const priorTarget = path.resolve(
      path.dirname(interruptedSnapshot.activeLinkPath),
      priorLink,
    );
    const realRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (
        path.basename(source).startsWith(".web-current-stage-") &&
        path.resolve(destination) === interruptedSnapshot.activeLinkPath
      ) {
        throw new Error("injected interruption before atomic link commit");
      }
      return realRename(source, destination);
    };
    try {
      assert.throws(
        () => installWebCandidate(interruptedSnapshot, interruptedCandidate),
        (error) => error?.code === "WEB_CANDIDATE_ATOMIC_SWAP_FAILED",
      );
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(
      fs.readlinkSync(interruptedSnapshot.activeLinkPath),
      priorLink,
    );
    assert.equal(
      fs.readFileSync(path.join(priorTarget, "index.js"), "utf8"),
      "live-server",
      "an interruption before the one atomic rename must leave a complete prior release active",
    );
    assert.equal(
      fs.readFileSync(
        path.join(interruptedSnapshot.candidatePath, "index.js"),
        "utf8",
      ),
      "complete-next-server",
      "the complete candidate remains staged for diagnosis and is never partially live",
    );
    assert.equal(hasPendingWebActivation(candidateRoot), true);
    const recoveryCalls = [];
    const recovered = recoverPendingWebActivation(candidateRoot, {
      reload: () => recoveryCalls.push("reload"),
      health: () => recoveryCalls.push("health"),
    });
    assert.equal(recovered.id, interruptedSnapshot.id);
    assert.deepEqual(recoveryCalls, ["reload", "health"]);
    assert.equal(
      fs.readlinkSync(interruptedSnapshot.activeLinkPath),
      path.relative(
        path.dirname(interruptedSnapshot.activeLinkPath),
        interruptedSnapshot.previousPath,
      ),
      "a second process must restore the previous immutable release from the journal",
    );
    assert.equal(hasPendingWebActivation(candidateRoot), false);
    cleanupWebCandidate(interruptedCandidate);

    const committedThenErroredCandidate = prepareWebCandidate(candidateRoot, {
      id: "candidate-committed-then-errored",
      expectedSha,
      operations: makeOperations((sourceRoot) => {
        fs.mkdirSync(path.join(sourceRoot, "dist/public"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(sourceRoot, "dist/index.js"),
          "committed-next-server",
        );
        fs.writeFileSync(
          path.join(sourceRoot, "dist/public/index.html"),
          "committed-next-client",
        );
      }),
    });
    const committedThenErroredSnapshot = snapshotWebArtifact(candidateRoot, {
      id: "web-700-committed-then-errored",
    });
    const realRenameAfterCommit = fs.renameSync;
    fs.renameSync = (source, destination) => {
      const result = realRenameAfterCommit(source, destination);
      if (
        path.basename(source).startsWith(".web-current-stage-") &&
        path.resolve(destination) ===
          committedThenErroredSnapshot.activeLinkPath
      ) {
        throw new Error("injected I/O report after atomic link commit");
      }
      return result;
    };
    try {
      assert.throws(
        () =>
          installWebCandidate(
            committedThenErroredSnapshot,
            committedThenErroredCandidate,
          ),
        (error) => error?.code === "WEB_CANDIDATE_ATOMIC_SWAP_FAILED",
      );
    } finally {
      fs.renameSync = realRenameAfterCommit;
    }
    assert.equal(
      isWebCandidateActive(committedThenErroredSnapshot),
      true,
      "deployment must recognize a committed link even when a later durability operation reports failure",
    );
    rollbackWebArtifact(committedThenErroredSnapshot, {
      reload: () => {},
      health: () => {},
    });
    cleanupWebCandidate(committedThenErroredCandidate);
  }
} finally {
  fs.rmSync(candidateRoot, { recursive: true, force: true });
}

{
  const greenRuns = [
    { name: "audit", status: "completed", conclusion: "success" },
    { name: "check-test-build", status: "completed", conclusion: "success" },
  ];
  assert.deepEqual(evaluateDeployCiCheckRuns(greenRuns), {
    ok: true,
    code: "OK",
    source: "head",
  });
  assert.deepEqual(
    evaluateDeployCiCheckRuns([
      ...greenRuns,
      { name: "diagnose", status: "completed", conclusion: "failure" },
    ]),
    {
      ok: true,
      code: "OK",
      source: "head",
    },
  );
  assert.equal(
    evaluateDeployCiCheckRuns([
      ...greenRuns,
      { name: "test-shard-1-of-8", status: "in_progress", conclusion: "" },
    ]).code,
    "DEPLOY_CI_NOT_GREEN",
  );
  assert.equal(
    evaluateDeployCiCheckRuns([
      { name: "audit", status: "completed", conclusion: "success" },
      { name: "test-shard-2-of-8", status: "completed", conclusion: "failure" },
    ]).code,
    "DEPLOY_CI_FAILED_ON_HEAD",
  );
  assert.equal(
    evaluateDeployCiCheckRuns([
      ...greenRuns,
      { name: "authz-guard", status: "completed", conclusion: "startup_failure" },
    ]).code,
    "DEPLOY_CI_FAILED_ON_HEAD",
  );
  assert.equal(
    evaluateDeployCiCheckRuns([
      ...greenRuns,
      { name: "authz-guard", status: "completed", conclusion: "stale" },
    ]).code,
    "DEPLOY_CI_FAILED_ON_HEAD",
  );
  assert.equal(
    evaluateDeployCiCheckRuns([
      { name: "audit", status: "completed", conclusion: "success" },
    ]).code,
    "DEPLOY_CI_NOT_GREEN",
  );
  // PR check runs on a feature branch must not satisfy the main deployment gate
  assert.equal(
    evaluateDeployCiCheckRuns([
      {
        name: "audit",
        status: "completed",
        conclusion: "success",
        event: "pull_request",
        head_branch: "fix/branch",
      },
      {
        name: "check-test-build",
        status: "completed",
        conclusion: "success",
        event: "pull_request",
        head_branch: "fix/branch",
      },
    ]).code,
    "DEPLOY_CI_NOT_GREEN",
  );
  // Re-run deduplication: older failed check run superseded by newer successful re-run on main passes
  assert.deepEqual(
    evaluateDeployCiCheckRuns([
      {
        id: 10,
        name: "audit",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "main",
        completed_at: "2026-10-22T10:00:00Z",
      },
      {
        id: 11,
        name: "check-test-build",
        status: "completed",
        conclusion: "failure",
        event: "push",
        head_branch: "main",
        completed_at: "2026-10-22T10:05:00Z",
      },
      {
        id: 12,
        name: "check-test-build",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "main",
        completed_at: "2026-10-22T10:20:00Z",
      },
    ]),
    {
      ok: true,
      code: "OK",
      source: "head",
    },
  );
  // Unmapped check_suite without resolved push+main provenance must fail closed
  assert.equal(
    evaluateDeployCiCheckRuns([
      {
        name: "audit",
        status: "completed",
        conclusion: "success",
        check_suite: { id: 999 },
      },
      {
        name: "check-test-build",
        status: "completed",
        conclusion: "success",
        check_suite: { id: 999 },
      },
    ]).code,
    "DEPLOY_CI_NOT_GREEN",
  );
  // Partial provenance (event without head_branch) must fail closed
  assert.equal(
    evaluateDeployCiCheckRuns([
      {
        name: "audit",
        status: "completed",
        conclusion: "success",
        event: "push",
      },
      {
        name: "check-test-build",
        status: "completed",
        conclusion: "success",
        event: "push",
      },
    ]).code,
    "DEPLOY_CI_NOT_GREEN",
  );
  // Check runs attached to pull_requests must be rejected even if other provenance fields are omitted
  assert.equal(
    evaluateDeployCiCheckRuns([
      {
        name: "audit",
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 1530 }],
      },
      {
        name: "check-test-build",
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 1530 }],
      },
    ]).code,
    "DEPLOY_CI_NOT_GREEN",
  );
  // Third-party GitHub App check runs (check_suite without Actions provenance) must block when failed or pending
  assert.deepEqual(
    evaluateDeployCiCheckRuns([
      {
        name: "audit",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "main",
      },
      {
        name: "check-test-build",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "main",
      },
      {
        id: 201,
        name: "GitGuardian Security Checks",
        app: { slug: "gitguardian" },
        status: "completed",
        conclusion: "failure",
        check_suite: { id: 888 },
      },
    ]),
    {
      ok: false,
      code: "DEPLOY_CI_FAILED_ON_HEAD",
      failedChecks: ["GitGuardian Security Checks"],
    },
  );
  assert.equal(
    evaluateDeployCiCheckRuns([
      {
        name: "audit",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "main",
      },
      {
        name: "check-test-build",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "main",
      },
      {
        id: 202,
        name: "GitGuardian Security Checks",
        app: { slug: "gitguardian" },
        status: "in_progress",
        conclusion: "",
        check_suite: { id: 888 },
      },
    ]).code,
    "DEPLOY_CI_NOT_GREEN",
  );
  // Re-run of third-party check suite supersedes older failure; PR-bound third-party failure does not contaminate main
  assert.deepEqual(
    evaluateDeployCiCheckRuns([
      {
        name: "audit",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "main",
      },
      {
        name: "check-test-build",
        status: "completed",
        conclusion: "success",
        event: "push",
        head_branch: "main",
      },
      {
        id: 203,
        name: "GitGuardian Security Checks",
        app: { slug: "gitguardian" },
        status: "completed",
        conclusion: "failure",
        check_suite: { id: 888 },
        completed_at: "2026-10-22T10:01:00Z",
      },
      {
        id: 204,
        name: "GitGuardian Security Checks",
        app: { slug: "gitguardian" },
        status: "completed",
        conclusion: "success",
        check_suite: { id: 888 },
        completed_at: "2026-10-22T10:06:00Z",
      },
      {
        id: 205,
        name: "GitGuardian Security Checks",
        app: { slug: "gitguardian" },
        status: "completed",
        conclusion: "failure",
        check_suite: { id: 889 },
        pull_requests: [{ number: 1532 }],
      },
    ]),
    {
      ok: true,
      code: "OK",
      source: "head",
    },
  );
  await assert.rejects(
    () =>
      assertRemoteCiGreenForDeploy("deadbeef", {
        env: {},
        fetchRuns: async () => [
          { name: "audit", status: "completed", conclusion: "success" },
        ],
      }),
    (err) => err?.code === "DEPLOY_CI_NOT_GREEN",
  );
}

{
  const { writeActivationJournal } = await import("./lib/inventory-activation-journal.mjs");
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const journalRoot = fs.mkdtempSync(path.join(temporaryRoot, "erp-inventory-prepull-"));
  fs.chmodSync(journalRoot, 0o700);
  const file = path.join(journalRoot, "activation.json");
  const released = () => {
    const journal = {
      version: 1,
      id: "12345678-1234-1234-1234-123456789abc",
      phase: "RELEASED",
      nonce: "a".repeat(64),
      commit: "b".repeat(40),
      database: "erp_prepull_fixture",
      serverUuid: "prepull-fixture-server",
      artifacts: [{
        name: "erp-server",
        script: path.join(journalRoot, "index.js"),
        bundle: path.join(journalRoot, "index.js"),
        hash: "c".repeat(64),
        scriptHash: "c".repeat(64),
        instances: 2,
      }],
    };
    journal.active = {
      readyVersion: 1,
      activationId: journal.id,
      commit: journal.commit,
      projectionCommit: journal.commit,
      database: journal.database,
      serverUuid: journal.serverUuid,
      artifacts: journal.artifacts,
    };
    return journal;
  };
  try {
    assert.equal(assertInventoryPrePullReconciliationAllowed(file), null);
    const journal = released();
    writeActivationJournal(file, journal);
    assert.deepEqual(assertInventoryPrePullReconciliationAllowed(file), journal);
    assert.throws(
      () => assertInventoryPrePullReconciliationAllowed(file, { hasPendingBridgeRecovery: true }),
      /INVENTORY_ACTIVATION_RECOVERY_REQUIRED:RELEASED/,
    );
    for (const phase of ["PREPARED", "LOCKED", "QUIESCENT", "READY", "CANDIDATES", "PRE_RELEASE", "ROLLBACK_READY", "FATAL"]) {
      writeActivationJournal(file, { ...released(), phase });
      assert.throws(() => assertInventoryPrePullReconciliationAllowed(file),
        new RegExp(`INVENTORY_ACTIVATION_RECOVERY_REQUIRED:${phase}`));
    }
    for (const mutate of [
      j => { j.active.commit = "d".repeat(40); },
      j => { j.active.database = "another_database"; },
      j => { j.active.serverUuid = "another_server"; },
      j => { j.active.artifacts = [{ ...j.artifacts[0], hash: "d".repeat(64) }]; },
      j => { delete j.artifacts[0].scriptHash; },
    ]) {
      const invalid = released();
      mutate(invalid);
      writeActivationJournal(file, invalid);
      assert.throws(() => assertInventoryPrePullReconciliationAllowed(file), /INVENTORY_ACTIVE_MANIFEST_INVALID/);
    }
    const { createHash } = await import("node:crypto");
    const bridgeRelease = {
      id: "e".repeat(64),
      mode: "enabled",
      bootstrapPath: path.join(journalRoot, "new-bridge-bootstrap.cjs"),
      artifactPath: path.join(journalRoot, "new-bridge.cjs"),
    };
    fs.writeFileSync(bridgeRelease.bootstrapPath, "approved bootstrap\n");
    fs.writeFileSync(bridgeRelease.artifactPath, "approved bridge\n");
    const bridgeJournal = released();
    bridgeJournal.artifacts.push({
      name: "erp-hr-bridge",
      script: bridgeRelease.bootstrapPath,
      bundle: bridgeRelease.artifactPath,
      scriptHash: createHash("sha256").update(fs.readFileSync(bridgeRelease.bootstrapPath)).digest("hex"),
      hash: createHash("sha256").update(fs.readFileSync(bridgeRelease.artifactPath)).digest("hex"),
      instances: 1,
    });
    const priorId = "f".repeat(64);
    const releaseTools = {
      validateRelease(_root, id) {
        return id === bridgeRelease.id ? bridgeRelease : {
          id,
          mode: "enabled",
          bootstrapPath: path.join(journalRoot, "prior-bootstrap.cjs"),
          artifactPath: path.join(journalRoot, "prior-bridge.cjs"),
        };
      },
    };
    function reconciliationAttempt(descriptor, expected) {
      const operations = [];
      assert.throws(() => reconcileCommittedBridge(descriptor, releaseTools, null, {
        journalFile: file,
        createOperations() {
          operations.push("create");
          throw new Error("FIXTURE_COMPATIBLE_RECONCILIATION");
        },
      }), expected);
      return operations;
    }
    writeActivationJournal(file, bridgeJournal);
    for (const stale of [{ id: priorId, mode: "disabled" }, { id: priorId, mode: "enabled" }, null]) {
      assert.deepEqual(reconciliationAttempt(stale, /INVENTORY_BRIDGE_RECONCILIATION_MISMATCH/), []);
    }
    assert.deepEqual(reconciliationAttempt({ id: bridgeRelease.id, mode: "enabled" },
      /FIXTURE_COMPATIBLE_RECONCILIATION/), ["create"]);
    fs.writeFileSync(bridgeRelease.bootstrapPath, "tampered bootstrap\n");
    assert.deepEqual(reconciliationAttempt({ id: bridgeRelease.id, mode: "enabled" },
      /INVENTORY_BRIDGE_RECONCILIATION_MISMATCH/), []);
    writeActivationJournal(file, released());
    assert.deepEqual(reconciliationAttempt({ id: priorId, mode: "enabled" },
      /INVENTORY_BRIDGE_RECONCILIATION_MISMATCH/), []);
    assert.deepEqual(reconciliationAttempt({ id: priorId, mode: "disabled" },
      /FIXTURE_COMPATIBLE_RECONCILIATION/), ["create"]);
    const rolledBack = { ...released(), phase: "ROLLED_BACK", initialReadyVersion: 0, active: null };
    writeActivationJournal(file, rolledBack);
    assert.deepEqual(assertInventoryPrePullReconciliationAllowed(file), rolledBack);
    assert.deepEqual(assertInventoryPrePullReconciliationAllowed(file, { hasPendingBridgeRecovery: true }), rolledBack);
  } finally {
    const resolved = fs.realpathSync(journalRoot);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith("erp-inventory-prepull-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

{
  const { createHash } = await import("node:crypto");
  const { writeActivationJournal, readActivationJournal, activeInventoryManifest } =
    await import("./lib/inventory-activation-journal.mjs");
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const project = fs.mkdtempSync(path.join(temporaryRoot, "inventory-rollback-retention-"));
  const file = path.join(project, "inventory-activation.json");
  const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  try {
    fs.mkdirSync(path.join(project, "dist/public"), { recursive: true });
    fs.writeFileSync(path.join(project, "dist/index.js"), "legacy-server");
    fs.writeFileSync(path.join(project, "dist/public/index.html"), "legacy-client");
    const makeCandidate = (id, projectRoot = project) => prepareWebCandidate(projectRoot, {
      id,
      expectedSha: "a".repeat(40),
      operations: {
        createWorktree: source => fs.mkdirSync(source, { recursive: true }),
        linkDependencies() {},
        build(source) {
          fs.mkdirSync(path.join(source, "dist/public"), { recursive: true });
          fs.writeFileSync(path.join(source, "dist/index.js"), "activated-server");
          fs.writeFileSync(path.join(source, "dist/public/index.html"), "activated-client");
        },
        removeWorktree: source => fs.rmSync(source, { recursive: true, force: true }),
      },
    });
    const candidate = makeCandidate("candidate-retention");
    const original = snapshotWebArtifact(project, { id: "web-100-original" });
    installWebCandidate(original, candidate);
    commitWebArtifact(original);
    fs.utimesSync(original.releaseDirectory, new Date(1000), new Date(1000));
    const bundle = path.join(original.candidatePath, "index.js");
    const artifact = { name: "erp-server", script: bundle, bundle,
      hash: hash(bundle), scriptHash: hash(bundle), instances: 2 };
    const journal = { version: 1, phase: "RELEASED",
      id: "12345678-1234-1234-1234-123456789abc", nonce: "a".repeat(64),
      commit: "b".repeat(40), database: "erp_retention_fixture", serverUuid: "fixture",
      artifacts: [artifact] };
    journal.active = { readyVersion: 1, activationId: journal.id, commit: journal.commit,
      projectionCommit: journal.commit, database: journal.database,
      serverUuid: journal.serverUuid, artifacts: journal.artifacts };
    writeActivationJournal(file, journal);
    for (let attempt = 0; attempt < 6; attempt++) {
      const snapshot = snapshotWebArtifact(project, { id: `web-${200 + attempt}-failed` });
      fs.utimesSync(snapshot.releaseDirectory, new Date(2000 + attempt), new Date(2000 + attempt));
      pruneWebArtifactSnapshots(project, { keepRecent: 3, protectedIds: [snapshot.id] });
      const prior = readActivationJournal(file);
      const replacement = makeCandidate(`candidate-failed-${attempt}`);
      installWebCandidate(snapshot, replacement);
      // The inventory controller invokes this callback after candidate failure.
      restoreInventoryWebArtifact(snapshot, prior);
      writeActivationJournal(file, { ...journal, phase: "ROLLED_BACK", initialReadyVersion: 1,
        priorArtifacts: journal.artifacts, active: journal.active });
      pruneWebArtifactSnapshots(project, { keepRecent: 3, protectedIds: [snapshot.id] });
      cleanupWebCandidate(replacement);
    }
    assert.equal(fs.existsSync(bundle), true,
      "repeated failed replacements must preserve the original PM2/manifest artifact");
    assert.equal(hash(bundle), artifact.hash);
    assert.deepEqual(activeInventoryManifest(readActivationJournal(file)), journal.active);
    assert.equal(fs.realpathSync(original.activeLinkPath), fs.realpathSync(original.candidatePath));
    assert.equal(fs.readdirSync(original.releasesRoot).length, 3,
      "retention must remain bounded while preserving the original active release");
    assert.equal(fs.existsSync(path.join(original.releasesRoot, "web-200-failed")), false);
    const rejected = snapshotWebArtifact(project, { id: "web-300-invalid-target" });
    const replacement = makeCandidate("candidate-invalid-target");
    installWebCandidate(rejected, replacement);
    const withArtifact = artifact => ({ ...journal, artifacts: [artifact],
      active: { ...journal.active, artifacts: [artifact] } });
    const alias = path.join(original.releasesRoot, "web-symlink");
    fs.symlinkSync(original.releaseDirectory, alias, process.platform === "win32" ? "junction" : "dir");
    for (const invalid of [
      { ...journal, phase: "FATAL" },
      { ...journal, active: { ...journal.active, commit: "c".repeat(40) } },
      withArtifact({ ...artifact, hash: "0".repeat(64) }),
      withArtifact({ ...artifact, scriptHash: "0".repeat(64) }),
      withArtifact({ ...artifact, script: path.join(rejected.candidatePath, "index.js") }),
      withArtifact({ ...artifact, script: path.join(project, "outside/index.js"),
        bundle: path.join(project, "outside/index.js") }),
      withArtifact({ ...artifact, script: path.join(alias, "candidate/index.js"),
        bundle: path.join(alias, "candidate/index.js") }),
    ]) {
      assert.throws(() => restoreInventoryWebArtifact(rejected, invalid),
        /INVENTORY_(WEB_ROLLBACK_TARGET|ACTIVE_MANIFEST)_INVALID/);
      assert.equal(fs.realpathSync(rejected.activeLinkPath), fs.realpathSync(rejected.candidatePath),
        "invalid manifest must not redirect the active link");
      assert.equal(hasPendingWebActivation(project), true,
        "invalid rollback target must retain the recovery journal");
    }
    fs.unlinkSync(alias);
    restoreInventoryWebArtifact(rejected, readActivationJournal(file));
    assert.equal(hasPendingWebActivation(project), false);
    assert.equal(fs.realpathSync(rejected.activeLinkPath), fs.realpathSync(original.candidatePath));
    cleanupWebCandidate(replacement);

    const legacy = path.join(project, "legacy-project");
    fs.mkdirSync(path.join(legacy, "dist/public"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "dist/index.js"), "legacy-server");
    fs.writeFileSync(path.join(legacy, "dist/public/index.html"), "legacy-client");
    for (const [index, prior] of [null,
      { ...journal, phase: "ROLLED_BACK", initialReadyVersion: 0, active: null }].entries()) {
      const snapshot = snapshotWebArtifact(legacy, { id: `web-legacy-${index}` });
      const candidate = makeCandidate(`candidate-legacy-${index}`, legacy);
      installWebCandidate(snapshot, candidate);
      restoreInventoryWebArtifact(snapshot, prior);
      assert.equal(fs.realpathSync(snapshot.activeLinkPath), fs.realpathSync(snapshot.previousPath));
      assert.equal(fs.readFileSync(path.join(snapshot.previousPath, "index.js"), "utf8"), "legacy-server");
      assert.equal(hasPendingWebActivation(legacy), false);
      cleanupWebCandidate(candidate);
    }
    cleanupWebCandidate(candidate);
  } finally {
    const resolved = fs.realpathSync(project);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith("inventory-rollback-retention-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

{
  const { createHash } = await import("node:crypto");
  const { default: releases } = await import("./hr-bridge-release.cjs");
  const { runInventoryActivation } = await import("./lib/inventory-activation-fence.mjs");
  const { writeActivationJournal, readActivationJournal } = await import("./lib/inventory-activation-journal.mjs");
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const fixtureRoot = fs.mkdtempSync(path.join(temporaryRoot, "inventory-bridge-baseline-"));
  const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const descriptor = release => release && ({ id: release.id, mode: release.mode });
  try {
    for (const [index, [oldMode, newMode]] of [
      [null, "enabled"], [null, "disabled"], ["enabled", "enabled"],
      ["enabled", "disabled"], ["disabled", "enabled"], ["disabled", "disabled"],
    ].entries()) {
      const project = path.join(fixtureRoot, String(index));
      fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(project, "dist"));
      for (const name of ["hr-bridge-release-worker.mjs", "hr-bridge-runtime-policy.cjs",
        "hr-bridge-mode.cjs", "hr-bridge-pm2-app.cjs", "hr-bridge-pm2.config.cjs"]) {
        fs.copyFileSync(path.join(root, "scripts", name), path.join(project, "scripts", name));
      }
      const prepare = (mode, contents, sourceCommit) => {
        fs.writeFileSync(path.join(project, "dist/hr-bridge-worker.cjs"), contents);
        return releases.prepareRelease(project, {
          sourceCommit,
          deploymentEnvironment: { NODE_ENV: "production", HR_DEVICE_BRIDGE: mode === "enabled" ? "1" : "0" },
        });
      };
      const priorRelease = oldMode && prepare(oldMode, "old fixture bridge", "a".repeat(40));
      const prior = descriptor(priorRelease) || null;
      if (prior) releases.establishBaseline(project, prior);
      const candidateRelease = prepare(newMode, "new fixture bridge", "b".repeat(40));
      const candidate = descriptor(candidateRelease);
      // Identical bridge content can legitimately be reused for a new web SHA.
      assert.equal(prepare(newMode, "new fixture bridge", "c".repeat(40)).sourceCommit, "b".repeat(40));
      fs.mkdirSync(path.join(project, "dist/public"));
      fs.writeFileSync(path.join(project, "dist/public/index.html"), "old fixture web");
      fs.writeFileSync(path.join(project, "dist/index.js"), "old fixture web");
      const snapshot = snapshotWebArtifact(project, { id: `web-${index}-bridge` });
      const webCandidate = prepareWebCandidate(project, {
        id: `candidate-${index}-bridge`, expectedSha: "c".repeat(40),
        operations: {
          createWorktree(source) { fs.mkdirSync(source); }, linkDependencies() {},
          build(source) {
            fs.mkdirSync(path.join(source, "dist/public"), { recursive: true });
            fs.writeFileSync(path.join(source, "dist/index.js"), "new fixture web");
            fs.writeFileSync(path.join(source, "dist/public/index.html"), "new fixture web");
          },
          removeWorktree(source) { fs.rmSync(source, { recursive: true, force: true }); },
        },
      });
      const web = path.join(snapshot.candidatePath, "index.js");
      const artifacts = (release, bundle, bundleHash = hash(bundle)) => [{ name: "erp-server", script: bundle, bundle,
        hash: bundleHash, scriptHash: bundleHash, instances: 1 }, ...(release?.mode === "enabled" ? [{
        name: "erp-hr-bridge", script: release.bootstrapPath, bundle: release.artifactPath,
        scriptHash: hash(release.bootstrapPath), hash: hash(release.artifactPath), instances: 1,
      }] : [])];
      const journalFile = path.join(project, "inventory-activation.json");
      const options = { projectRoot: project, journalFile };
      const initial = {
        version: 1, id: "12345678-1234-1234-1234-123456789abc", nonce: "a".repeat(64),
        commit: "c".repeat(40), database: "erp_fixture", serverUuid: "fixture-uuid",
        artifacts: artifacts(candidateRelease, web, hash(path.join(webCandidate.distPath, "index.js"))),
        priorArtifacts: artifacts(priorRelease, path.join(snapshot.previousPath, "index.js")),
        bridgeBaseline: { candidate, prior, candidateSourceCommit: candidateRelease.sourceCommit },
      };
      const phases = [];
      const noop = async () => {};
      const operations = {
        preflight: noop, acquireGate: async () => ({ assertLocked: noop, release: noop }),
        stopOld: noop, assertQuiescent: noop, installCandidate: noop, startCandidates: noop,
        verifyCandidates: noop, saveCompatibleRestartDefinitions: noop,
        stopCandidates: noop, restoreArtifact: noop, restartOld: noop,
      };
      const run = (overrides = {}) => runInventoryActivation({
        journal: initial, connectionB: {}, operations: { ...operations, ...overrides },
        activate: noop, invalidate: noop,
        persist: journal => { phases.push(journal.phase); writeActivationJournal(journalFile, journal); },
      });
      await assert.rejects(run({ verifyCandidates: async () => { throw new Error("FIXTURE_PRE_RELEASE"); } }), /FIXTURE_PRE_RELEASE/);
      assert.equal(readActivationJournal(journalFile).phase, "ROLLED_BACK");
      settleReleasedInventoryBridgeBaseline(releases, options);
      assert.deepEqual(releases.readState(project).current, prior, "rollback must retain the prior descriptor");
      await run({ installCandidate: async () => { installWebCandidate(snapshot, webCandidate); } });
      assert.ok(phases.includes("PREPARED"));
      assert.equal(readActivationJournal(journalFile).phase, "RELEASED");
      assert.deepEqual(releases.readState(project).current, prior, "crash before settlement retains old disk state");
      const released = readActivationJournal(journalFile);
      if (newMode === "enabled" || oldMode === "enabled") {
        assert.throws(() => reconcileCommittedBridge(prior, {
          ...releases, validateRelease(_root, id) { return releases.validateRelease(project, id); },
        }, null, { journalFile, createOperations() { throw new Error("UNSAFE_PM2_OPERATION"); } }),
        /INVENTORY_BRIDGE_RECONCILIATION_MISMATCH/,
        "reproduce the released-manifest/old-baseline failure before recovery repairs it");
      }
      for (const phase of ["PREPARED", "PRE_RELEASE", "FATAL"]) {
        writeActivationJournal(journalFile, { ...released, phase });
        assert.throws(() => settleReleasedInventoryBridgeBaseline(releases, options), /INVENTORY_ACTIVATION_RECOVERY_REQUIRED/);
        assert.throws(() => finalizeReleasedInventoryWebArtifact(project, options), /INVENTORY_ACTIVATION_RECOVERY_REQUIRED/);
        assert.equal(hasPendingWebActivation(project), true);
        assert.deepEqual(releases.readState(project).current, prior);
      }
      for (const mutate of [
        journal => { journal.bridgeBaseline.candidateSourceCommit = "d".repeat(40); },
        journal => { journal.active.serverUuid = "wrong-server"; },
        journal => { journal.bridgeBaseline.prior = { id: "f".repeat(64), mode: "disabled" }; },
        journal => { journal.bridgeBaseline.candidate.mode = newMode === "enabled" ? "disabled" : "enabled"; },
      ]) {
        const bad = structuredClone(released);
        mutate(bad);
        writeActivationJournal(journalFile, bad);
        assert.throws(() => settleReleasedInventoryBridgeBaseline(releases, options));
        assert.deepEqual(releases.readState(project).current, prior);
      }
      writeActivationJournal(journalFile, released);
      // Follow the actual pre-pull order: pending web finalization, baseline
      // classification (including null prior), then locked descriptor settlement.
      const mismatchedWeb = structuredClone(released);
      mismatchedWeb.artifacts[0].hash = "f".repeat(64);
      mismatchedWeb.active.artifacts[0].hash = "f".repeat(64);
      writeActivationJournal(journalFile, mismatchedWeb);
      assert.throws(() => finalizeReleasedInventoryWebArtifact(project, options), /INVENTORY_WEB_RELEASE_RECONCILIATION_MISMATCH/);
      assert.equal(hasPendingWebActivation(project), true);
      writeActivationJournal(journalFile, released);
      assert.equal(finalizeReleasedInventoryWebArtifact(project, options), true);
      assert.equal(hasPendingWebActivation(project), false);
      assert.equal(hasReleasedInventoryBridgeBaseline(journalFile), true);
      assert.throws(() => settleReleasedInventoryBridgeBaseline({ ...releases,
        commitInventoryBaseline() { throw new Error("FIXTURE_BEFORE_CAS"); },
      }, options), /FIXTURE_BEFORE_CAS/);
      assert.deepEqual(releases.readState(project).current, prior);
      assert.throws(() => settleReleasedInventoryBridgeBaseline({ ...releases,
        commitInventoryBaseline(...args) {
          releases.commitInventoryBaseline(...args);
          throw new Error("FIXTURE_AFTER_CAS");
        },
      }, options), /FIXTURE_AFTER_CAS/);
      const committed = releases.readState(project);
      assert.deepEqual(committed.current, candidate);
      assert.deepEqual(committed.previous, prior);
      assert.equal(committed.pending, null);
      assert.throws(() => reconcileCommittedBridge(committed.current, {
        ...releases, validateRelease(_root, id) { return releases.validateRelease(project, id); },
      }, null, { journalFile, createOperations() { throw new Error("FIXTURE_COMPATIBLE_RECONCILIATION"); } }),
      /FIXTURE_COMPATIBLE_RECONCILIATION/, "retry must pass the unchanged strict artifact guard");
      for (const failure of ["internal health", "external smoke", "control request repair"]) {
        assert.throws(() => {
          settleReleasedInventoryBridgeBaseline(releases, options);
          throw new Error(failure);
        }, new RegExp(failure));
        assert.deepEqual(settleReleasedInventoryBridgeBaseline(releases, options), candidate);
        assert.equal(releases.readState(project).generation, committed.generation, "retry must not rewrite or roll back baseline");
      }
      const pending = releases.beginActivation(project, candidate);
      assert.throws(() => settleReleasedInventoryBridgeBaseline(releases, options), /INVENTORY_BRIDGE_RECONCILIATION_MISMATCH/);
      releases.abortActivation(project, pending.txId);
      const unrelated = descriptor(prepare("disabled", "unrelated fixture", "e".repeat(40)));
      releases.commitInventoryBaseline(project, unrelated, candidate);
      assert.throws(() => settleReleasedInventoryBridgeBaseline(releases, options), /INVENTORY_BRIDGE_RECONCILIATION_MISMATCH/);
      assert.deepEqual(releases.readState(project).current, unrelated);
      cleanupWebCandidate(webCandidate);
    }
  } finally {
    const resolved = fs.realpathSync(fixtureRoot);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith("inventory-bridge-baseline-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

console.log("deployment storefront-readiness contract test: OK");
