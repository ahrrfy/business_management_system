import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertLocalEndpoint, assertIsolation, verifySecret } from "./isolated-local-restore.mjs";
import { verifyRecoveryAttachments } from "./lib/recovery-attachments.mjs";

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

test("checks known attachment columns and keeps unresolved references in the count", async () => {
  const columns = [["receipts", "attachmentUrl"], ["receipts", "externalEvidenceReference"]];
  const statements = [];
  const result = await verifyRecoveryAttachments(query => {
    statements.push(query);
    return "3\t1";
  }, columns);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /FROM_BASE64/);
  assert.deepEqual(result, {
    scope: "KNOWN_FILE_REFERENCES_V1", references: 3, inlineVerified: 1, mirroredVerified: 0,
  });
  await assert.rejects(verifyRecoveryAttachments(() => "0\t0", columns, "//host/share"), /LOCAL_ATTACHMENT_MIRROR_REQUIRED/);
});

test("credits only mirrored objects whose bytes match their stored key", async t => {
  const root = await mkdtemp(join(tmpdir(), "erp-attachment-check-"));
  t.after(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("erp-attachment-check-")) {
      throw Error("Unsafe attachment fixture cleanup");
    }
    await rm(root, { recursive: true, force: true });
  });
  const key = bytes => {
    const hash = createHash("sha256").update(bytes).digest("hex");
    return "single/studio/candidate/" + hash.slice(0, 2) + "/" + hash + ".png";
  };
  const good = key("matching bytes");
  const tampered = key("different expected bytes");
  const missing = key("missing bytes");
  for (const object of [good, tampered]) {
    const file = join(root, "objects", ...object.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "matching bytes");
  }
  const grouped = [good + "\t2", tampered + "\t1", missing + "\t1"].join("\n");
  const result = await verifyRecoveryAttachments(query => query.includes("GROUP BY") ? grouped : "5\t1",
    [["productImages", "objectKey"]], root);
  assert.deepEqual(result, {
    scope: "KNOWN_FILE_REFERENCES_V1", references: 5, inlineVerified: 1, mirroredVerified: 2,
  });
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
