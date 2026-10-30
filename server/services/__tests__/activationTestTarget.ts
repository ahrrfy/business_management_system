/** Test-only admission; never opens a SQL connection. */
export function assertIsolatedActivationTestTarget(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("ISOLATED_ACTIVATION_TEST_DATABASE_REQUIRED");
  }
  const port = u.port || "3306";
  // ci.yml provisions a fresh MySQL service per GitHub job on its default port.
  // Local opt-in alone must never admit the production-mirror default port.
  const isolatedGitHubCi =
    env.CI === "true" &&
    env.GITHUB_ACTIONS === "true" &&
    env.ALLOW_TEST_DB_PORT_3306 === "1" &&
    u.pathname === "/erp_test";
  if (
    u.protocol !== "mysql:" ||
    !/^(127\.0\.0\.1|localhost)$/.test(u.hostname) ||
    !u.pathname.endsWith("_test") ||
    (port === "3306" && !isolatedGitHubCi)
  )
    throw new Error("ISOLATED_ACTIVATION_TEST_DATABASE_REQUIRED");
}
