import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("سجل الورديات — العرض الافتراضي للورديات المفتوحة والجارية", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "client/src/pages/Shifts.tsx"),
    "utf8",
  );

  it("يضبط الحالة الافتراضية على الورديات المفتوحة OPEN مع قراءة معلمات الرابط useSearch", () => {
    expect(source).toContain('import { Link, useSearch } from "wouter";');
    expect(source).toContain('const searchStr = useSearch();');
    expect(source).toContain('const initialStatus = useMemo<"" | "OPEN" | "CLOSED">(');
    expect(source).toContain('return "OPEN";');
    expect(source).toContain('const [status, setStatus] = useState<"" | "OPEN" | "CLOSED">(initialStatus);');
  });

  it("يعيد تعيين الفلاتر إلى الحالة الافتراضية OPEN عند الضغط على إعادة التعيين", () => {
    expect(source).toContain('function resetFilters() {');
    expect(source).toContain('setStatus("OPEN");');
  });

  it("يعامل الحالة OPEN كخط أساسي في عداد الفلاتر النشطة", () => {
    expect(source).toContain('status !== "OPEN" ? (status || "ALL") : ""');
  });

  it("يحتوي منتقي الحالة على خيارات مفتوحة (جارية)، مغلقة، وكل الورديات", () => {
    expect(source).toContain('<option value="OPEN">مفتوحة (جارية)</option>');
    expect(source).toContain('<option value="CLOSED">مغلقة</option>');
    expect(source).toContain('<option value="">كل الورديات</option>');
  });

  it("يوضح رسالة تصفية مخصصة عند عدم وجود ورديات مفتوحة حالياً", () => {
    expect(source).toContain('status === "OPEN" ? "لا توجد ورديات مفتوحة حالياً. يمكنك تغيير فلتر الحالة لعرض كل الورديات أو الورديات المغلقة."');
  });
});
