const requiredDatabaseGrants = [
  "ALTER", "ALTER ROUTINE", "CREATE", "CREATE ROUTINE", "CREATE TEMPORARY TABLES",
  "CREATE VIEW", "DELETE", "DROP", "EVENT", "EXECUTE", "INDEX", "INSERT",
  "LOCK TABLES", "REFERENCES", "SELECT", "SHOW VIEW", "TRIGGER", "UPDATE",
];

export function assertOwnerRestoreImporterGrants(version: string, database: string, grants: string[]) {
  const definerGrant = /^8\.0\.\d+\b/.test(version) ? "SET_USER_ID" :
    /^8\.4\.\d+\b/.test(version) ? "SET_ANY_DEFINER" : null;
  if (!definerGrant) throw Error("RESTORE_DATABASE_VERSION_UNSUPPORTED");

  const databaseScope = " ON `" + database + "`.*";
  const databaseGrants = new Set<string>();
  const globalGrants = new Set<string>();
  const allowedGlobalGrants = ["USAGE", "CONNECTION_ADMIN", definerGrant];
  for (const grant of grants) {
    if (/\bWITH\s+(?:GRANT|ADMIN)\s+OPTION\b/i.test(grant)) throw Error("RESTORE_IMPORT_PRIVILEGES_TOO_BROAD");
    const [privilege] = grant.split(" TO ", 1);
    if (privilege.endsWith(databaseScope)) {
      for (const name of privilege.slice("GRANT ".length, -databaseScope.length).split(/,\s*/)) databaseGrants.add(name);
      continue;
    }
    const names = /^GRANT ([A-Z ,_]+) ON \*\.\*$/.exec(privilege)?.[1].split(/,\s*/);
    if (!names?.every(name => allowedGlobalGrants.includes(name))) {
      throw Error("RESTORE_IMPORT_PRIVILEGES_TOO_BROAD");
    }
    for (const name of names) globalGrants.add(name);
  }

  if (!globalGrants.has("CONNECTION_ADMIN") || !globalGrants.has(definerGrant) ||
      (!databaseGrants.has("ALL PRIVILEGES") && !requiredDatabaseGrants.every(name => databaseGrants.has(name)))) {
    throw Error("RESTORE_IMPORT_PRIVILEGES_INSUFFICIENT");
  }
}
