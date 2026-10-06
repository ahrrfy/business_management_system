import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("dependency security coverage", () => {
  it("يفحص Security Audit أقفال الجذر وتطبيقي Expo", () => {
    const workflow = read(".github/workflows/security.yml");

    expect(workflow).toContain("pnpm-lock.yaml");
    expect(workflow).toContain("expo/customer-store-mobile/pnpm-lock.yaml");
    expect(workflow).toContain("expo/superapp-mobile/pnpm-lock.yaml");
    expect(workflow).toContain("--config=osv-scanner.toml");
  });

  it("يبقي فحص الثغرات مركزياً في OSV بلا اعتماد على npm audit المتقاعد", () => {
    const mobileWorkflow = read(".github/workflows/expo-mobile-check.yml");
    const securityWorkflow = read(".github/workflows/security.yml");

    expect(mobileWorkflow).not.toContain("pnpm audit");
    expect(securityWorkflow).toContain("osv-scanner scan");
  });

  it("يثبت الإصدارات العابرة الآمنة ويبرر الاستثناء الوحيد غير القابل للإصلاح", () => {
    const rootPackageJson = JSON.parse(read("package.json")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const rootOverrides = rootPackageJson.pnpm?.overrides ?? {};
    expect(rootOverrides["brace-expansion@<5.0.12"]).toBe("5.0.12");
    expect(rootOverrides["fast-uri@<3.1.8"]).toBe("3.1.8");
    expect(rootOverrides["ip-address@<10.7.1"]).toBe("10.7.1");
    expect(rootOverrides["serialize-javascript@<7.1.2"]).toBe("7.1.2");
    expect(rootOverrides["compression@<1.8.2"]).toBe("1.8.2");
    expect(rootOverrides["fast-copy@<4.1.0"]).toBe("4.1.0");
    expect(rootOverrides["postcss-selector-parser@<7.1.6"]).toBe("7.1.6");
    expect(rootOverrides["proxy-addr@<2.0.8"]).toBe("2.0.8");
    expect(rootOverrides["source-map-js@<1.2.2"]).toBe("1.2.2");

    const packageJson = JSON.parse(
      read("expo/customer-store-mobile/package.json"),
    ) as {
      pnpm?: {
        overrides?: Record<string, string>;
      };
    };
    const overrides = packageJson.pnpm?.overrides ?? {};

    expect(overrides["fast-uri"]).toBe("3.1.8");
    expect(overrides["undici"]).toBe("6.29.0");
    expect(overrides["@grpc/grpc-js"]).toBe("1.13.6");
    expect(overrides["brace-expansion@1.1.18"]).toBe("1.1.21");
    expect(overrides["brace-expansion@2.1.4"]).toBe("2.1.7");
    expect(overrides["brace-expansion@5.0.9"]).toBe("5.0.12");
    expect(overrides["compression"]).toBe("1.8.2");
    expect(overrides["postcss-selector-parser"]).toBe("7.1.6");
    expect(overrides["source-map-js"]).toBe("1.2.2");
    expect(overrides["shell-quote"]).toBe("^1.12.0");

    const superappPackageJson = JSON.parse(
      read("expo/superapp-mobile/package.json"),
    ) as {
      pnpm?: {
        overrides?: Record<string, string>;
      };
    };
    const superappOverrides = superappPackageJson.pnpm?.overrides ?? {};
    expect(superappOverrides["fast-uri"]).toBe("3.1.8");
    expect(superappOverrides["brace-expansion@1.1.18"]).toBe("1.1.21");
    expect(superappOverrides["brace-expansion@2.1.4"]).toBe("2.1.7");
    expect(superappOverrides["brace-expansion@5.0.9"]).toBe("5.0.12");
    expect(superappOverrides["compression"]).toBe("1.8.2");
    expect(superappOverrides["source-map-js"]).toBe("1.2.2");
    expect(superappOverrides["shell-quote"]).toBe("^1.12.0");

    const osvConfig = read("osv-scanner.toml");
    expect(osvConfig).toContain('id = "GHSA-86w9-cpqp-85rv"');
    expect(osvConfig).toContain('id = "GHSA-hp3w-g68c-fv3c"');
    expect(osvConfig).toContain('reason = "');
  });
});
