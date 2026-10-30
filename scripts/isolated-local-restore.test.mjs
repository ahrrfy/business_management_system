import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertLocalEndpoint, assertIsolation, verifySecret } from "./isolated-local-restore.mjs";

test("remote Docker endpoints are rejected", () => {
  for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://host", "https://host", "npipe:////remote-host/pipe/docker_engine", "unix://remote/socket", ""]) assert.throws(() => assertLocalEndpoint(endpoint));
  assertLocalEndpoint("npipe:////./pipe/dockerDesktopLinuxEngine");
  assertLocalEndpoint("unix:///var/run/docker.sock");
});
test("container identity, network, ports and host mounts fail closed", () => {
  const clean = { Name: "/sandbox", Config: { Labels: { "alroya.recovery.token": "nonce" } },
    HostConfig: { NetworkMode: "none", RestartPolicy: { Name: "no" } }, Mounts: [{ Type: "volume" }] };
  assertIsolation(clean, "sandbox", "nonce");
  for (const alter of [c => c.Name = "/erp-mysql", c => c.Config.Labels = {},
    c => c.HostConfig.NetworkMode = "bridge", c => c.HostConfig.Privileged = true,
    c => c.HostConfig.PortBindings = { "3306/tcp": [] }, c => c.HostConfig.Binds = ["/host:/data"],
    c => c.Mounts = [{ Type: "bind" }], c => c.HostConfig.RestartPolicy.Name = "always"]) {
    const changed = structuredClone(clean); alter(changed);
    assert.throws(() => assertIsolation(changed, "sandbox", "nonce"));
  }
});
test("integration key must authenticate stored ciphertext, not just have a valid length", () => {
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update("synthetic credential"), c.final()]);
  const stored = ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
  verifySecret(stored, key.toString("hex"));
  verifySecret(stored, key.toString("base64"));
  assert.throws(() => verifySecret(stored, randomBytes(32).toString("hex")));
  assert.throws(() => verifySecret("v2:bad:bad:bad", key.toString("hex")));
});

test("actual CI aggregation step rejects failure, cancellation and unexpected skip", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /needs: \[scope, test-shards, quality-build, backup-safety\]/);
  const step = workflow.split("- name: Require backup safety on every non-documentation change")[1].split("- name:")[0];
  const script = step.split("run: |")[1].split(/\r?\n/).map(line => line.replace(/^ {10}/, "")).join("\n");
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  for (const [heavy, result, expected] of [["true", "success", 0], ["true", "failure", 1],
    ["true", "cancelled", 1], ["true", "skipped", 1], ["", "", 1], ["false", "skipped", 0]]) {
    const r = spawnSync(bash, ["--noprofile", "--norc", "-c", script],
      { env: { ...process.env, HEAVY: heavy, BACKUP_SAFETY_RESULT: result }, encoding: "utf8" });
    assert.equal(r.status, expected, `heavy=${heavy}; result=${result}`);
  }
});
