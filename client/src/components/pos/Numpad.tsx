// لوحة أرقام الكاشير (كمية/٪/مبلغ) القابلة للطيّ.
// استُخرج حرفياً من client/src/pages/POS.tsx (برنامج v2 «السهل الممتنع» م١ — PR-A) بلا تغيير
// سلوكيّ: الصفحةُ العملاقة (٣٧٨٣ سطراً) قُسِّمت مكوّنياً كي تنزل تحت خطّ أساس `check:page-size`
// ومقياس الاحتكاك D4، وتبقى كلّ الحالة المالية عند الأب (POS.tsx) وتصل عبر props.

import type { NumMode, FluidFn, PosColors as C } from "./posShared";

export interface NumpadProps {
  C: C;
  fluid: FluidFn;
  blockPad: string;
  ultra: boolean;
  numMode: NumMode;
  numpadOpen: boolean;
  setNumModeAndReveal: (m: NumMode) => void;
  numPress: (k: string) => void;
}

/** لوحة الأرقام (Odoo 19) القابلة للطيّ + شريط الأوضاع المضغوط حين تُطوى. */
export function Numpad({ C, fluid, blockPad, ultra, numMode, numpadOpen, setNumModeAndReveal, numPress }: NumpadProps) {
  const modeStyle = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    height: fluid(44, 6.6, 58), minWidth: 70, padding: "0 8px",
    fontSize: 13.5, fontWeight: 800, cursor: "pointer",
    fontFamily: "inherit", borderRadius: 9,
    border: active ? `1.5px solid ${C.modeBord}` : `1.5px solid ${C.border}`,
    background: active ? C.modeActive : C.numKey,
    color: active ? C.modeFg : C.mutedFg,
    // ⚠ لا تُعِدها `all`: مع ارتفاعٍ بوحدات الحاوية يُبقي كروم القيمة القديمة عند تغيّر
    // حجم الحاوية (الانتقال لا يُعيد حلّ الوحدة) فيثبت الزرّ على مقاسٍ بائد.
    transition: "background .1s, color .1s, border-color .1s", userSelect: "none" as const, touchAction: "manipulation" as const,
  });

  const numKeyStyle = (del?: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    height: fluid(44, 6.6, 58), fontSize: fluid(19, 2.7, 24), fontWeight: 800,
    background: del ? C.delKey : C.numKey,
    color: del ? C.delFg : C.fg,
    border: `1.5px solid ${C.border}`,
    borderRadius: 9, cursor: "pointer",
    fontFamily: "inherit", direction: "ltr" as const,
    transition: "background .07s, transform .06s",
    userSelect: "none" as const, touchAction: "manipulation" as const,
  });

  return numpadOpen ? (
    <div style={{ padding: blockPad, flexShrink: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 1fr", gap: ultra ? 3 : 4, direction: "rtl" }}>
        <button style={modeStyle(numMode === "QTY")}  onClick={() => setNumModeAndReveal("QTY")}>الكمية</button>
        <button style={numKeyStyle()} onClick={() => numPress("3")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>3</button>
        <button style={numKeyStyle()} onClick={() => numPress("2")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>2</button>
        <button style={numKeyStyle()} onClick={() => numPress("1")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>1</button>

        <button style={modeStyle(numMode === "DISC")} onClick={() => setNumModeAndReveal("DISC")}>%</button>
        <button style={numKeyStyle()} onClick={() => numPress("6")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>6</button>
        <button style={numKeyStyle()} onClick={() => numPress("5")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>5</button>
        <button style={numKeyStyle()} onClick={() => numPress("4")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>4</button>

        <button style={modeStyle(numMode === "PAY")}  onClick={() => setNumModeAndReveal("PAY")}>المبلغ</button>
        <button style={numKeyStyle()} onClick={() => numPress("9")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>9</button>
        <button style={numKeyStyle()} onClick={() => numPress("8")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>8</button>
        <button style={numKeyStyle()} onClick={() => numPress("7")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>7</button>

        <button style={numKeyStyle(true)} onClick={() => numPress("⌫")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>⌫</button>
        <button style={numKeyStyle()}     onClick={() => numPress(".")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>.</button>
        <button style={numKeyStyle()}     onClick={() => numPress("0")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>0</button>
        <button style={{ ...numKeyStyle(), fontSize: 13 }} onClick={() => numPress("+/-")} onMouseDown={(e) => (e.currentTarget.style.transform = "scale(.94)")} onMouseUp={(e) => (e.currentTarget.style.transform = "")}>+/-</button>
      </div>
    </div>
  ) : (
    // شريطُ الأوضاع المضغوط — يظهر مكانَ اللوحة المطويّة كي تبقى الأوضاع قابلةً للتبديل
    // بلا استرداد اللوحة. اختيارُ «الكمية» أو «%» يعيد فتحها تلقائياً (لا مدخل لمس بديل).
    <div style={{ padding: blockPad, flexShrink: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
        <button style={{ ...modeStyle(numMode === "QTY"), height: 34, fontSize: 12 }} onClick={() => setNumModeAndReveal("QTY")}>الكمية</button>
        <button style={{ ...modeStyle(numMode === "DISC"), height: 34, fontSize: 12 }} onClick={() => setNumModeAndReveal("DISC")}>خصم %</button>
        <button style={{ ...modeStyle(numMode === "PAY"), height: 34, fontSize: 12 }} onClick={() => setNumModeAndReveal("PAY")}>المبلغ</button>
      </div>
    </div>
  );
}
