import { execFileSync } from "node:child_process";
import { it } from "vitest";

it("runs backup/restore endpoint identity regressions without database writes", () => {
  execFileSync(
    process.execPath,
    [
      "--test",
      "scripts/lib/db-target.test.mjs",
      "scripts/lib/backup-client.test.mjs",
    ],
    {
      cwd: process.cwd(),
      stdio: "pipe",
    },
  );
});
