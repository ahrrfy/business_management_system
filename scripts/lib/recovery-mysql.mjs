import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export async function assertPrivateRecoveryDirectory(directory, { restrictNewWindowsDirectory = false } = {}) {
  if (process.platform !== "win32") {
    if (((await stat(directory)).mode & 0o077) !== 0) throw Error("PRIVATE_EVIDENCE_DIRECTORY_REQUIRED");
    return;
  }
  // Read SIDs directly so ACL checks do not depend on account-name resolution.
  const script = `$ErrorActionPreference='Stop';
$sidType=[System.Security.Principal.SecurityIdentifier];
$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$allowed=@($current,'S-1-5-18','S-1-5-32-544');
$target=$env:RECOVERY_PRIVATE_DIR;
$acl=[IO.Directory]::GetAccessControl($target);
if($env:RECOVERY_RESTRICT_NEW_DIRECTORY -eq '1'){
 $attributes=[IO.File]::GetAttributes($target);
 if(!($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)){exit 2}
 if([IO.Directory]::GetFileSystemEntries($target).Length -ne 0){exit 3}
 if($acl.GetOwner($sidType).Value -notin $allowed){exit 4}
 $acl.SetAccessRuleProtection($true,$false);
 foreach($rule in $acl.GetAccessRules($true,$false,$sidType)){$acl.RemoveAccessRuleSpecific($rule)}
 $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit;
 foreach($sid in $allowed){
  $principal=[Security.Principal.SecurityIdentifier]::new($sid);
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl',$inherit,'None','Allow');
  $acl.AddAccessRule($rule);
 }
 [IO.Directory]::SetAccessControl($target,$acl);
 $acl=[IO.Directory]::GetAccessControl($target);
}
foreach($rule in $acl.GetAccessRules($true,$true,$sidType)){
 if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){exit 5}
}
exit 0`;
  const systemRoot = process.env.SystemRoot ?? "C:/Windows";
  const platformEnvironment = Object.fromEntries([
    "PATH", "SystemDrive", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData",
  ].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const r = spawnSync(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: {
      ...platformEnvironment,
      SystemRoot: systemRoot,
      RECOVERY_PRIVATE_DIR: directory,
      RECOVERY_RESTRICT_NEW_DIRECTORY: restrictNewWindowsDirectory ? "1" : "0",
      PSModulePath: join(systemRoot, "System32/WindowsPowerShell/v1.0/Modules"),
    },
    timeout: 30_000, stdio: "ignore" });
  if (r.status !== 0) {
    const reason = r.error?.code ?? `WINDOWS_ACL_EXIT_${r.status}`;
    throw Error("PRIVATE_EVIDENCE_DIRECTORY_REQUIRED", { cause: reason });
  }
}

export const DEFINER_INVENTORY_SQL = `
SELECT JSON_OBJECT('kind','TRIGGER','name',TRIGGER_NAME,'definer',DEFINER) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='erp'
UNION ALL SELECT JSON_OBJECT('kind','ROUTINE','name',ROUTINE_NAME,'definer',DEFINER) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='erp'
UNION ALL SELECT JSON_OBJECT('kind','VIEW','name',TABLE_NAME,'definer',DEFINER) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='erp'
UNION ALL SELECT JSON_OBJECT('kind','EVENT','name',EVENT_NAME,'definer',DEFINER) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='erp';`;
const jsonRows = raw => raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));

export function planDefiners(objects, accounts) {
  const existing = new Set(accounts.map(a => `${a.user}@${a.host}`));
  const missing = [...new Set(objects.map(o => o.definer))].filter(d => !existing.has(d));
  for (const d of missing) {
    // Deliberately narrow reviewed policy. Unknown stored code needs a separate review.
    if (d !== "erp_app@%" || objects.some(o => o.definer === d && o.kind !== "TRIGGER"))
      throw Error("UNREVIEWED_DEFINER");
  }
  return missing;
}

export function prepareRecoveryMysql(sql, guard) {
  guard();
  const objects = jsonRows(sql(DEFINER_INVENTORY_SQL));
  const accounts = jsonRows(sql("SELECT JSON_OBJECT('user',User,'host',Host,'locked',account_locked) FROM mysql.user"));
  const missing = planDefiners(objects, accounts);
  for (const account of missing) {
    guard();
    if (account !== "erp_app@%") throw Error("UNREVIEWED_DEFINER");
    // Never copy production MySQL passwords or modify an existing principal.
    sql(`CREATE USER 'erp_app'@'%' IDENTIFIED BY '${randomBytes(32).toString("hex")}' ACCOUNT LOCK;
GRANT SELECT, INSERT, UPDATE, TRIGGER ON erp.* TO 'erp_app'@'%';`);
  }
  const after = jsonRows(sql("SELECT JSON_OBJECT('user',User,'host',Host,'locked',account_locked) FROM mysql.user"));
  if (planDefiners(objects, after).length) throw Error("MISSING_DEFINER_AFTER_PREPARATION");
  if (missing.length && after.find(a => a.user === "erp_app" && a.host === "%")?.locked !== "Y") throw Error("DEFINER_NOT_LOCKED");
  return { status: "DEFINERS_PRESENT", objectCounts: Object.fromEntries(["TRIGGER", "ROUTINE", "VIEW", "EVENT"].map(kind =>
    [kind, objects.filter(o => o.kind === kind).length])), createdLockedAccounts: missing,
    existingAccountsModified: false, missingDefiners: 0,
    writeRecovery: "REQUIRES_APPLICATION_WRITE_PROBE" };
}

export function originalUsersFingerprint(sql, upperId) {
  const columns = sql("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='erp' AND TABLE_NAME='users' ORDER BY ORDINAL_POSITION").split(/\r?\n/);
  if (!columns.length || columns.some(c => !/^[A-Za-z0-9_]+$/.test(c)) || !Number.isSafeInteger(upperId) || upperId < 0)
    throw Error("USER_FINGERPRINT_INPUT_INVALID");
  const raw = sql(`SELECT HEX(CAST(JSON_ARRAY(${columns.map(c => `\`${c}\``).join(",")}) AS CHAR)) FROM users WHERE id<=${upperId} ORDER BY id`);
  return { sha256: createHash("sha256").update(raw).digest("hex"), columns: columns.length,
    rows: raw ? raw.split(/\r?\n/).length : 0, upperId };
}

export async function bootstrapRecoveryAdmin(sql, guard, saveCredential) {
  guard();
  const upperId = Number(sql("SELECT COALESCE(MAX(id),0) FROM users"));
  const before = originalUsersFingerprint(sql, upperId);
  const branchId = Number(sql("SELECT MIN(id) FROM branches WHERE isActive=1"));
  if (!Number.isSafeInteger(branchId) || branchId < 1) throw Error("ACTIVE_BRANCH_REQUIRED");
  const { hashPassword } = await import("../../server/auth/password.ts");
  const nonce = randomBytes(12).toString("hex"), password = `${randomBytes(32).toString("base64url")}aA9!`;
  const email = `recovery-${nonce}@local.invalid`;
  const passwordHash = await hashPassword(password);
  // Persist the new credential BEFORE committing an account, so interruption cannot lose it.
  await saveCredential({ email, password, branchId, purpose: "ISOLATED_RECOVERY_ONLY", createdAt: new Date().toISOString() });
  guard();
  const id = Number(sql(`INSERT INTO users (openId,name,email,username,passwordHash,role,branchId,isActive,isOwner,accessExpiresAt)
VALUES ('recovery-${nonce}','Isolated recovery administrator','${email}','recovery-${nonce}','${passwordHash}','admin',${branchId},1,1,DATE_ADD(NOW(),INTERVAL 24 HOUR)); SELECT LAST_INSERT_ID();`));
  if (!Number.isSafeInteger(id) || id <= upperId) throw Error("BOOTSTRAP_ID_INVALID");
  const after = originalUsersFingerprint(sql, upperId);
  if (before.sha256 !== after.sha256 || before.rows !== after.rows) throw Error("ORIGINAL_USERS_CHANGED");
  return { id, branchId, expiresAfterHours: 24, originalUsers: before, originalUsersUnchanged: true,
    authentication: "REQUIRES_LOGIN_AND_2FA_PROBE", originalAdminAccess: "NOT_CHANGED_OR_RECOVERED" };
}
