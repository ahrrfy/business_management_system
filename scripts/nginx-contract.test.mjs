import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NGINX_MANAGED_FILES,
  NGINX_MANAGED_LINKS,
  PROJECT_ROOT,
  verifyLiveNginxContract,
} from "./nginx-contract.mjs";
import { installNginxContract } from "./install-nginx-contract.mjs";

const SECRET = "a".repeat(64);
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
  };
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
      "smoke",
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

console.log("nginx atomic contract installer tests: OK");
