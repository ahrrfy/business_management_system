/**
 * InvoiceHeader — top header card with document metadata, entity picker,
 * financial terms and references.
 * Ported from `_design-bundle/project/invoice-header.jsx#InvoiceHeader`.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type { Dispatch } from "react";
import {
  FileText, Hash, Calendar, Building, User, Factory, Wallet, Tag,
  ClipboardList, Clock, DollarSign, UserCheck, Pin, CalendarDays, NotebookPen,
  type LucideIcon,
} from "lucide-react";
import { EntityPicker } from "./EntityPicker";
import {
  CURRENCIES,
  INVOICE_TYPES,
  PAYMENT_TERMS,
  TIER_OPTIONS,
  type Currency,
  type InvoiceAction,
  type InvoiceState,
  type InvoiceType,
  type PaymentTerm,
  type PriceTier,
} from "./types";

export interface InvoiceHeaderProps {
  state: InvoiceState;
  dispatch: Dispatch<InvoiceAction>;
  invoiceType: InvoiceType;
  /** Optional sales reps list (id+name). When empty, the field is hidden. */
  salesReps?: Array<{ id: number; name: string }>;
}

function FieldGroup({
  label,
  icon: Icon,
  required,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon aria-hidden className="size-3.5 opacity-70" />}
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
    </div>
  );
}

function HeaderSection({
  title,
  icon: Icon,
  children,
  columnsClass,
}: {
  title: string;
  icon?: LucideIcon;
  children: React.ReactNode;
  columnsClass?: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-primary">
        {Icon && <Icon aria-hidden className="size-4" />}
        {title}
        <div className="ms-1 h-px flex-1 bg-border" />
      </div>
      <div className={cn("grid items-end gap-x-3 gap-y-2", columnsClass ?? "grid-cols-1 md:grid-cols-2 lg:grid-cols-4")}>
        {children}
      </div>
    </div>
  );
}

export function InvoiceHeader({ state, dispatch, invoiceType, salesReps }: InvoiceHeaderProps) {
  const typeInfo = INVOICE_TYPES[invoiceType];
  const isSale = invoiceType === "SALE" || invoiceType === "QUOTATION" || invoiceType === "SALE_RETURN";
  const isPurchase = invoiceType === "PURCHASE" || invoiceType === "PURCHASE_RETURN";
  const isQuote = invoiceType === "QUOTATION";
  const isReturn = invoiceType === "SALE_RETURN" || invoiceType === "PURCHASE_RETURN";

  const branches = trpc.branches.list.useQuery();

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* Title bar */}
      <header
        className="flex items-center justify-between border-b px-4 py-2.5"
        style={{ background: `linear-gradient(135deg, ${typeInfo.colorHex}0a, transparent)` }}
      >
        <div className="flex items-center gap-2">
          <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg text-white", typeInfo.colorBg)}>
            <typeInfo.icon aria-hidden className="size-4" />
          </div>
          <span className="text-base font-extrabold text-foreground">{typeInfo.label}</span>
          <span className="rounded-md border border-amber-300/40 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">
            مسوّدة
          </span>
        </div>
        <div className="text-xs font-semibold text-muted-foreground" dir="ltr">
          {state.invoiceNumber}
        </div>
      </header>

      {/* Sections */}
      <div className="flex flex-col gap-3.5 px-4 pb-3.5 pt-3">
        <HeaderSection title="بيانات المستند" icon={FileText} columnsClass="grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <FieldGroup label="رقم المستند" icon={Hash}>
            <Input value={state.invoiceNumber} readOnly className="bg-muted font-bold" />
          </FieldGroup>

          <FieldGroup label="التاريخ" icon={Calendar}>
            <Input
              type="date"
              dir="ltr"
              value={state.date}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "date", value: e.target.value })}
            />
          </FieldGroup>

          <FieldGroup label="الفرع" icon={Building}>
            <Select
              value={String(state.branchId)}
              onValueChange={(v) => dispatch({ type: "SET_FIELD", field: "branchId", value: Number(v) })}
            >
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {(branches.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldGroup>

          <FieldGroup label={isSale ? "العميل" : "المورد"} icon={isSale ? User : Factory} required>
            <EntityPicker
              type={invoiceType}
              selectedId={state.entityId}
              onSelect={(id) => dispatch({ type: "SET_ENTITY", id })}
            />
          </FieldGroup>
        </HeaderSection>

        <HeaderSection title="الشروط المالية والمراجع" icon={Wallet} columnsClass="grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          {isSale && (
            <FieldGroup label="فئة السعر" icon={Tag}>
              <Select
                value={state.tier}
                onValueChange={(v) => dispatch({ type: "SET_FIELD", field: "tier", value: v as PriceTier })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIER_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldGroup>
          )}

          <FieldGroup label="شروط الدفع" icon={ClipboardList}>
            <Select
              value={state.paymentTerms}
              onValueChange={(v) => dispatch({ type: "SET_FIELD", field: "paymentTerms", value: v as PaymentTerm })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_TERMS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldGroup>

          {(state.paymentTerms === "CREDIT" || state.paymentTerms === "INSTALLMENT") && (
            <FieldGroup label="تاريخ الاستحقاق" icon={Clock}>
              <Input
                type="date"
                dir="ltr"
                value={state.dueDate}
                onChange={(e) => dispatch({ type: "SET_FIELD", field: "dueDate", value: e.target.value })}
              />
            </FieldGroup>
          )}

          <FieldGroup label="العملة" icon={DollarSign}>
            <Select
              value={state.currency}
              onValueChange={(v) => dispatch({ type: "SET_FIELD", field: "currency", value: v as Currency })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldGroup>

          {isSale && !isReturn && salesReps && salesReps.length > 0 && (
            <FieldGroup label="مندوب المبيعات" icon={UserCheck}>
              <Select
                value={state.salesRepId ? String(state.salesRepId) : ""}
                onValueChange={(v) => dispatch({ type: "SET_FIELD", field: "salesRepId", value: v ? Number(v) : "" })}
              >
                <SelectTrigger><SelectValue placeholder="— اختياري —" /></SelectTrigger>
                <SelectContent>
                  {salesReps.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldGroup>
          )}

          {isReturn && (
            <FieldGroup label="رقم الفاتورة المرجعية" icon={Pin} required>
              <Input
                value={state.refInvoice}
                onChange={(e) => dispatch({ type: "SET_FIELD", field: "refInvoice", value: e.target.value })}
                placeholder="INV-2406-XXXX"
              />
            </FieldGroup>
          )}

          {isPurchase && (
            <FieldGroup label="رقم أمر الشراء المرجعي" icon={Pin}>
              <Input
                value={state.poReference}
                onChange={(e) => dispatch({ type: "SET_FIELD", field: "poReference", value: e.target.value })}
                placeholder="PO-REF"
              />
            </FieldGroup>
          )}

          {isQuote && (
            <FieldGroup label="صالح حتى" icon={CalendarDays}>
              <Input
                type="date"
                dir="ltr"
                value={state.validUntil}
                onChange={(e) => dispatch({ type: "SET_FIELD", field: "validUntil", value: e.target.value })}
              />
            </FieldGroup>
          )}

          <FieldGroup label="ملاحظات" icon={NotebookPen}>
            <Input
              value={state.notes}
              onChange={(e) => dispatch({ type: "SET_FIELD", field: "notes", value: e.target.value })}
              placeholder="أضف ملاحظة..."
            />
          </FieldGroup>
        </HeaderSection>
      </div>
    </section>
  );
}
