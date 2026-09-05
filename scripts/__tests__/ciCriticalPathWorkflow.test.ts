import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
  "utf8",
);

function jobBlock(name: string, nextName: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  const end = workflow.indexOf(`  ${nextName}:`, start + 1);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("CI critical-path policy", () => {
  it("يشغّل الجودة والبناء بالتوازي مع شرائح الاختبار", () => {
    const qualityBuild = jobBlock("quality-build", "check-test-build");

    expect(qualityBuild).not.toMatch(/^\s+needs:/m);
    expect(qualityBuild).toContain("pnpm check");
    expect(qualityBuild).toContain("pnpm build");
  });

  it("يبقي الفحص المحمي بوابة تجميع خفيفة لا تعيد العمل", () => {
    const gate = jobBlock("check-test-build", "authz-guard");

    expect(gate).toContain("needs: [test-shards, quality-build]");
    expect(gate).toContain("needs.test-shards.result");
    expect(gate).toContain("needs.quality-build.result");
    expect(gate).not.toContain("actions/checkout");
    expect(gate).not.toContain("pnpm install");
    expect(gate).not.toContain("pnpm build");
  });
});
