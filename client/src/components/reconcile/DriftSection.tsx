import { Card, CardContent } from "@/components/ui/card";
import { DataTable } from "@/components/data-table/DataTable";
import type { ColumnDef } from "@tanstack/react-table";
import { fmt } from "@/lib/money";
import { Check } from "lucide-react";
import { RowActions } from "@/components/list";
import { PANEL_TABLE, type Row } from "./types";

export function DriftSection({
  title,
  desc,
  idLabel,
  rows,
  money,
  link,
  linkLabel,
  action,
  names,
}: {
  title: string;
  desc: string;
  idLabel: string;
  rows: Row[];
  money?: boolean;
  link?: (id: number) => string;
  linkLabel?: string;
  action?: React.ReactNode;
  /** اسم الطرف (عميل/مورّد/جهة توصيل) بحسب المعرّف — يُعرض تحت الرقم إن تُوفِّر. */
  names?: Map<number, string>;
}) {
  const val = (s: string) => (money ? fmt(s) : s);
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <div>
            <h2 className="font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {action}
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold inline-flex items-center gap-1 ${
                rows.length === 0 ? "badge-status-active" : "bg-[var(--sem-neg-bg)] text-[var(--sem-neg)]"
              }`}
            >
              {rows.length === 0 ? (
                <>
                  <Check aria-hidden className="size-3.5" />
                  لا انحراف
                </>
              ) : (
                `${rows.length} انحراف`
              )}
            </span>
          </div>
        </div>
        {rows.length > 0 && (
          <DataTable<Row>
            {...PANEL_TABLE}
            data={rows}
            emptyText="لا انحراف."
            columns={[
              {
                id: "id",
                header: idLabel,
                accessorFn: (r) => (names ? `${r.id} — ${names.get(r.id) ?? "—"}` : String(r.id)),
                /* ⛔ لا `kind: "code"` هنا: الخليّة تحمل **اسم الطرف بالعربية** تحت الرقم،
                   وkind الرمز يفرض `font-mono` + `whitespace-nowrap` + عزلَ اتّجاهٍ LTR على
                   الخليّة كلّها ⇒ اسمٌ عربيّ بخطٍّ أحاديّ لا يلتفّ. الرقم وحده يُعزَل بـdir. */
                meta: { width: "wide", wrap: true },
                cell: ({ row }) => (
                  <span className="font-medium">
                    <div className="tabular-nums" dir="ltr">
                      {row.original.id}
                    </div>
                    {names && (
                      <div className="text-xs font-normal text-muted-foreground">
                        {names.get(row.original.id) ?? "—"}
                      </div>
                    )}
                  </span>
                ),
              },
              { id: "expected", header: "المتوقّع", accessorFn: (r) => val(r.expected), meta: { kind: "money" }, cell: ({ row }) => val(row.original.expected) },
              { id: "actual", header: "الفعلي", accessorFn: (r) => val(r.actual), meta: { kind: "money" }, cell: ({ row }) => val(row.original.actual) },
              {
                id: "drift",
                header: "الانحراف",
                accessorFn: (r) => `${val(r.drift)}${r.note ? ` — ${r.note}` : ""}`,
                meta: { kind: "money" },
                /* الانحراف هنا **ليس مالاً دائماً**: ثلاثة من مستدعي هذا المكوّن تمرّر بلا `money`
                   (أرصدة المخزون كمّية، وطلبات المتجر «رقمٌ رمزيّ ١ لكل صفّ»، والأيتام عدّة أسطر) ⇒
                   `money-negative` كان يصبغ قيمةً غير ماليّة بتوكن إشارة المبلغ. الدلالة خطرٌ/انحراف
                   ⇒ `--sem-neg` مثل شارة الرأس في المكوّن نفسه. */
                cell: ({ row }) => (
                  <span className="font-semibold text-[var(--sem-neg)]">
                    {val(row.original.drift)}
                    {row.original.note && (
                      <span
                        dir="rtl"
                        className="mr-2 inline-block rounded-md border border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--sem-warn)]"
                      >
                        {row.original.note}
                      </span>
                    )}
                  </span>
                ),
              },
              // عمود الإجراء يظهر فقط حين يوجد رابطٌ للسجل — كما كان بالضبط.
              ...(link
                ? ([
                    {
                      id: "actions",
                      header: "إجراء",
                      enableSorting: false,
                      meta: { kind: "actions" },
                      cell: ({ row }) => (
                        <RowActions
                          mode="inline"
                          actions={[
                            {
                              key: "open",
                              kind: "view",
                              label: linkLabel,
                              href: link(row.original.id),
                              gate: { adminOnly: true },
                            },
                          ]}
                        />
                      ),
                    },
                  ] as ColumnDef<Row, unknown>[])
                : []),
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}
