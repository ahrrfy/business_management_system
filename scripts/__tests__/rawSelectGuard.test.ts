import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const guardSource = join(projectRoot, "scripts", "check-raw-select.mjs");
const baselineSource = join(projectRoot, "scripts", "raw-select-baseline.json");
const nodeModulesSource = join(projectRoot, "node_modules");

let fixtureRoot: string | undefined;

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function rawSelectPage(count: number) {
  const selects = Array.from(
    { length: count },
    (_, index) => `<select aria-label="field-${index}" />`,
  ).join("\n      ");
  return `export default function Example() {\n  return (\n    <>\n      ${selects}\n    </>\n  );\n}\n`;
}

function commit(root: string, message: string, ...paths: string[]) {
  git(root, "add", "--", ...paths);
  git(root, "commit", "-m", message);
}

function runGuard(root: string) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "check-raw-select.mjs")],
    {
      cwd: root,
      env: { ...process.env, RAW_SELECT_BASE_REF: "main" },
      encoding: "utf8",
    },
  );
}

function createMovingMainFixture() {
  const root = mkdtempSync(join(tmpdir(), "raw-select-guard-"));
  fixtureRoot = root;
  mkdirSync(join(root, "client", "src", "pages"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(guardSource, join(root, "scripts", "check-raw-select.mjs"));
  copyFileSync(
    baselineSource,
    join(root, "scripts", "raw-select-baseline.json"),
  );
  symlinkSync(
    nodeModulesSource,
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "ci@example.test");
  git(root, "config", "user.name", "CI Test");

  const page = join(root, "client", "src", "pages", "Example.tsx");
  writeFileSync(page, rawSelectPage(4), "utf8");
  commit(root, "base with inherited selects", "client/src/pages/Example.tsx");

  git(root, "switch", "-c", "feature");
  writeFileSync(join(root, "feature.txt"), "unrelated change\n", "utf8");
  commit(root, "unrelated feature", "feature.txt");

  git(root, "switch", "main");
  writeFileSync(page, rawSelectPage(2), "utf8");
  commit(
    root,
    "reduce inherited selects on main",
    "client/src/pages/Example.tsx",
  );
  git(root, "switch", "feature");

  return { root, page };
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe("check-raw-select merge-base ratchet", () => {
  it("does not blame an unchanged PR when main reduces inherited debt later", () => {
    const { root } = createMovingMainFixture();

    const result = runGuard(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("اعتماد AppSelect محفوظ");
  });

  it("still rejects a genuine raw select increase introduced by the PR", () => {
    const { root, page } = createMovingMainFixture();
    writeFileSync(page, rawSelectPage(5), "utf8");

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("+1");
  });
});
