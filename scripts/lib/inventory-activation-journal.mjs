import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const JOURNAL_NAME = "erp-inventory-activation.json";
export const CAPABILITY = "inventory-projection-v1-fenced-boot";
const phases = new Set([
  "PREPARED",
  "LOCKED",
  "QUIESCENT",
  "READY",
  "CANDIDATES",
  "PRE_RELEASE",
  "RELEASED",
  "ROLLBACK_READY",
  "ROLLED_BACK",
  "FATAL",
]);
export function readActivationJournal(file) {
  if (!fs.existsSync(file)) return null;
  const st = fs.lstatSync(file);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.size > 65536 ||
    (process.platform !== "win32" && (st.mode & 0o777) !== 0o600)
  )
    throw new Error("INVENTORY_JOURNAL_UNTRUSTED");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    j.version !== 1 ||
    !phases.has(j.phase) ||
    !/^[a-f0-9-]{36}$/.test(j.id) ||
    !/^[a-f0-9]{40}$/.test(j.commit) ||
    !j.database ||
    !j.serverUuid ||
    !Array.isArray(j.artifacts) ||
    !j.artifacts.length ||
    !/^[a-f0-9]{64}$/.test(j.nonce)
  )
    throw new Error("INVENTORY_JOURNAL_INVALID");
  for (const a of j.artifacts)
    if (
      !path.isAbsolute(a.script) ||
      !path.isAbsolute(a.bundle) ||
      !/^[a-f0-9]{64}$/.test(a.hash) ||
      !Number.isSafeInteger(a.instances) ||
      a.instances < 1 ||
      !["erp-server", "erp-hr-bridge"].includes(a.name)
    )
      throw new Error("INVENTORY_JOURNAL_ARTIFACT_INVALID");
  return j;
}
export function writeActivationJournal(file, journal) {
  const dir = path.dirname(file);
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && stat.mode & 0o022)
  )
    throw new Error("INVENTORY_JOURNAL_DIRECTORY_UNTRUSTED");
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(journal)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") {
    const d = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  }
}
// Recovery never guesses whether a lost controller COMMIT succeeded. A retained
// pending/fatal journal requires deliberate operator recovery, not old-binary boot.
export function assertActivationRecoveryAllowed(
  file,
  { allowReleased = false } = {},
) {
  const j = readActivationJournal(file);
  if (
    j &&
    j.phase !== "ROLLED_BACK" &&
    !(allowReleased && j.phase === "RELEASED")
  )
    throw new Error(`INVENTORY_ACTIVATION_RECOVERY_REQUIRED:${j.phase}`);
  activeInventoryManifest(j);
  return j;
}

export function activeInventoryManifest(journal) {
  if (!journal || !["RELEASED", "ROLLED_BACK"].includes(journal.phase))
    return null;
  if (
    journal.phase === "ROLLED_BACK" &&
    journal.initialReadyVersion === 0 &&
    journal.active === null
  )
    return null;
  const a = journal.active;
  const artifacts =
    journal.phase === "RELEASED" ? journal.artifacts : journal.priorArtifacts;
  if (
    !a ||
    a.readyVersion !== 1 ||
    (journal.phase === "ROLLED_BACK" && journal.initialReadyVersion !== 1) ||
    (journal.phase === "RELEASED" &&
      (a.activationId !== journal.id || a.commit !== journal.commit)) ||
    a.database !== journal.database ||
    a.serverUuid !== journal.serverUuid ||
    !/^[a-f0-9-]{36}$/.test(a.activationId) ||
    !/^[a-f0-9]{40}$/.test(a.commit) ||
    !/^[a-f0-9]{40}$/.test(a.projectionCommit) ||
    !Array.isArray(artifacts) ||
    !artifacts.length ||
    JSON.stringify(a.artifacts) !== JSON.stringify(artifacts)
  )
    throw new Error("INVENTORY_ACTIVE_MANIFEST_INVALID");
  const names = new Set();
  for (const artifact of artifacts) {
    if (
      !["erp-server", "erp-hr-bridge"].includes(artifact.name) ||
      names.has(artifact.name) ||
      !path.isAbsolute(artifact.script) ||
      !path.isAbsolute(artifact.bundle) ||
      !/^[a-f0-9]{64}$/.test(artifact.hash) ||
      !/^[a-f0-9]{64}$/.test(artifact.scriptHash) ||
      !Number.isSafeInteger(artifact.instances) ||
      artifact.instances < 1
    )
      throw new Error("INVENTORY_ACTIVE_MANIFEST_INVALID");
    names.add(artifact.name);
  }
  if (!names.has("erp-server"))
    throw new Error("INVENTORY_ACTIVE_MANIFEST_INVALID");
  return a;
}
export function assertInventoryReadinessLifecycle(existing, state) {
  const active = activeInventoryManifest(existing);
  if (
    !state ||
    ![0, 1].includes(Number(state.readyVersion)) ||
    (Number(state.readyVersion) === 1 &&
      (!active || state.activatedCommit !== active.projectionCommit)) ||
    (Number(state.readyVersion) === 0 && active)
  )
    throw new Error("INVENTORY_READINESS_LIFECYCLE_MISMATCH");
  return active;
}
