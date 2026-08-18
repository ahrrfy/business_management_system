import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NGINX_MANAGED_FILES,
  NGINX_MANAGED_LINKS,
  PROJECT_ROOT,
  readInternalProxySecretsFromEnv,
  verifyLiveNginxContract,
} from "./nginx-contract.mjs";
import {
  installNginxContract,
  prepareProxySecretRotation,
  retireProxySecretRotation,
  rollbackProxySecretRotation,
  switchProxySecretRotation,
  verifyLoggerRedactionAppend,
} from "./install-nginx-contract.mjs";
import { verifyNginxReleaseManifest } from "./verify-nginx-abuse-controls.mjs";

const SECRET = "a".repeat(64);
const NEXT_SECRET = "b".repeat(64);
assert.equal(
  NGINX_MANAGED_LINKS.length,
  2,
  "production contract must enable both vhosts",
);

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nginx-contract-test-"));
  const projectRoot = path.join(root, "project");
  const nginxRoot = path.join(root, "nginx");
  const backupRoot = path.join(root, "backups");
  for (const directory of [
    projectRoot,
    path.join(projectRoot, "deploy"),
    nginxRoot,
    path.join(nginxRoot, "conf.d"),
    path.join(nginxRoot, "snippets"),
    path.join(nginxRoot, "sites-available"),
    path.join(nginxRoot, "sites-enabled"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const entry of NGINX_MANAGED_FILES) {
    fs.copyFileSync(
      path.join(PROJECT_ROOT, entry.source),
      path.join(projectRoot, entry.source),
    );
    const live = path.join(nginxRoot, entry.target);
    fs.writeFileSync(live, `old:${entry.target}\n`, "utf8");
  }
  fs.copyFileSync(
    path.join(PROJECT_ROOT, "deploy", "nginx-proxy-secret.conf.example"),
    path.join(projectRoot, "deploy", "nginx-proxy-secret.conf.example"),
  );
  fs.writeFileSync(
    path.join(nginxRoot, "nginx.conf"),
    "events {}\nhttp {}\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(nginxRoot, "sites-enabled", "alroya-erp"),
    "fixture internal vhost\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(nginxRoot, "sites-enabled", "alroya-public"),
    "fixture public vhost\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(nginxRoot, "snippets", "alroya-proxy-secret.conf"),
    `set $alroya_proxy_secret "${SECRET}";\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(projectRoot, ".env"),
    `INTERNAL_PROXY_SECRET=${SECRET}\n`,
    "utf8",
  );
  return { root, projectRoot, nginxRoot, backupRoot };
}

function snapshotLive(fixture) {
  const targets = [
    ...NGINX_MANAGED_FILES.map((entry) =>
      path.join(fixture.nginxRoot, entry.target),
    ),
  ];
  return targets.map((target) => {
    const stat = fs.lstatSync(target);
    return stat.isSymbolicLink()
      ? { target, kind: "link", value: fs.readlinkSync(target) }
      : { target, kind: "file", value: fs.readFileSync(target, "utf8") };
  });
}

function secretPath(fixture) {
  return path.join(fixture.nginxRoot, "snippets", "alroya-proxy-secret.conf");
}

function writeAppSecrets(fixture, current, previous) {
  fs.writeFileSync(
    path.join(fixture.projectRoot, ".env"),
    [
      `INTERNAL_PROXY_SECRET=${current}`,
      ...(previous ? [`INTERNAL_PROXY_SECRET_PREVIOUS=${previous}`] : []),
      "",
    ].join("\n"),
    "utf8",
  );
}

function assertSnapshot(snapshot) {
  for (const entry of snapshot) {
    const stat = fs.lstatSync(entry.target);
    if (entry.kind === "link") {
      assert.equal(stat.isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(entry.target), entry.value);
    } else {
      assert.equal(stat.isFile(), true);
      assert.equal(fs.readFileSync(entry.target, "utf8"), entry.value);
    }
  }
}

function fixtureOptions(fixture, operations) {
  operations.renderedConfig = () => {
    operations.calls.push("nginx-render");
    return [
      `# configuration file ${path.join(fixture.nginxRoot, "nginx.conf")}:`,
      "events {}",
      `# configuration file ${path.join(fixture.nginxRoot, "sites-enabled", "alroya-erp")}:`,
      "server_name srv1548487.hstgr.cloud;",
      "server_name srv1548487.hstgr.cloud;",
      `# configuration file ${path.join(fixture.nginxRoot, "sites-enabled", "alroya-public")}:`,
      "server_name alarabiya.online www.alarabiya.online;",
      "server_name alarabiya.online www.alarabiya.online;",
    ].join("\n");
  };
  return {
    projectRoot: fixture.projectRoot,
    nginxRoot: fixture.nginxRoot,
    appEnvPath: path.join(fixture.projectRoot, ".env"),
    backupRoot: fixture.backupRoot,
    tlsDependencies: [],
    strictOwnership: false,
    strictMode: false,
    requireRoot: false,
    managedLinks: [],
    operations,
  };
}

function makeOperations(fault = null) {
  const calls = [];
  let originSecrets = new Set([SECRET]);
  let fired = false;
  const maybeFail = (phase) => {
    calls.push(phase);
    if (!fired && fault === phase) {
      fired = true;
      throw new Error(`injected-${phase}`);
    }
  };
  return {
    calls,
    staticCheck: () => maybeFail("static"),
    rename: (source, destination, phase) => {
      maybeFail(phase);
      fs.renameSync(source, destination);
    },
    nginxTest: () => maybeFail("nginx-test"),
    reload: () => maybeFail("reload"),
    smoke: () => maybeFail("smoke"),
    rollbackSmoke: () => maybeFail("rollback-smoke"),
    loggerRedactionGate: () => maybeFail("logger-redaction-gate"),
    setOriginSecrets: (...secrets) => {
      originSecrets = new Set(secrets);
    },
    originProbe: (policy) => {
      const statuses = policy.secrets.map((secret) =>
        Array.from({ length: policy.workers }, () =>
          originSecrets.has(secret) ? 200 : 403,
        ),
      );
      maybeFail(
        statuses.flat().includes(403)
          ? "origin-steady-canary"
          : "origin-dual-canary",
      );
      return { results: statuses };
    },
  };
}

function syncOriginWithApp(operations, fixture) {
  const app = readInternalProxySecretsFromEnv(
    path.join(fixture.projectRoot, ".env"),
  );
  operations.setOriginSecrets(app.current, app.previous);
}

function finishRollback(options, operations, fixture) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    syncOriginWithApp(operations, fixture);
    const result = rollbackProxySecretRotation(options);
    if (result.state === "rolled-back") return result;
  }
  assert.fail("rollback did not reach a terminal state");
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeFixtureReleaseManifest(fixture) {
  const files = Object.fromEntries(
    [
      ...NGINX_MANAGED_FILES.map((entry) => entry.source),
      "deploy/nginx-proxy-secret.conf.example",
    ].map((relative) => [
      relative,
      sha256(path.join(fixture.projectRoot, relative)),
    ]),
  );
  const manifest = path.join(
    fixture.projectRoot,
    "deploy",
    "nginx-release-manifest.json",
  );
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({ version: 1, files })}\n`,
    "utf8",
  );
  return manifest;
}

function probeLogAppend(appended, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "logger-redaction-gate-"));
  const file = path.join(root, "erp-out.log");
  fs.writeFileSync(file, "baseline\n", "utf8");
  const descriptor = fs.openSync(file, "r");
  const snapshot = fs.fstatSync(descriptor);
  fs.appendFileSync(file, appended, "utf8");
  try {
    return verifyLoggerRedactionAppend({
      file,
      descriptor,
      snapshot,
      marker: options.marker ?? "lrp-test-marker",
      bearer: options.bearer ?? "c".repeat(64),
      secrets: options.secrets ?? [SECRET, NEXT_SECRET],
      timeoutMilliseconds: 0,
    });
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runRollbackFault(fault) {
  const fixture = createFixture();
  try {
    const before = snapshotLive(fixture);
    const operations = makeOperations(fault);
    assert.throws(
      () => installNginxContract(fixtureOptions(fixture, operations)),
      (error) => error?.code === "NGINX_INSTALL_FAILED_ROLLBACK_OK",
    );
    assertSnapshot(before);
    assert.equal(operations.calls.includes("rollback"), true);
    assert.deepEqual(operations.calls.slice(-3), [
      "nginx-test",
      "reload",
      "rollback-smoke",
    ]);
    assert.equal(fs.readdirSync(fixture.backupRoot).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const operations = makeOperations();
    const result = installNginxContract(fixtureOptions(fixture, operations));
    assert.deepEqual(operations.calls.slice(-3), [
      "nginx-test",
      "reload",
      "smoke",
    ]);
    assert.equal(
      fs.existsSync(path.join(result.backupDirectory, "manifest.json")),
      true,
    );
    const verified = verifyLiveNginxContract({
      projectRoot: fixture.projectRoot,
      nginxRoot: fixture.nginxRoot,
      strictOwnership: false,
      strictMode: false,
      managedLinks: [],
    });
    assert.equal(verified.files, NGINX_MANAGED_FILES.length);
    assert.equal(verified.links, 0);

    // انحدار (١٦/٨/٢٦): تجديد شهادة certbot يغيّر **توقيت مجلّد** اعتماديات TLS وحده بلا
    // مساس بأيّ ملفّ. كان ذلك يُسقط النشر بإنذارٍ كاذب. نحاكيه هنا: مجلّدٌ في قائمة
    // tlsDependencies يُلمَس توقيته ⇒ يجب أن **يبقى النشر ممكناً**.
    const tlsDirectory = path.join(fixture.nginxRoot, "sites-enabled");
    const renewedAt = new Date(Date.now() + 60_000);
    fs.utimesSync(tlsDirectory, renewedAt, renewedAt);
    const afterRenewal = verifyLiveNginxContract({
      projectRoot: fixture.projectRoot,
      nginxRoot: fixture.nginxRoot,
      strictOwnership: false,
      strictMode: false,
      managedLinks: [],
      // مجلّد الاعتماديات = sites-enabled في هذه التجهيزة (يقوم مقام /etc/letsencrypt).
      tlsDependencies: [path.join(tlsDirectory, "fullchain.pem")],
    });
    assert.equal(
      afterRenewal.files,
      NGINX_MANAGED_FILES.length,
      "renewing a TLS dependency directory must not block a legitimate deploy",
    );

    fs.writeFileSync(
      path.join(fixture.nginxRoot, "sites-enabled", "legacy-storefront"),
      "server_name alarabiya.online;\n",
      "utf8",
    );
    assert.throws(
      () =>
        verifyLiveNginxContract({
          projectRoot: fixture.projectRoot,
          nginxRoot: fixture.nginxRoot,
          strictOwnership: false,
          strictMode: false,
          managedLinks: [],
        }),
      (error) =>
        error?.code === "NGINX_LIVE_CONTRACT_DRIFT" &&
        error?.details?.includes("NGINX_LIVE_TOPOLOGY_DRIFT"),
      "the unprivileged deploy gate must detect an out-of-band active config change",
    );
    fs.writeFileSync(
      path.join(fixture.projectRoot, ".env"),
      `INTERNAL_PROXY_SECRET=${"b".repeat(64)}\n`,
      "utf8",
    );
    assert.throws(
      () =>
        verifyLiveNginxContract({
          projectRoot: fixture.projectRoot,
          nginxRoot: fixture.nginxRoot,
          strictOwnership: false,
          strictMode: false,
          managedLinks: [],
        }),
      (error) =>
        error?.code === "NGINX_LIVE_CONTRACT_DRIFT" &&
        error?.details?.includes("NGINX_LIVE_SECRET_MISMATCH"),
      "live gate must fail closed before deployment when app and nginx secrets drift",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    installNginxContract(fixtureOptions(fixture, makeOperations()));
    const secretPath = path.join(
      fixture.nginxRoot,
      "snippets",
      "alroya-proxy-secret.conf",
    );
    const before = fs.statSync(secretPath);
    fs.writeFileSync(
      secretPath,
      `set $alroya_proxy_secret "${"b".repeat(64)}";\n`,
      "utf8",
    );
    fs.utimesSync(secretPath, before.atime, before.mtime);
    assert.throws(
      () =>
        verifyLiveNginxContract({
          projectRoot: fixture.projectRoot,
          nginxRoot: fixture.nginxRoot,
          strictOwnership: false,
          strictMode: false,
          managedLinks: [],
        }),
      (error) =>
        error?.code === "NGINX_LIVE_CONTRACT_DRIFT" &&
        error?.details?.includes("NGINX_LIVE_SECRET_CONTENT_MISMATCH"),
      "same-size secret tampering with restored mtime must still fail closed",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const before = snapshotLive(fixture);
    const operations = makeOperations();
    const options = fixtureOptions(fixture, operations);
    const renderManaged = operations.renderedConfig;
    operations.renderedConfig = () =>
      `${renderManaged()}\n# configuration file ${path.join(
        fixture.nginxRoot,
        "sites-enabled",
        "legacy-storefront",
      )}:\nserver_name alarabiya.online;\n`;
    assert.throws(
      () => installNginxContract(options),
      (error) => error?.code === "NGINX_INSTALL_FAILED_ROLLBACK_OK",
      "an nginx -T conflict must fail closed even when nginx itself exits successfully",
    );
    assertSnapshot(before);
    assert.equal(
      fs.existsSync(path.join(fixture.backupRoot, "pending.json")),
      false,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const before = snapshotLive(fixture);
    const interruptedOperations = makeOperations();
    let interrupted = false;
    interruptedOperations.afterInstallItem = () => {
      if (interrupted) return;
      interrupted = true;
      const error = new Error("simulated abrupt process termination");
      error.code = "NGINX_INSTALL_SIMULATED_POWER_LOSS";
      throw error;
    };
    assert.throws(
      () =>
        installNginxContract({
          ...fixtureOptions(fixture, interruptedOperations),
          faultInjection: true,
        }),
      (error) => error?.code === "NGINX_INSTALL_SIMULATED_POWER_LOSS",
    );
    assert.equal(
      fs.existsSync(path.join(fixture.backupRoot, "pending.json")),
      true,
      "an abrupt stop must retain a durable recovery journal",
    );

    const recoveryOperations = makeOperations();
    recoveryOperations.staticCheck = () => {
      recoveryOperations.calls.push("static");
      assertSnapshot(before);
    };
    installNginxContract(fixtureOptions(fixture, recoveryOperations));
    assert.ok(
      recoveryOperations.calls.indexOf("rollback") <
        recoveryOperations.calls.indexOf("static"),
      "the next root run must restore the complete prior tree before a new install",
    );
    assert.equal(
      fs.existsSync(path.join(fixture.backupRoot, "pending.json")),
      false,
      "the journal must clear only after recovery and a successful new smoke",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const before = snapshotLive(fixture);
    fs.unlinkSync(
      path.join(fixture.nginxRoot, "snippets", "alroya-proxy-secret.conf"),
    );
    const operations = makeOperations();
    assert.throws(
      () => installNginxContract(fixtureOptions(fixture, operations)),
      (error) => error?.code === "NGINX_INSTALL_SECRET_MISSING",
    );
    assertSnapshot(
      before.filter(
        (entry) => !entry.target.endsWith("alroya-proxy-secret.conf"),
      ),
    );
    assert.deepEqual(operations.calls, []);
    assert.equal(fs.existsSync(fixture.backupRoot), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const fault of ["install", "nginx-test", "reload", "smoke"]) {
  runRollbackFault(fault);
}

{
  const fixture = createFixture();
  try {
    const before = snapshotLive(fixture);
    const operations = makeOperations();
    operations.smoke = () => {
      operations.calls.push("smoke");
      throw new Error("public storefront was already degraded before install");
    };
    operations.rollbackSmoke = () => operations.calls.push("rollback-smoke");

    assert.throws(
      () => installNginxContract(fixtureOptions(fixture, operations)),
      (error) => error?.code === "NGINX_INSTALL_FAILED_ROLLBACK_OK",
      "a failed candidate smoke must not make a successfully restored degraded baseline look like a rollback failure",
    );
    assertSnapshot(before);
    assert.equal(
      fs.existsSync(path.join(fixture.backupRoot, "pending.json")),
      false,
      "the durable journal must clear once the previous baseline is restored and rollback health passes",
    );
    assert.deepEqual(operations.calls.slice(-3), [
      "nginx-test",
      "reload",
      "rollback-smoke",
    ]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const operations = makeOperations("nginx-test");
    const realRename = operations.rename;
    let rollbackFailed = false;
    operations.rename = (source, destination, phase) => {
      if (phase === "rollback" && !rollbackFailed) {
        rollbackFailed = true;
        throw new Error("injected-rollback");
      }
      realRename(source, destination, phase);
    };
    assert.throws(
      () => installNginxContract(fixtureOptions(fixture, operations)),
      (error) => error?.code === "NGINX_INSTALL_FAILED_ROLLBACK_FAILED",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const invalidSecret of ["c".repeat(32), "z".repeat(64)]) {
  const fixture = createFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.nginxRoot, "snippets", "alroya-proxy-secret.conf"),
      `set $alroya_proxy_secret "${invalidSecret}";\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(fixture.projectRoot, ".env"),
      `INTERNAL_PROXY_SECRET=${invalidSecret}\n`,
      "utf8",
    );
    const operations = makeOperations();
    assert.throws(
      () => installNginxContract(fixtureOptions(fixture, operations)),
      (error) => error?.code === "NGINX_INSTALL_SECRET_CONTENT_INVALID",
    );
    assert.deepEqual(operations.calls, []);
    assert.equal(fs.existsSync(fixture.backupRoot), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const fixture = createFixture();
  try {
    for (const directory of [
      fixture.nginxRoot,
      path.join(fixture.nginxRoot, "conf.d"),
      path.join(fixture.nginxRoot, "snippets"),
      path.join(fixture.nginxRoot, "sites-available"),
      path.join(fixture.nginxRoot, "sites-enabled"),
    ]) {
      fs.chmodSync(directory, 0o755);
    }
    fs.chmodSync(
      path.join(fixture.nginxRoot, "snippets", "alroya-proxy-secret.conf"),
      0o600,
    );
    fs.chmodSync(path.join(fixture.nginxRoot, "snippets"), 0o777);
    const operations = makeOperations();
    assert.throws(
      () =>
        installNginxContract({
          ...fixtureOptions(fixture, operations),
          strictMode: true,
        }),
      (error) => error?.code === "NGINX_INSTALL_TARGET_DIRECTORY_WRITABLE",
    );
    assert.deepEqual(operations.calls, []);
    assert.equal(fs.existsSync(fixture.backupRoot), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    writeAppSecrets(fixture, SECRET, NEXT_SECRET);
    assert.deepEqual(
      readInternalProxySecretsFromEnv(path.join(fixture.projectRoot, ".env")),
      {
        current: SECRET,
        previous: NEXT_SECRET,
      },
    );
    assert.doesNotThrow(() =>
      installNginxContract(fixtureOptions(fixture, makeOperations())),
    );

    writeAppSecrets(fixture, NEXT_SECRET, SECRET);
    assert.throws(
      () => installNginxContract(fixtureOptions(fixture, makeOperations())),
      (error) => error?.code === "NGINX_INSTALL_SECRET_MISMATCH",
      "step zero must not accept nginx=old when app current=new, even if previous=old",
    );

    for (const previous of [SECRET, "short", "z".repeat(64)]) {
      writeAppSecrets(fixture, SECRET, previous);
      assert.throws(
        () =>
          readInternalProxySecretsFromEnv(
            path.join(fixture.projectRoot, ".env"),
          ),
        (error) => error?.code === "NGINX_APP_SECRET_INVALID",
      );
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const makeOptions = (operations) => ({
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    });
    assert.equal(
      prepareProxySecretRotation(makeOptions(makeOperations())).state,
      "prepared",
    );
    const switchOperations = makeOperations();
    switchOperations.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.equal(
      switchProxySecretRotation(makeOptions(switchOperations)).state,
      "switched",
    );
    const retireBeforeDeploy = makeOperations();
    retireBeforeDeploy.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.equal(
      retireProxySecretRotation(makeOptions(retireBeforeDeploy)).state,
      "retiring",
    );
    const retireAfterRebootBeforeDeploy = makeOperations();
    retireAfterRebootBeforeDeploy.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.equal(
      retireProxySecretRotation(makeOptions(retireAfterRebootBeforeDeploy))
        .state,
      "retiring",
    );
    const retireAfterDeploy = makeOperations();
    retireAfterDeploy.setOriginSecrets(NEXT_SECRET);
    assert.equal(
      retireProxySecretRotation(makeOptions(retireAfterDeploy)).state,
      "retired",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const makeOptions = (operations) => ({
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    });
    prepareProxySecretRotation(makeOptions(makeOperations()));
    const switching = makeOperations();
    switching.setOriginSecrets(SECRET, NEXT_SECRET);
    switchProxySecretRotation(makeOptions(switching));
    const rollbackPrime = makeOperations();
    rollbackPrime.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.equal(
      rollbackProxySecretRotation(makeOptions(rollbackPrime)).state,
      "rollback-primed",
    );
    const rollbackSwitch = makeOperations();
    rollbackSwitch.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.equal(
      rollbackProxySecretRotation(makeOptions(rollbackSwitch)).state,
      "rolling-back",
    );
    const rollbackAfterDeploy = makeOperations();
    rollbackAfterDeploy.setOriginSecrets(SECRET);
    assert.equal(
      rollbackProxySecretRotation(makeOptions(rollbackAfterDeploy)).state,
      "rolled-back",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const manifestPath = writeFixtureReleaseManifest(fixture);
    assert.deepEqual(verifyNginxReleaseManifest(fixture.projectRoot), []);
    const valid = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const missing = structuredClone(valid);
    delete missing.files[Object.keys(missing.files)[0]];
    fs.writeFileSync(manifestPath, JSON.stringify(missing), "utf8");
    assert.equal(verifyNginxReleaseManifest(fixture.projectRoot).length, 1);
    const extra = structuredClone(valid);
    extra.files["deploy/nginx-extra.conf"] = "a".repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(extra), "utf8");
    assert.equal(verifyNginxReleaseManifest(fixture.projectRoot).length, 1);
    const malformed = structuredClone(valid);
    malformed.files[Object.keys(malformed.files)[0]] = "not-a-hash";
    fs.writeFileSync(manifestPath, JSON.stringify(malformed), "utf8");
    assert.equal(verifyNginxReleaseManifest(fixture.projectRoot).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    fs.mkdirSync(fixture.backupRoot, { mode: 0o700 });
    const target = path.join(fixture.root, "symlink-target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "marker"), "unchanged", "utf8");
    fs.symlinkSync(
      target,
      path.join(fixture.backupRoot, "proxy-secret-rotation-active"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () =>
        prepareProxySecretRotation({
          ...fixtureOptions(fixture, makeOperations()),
          generateSecret: () => NEXT_SECRET,
        }),
      (error) => error?.code === "NGINX_ROTATION_DIRECTORY_INVALID",
    );
    assert.equal(
      fs.readFileSync(path.join(target, "marker"), "utf8"),
      "unchanged",
    );
    assert.deepEqual(fs.readdirSync(target), ["marker"]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const stage = path.join(fixture.projectRoot, ".alroya-.env-rotation-stage");
    const hardlinkSource = path.join(fixture.projectRoot, "preseed-hardlink");
    fs.writeFileSync(hardlinkSource, "attacker-controlled stage\n", "utf8");
    fs.linkSync(hardlinkSource, stage);
    fs.chmodSync(stage, 0o644);
    assert.equal(
      prepareProxySecretRotation({
        ...fixtureOptions(fixture, makeOperations()),
        generateSecret: () => NEXT_SECRET,
      }).state,
      "prepared",
    );
    assert.equal(fs.existsSync(stage), false);
    assert.equal(
      fs.readFileSync(hardlinkSource, "utf8"),
      "attacker-controlled stage\n",
    );
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.join(fixture.projectRoot, ".env")).mode & 0o777,
        0o600,
      );
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const action of [retireProxySecretRotation, rollbackProxySecretRotation]) {
  const fixture = createFixture();
  try {
    writeAppSecrets(fixture, SECRET, NEXT_SECRET);
    assert.throws(
      () => action(fixtureOptions(fixture, makeOperations())),
      (error) =>
        /NGINX_ROTATION_(?:RETIRE|ROLLBACK)_TERMINAL_INVALID/u.test(
          error?.code ?? "",
        ),
    );
    writeAppSecrets(fixture, NEXT_SECRET);
    assert.throws(
      () => action(fixtureOptions(fixture, makeOperations())),
      (error) =>
        /NGINX_ROTATION_(?:RETIRE|ROLLBACK)_TERMINAL_INVALID/u.test(
          error?.code ?? "",
        ),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const operations = makeOperations("nginx-test");
    const options = {
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    };
    prepareProxySecretRotation(options);
    operations.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.throws(
      () => switchProxySecretRotation(options),
      (error) => error?.code === "NGINX_ROTATION_SWITCH_FAILED_ROLLBACK_OK",
    );
    assert.deepEqual(
      readInternalProxySecretsFromEnv(path.join(fixture.projectRoot, ".env")),
      { current: SECRET, previous: NEXT_SECRET },
    );
    assert.equal(
      fs.readFileSync(secretPath(fixture), "utf8").includes(SECRET),
      true,
    );
    assert.equal(switchProxySecretRotation(options).state, "switched");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const rotationDirectory = path.join(
      fixture.backupRoot,
      "proxy-secret-rotation-active",
    );
    fs.mkdirSync(rotationDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(rotationDirectory, "proxy-secret-rotation.pending.json"),
      '{"version":1,"state":"preparing"}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(rotationDirectory, "old-secret.bin"),
      "truncated",
      {
        mode: 0o600,
      },
    );
    fs.writeFileSync(
      path.join(rotationDirectory, "next-secret.bin"),
      "partial",
      {
        mode: 0o600,
      },
    );
    const options = {
      ...fixtureOptions(fixture, makeOperations()),
      generateSecret: () => NEXT_SECRET,
    };
    assert.equal(prepareProxySecretRotation(options).state, "prepared");
    assert.deepEqual(
      readInternalProxySecretsFromEnv(path.join(fixture.projectRoot, ".env")),
      { current: SECRET, previous: NEXT_SECRET },
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const rotationDirectory = path.join(
      fixture.backupRoot,
      "proxy-secret-rotation-active",
    );
    fs.mkdirSync(rotationDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(rotationDirectory, ".proxy-secret-rotation.pending.stage"),
      "{partial",
      { mode: 0o600 },
    );
    assert.equal(
      prepareProxySecretRotation({
        ...fixtureOptions(fixture, makeOperations()),
        generateSecret: () => NEXT_SECRET,
      }).state,
      "prepared",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  assert.deepEqual(
    probeLogAppend(
      '{"url":"/healthz?probe=lrp-test-marker","headers":"[redacted]"}\n',
    ),
    { ok: true },
  );
  for (const leaked of [
    SECRET,
    NEXT_SECRET,
    "c".repeat(64),
    "Bearer [redacted]",
  ]) {
    assert.throws(
      () =>
        probeLogAppend(
          `{"url":"/healthz?probe=lrp-test-marker","leak":"${leaked}"}\n`,
        ),
      (error) => error?.code === "NGINX_ROTATION_LOG_REDACTION_GATE_FAILED",
    );
  }
  for (const incomplete of [
    '{"url":"/healthz?probe=missing"}\n',
    '{"url":"/healthz?probe=lrp-test-marker"}',
  ]) {
    assert.throws(
      () => probeLogAppend(incomplete),
      (error) => error?.code === "NGINX_ROTATION_LOG_REDACTION_GATE_FAILED",
    );
  }
}

{
  const fixture = createFixture();
  try {
    fs.appendFileSync(
      path.join(fixture.projectRoot, ".env"),
      "  export PORT = \"3100\" # production\nWEB_INSTANCES='3'\n",
      "utf8",
    );
    const operations = makeOperations();
    const options = {
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    };
    prepareProxySecretRotation(options);
    operations.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.equal(switchProxySecretRotation(options).state, "switched");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const [definition, code] of [
  ["PORT=abc", "NGINX_ROTATION_PORT_INVALID"],
  ["PORT=3000\nPORT=3001", "NGINX_ROTATION_PORT_INVALID"],
  ["PORT=65536", "NGINX_ROTATION_PORT_INVALID"],
  ["WEB_INSTANCES=abc", "NGINX_ROTATION_WEB_INSTANCES_INVALID"],
  ["WEB_INSTANCES=2\nWEB_INSTANCES=3", "NGINX_ROTATION_WEB_INSTANCES_INVALID"],
  ["WEB_INSTANCES=0", "NGINX_ROTATION_WEB_INSTANCES_INVALID"],
]) {
  const fixture = createFixture();
  try {
    fs.appendFileSync(
      path.join(fixture.projectRoot, ".env"),
      `${definition}\n`,
      "utf8",
    );
    const operations = makeOperations();
    const options = {
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    };
    prepareProxySecretRotation(options);
    operations.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.throws(
      () => switchProxySecretRotation(options),
      (error) => error?.code === code,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const beforeEnv = fs.readFileSync(
      path.join(fixture.projectRoot, ".env"),
      "utf8",
    );
    const beforeNginx = fs.readFileSync(secretPath(fixture), "utf8");
    const options = {
      ...fixtureOptions(fixture, makeOperations("logger-redaction-gate")),
      generateSecret: () => NEXT_SECRET,
    };
    assert.throws(() => prepareProxySecretRotation(options));
    assert.equal(
      fs.readFileSync(path.join(fixture.projectRoot, ".env"), "utf8"),
      beforeEnv,
    );
    assert.equal(fs.readFileSync(secretPath(fixture), "utf8"), beforeNginx);
    assert.equal(
      fs.existsSync(
        path.join(fixture.backupRoot, "proxy-secret-rotation-active"),
      ),
      false,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const operations = makeOperations();
    let gateCalls = 0;
    operations.loggerRedactionGate = () => {
      gateCalls += 1;
      operations.calls.push("logger-redaction-gate");
      if (gateCalls === 2) throw new Error("logger gate failed");
    };
    const options = {
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    };
    prepareProxySecretRotation(options);
    operations.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.throws(() => switchProxySecretRotation(options));
    assert.deepEqual(
      readInternalProxySecretsFromEnv(path.join(fixture.projectRoot, ".env")),
      { current: SECRET, previous: NEXT_SECRET },
    );
    assert.equal(
      fs.readFileSync(secretPath(fixture), "utf8").includes(SECRET),
      true,
    );
    const recoveredOperations = makeOperations();
    recoveredOperations.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.equal(
      switchProxySecretRotation({
        ...fixtureOptions(fixture, recoveredOperations),
        generateSecret: () => NEXT_SECRET,
      }).state,
      "switched",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const operations = makeOperations();
    const original = fs.readFileSync(
      path.join(fixture.projectRoot, "deploy", "nginx-public.conf"),
      "utf8",
    );
    operations.staticCheck = (configuration) => {
      operations.calls.push("static");
      assert.equal(configuration.publicSite, original);
      fs.writeFileSync(
        path.join(fixture.projectRoot, "deploy", "nginx-public.conf"),
        "attacker replacement after staging\n",
        "utf8",
      );
    };
    const options = {
      ...fixtureOptions(fixture, operations),
      requireReleaseManifest: true,
      releaseManifestPath: writeFixtureReleaseManifest(fixture),
    };
    installNginxContract(options);
    assert.equal(
      fs.readFileSync(
        path.join(fixture.nginxRoot, "sites-available", "alroya-public"),
        "utf8",
      ),
      original,
      "the installed bytes must be the staged and verified bytes",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const manifest = writeFixtureReleaseManifest(fixture);
    fs.appendFileSync(
      path.join(fixture.projectRoot, "deploy", "nginx-public.conf"),
      "tampered before staging\n",
      "utf8",
    );
    assert.throws(
      () =>
        installNginxContract({
          ...fixtureOptions(fixture, makeOperations()),
          requireReleaseManifest: true,
          releaseManifestPath: manifest,
        }),
      (error) =>
        error?.code === "NGINX_INSTALL_FAILED_ROLLBACK_OK" &&
        error?.cause?.code === "NGINX_INSTALL_STAGING_FAILED",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const operations = makeOperations();
    const options = {
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
      afterRotationMutation: (point) => operations.calls.push(point),
    };
    const prepared = prepareProxySecretRotation(options);
    assert.equal(prepared.state, "prepared");
    assert.deepEqual(
      readInternalProxySecretsFromEnv(path.join(fixture.projectRoot, ".env")),
      { current: SECRET, previous: NEXT_SECRET },
    );
    assert.equal(
      fs.readFileSync(secretPath(fixture), "utf8").includes(SECRET),
      true,
    );
    assert.equal(
      operations.calls.indexOf("logger-redaction-gate") <
        operations.calls.indexOf("prepare-env"),
      true,
    );

    operations.setOriginSecrets(SECRET, NEXT_SECRET);
    const switchStart = operations.calls.length;
    const switched = switchProxySecretRotation(options);
    assert.equal(switched.state, "switched");
    assert.deepEqual(
      readInternalProxySecretsFromEnv(path.join(fixture.projectRoot, ".env")),
      { current: NEXT_SECRET, previous: SECRET },
    );
    assert.equal(
      fs.readFileSync(secretPath(fixture), "utf8").includes(NEXT_SECRET),
      true,
    );
    assert.equal(operations.calls.includes("origin-dual-canary"), true);
    assert.deepEqual(
      operations.calls
        .slice(switchStart)
        .filter((call) =>
          [
            "logger-redaction-gate",
            "origin-dual-canary",
            "switch-env",
          ].includes(call),
        )
        .slice(0, 3),
      ["logger-redaction-gate", "origin-dual-canary", "switch-env"],
    );

    const retireStart = operations.calls.length;
    const retiring = retireProxySecretRotation(options);
    assert.equal(retiring.state, "retiring");
    assert.deepEqual(
      operations.calls
        .slice(retireStart)
        .filter((call) =>
          ["logger-redaction-gate", "retire-journal"].includes(call),
        )
        .slice(0, 2),
      ["logger-redaction-gate", "retire-journal"],
    );
    assert.deepEqual(
      readInternalProxySecretsFromEnv(path.join(fixture.projectRoot, ".env")),
      { current: NEXT_SECRET },
    );
    assert.equal(retireProxySecretRotation(options).state, "retiring");
    operations.setOriginSecrets(NEXT_SECRET);
    assert.equal(retireProxySecretRotation(options).state, "retired");
    assert.equal(operations.calls.includes("origin-steady-canary"), true);
    assert.equal(
      fs.existsSync(
        path.join(fixture.backupRoot, "proxy-secret-rotation-active"),
      ),
      false,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const rollbackPhase of ["prepared", "switched", "retiring"]) {
  const fixture = createFixture();
  try {
    const operations = makeOperations();
    const options = {
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    };
    prepareProxySecretRotation(options);
    operations.setOriginSecrets(SECRET, NEXT_SECRET);
    if (rollbackPhase !== "prepared") switchProxySecretRotation(options);
    if (rollbackPhase === "retiring") retireProxySecretRotation(options);

    assert.equal(rollbackProxySecretRotation(options).state, "rollback-primed");
    assert.equal(rollbackProxySecretRotation(options).state, "rolling-back");
    assert.deepEqual(
      readInternalProxySecretsFromEnv(path.join(fixture.projectRoot, ".env")),
      { current: SECRET },
    );
    assert.equal(
      fs.readFileSync(secretPath(fixture), "utf8").includes(SECRET),
      true,
    );
    operations.setOriginSecrets(SECRET);
    assert.equal(rollbackProxySecretRotation(options).state, "rolled-back");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const options = {
      ...fixtureOptions(fixture, makeOperations()),
      generateSecret: () => NEXT_SECRET,
    };
    prepareProxySecretRotation(options);
    assert.equal(
      prepareProxySecretRotation(options).state,
      "prepared",
      "prepare must be safely retryable after a process crash",
    );
    const journal = path.join(
      fixture.backupRoot,
      "proxy-secret-rotation-active",
      "proxy-secret-rotation.pending.json",
    );
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
    }
    const serialized = fs.readFileSync(journal, "utf8");
    assert.doesNotMatch(
      serialized,
      new RegExp(`${SECRET}|${NEXT_SECRET}`, "u"),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture();
  try {
    const rotationDirectory = path.join(
      fixture.root,
      "var",
      "lib",
      "alroya-nginx",
      "rotation-active",
    );
    fs.mkdirSync(path.dirname(rotationDirectory), {
      recursive: true,
      mode: 0o700,
    });
    const prepareOperations = makeOperations();
    const prepareOptions = {
      ...fixtureOptions(fixture, prepareOperations),
      rotationDirectory,
      generateSecret: () => NEXT_SECRET,
    };
    assert.equal(prepareProxySecretRotation(prepareOptions).state, "prepared");

    const switchOperations = makeOperations();
    switchOperations.setOriginSecrets(SECRET, NEXT_SECRET);
    const switchOptions = {
      ...fixtureOptions(fixture, switchOperations),
      rotationDirectory,
      generateSecret: () => {
        throw new Error("restart must resume the existing rotation material");
      },
    };
    assert.equal(
      switchProxySecretRotation(switchOptions).state,
      "switched",
      "a process restart must resume from the same persistent rotation path",
    );

    const retireOperations = makeOperations();
    retireOperations.setOriginSecrets(NEXT_SECRET, SECRET);
    const retireOptions = {
      ...fixtureOptions(fixture, retireOperations),
      rotationDirectory,
    };
    assert.equal(retireProxySecretRotation(retireOptions).state, "retiring");
    retireOperations.setOriginSecrets(NEXT_SECRET);
    assert.equal(
      retireProxySecretRotation(retireOptions).state,
      "retired",
      "a reboot-equivalent restart must complete from persistent state",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const crashPoint of [
  "journal-preparing-staged",
  "journal-preparing-renamed",
  "material-old-secret.bin-staged",
  "material-old-secret.bin-renamed",
  "material-next-secret.bin-staged",
  "material-next-secret.bin-renamed",
  "rotation-material",
  "app-env-staged",
  "app-env-renamed",
  "prepare-env",
]) {
  const fixture = createFixture();
  try {
    let fired = false;
    const base = {
      ...fixtureOptions(fixture, makeOperations()),
      generateSecret: () => NEXT_SECRET,
    };
    const crashing = {
      ...base,
      faultInjection: true,
      afterRotationMutation: (point) => {
        if (!fired && point === crashPoint) {
          fired = true;
          throw new Error("SIMULATED_ROTATION_PROCESS_LOSS");
        }
      },
    };
    assert.throws(() => prepareProxySecretRotation(crashing));
    assert.equal(prepareProxySecretRotation(base).state, "prepared");
    assert.deepEqual(
      readInternalProxySecretsFromEnv(path.join(fixture.projectRoot, ".env")),
      { current: SECRET, previous: NEXT_SECRET },
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const crashPoint of [
  "switch-env",
  "nginx-secret-staged",
  "nginx-secret-renamed",
  "switch-nginx",
]) {
  const fixture = createFixture();
  try {
    let fired = false;
    const operations = makeOperations();
    const base = {
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    };
    prepareProxySecretRotation(base);
    operations.setOriginSecrets(SECRET, NEXT_SECRET);
    assert.throws(() =>
      switchProxySecretRotation({
        ...base,
        faultInjection: true,
        afterRotationMutation: (point) => {
          if (!fired && point === crashPoint) {
            fired = true;
            throw new Error("SIMULATED_ROTATION_PROCESS_LOSS");
          }
        },
      }),
    );
    assert.equal(switchProxySecretRotation(base).state, "switched");
    assert.equal(
      fs.readFileSync(secretPath(fixture), "utf8").includes(NEXT_SECRET),
      true,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const crashPoint of [
  "retire-journal",
  "retire-env",
  "cleanup-old-secret.bin",
  "cleanup-next-secret.bin",
  "cleanup-journal",
]) {
  const fixture = createFixture();
  try {
    let fired = false;
    const operations = makeOperations();
    const base = {
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    };
    prepareProxySecretRotation(base);
    operations.setOriginSecrets(SECRET, NEXT_SECRET);
    switchProxySecretRotation(base);
    const crashing = {
      ...base,
      afterRotationMutation: (point) => {
        if (!fired && point === crashPoint) {
          fired = true;
          throw new Error("SIMULATED_ROTATION_PROCESS_LOSS");
        }
      },
    };
    if (crashPoint.startsWith("cleanup-")) {
      assert.equal(retireProxySecretRotation(base).state, "retiring");
      operations.setOriginSecrets(NEXT_SECRET);
    }
    assert.throws(() => retireProxySecretRotation(crashing));
    assert.equal(
      retireProxySecretRotation(base).state,
      crashPoint.startsWith("cleanup-") ? "retired" : "retiring",
    );
    if (!crashPoint.startsWith("cleanup-")) {
      assert.equal(retireProxySecretRotation(base).state, "retiring");
      operations.setOriginSecrets(NEXT_SECRET);
      assert.equal(retireProxySecretRotation(base).state, "retired");
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

for (const crashPoint of [
  "rollback-journal",
  "rollback-prime-env",
  "rollback-nginx",
  "rollback-env",
  "cleanup-old-secret.bin",
  "cleanup-next-secret.bin",
  "cleanup-journal",
]) {
  const fixture = createFixture();
  try {
    let fired = false;
    const operations = makeOperations();
    const base = {
      ...fixtureOptions(fixture, operations),
      generateSecret: () => NEXT_SECRET,
    };
    prepareProxySecretRotation(base);
    operations.setOriginSecrets(SECRET, NEXT_SECRET);
    switchProxySecretRotation(base);
    const crashing = {
      ...base,
      afterRotationMutation: (point) => {
        if (!fired && point === crashPoint) {
          fired = true;
          throw new Error("SIMULATED_ROTATION_PROCESS_LOSS");
        }
      },
    };
    if (["rollback-nginx", "rollback-env"].includes(crashPoint)) {
      assert.equal(rollbackProxySecretRotation(base).state, "rollback-primed");
    } else if (crashPoint.startsWith("cleanup-")) {
      assert.equal(rollbackProxySecretRotation(base).state, "rollback-primed");
      assert.equal(rollbackProxySecretRotation(base).state, "rolling-back");
      operations.setOriginSecrets(SECRET);
    }
    assert.throws(() => rollbackProxySecretRotation(crashing));
    assert.equal(
      finishRollback(base, operations, fixture).state,
      "rolled-back",
    );
    assert.equal(
      fs.readFileSync(secretPath(fixture), "utf8").includes(SECRET),
      true,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const installer = fs.readFileSync(
    path.join(PROJECT_ROOT, "scripts", "install-nginx-contract.mjs"),
    "utf8",
  );
  assert.match(
    installer,
    /NGINX_INSTALL_UNTRUSTED_EXECUTABLE/u,
    "root must refuse an installer executed from the deploy-writable checkout",
  );
  assert.match(
    installer,
    /\/usr\/local\/libexec\/erp\/nginx\/install-nginx-contract\.mjs/u,
  );
  const docs = fs.readFileSync(
    path.join(PROJECT_ROOT, "docs", "deployment-vps.md"),
    "utf8",
  );
  const ci = fs.readFileSync(
    path.join(PROJECT_ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.match(docs, /<RELEASE_NGINX_INSTALLER_SHA256>/u);
  assert.match(docs, /<RELEASE_NGINX_CONTRACT_SHA256>/u);
  assert.match(docs, /<RELEASE_NGINX_VERIFIER_SHA256>/u);
  assert.match(docs, /<RELEASE_NGINX_MANIFEST_SHA256>/u);
  assert.match(
    docs,
    /root:root:444[\s\S]*nginx-release-manifest\.json|nginx-release-manifest\.json[\s\S]*root:root:444/u,
  );
  assert.doesNotMatch(
    docs,
    /sudo\s+"?\$\(command -v node\)"?\s+scripts\/install-nginx-contract/u,
  );
  assert.match(ci, /RELEASE_NGINX_INSTALLER_SHA256/u);
  assert.match(ci, /RELEASE_NGINX_CONTRACT_SHA256/u);
  assert.match(ci, /RELEASE_NGINX_VERIFIER_SHA256/u);
  assert.match(ci, /RELEASE_NGINX_MANIFEST_SHA256/u);
  assert.match(ci, /GITHUB_STEP_SUMMARY/u);
  assert.match(installer, /execFileSync\(\s*"\/usr\/bin\/flock"/u);
  assert.match(
    installer,
    /\/var\/lib\/alroya-nginx\/rotation-active/u,
    "production rotation state must survive a process or host restart",
  );
  assert.doesNotMatch(
    installer,
    /\?\s*"\/run\/erp-nginx-rotation/u,
    "production rotation state must never default to volatile /run storage",
  );
  assert.match(installer, /const TRUSTED_NODE_PATH = "\/usr\/bin\/node"/u);
  assert.match(installer, /"\/usr\/sbin\/nginx"/u);
  assert.match(installer, /"\/usr\/bin\/systemctl"/u);
  assert.doesNotMatch(
    installer,
    /execFileSync\([^)]*scripts\/verify-nginx-abuse-controls/u,
  );
}

if (process.platform === "linux" && fs.existsSync("/usr/bin/flock")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nginx-flock-test-"));
  try {
    const lock = path.join(root, "operation.lock");
    const ready = path.join(root, "ready");
    const holder = spawn(
      "/usr/bin/flock",
      [
        "-n",
        "-x",
        "-E",
        "75",
        lock,
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '1'); setTimeout(() => {}, 600);`,
      ],
      { stdio: "ignore" },
    );
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(ready), true, "lock holder must become ready");
    assert.throws(
      () =>
        execFileSync(
          "/usr/bin/flock",
          ["-n", "-x", "-E", "75", lock, "/usr/bin/true"],
          { stdio: "ignore" },
        ),
      (error) => error?.status === 75,
      "a concurrent operation must fail closed",
    );
    await new Promise((resolve, reject) => {
      holder.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`holder:${code}`)),
      );
      holder.once("error", reject);
    });
    assert.doesNotThrow(() =>
      execFileSync(
        "/usr/bin/flock",
        ["-n", "-x", "-E", "75", lock, "/usr/bin/true"],
        { stdio: "ignore" },
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("nginx atomic contract installer tests: OK");
