/**
 * قوائم العدّ الورقية (/stocktakes/:id/sheets) — مرجع التصميم jrd-countsheet.jsx.
 * معاينة قائمة كل عامل (تبويب) من trpc.stocktakes.countSheets (العقد §٣ — أعمى: بلا expectedQty
 * ولا أرصدة إطلاقاً) + زر طباعة يستدعي printCountSheets (صفحة لكل عامل).
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtInt } from "@/lib/money";
import { printCountSheets } from "@/lib/printing/stocktakeTemplates";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { Printer } from "lucide-react";

// ─── شكل مخرج stocktakes.countSheets المُستهلَك (العقد §٣):
//     لكل تكليف { assignment, items: [{ productName, variantName, sku, barcode, baseUnit }] } ───

type SheetItem = {
  productName: string;
  variantName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  baseUnit?: string | null;
};

type Sheet = {
  assignment: { id?: number; name: string; zone?: string | null; method?: string | null; status?: string | null };
  items: SheetItem[];
};

type SessionHeader = {
  code?: string;
  name?: string | null;
  branchName?: string | null;
  createdAt?: string | null;
  status?: string;
};

const dOnly = (v?: string | Date | null): string =>
  v ? new Date(v).toLocaleDateString("ar-IQ-u-nu-latn", { dateStyle: "medium" }) : "—";

export default function StocktakeCountSheets() {
  const params = useParams();
  const sessionId = Number(params.id);
  const enabled = Number.isFinite(sessionId);

  const sheetsQ = trpc.stocktakes.countSheets.useQuery({ sessionId }, { enabled });
  const getQ = trpc.stocktakes.get.useQuery({ sessionId }, { enabled });

  const [tab, setTab] = useState("0");

  // دفاعي: المخرج إمّا مصفوفة تكليفات مباشرة أو { session, sheets }
  const sheets: Sheet[] = useMemo(() => {
    const raw = sheetsQ.data as unknown;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as Sheet[];
    const o = raw as { sheets?: Sheet[]; assignments?: Sheet[] };
    return o.sheets ?? o.assignments ?? [];
  }, [sheetsQ.data]);

  const sess: SessionHeader | undefined = useMemo(() => {
    const g = getQ.data as unknown as ({ session?: SessionHeader } & SessionHeader) | undefined;
    if (!g) {
      const raw = sheetsQ.data as unknown as { session?: SessionHeader } | undefined;
      return raw && !Array.isArray(raw) ? raw.session : undefined;
    }
    return g.session ?? g;
  }, [getQ.data, sheetsQ.data]);

  if (!enabled) return <div className="p-10 text-center text-muted-foreground">جلسة غير صالحة.</div>;
  if (sheetsQ.isLoading) return <div className="p-10 text-center text-muted-foreground">جارٍ التحميل…</div>;
  if (sheetsQ.error) return <div className="p-10 text-center text-destructive">تعذّر تحميل قوائم العدّ: {sheetsQ.error.message}</div>;

  const code = sess?.code ?? `#${sessionId}`;
  const branchName = sess?.branchName ?? "—";

  function doPrint() {
    if (!sheets.length) return;
    printCountSheets({
      code,
      name: sess?.name,
      branchName,
      date: sess?.createdAt,
      sheets: sheets.map((sh) => ({
        workerName: sh.assignment.name,
        zone: sh.assignment.zone,
        items: sh.items,
      })),
    });
  }

  return (
    <div className="space-y-4 max-w-5xl">
      {/* شريط الإجراءات */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">قوائم العدّ الورقية</h1>
          <Badge variant="secondary" className="font-mono" dir="ltr">{code}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/stocktakes/${sessionId}`}>
            <Button variant="outline">← متابعة العدّ</Button>
          </Link>
          <Link href="/stocktakes">
            <Button variant="outline">قائمة الجلسات</Button>
          </Link>
          <Button onClick={doPrint} disabled={!sheets.length}>
            <Printer aria-hidden className="size-4" /> طباعة القوائم
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        قائمة مستقلة لكل عامل بمنتجات منطقته — بلا أرصدة دفترية (جرد أعمى). تُطبع وتُسلَّم ورقياً عند
        تعذّر استخدام الهاتف، ثم تُدخل الكميات في النظام. رمز الدخول (PIN) لا يُطبع على الورقة.
      </p>

      {sheets.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-muted-foreground">
          لا توجد تكليفات في هذه الجلسة.
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap">
            {sheets.map((sh, i) => (
              <TabsTrigger key={i} value={String(i)}>
                {sh.assignment.name}
                <span className="mr-1 text-xs text-muted-foreground">({fmtInt(sh.items.length)})</span>
              </TabsTrigger>
            ))}
          </TabsList>

          {sheets.map((sh, i) => (
            <TabsContent key={i} value={String(i)}>
              <div className="mx-auto rounded-xl border bg-card p-8 shadow-sm">
                {/* ترويسة الورقة */}
                <div className="flex items-start justify-between border-b-2 border-foreground pb-3">
                  <div>
                    <p className="text-base font-bold">الرؤية العربية — قائمة عدّ ميداني</p>
                    <p className="text-xs text-muted-foreground">
                      {branchName} · جلسة <span className="font-mono" dir="ltr">{code}</span> · {dOnly(sess?.createdAt)}
                      {sess?.name ? ` · ${sess.name}` : ""}
                    </p>
                  </div>
                  <div className="text-left text-sm">
                    <p className="font-bold">العامل: {sh.assignment.name}</p>
                    <p className="text-xs text-muted-foreground">
                      المنطقة: {sh.assignment.zone ?? "—"} · ورقة {fmtInt(i + 1)} من {fmtInt(sheets.length)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">رمز الدخول (PIN) لا يُطبع — يُسلَّم للعامل مباشرة</p>
                  </div>
                </div>

                {/* جدول المنتجات — أعمى: بلا أرصدة */}
                <table className="mt-4 w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-y-2 border-foreground text-right text-xs">
                      <th className="w-8 py-1.5 pl-2 font-bold">#</th>
                      <th className="px-2 py-1.5 font-bold">المنتج</th>
                      <th className="px-2 py-1.5 font-bold">المتغيّر</th>
                      <th className="px-2 py-1.5 font-bold">SKU</th>
                      <th className="px-2 py-1.5 font-bold">الباركود</th>
                      <th className="w-20 px-2 py-1.5 text-center font-bold">الوحدة الأساس</th>
                      <th className="w-24 px-2 py-1.5 text-center font-bold">العدّ 1</th>
                      <th className="w-24 px-2 py-1.5 text-center font-bold">العدّ 2</th>
                      <th className="w-32 py-1.5 pr-2 font-bold">ملاحظات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sh.items.map((it, idx) => (
                      <tr key={idx} className="border-b">
                        <td className="py-2.5 pl-2 text-xs text-muted-foreground">{fmtInt(idx + 1)}</td>
                        <td className="px-2 py-2.5 font-semibold">{it.productName}</td>
                        <td className="px-2 py-2.5 text-muted-foreground">{it.variantName ?? "—"}</td>
                        <td className="px-2 py-2.5 font-mono text-[11px] text-muted-foreground" dir="ltr">{it.sku ?? "—"}</td>
                        <td className="px-2 py-2.5 font-mono text-[11px] text-muted-foreground" dir="ltr">{it.barcode ?? "—"}</td>
                        <td className="px-2 py-2.5 text-center text-xs">{it.baseUnit ?? "—"}</td>
                        <td className="px-2 py-2.5"><div className="h-7 rounded border"></div></td>
                        <td className="px-2 py-2.5"><div className="h-7 rounded border"></div></td>
                        <td className="py-2.5 pr-2"><div className="h-7 border-b border-dashed"></div></td>
                      </tr>
                    ))}
                    {sh.items.length === 0 && (
                      <tr><td colSpan={9} className="py-3 text-center text-muted-foreground">لا منتجات في هذا التكليف.</td></tr>
                    )}
                  </tbody>
                </table>

                {/* تواقيع */}
                <div className="mt-8 grid grid-cols-2 gap-8 text-center text-sm">
                  {[
                    ["عدّ (العامل)", sh.assignment.name],
                    ["راجع (المشرف)", ""],
                  ].map(([k, who]) => (
                    <div key={k}>
                      <p className="font-bold">{k}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{who || " "}</p>
                      <div className="mt-9 border-t border-foreground pt-1 text-xs text-muted-foreground">الاسم والتوقيع</div>
                    </div>
                  ))}
                </div>

                <p className="mt-4 text-[11px] text-muted-foreground">
                  تعليمات: عُدَّ ما على الرف فعلياً فقط · لا تنقل أرقاماً من النظام أو من زميل · أي منتج
                  غير موجود اكتب «0» · الكميات بوحدة الأساس المذكورة.
                </p>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
