import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const fail = (code) => Object.assign(new Error(code), { code });
const positivePid = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const msysPath = value => value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");

// Each backup pins its own Linux kernel identity. Signal 0 alone also sees zombies.
export function createAgentProcessProbe({ platform = process.platform, signal = pid => process.kill(pid, 0), readProc = readFileSync } = {}) {
  const identities = new Map();
  const exists = pid => {
    try { signal(pid); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw fail("BACKUP_GPG_PID_PROBE_FAILED"); }
  };
  const statIdentity = (raw, pid) => {
    const open = raw.indexOf(" (");
    const close = raw.lastIndexOf(")");
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    // stat field 22 (starttime) is index 19 after the parenthesized comm field.
    if (open < 1 || close <= open || raw[close + 1] !== " " || raw.slice(0, open) !== String(pid) ||
        fields.length < 20 || !/^[RSDTtZXxKWPI]$/.test(fields[0]) || !/^\d+$/.test(fields[19]))
      throw fail("BACKUP_GPG_PID_PROBE_FAILED");
    return { state: fields[0], startTime: fields[19] };
  };
  const linuxIdentity = pid => {
    const before = statIdentity(readProc(`/proc/${pid}/stat`, "utf8"), pid);
    const status = readProc(`/proc/${pid}/status`, "utf8");
    const pids = [...status.matchAll(/^Pid:[ \t]+(\d+)[ \t]*\r?$/gm)];
    const uids = [...status.matchAll(/^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*\r?$/gm)];
    const after = statIdentity(readProc(`/proc/${pid}/stat`, "utf8"), pid);
    if (pids.length !== 1 || Number(pids[0][1]) !== pid || uids.length !== 1 || before.startTime !== after.startTime ||
        uids[0].slice(1).some(uid => !Number.isSafeInteger(Number(uid)) || Number(uid) > 0xffffffff) ||
        (/[ZX]/.test(before.state) && !/[ZX]/.test(after.state))) throw fail("BACKUP_GPG_PID_PROBE_FAILED");
    return { ...after, uid: uids[0].slice(1).map(Number).join(":") };
  };
  return pid => {
    if (!positivePid(pid)) throw fail("BACKUP_GPG_PID_PROBE_FAILED");
    if (!exists(pid)) return false;
    if (platform !== "linux") return true;
    let current;
    try { current = linuxIdentity(pid); }
    catch (error) {
      // A disappearing proc entry alone is ambiguous; confirm kernel absence.
      if (["ENOENT", "ESRCH"].includes(error.code) && !exists(pid)) return false;
      throw fail("BACKUP_GPG_PID_PROBE_FAILED");
    }
    const known = identities.get(pid);
    if (known && (known.startTime !== current.startTime || known.uid !== current.uid)) throw fail("BACKUP_GPG_PID_IDENTITY_CHANGED");
    const terminated = current.state === "Z" || current.state === "X";
    if (!known) {
      if (terminated) throw fail("BACKUP_GPG_PID_PROBE_FAILED");
      identities.set(pid, current);
    }
    return !terminated;
  };
}

// Deliberately exclude ERP/database credentials and inherited agent/socket settings.
function platformEnvironment(environment, home) {
  const result = { HOME: home, USERPROFILE: home, GNUPGHOME: home, LC_ALL: "C", LANG: "C" };
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR"])
    if (environment[key] !== undefined) result[key] = environment[key];
  return result;
}

// Only the directory created by this invocation may be removed, after its agent exits.
function assertOwnedHome(home, base, identity) {
  const current = lstatSync(home);
  const canonical = realpathSync(home);
  if (!isAbsolute(home) || resolve(home) !== home || canonical !== home || dirname(canonical) !== base ||
      !basename(home).startsWith("erp-backup-gpg-") || !current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid ||
      !Number.isInteger(current.nlink) || current.nlink < 1 ||
      (current.mode & 0o777) !== (identity.mode & 0o777) ||
      (process.platform !== "win32" && (current.mode & 0o077) !== 0) ||
      (process.getuid && current.uid !== process.getuid())) throw fail("BACKUP_GPG_HOME_IDENTITY_CHANGED");
  return canonical;
}

export async function encryptBackupWithOwnedAgent({
  sqlFile, partialFile, passphrase, gpg = "gpg", gpgconf = "gpgconf", connectAgent = "gpg-connect-agent",
  msys = false, environment = process.env, run = spawnSync, alive = createAgentProcessProbe(),
  wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms)), now = Date.now, shutdownTimeoutMs = 5000,
}) {
  const base = realpathSync(tmpdir());
  const home = realpathSync(mkdtempSync(join(base, "erp-backup-gpg-")));
  chmodSync(home, 0o700);
  const identity = lstatSync(home);
  const env = platformEnvironment(environment, home);
  let pid;
  let confirmedLive = false;
  let primaryFailure;
  const execute = (command, args, extra = {}) => run(command, args, {
    encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"], env, ...extra,
  });
  const checked = (command, args, code, extra) => {
    const result = execute(command, args, extra);
    if (result.error || result.status !== 0) throw fail(code);
    return result.stdout ?? "";
  };
  const args = values => msys ? values.map(msysPath) : values;
  const readAgentPid = () => {
    const info = checked(connectAgent, args(["--homedir", home, "--no-autostart", "GETINFO pid", "/bye"]), "BACKUP_GPG_PID_READ_FAILED");
    const matches = [...info.matchAll(/^D (\d+)\r?$/gm)];
    if (matches.length !== 1 || !positivePid(matches[0][1])) throw fail("BACKUP_GPG_PID_INVALID");
    let currentPid = Number(matches[0][1]);
    if (msys) {
      // MSYS GETINFO uses a POSIX PID. Node must probe its Windows PID instead.
      const mapping = checked(join(dirname(gpg), "ps.exe"), ["-p", String(currentPid), "-l"], "BACKUP_GPG_PID_MAPPING_FAILED").trim().split(/\r?\n/);
      const header = mapping[0]?.trim().split(/\s+/).join(" ");
      const row = mapping[1]?.trim().split(/\s+/);
      if (mapping.length !== 2 || header !== "PID PPID PGID WINPID TTY UID STIME COMMAND" ||
          !row || !positivePid(row[0]) || Number(row[0]) !== currentPid || !positivePid(row[3])) throw fail("BACKUP_GPG_PID_MAPPING_FAILED");
      currentPid = Number(row[3]);
    }
    return currentPid;
  };
  try {
    assertOwnedHome(home, base, identity);
    if (msys) {
      if (!isAbsolute(gpg)) throw fail("BACKUP_GPG_MSYS_PATH_REQUIRED");
      gpgconf = join(dirname(gpg), "gpgconf.exe");
      connectAgent = join(dirname(gpg), "gpg-connect-agent.exe");
    }
    checked(gpgconf, args(["--homedir", home, "--launch", "gpg-agent"]), "BACKUP_GPG_AGENT_START_FAILED");
    pid = readAgentPid();
    if (!alive(pid)) throw fail("BACKUP_GPG_PID_NOT_LIVE");
    confirmedLive = true;
    checked(gpg, args(["--homedir", home, "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0",
      "--symmetric", "--cipher-algo", "AES256", "-o", partialFile, sqlFile]), "BACKUP_ENCRYPTION_FAILED", { input: passphrase, timeout: 15 * 60_000 });
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      // Never send a destructive command through a replaced/symlinked home.
      assertOwnedHome(home, base, identity);
      // GPG may have reconnected to a replacement agent during encryption.
      let identityFailure;
      try {
        const currentPid = readAgentPid();
        if (!confirmedLive || currentPid !== pid || !alive(currentPid)) throw fail("BACKUP_GPG_AGENT_IDENTITY_CHANGED");
      } catch (error) { identityFailure = error; }
      checked(gpgconf, args(["--homedir", home, "--kill", "gpg-agent"]), "BACKUP_GPG_AGENT_CLEANUP_FAILED");
      if (identityFailure) throw identityFailure;
      // A PID was positively alive before encryption. A probe error is never absence.
      if (!confirmedLive) throw fail("BACKUP_GPG_AGENT_CLEANUP_UNPROVEN");
      const deadline = now() + shutdownTimeoutMs;
      while (alive(pid)) {
        if (now() >= deadline) throw fail("BACKUP_GPG_AGENT_EXIT_TIMEOUT");
        await wait(50);
      }
      const canonical = assertOwnedHome(home, base, identity);
      rmSync(canonical, { recursive: true, force: false });
    } catch (error) {
      const cleanup = fail("BACKUP_GPG_AGENT_CLEANUP_FAILED");
      cleanup.diagnosticHome = home;
      cleanup.cause = error;
      if (primaryFailure) cleanup.encryptionFailure = primaryFailure.code ?? "BACKUP_ENCRYPTION_FAILED";
      throw cleanup;
    }
  }
  if (primaryFailure) throw primaryFailure;
}
