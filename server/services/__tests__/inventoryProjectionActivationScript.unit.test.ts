import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("rejects unsafe local development activation targets before any SQL connection", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--test",
      path.resolve(
        import.meta.dirname,
        "../../../scripts/dev-inventory-init.test.mjs",
      ),
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  expect(output).toMatch(/pass 28/);
  expect(output).toMatch(/fail 0/);
});

it("runs raw deployment B failure and uncertain-commit contracts under the current Node runtime", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--test",
      path.resolve(
        import.meta.dirname,
        "../../../scripts/lib/inventory-projection-activation.test.mjs",
      ),
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  expect(output).toMatch(/pass 5/);
  expect(output).toMatch(/fail 0/);
});
