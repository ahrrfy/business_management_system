/**
 * TermsAndNotes — terms & conditions textarea.
 * Ported from `_design-bundle/project/invoice-footer.jsx#TermsAndNotes`.
 */
import type { Dispatch } from "react";
import { Textarea } from "@/components/ui/textarea";
import type { InvoiceAction, InvoiceState } from "./types";

export interface TermsAndNotesProps {
  state: InvoiceState;
  dispatch: Dispatch<InvoiceAction>;
}

export function TermsAndNotes({ state, dispatch }: TermsAndNotesProps) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-extrabold">📜 الشروط والأحكام</div>
      <Textarea
        value={state.terms ?? ""}
        onChange={(e) => dispatch({ type: "SET_FIELD", field: "terms", value: e.target.value })}
        rows={3}
        placeholder="أضف شروط وأحكام... (مثال: البضاعة المباعة لا ترد ولا تستبدل)"
        className="resize-y text-xs"
      />
    </section>
  );
}
