/**
 * ShortcutsBar — strip of keyboard shortcut hints at the bottom of the editor.
 * Ported from `_design-bundle/project/invoice-app.jsx#ShortcutsBar`.
 */
import { Kbd } from "@/components/ui/kbd";

export interface ShortcutsBarProps {
  /** Optionally override the default set (Arabic labels). */
  shortcuts?: Array<{ key: string; label: string }>;
}

const DEFAULT_SHORTCUTS = [
  { key: "F2", label: "بحث" },
  { key: "F4", label: "حفظ" },
  { key: "F9", label: "طباعة" },
  { key: "F12", label: "تفريغ" },
  { key: "Esc", label: "إلغاء" },
];

export function ShortcutsBar({ shortcuts = DEFAULT_SHORTCUTS }: ShortcutsBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t bg-muted px-5 py-1.5">
      <span className="text-[11px] font-semibold text-muted-foreground">⌨️ اختصارات:</span>
      {shortcuts.map((s) => (
        <div key={s.key} className="flex items-center gap-1">
          <Kbd className="text-[11px] font-bold">{s.key}</Kbd>
          <span className="text-[11px] text-muted-foreground">{s.label}</span>
        </div>
      ))}
    </div>
  );
}
