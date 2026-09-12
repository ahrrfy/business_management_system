import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const homeScreen = readFileSync(resolve(process.cwd(), "app/(tabs)/index.tsx"), "utf8");

describe("دليل اكتشاف المنتجات", () => {
  it("يوجّه الطالب والفرد والمكتب والشركة عبر المسارات الموجودة", () => {
    expect(homeScreen).toContain("تسوّق حسب احتياجك");
    expect(homeScreen).toContain('audience: "طالب"');
    expect(homeScreen).toContain('audience: "فرد"');
    expect(homeScreen).toContain('audience: "مكتب"');
    expect(homeScreen).toContain('audience: "شركة"');
    expect(homeScreen).toContain('route: "/search"');
    expect(homeScreen).toContain('route: "/categories"');
    expect(homeScreen).toContain('route: "/request-quote"');
  });
});
