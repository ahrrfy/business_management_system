import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walkClientFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...walkClientFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface ExtractedCall {
  argsText: string;
  startIndex: number;
}

/**
 * يستخرج استدعاءات `hookName(...)` بتوازن أقواس حقيقي يتجاوز النصوص والتعليقات والأقواس المتداخلة،
 * فلا ينكسر مع الأجسام الكتلية `{ ... }` ولا يبتلع استدعاءات `useEffect` متجاورة.
 */
function extractHookCalls(source: string, hookName: string): ExtractedCall[] {
  const results: ExtractedCall[] = [];
  const callRe = new RegExp(`\\b${hookName}\\s*(?:<[^>]*>)?\\s*\\(`, "g");

  for (const match of source.matchAll(callRe)) {
    const startIndex = match.index ?? 0;
    const openParenIndex = startIndex + match[0].length - 1;
    let depth = 1;
    let i = openParenIndex + 1;

    while (i < source.length && depth > 0) {
      const ch = source[i];
      const next = source[i + 1];

      if (ch === "/" && next === "/") {
        i += 2;
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === quote) {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === "`") {
        i++;
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === "`") {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }

    if (depth === 0) {
      results.push({
        argsText: source.slice(openParenIndex + 1, i - 1),
        startIndex,
      });
    }
  }
  return results;
}

/** يفصل المعامل الأول (الدالة) عن المعامل الثاني (مصفوفة الاعتماديات) على المستوى الأعلى. */
function splitCallbackAndDeps(argsText: string): { callback: string; deps: string | null } {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let lastTopComma = -1;

  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    const next = argsText[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < argsText.length && argsText[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < argsText.length && !(argsText[i] === "*" && argsText[i + 1] === "/")) i++;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const q = ch;
      i++;
      while (i < argsText.length) {
        if (argsText[i] === "\\") {
          i += 2;
          continue;
        }
        if (argsText[i] === q) break;
        i++;
      }
      continue;
    }
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket--;
    else if (ch === "," && paren === 0 && brace === 0 && bracket === 0) {
      const rest = argsText.slice(i + 1).trim();
      if (rest.length > 0) {
        lastTopComma = i;
      }
    }
  }

  if (lastTopComma < 0) {
    return { callback: argsText.trim(), deps: null };
  }
  const callback = argsText.slice(0, lastTopComma).trim();
  const rawDeps = argsText.slice(lastTopComma + 1).trim().replace(/,\s*$/, "").trim();
  if (!rawDeps.startsWith("[") || !rawDeps.endsWith("]")) {
    return { callback, deps: null };
  }
  return { callback, deps: rawDeps.slice(1, -1) };
}

function allocatesFreshArrayInMemoCallback(callback: string): boolean {
  const arrowIdx = callback.indexOf("=>");
  if (arrowIdx < 0) return false;
  const body = callback.slice(arrowIdx + 2).trim();
  if (body.startsWith("{")) {
    return /\breturn\s+(?:Array\.from\s*\(|\[\s*(?:\.\.\.|\w)|[\w.?]+\.(?:map|filter|slice|flatMap)\s*\()/.test(
      body,
    );
  }
  return /^(?:Array\.from\s*\(|\[\s*(?:\.\.\.|\w)|[\w.?]+\.(?:map|filter|slice|flatMap)\s*\()/.test(
    body,
  );
}

export function findUnstableArrayEffectLoops(source: string, relPath: string): string[] {
  const violations: string[] = [];
  const unstableArrayMemos = new Set<string>();

  const varMemoRe = /const\s+(\w+)\s*=\s*useMemo\s*(?:<[^>]*>)?\s*\(/g;
  for (const match of source.matchAll(varMemoRe)) {
    const varName = match[1];
    const hookSlice = source.slice(match.index ?? 0);
    const [call] = extractHookCalls(hookSlice, "useMemo");
    if (!call) continue;
    const { callback, deps } = splitCallbackAndDeps(call.argsText);
    if (!deps) continue;
    const depTokens = deps.split(",").map((d) => d.trim());
    const dependsOnItemsState = depTokens.some(
      (d) => d === "state.items" || d === "items" || d === "tabs",
    );
    if (dependsOnItemsState && allocatesFreshArrayInMemoCallback(callback)) {
      unstableArrayMemos.add(varName);
    }
  }

  if (unstableArrayMemos.size === 0) return violations;

  for (const effectCall of extractHookCalls(source, "useEffect")) {
    const { callback, deps } = splitCallbackAndDeps(effectCall.argsText);
    if (!deps) continue;
    if (!/\b(?:dispatch|set[A-Z]\w*)\s*\(/.test(callback)) continue;
    const depTokens = deps
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    for (const dep of depTokens) {
      if (unstableArrayMemos.has(dep)) {
        const line = source.slice(0, effectCall.startIndex).split("\n").length;
        violations.push(
          `${relPath}:${line} يضع المصفوفة غير المستقرة مرجعياً «${dep}» في اعتماديات useEffect يحدّث الحالة — اشتق مفتاحاً نصياً بدائياً أولاً`,
        );
      }
    }
  }

  return violations;
}

describe("حارس منع حلقات التصيير اللانهائية في React Hooks", () => {
  it("يمسك كلا النمطين المختصر والكتلي لـ useMemo حتى بوجود useEffect مجاورة بلا مصفوفة اعتماديات", () => {
    const buggyConcise = `
      const allStockUnitIds = useMemo(
        () => Array.from(new Set(state.items.map((i) => i.productUnitId))),
        [state.items],
      );
      useEffect(() => {
        document.title = "test";
      });
      useEffect(() => {
        if (data) {
          dispatch({ type: "SET_STOCK_SNAPSHOTS", snapshotsByUnitId: {} });
        }
      }, [data, allStockUnitIds, branchId]);
    `;
    expect(findUnstableArrayEffectLoops(buggyConcise, "BuggyConcise.tsx")).toHaveLength(1);

    const buggyBlock = `
      const unitIds = useMemo(() => {
        const ids = new Set<number>();
        for (const item of items) {
          ids.add(item.productUnitId);
        }
        return Array.from(ids);
      }, [items, branchId]);
      useEffect(() => {
        setSnapshots({});
      }, [unitIds]);
    `;
    expect(findUnstableArrayEffectLoops(buggyBlock, "BuggyBlock.tsx")).toHaveLength(1);

    const safePrimitiveKey = `
      const unitIdsKey = useMemo(() => items.map((i) => i.productUnitId).join(","), [items]);
      const unitIds = useMemo(() => (unitIdsKey ? unitIdsKey.split(",").map(Number) : []), [unitIdsKey]);
      useEffect(() => {
        dispatch({ type: "SET_STOCK_SNAPSHOTS", snapshotsByUnitId: {} });
      }, [unitIds]);
    `;
    expect(findUnstableArrayEffectLoops(safePrimitiveKey, "SafeHook.ts")).toEqual([]);
  });

  it("يفحص كامل ملفات client/src ويمنع وجود أي حلقة useMemo -> useEffect نشطة", () => {
    const clientRoot = path.resolve(process.cwd(), "client/src");
    const violations: string[] = [];

    for (const file of walkClientFiles(clientRoot)) {
      const source = readFileSync(file, "utf8");
      const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
      violations.push(...findUnstableArrayEffectLoops(source, rel));
    }

    expect(violations).toEqual([]);
  });
});
