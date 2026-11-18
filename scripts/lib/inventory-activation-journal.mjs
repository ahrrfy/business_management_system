import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const hashFile = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Redacts database/broker connection URLs, credentialed URLs, and secret tokens while keeping file:// stack frames intact. */
export function redactDiagnosticText(value) {
  if (value == null) return value;
  return String(value)
    .replace(
      /\b(?:mysql2?|postgres(?:ql)?|rediss?|mongodb(?:\+srv)?|amqps?):\/\/[^\s"'`<>]+/gi,
      "[REDACTED_URL]",
    )
    .replace(
      /\b(https?:\/\/)([^/@\s"'`<>]+@)([^\s"'`<>]+)/gi,
      "$1[REDACTED]@$3",
    )
    .replace(
      /\b(https?:\/\/[^\s"'`<>?]+)\?[^\s"'`<>]+/gi,
      "$1?[REDACTED]",
    )
    .replace(
      /(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)([^\s"',;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/g, "$1 [REDACTED]")
    .replace(
      /\b(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk_[A-Za-z0-9_]{8,})\b/g,
      "[REDACTED_TOKEN]",
    )
    .replace(
      /\b(MYSQL_PWD|DB_ROOT_PW|DB_APP_PW|DB_CONTROL_PW|DATABASE_URL|ERP_INVENTORY_CONTROL_DATABASE_URL|CONTROL_DATABASE_URL|BACKUP_TARGET_URL|INTERNAL_PROXY_SECRET|INTERNAL_PROXY_SECRET_PREVIOUS|GITHUB_TOKEN|GH_TOKEN|ADMIN_PASSWORD|JWT_SECRET|SENTRY_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY|PASSWORD|PASSWD|SECRET|TOKEN)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /(--(?:password|passwd|secret|token)\s*(?:=|\s+))("[^"]*"|'[^']*'|[^\s"';]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\bmysql(?:dump)?\b[^\n;]*?\s-p)("[^"]*"|'[^']*'|[^\s"';]+)/g,
      "$1[REDACTED]",
    )
    .replace(
      /(IDENTIFIED\s+BY\s+)(?:'[^']*'|"[^"]*")/gi,
      "$1'[REDACTED]'",
    );
}

/** Recursively redacts strings inside diagnostic payloads without mutating the input object. */
export function redactDiagnosticValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactDiagnosticText(value);
  if (typeof value !== "object" || depth >= 6) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item, depth + 1));
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = redactDiagnosticValue(entry, depth + 1);
  }
  return output;
}

/** Verifies the root-owned pm2-systemd-start.mjs boot interlock matches the repo copy and systemd ExecStart. */
export function assertBootInterlock({
  projectRoot,
  installedHelperPath = "/usr/local/libexec/erp/pm2-systemd-start.mjs",
  execute = (file, args) =>
    execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }),
}) {
  let installedStat;
  try {
    installedStat = fs.lstatSync(installedHelperPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw Object.assign(new Error("INVENTORY_INSTALLED_BOOT_INTERLOCK_REQUIRED"), {
      code: "INVENTORY_INSTALLED_BOOT_INTERLOCK_REQUIRED",
    });
  }
  if (
    !installedStat.isFile() ||
    installedStat.isSymbolicLink() ||
    installedStat.uid !== 0 ||
    installedStat.mode & 0o022 ||
    hashFile(installedHelperPath) !==
      hashFile(path.join(projectRoot, "deploy/systemd/pm2-systemd-start.mjs"))
  ) {
    throw Object.assign(new Error("INVENTORY_INSTALLED_BOOT_INTERLOCK_REQUIRED"), {
      code: "INVENTORY_INSTALLED_BOOT_INTERLOCK_REQUIRED",
    });
  }
  const start = execute("systemctl", [
    "show",
    "pm2-deploy.service",
    "--property=ExecStart",
    "--value",
  ]);
  if (!String(start ?? "").includes(installedHelperPath)) {
    throw Object.assign(new Error("INVENTORY_SYSTEMD_BOOT_INTERLOCK_REQUIRED"), {
      code: "INVENTORY_SYSTEMD_BOOT_INTERLOCK_REQUIRED",
    });
  }
}

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
  if (j.recoveryArtifacts !== undefined && (!Array.isArray(j.recoveryArtifacts) || j.recoveryArtifacts.length > 64)) throw new Error("INVENTORY_RECOVERY_ARTIFACTS_INVALID");
  for (const a of [...j.artifacts, ...(j.recoveryArtifacts ?? [])])
    if (
      !path.isAbsolute(a.script) ||
      !path.isAbsolute(a.bundle) ||
      !/^[a-f0-9]{64}$/.test(a.hash) ||
      !Number.isSafeInteger(a.instances) ||
      a.instances < 1 ||
      !["erp-server", "erp-hr-bridge"].includes(a.name)
    )
      throw new Error("INVENTORY_JOURNAL_ARTIFACT_INVALID");
  if (j.schemaTransition && (
    j.schemaTransition.id !== "fractional-material-quantities-v1" ||
    j.schemaTransition.rollbackPolicy !== "FORWARD_ONLY" ||
    typeof j.schemaTransition.started !== "boolean"
  )) throw new Error("INVENTORY_SCHEMA_TRANSITION_INVALID");
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
