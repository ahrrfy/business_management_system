/**
 * TermsAndNotes — terms & conditions textarea + document notes composition helpers.
 * Ported from `_design-bundle/project/invoice-footer.jsx#TermsAndNotes`.
 */
import { useEffect, useRef, useState, type Dispatch } from "react";
import { ChevronDown, ChevronUp, Scroll } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { InvoiceAction, InvoiceState } from "./types";

const PO_REF_TAG_RE = /(?:^|\n)\[مرجع أمر الشراء:\s*([^\]]+)\]/;
const TERMS_TAG_RE = /(?:^|\n)\[الشروط والأحكام:\s*([\s\S]+?)\]$/;

/**
 * يدمج الملاحظات الحرّة ومرجع أمر الشراء والشروط والأحكام في حقل `notes` المحفوظ خادمياً
 * حتى لا تضيع مدخلات المستخدم عند الحفظ («المعروض = المحفوظ»).
 */
export function composeDocumentNotes({
  notes,
  terms,
  poReference,
}: {
  notes?: string | null;
  terms?: string | null;
  poReference?: string | null;
}): string | undefined {
  const parts: string[] = [];
  const cleanNotes = (notes ?? "").trim();
  const cleanPoRef = (poReference ?? "").trim();
  const cleanTerms = (terms ?? "").trim();
  if (cleanNotes) parts.push(cleanNotes);
  if (cleanPoRef) parts.push(`[مرجع أمر الشراء: ${cleanPoRef}]`);
  if (cleanTerms) parts.push(`[الشروط والأحكام: ${cleanTerms}]`);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * يفصل حقل `notes` المحفوظ خادمياً عند إعادة التحميل (تعديل/تصحيح) إلى حقوله الثلاثة الأصلية.
 */
export function splitDocumentNotes(raw?: string | null): {
  notes: string;
  terms: string;
  poReference: string;
} {
  let working = (raw ?? "").trim();
  let terms = "";
  let poReference = "";

  const termsMatch = working.match(TERMS_TAG_RE);
  if (termsMatch) {
    terms = termsMatch[1].trim();
    working = working.slice(0, termsMatch.index).trim();
  }

  const poMatch = working.match(PO_REF_TAG_RE);
  if (poMatch) {
    poReference = poMatch[1].trim();
    working = (
      working.slice(0, poMatch.index) +
      working.slice((poMatch.index ?? 0) + poMatch[0].length)
    ).trim();
  }

  return { notes: working, terms, poReference };
}

/**
 * يستبدل نصّ الملاحظات المرئيّ مع الحفاظ على الشروط والأحكام ومرجع أمر الشراء المحفوظين داخل `notes`.
 */
export function replaceDocumentNotes(
  raw?: string | null,
  nextNotes?: string | null,
): string {
  const existing = splitDocumentNotes(raw);
  return (
    composeDocumentNotes({
      notes: nextNotes,
      terms: existing.terms,
      poReference: existing.poReference,
    }) ?? ""
  );
}

export interface TermsAndNotesProps {
  state: InvoiceState;
  dispatch: Dispatch<InvoiceAction>;
}

export function TermsAndNotes({ state, dispatch }: TermsAndNotesProps) {
  const hasTerms = Boolean(state.terms?.trim());
  const [expanded, setExpanded] = useState(hasTerms);
  const prevHadTermsRef = useRef(hasTerms);

  useEffect(() => {
    if (!prevHadTermsRef.current && hasTerms) {
      setExpanded(true);
    }
    prevHadTermsRef.current = hasTerms;
  }, [hasTerms]);

  const isOpen = expanded;

  return (
    <section className="shrink-0 rounded-lg border bg-card px-2.5 py-2">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between text-xs font-extrabold text-foreground"
      >
        <span className="inline-flex items-center gap-1.5">
          <Scroll aria-hidden className="size-3.5 text-muted-foreground" />
          الشروط والأحكام
          {hasTerms && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">
              مُضافة
            </span>
          )}
        </span>
        {isOpen ? (
          <ChevronUp aria-hidden className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        )}
      </button>
      <div className={cn("mt-1.5", !isOpen && "hidden print:block")}>
        <Textarea
          value={state.terms ?? ""}
          onChange={(e) => dispatch({ type: "SET_FIELD", field: "terms", value: e.target.value })}
          rows={2}
          placeholder="أضف شروط وأحكام... (مثال: البضاعة المباعة لا ترد ولا تستبدل)"
          className="resize-y text-xs"
        />
      </div>
    </section>
  );
}
