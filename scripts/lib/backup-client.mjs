import { execFileSync as runFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mysqlCommand, resolveDbTarget } from "./db-target.mjs";

// Official client artifact, independent of the database-server image/version.
// MySQL 8.0 lacks mysqldump --init-command (introduced in 8.2).
export const BACKUP_CLIENT_IMAGE =
  "mysql@sha256:c36050afdca850f23cef85703f84c7531a5ae155a11b5ee1c60acb09937c4084";
export const BACKUP_CLIENT_VERSION = "8.4.9";
const RUN_LABEL = "alroya.backup-client.run";
const PROCESS_OPTIONS = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 30000,
};

function pinCapableHelp(command, prefix, execute) {
  try {
    const help = execute(
      command,
      [...prefix, "--no-defaults", "--help"],
      PROCESS_OPTIONS,
    );
    return /(?:^|\n)\s*--init-command(?:=|\s)/.test(help) ? help : null;
  } catch {
    return null;
  }
}

function isolatedPrefix(network) {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--network",
    network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "32",
    "--memory",
    "256m",
    "--user",
    "65534:65534",
    "--log-driver",
    "none",
  ];
}

function preparedImage(execute) {
  let image;
  try {
    image = JSON.parse(
      execute(
        "docker",
        ["image", "inspect", BACKUP_CLIENT_IMAGE],
        PROCESS_OPTIONS,
      ),
    )[0];
  } catch {
    throw new Error(
      "BACKUP_CLIENT_NOT_PREPARED: شغّل node scripts/provision-backup-client.mjs --pull أثناء تجهيز النشر؛ النسخ لا ينزّل صوراً من الشبكة.",
    );
  }
  const expectedDigest = BACKUP_CLIENT_IMAGE.split("@")[1];
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? "") ||
    !image.RepoDigests?.some((ref) => ref.split("@")[1] === expectedDigest)
  ) {
    throw new Error("BACKUP_CLIENT_IMAGE_MISMATCH");
  }
  const help = pinCapableHelp(
    "docker",
    [
      ...isolatedPrefix("none"),
      "--entrypoint",
      "mysqldump",
      BACKUP_CLIENT_IMAGE,
    ],
    execute,
  );
  if (
    !help ||
    !new RegExp(
      `\\bVer\\s+${BACKUP_CLIENT_VERSION.replaceAll(".", "\\.")}\\b`,
    ).test(help)
  ) {
    throw new Error(
      "BACKUP_CLIENT_CAPABILITY_MISMATCH: prepared client version/pin option is invalid",
    );
  }
  return { imageId: image.Id };
}

/** Explicit preparation only: routine backups never invoke docker pull. */
export function provisionBackupClient({
  pull = false,
  forceIsolated = false,
  execFileSync = runFile,
} = {}) {
  if (!forceIsolated && pinCapableHelp("mysqldump", [], execFileSync))
    return { kind: "native" };
  try {
    return { kind: "isolated", ...preparedImage(execFileSync) };
  } catch (error) {
    if (!pull || !error.message.startsWith("BACKUP_CLIENT_NOT_PREPARED:"))
      throw error;
    execFileSync("docker", ["pull", BACKUP_CLIENT_IMAGE], {
      stdio: "inherit",
      timeout: 10 * 60_000,
    });
    return { kind: "isolated", ...preparedImage(execFileSync) };
  }
}

export async function resolveBackupClient(
  rawUrl,
  { container, execFileSync = runFile, resolveTarget = resolveDbTarget } = {},
) {
  if (pinCapableHelp("mysqldump", [], execFileSync)) {
    return {
      target: await resolveTarget(rawUrl, { adapter: "native" }),
      kind: "native",
    };
  }
  let target;
  try {
    target = await resolveTarget(rawUrl, { adapter: "docker", container });
  } catch (error) {
    throw new Error(
      `BACKUP_CLIENT_CONFIG: لا يوجد عميل محلي يدعم تثبيت الاتصال ولا حاوية قاعدة مطابقة. حدّث عميل النسخ فقط أو اضبط DB_CONTAINER المطابق؛ خادم القاعدة لا يحتاج ترقية. (${error.message})`,
    );
  }
  if (
    pinCapableHelp(
      "docker",
      ["exec", target.containerId, "mysqldump"],
      execFileSync,
    )
  ) {
    return { target, kind: "container" };
  }
  return { target, kind: "isolated", ...preparedImage(execFileSync) };
}

/** The same UUID init guard runs on the actual dump connection/reconnections. */
export function backupDumpCommand(
  selection,
  flags,
  { execFileSync = runFile, runId = randomUUID() } = {},
) {
  const { target } = selection;
  if (selection.kind !== "isolated")
    return mysqlCommand(target, "mysqldump", flags);
  if (
    target.adapter !== "docker" ||
    !target.containerId ||
    !/^[A-Za-z0-9-]+$/.test(runId)
  )
    throw new Error("BACKUP_CLIENT_CONFIG");
  const name = `erp-backup-client-${runId}`;
  const guarded = mysqlCommand(
    {
      ...target,
      adapter: "native",
      host: "127.0.0.1",
      port: target.containerPort,
    },
    "mysqldump",
    flags,
  );
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    let current;
    try {
      current = JSON.parse(
        execFileSync("docker", ["inspect", name], PROCESS_OPTIONS),
      )[0];
    } catch {
      removed = true;
      return;
    } // --rm normally already removed it.
    // Never remove a pre-existing/unrelated container after a name collision.
    if (
      current?.Config?.Labels?.[RUN_LABEL] !== runId ||
      current.Image !== selection.imageId
    )
      return;
    try {
      execFileSync("docker", ["rm", "--force", current.Id], {
        stdio: "ignore",
        timeout: 10000,
      });
      removed = true;
    } catch {
      /* daemon unavailable; no unverified deletion fallback */
    }
  };
  return {
    command: "docker",
    args: [
      ...isolatedPrefix(`container:${target.containerId}`),
      "--name",
      name,
      "--label",
      `${RUN_LABEL}=${runId}`,
      "-e",
      "MYSQL_PWD",
      "--entrypoint",
      "mysqldump",
      BACKUP_CLIENT_IMAGE,
      "--no-defaults",
      "--no-login-paths",
      ...guarded.args,
    ],
    cleanup,
  };
}
