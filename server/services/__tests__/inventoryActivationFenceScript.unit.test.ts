import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("executes activation failure, ownership, per-PID and durable boot contracts", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--test",
      path.resolve(
        import.meta.dirname,
        "../../../scripts/lib/inventory-activation-fence.test.mjs",
      ),
      path.resolve(
        import.meta.dirname,
        "../../../scripts/lib/inventory-activation-host.test.mjs",
      ),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  expect(result).toMatch(/fail 0/);
  expect(result).toMatch(/pass 36/);
});
