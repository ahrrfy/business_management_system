import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { assertApprover, planApproval, soloExecutionRecord } from "./ownerGate";

/**
 * الثابت المحروس هنا هو **أمانُ الانتقال**: إطفاءُ العلَم يجب أن يُعيد السلوك القائم
 * حرفياً — بلا فرقٍ واحد. اختبارٌ يفحص السياسة الجديدة وحدها يترك أخطر نصفٍ بلا حراسة.
 */
const FLAG = "ROLLOUT_OWNER_ONLY_APPROVAL";
const OWNER = { userId: 1, branchId: 1, isOwner: true } as const;
const STAFF = { userId: 7, branchId: 1, isOwner: false } as const;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe("العلَم مطفأ — السلوك القائم يُعاد حرفياً", () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });

  it("إطفاء العلم يبقي الموظف على المسار القديم ولا يعيد اعتمادا ثانيا على المالك", () => {
    for (const trigger of [null, "MONEY_OUT", "ERASE_EFFECT"] as const) {
      const ownerPlan = planApproval({ actor: OWNER, trigger });
      expect(ownerPlan.executeNow, `owner/${trigger}`).toBe(true);
      expect(ownerPlan.underNewPolicy).toBe(true);

      const staffPlan = planApproval({ actor: STAFF, trigger });
      expect(staffPlan.executeNow, `staff/${trigger}`).toBe(false);
      expect(staffPlan.underNewPolicy).toBe(false);
    }
  });

  it("assertApprover تبقي الفحص القديم للموظف وتتجاوزه للمالك", () => {
    const legacy = vi.fn();
    assertApprover({ actor: OWNER, trigger: "MONEY_OUT", subject: "س", legacy });
    assertApprover({ actor: STAFF, trigger: "MONEY_OUT", subject: "س", legacy });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("ورميُ الفحص القديم يمرّ كما هو — لا تبتلعه البوّابة", () => {
    const boom = () => {
      throw new Error("فصل المهام القديم");
    };
    expect(() => assertApprover({ actor: OWNER, trigger: "MONEY_OUT", subject: "س", legacy: boom })).not.toThrow();
    expect(() => assertApprover({ actor: STAFF, trigger: "MONEY_OUT", subject: "س", legacy: boom })).toThrow("فصل المهام القديم");
  });
});

describe("العلَم مفتوح — شخصان لا أكثر", () => {
  beforeEach(() => {
    process.env[FLAG] = "ON";
  });

  it("لا خروجَ مالٍ ولا محوَ أثر ⇒ يُنفَّذ فوراً بلا طلبٍ ولا اعتماد", () => {
    const plan = planApproval({ actor: STAFF, trigger: null });
    expect(plan.outcome).toBe("NOT_REQUIRED");
    expect(plan.executeNow).toBe(true);
  });

  it("موظّفٌ + لحظةُ خطر ⇒ طلبٌ ينتظر المالك", () => {
    const plan = planApproval({ actor: STAFF, trigger: "MONEY_OUT" });
    expect(plan.outcome).toBe("NEEDS_OWNER");
    expect(plan.executeNow).toBe(false);
  });

  it("المالك + لحظةُ خطر ⇒ اعتمادٌ تلقائيّ ينفَّذ فوراً", () => {
    const plan = planApproval({ actor: OWNER, trigger: "ERASE_EFFECT" });
    expect(plan.outcome).toBe("AUTO_SELF_APPROVED");
    expect(plan.executeNow).toBe(true);
  });

  it("المالك يعتمد ولو كان هو المنشئ — ولا يُستدعى الفحص القديم إطلاقاً", () => {
    const legacy = vi.fn(() => {
      throw new Error("ما كان يجب أن يُستدعى");
    });
    expect(() =>
      assertApprover({ actor: OWNER, trigger: "MONEY_OUT", subject: "طلب دفع SP-42", legacy }),
    ).not.toThrow();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("غيرُ المالك لا يعتمد — ورسالتُه تقول ماذا يفعل وأين يجده", () => {
    let msg = "";
    try {
      assertApprover({ actor: STAFF, trigger: "MONEY_OUT", subject: "طلب دفع SP-42", legacy: () => {} });
    } catch (e) {
      msg = (e as { message: string }).message;
    }
    expect(msg).toContain("طلب دفع SP-42");
    expect(msg).toContain("اعتماد المالك");
    expect(msg).toContain("مطلوب مني الآن");
  });

  it("⭐ trigger = null ⇒ لا بوّابةَ إطلاقاً — يمرّ الموظّف بلا اعتماد", () => {
    const legacy = vi.fn();
    expect(() =>
      assertApprover({ actor: STAFF, trigger: null, subject: "ترحيل فاتورة مورّد", legacy }),
    ).not.toThrow();
    // ولا يُستدعى الفحص القديم: البوّابة **حُذفت** لا استُبدلت.
    expect(legacy).not.toHaveBeenCalled();
  });

  it("قيمةٌ غير مفهومة في العلَم ⇒ يُعامَل مطفأً (يفشل مغلقاً)", () => {
    process.env[FLAG] = "نعم";
    const legacy = vi.fn();
    assertApprover({ actor: STAFF, trigger: "MONEY_OUT", subject: "س", legacy });
    expect(legacy).toHaveBeenCalledOnce();
  });
});

describe("سجلّ «نُفِّذ بشخصٍ واحد» — التقريرُ يحلّ محلّ الفصل", () => {
  beforeEach(() => {
    process.env[FLAG] = "ON";
  });

  it("يُسجَّل ما اعتمده المالك على نفسه", () => {
    const plan = planApproval({ actor: OWNER, trigger: "MONEY_OUT" });
    const rec = soloExecutionRecord({
      actor: { userId: 1, branchId: 1, isOwner: true },
      plan,
      trigger: "MONEY_OUT",
      subject: "صرف ٢٥٠٬٠٠٠",
    });
    expect(rec).not.toBeNull();
    expect(rec?.outcome).toBe("AUTO_SELF_APPROVED");
    expect(rec?.actorUserId).toBe(1);
  });

  it("ويُسجَّل ما نفّذه موظّفٌ وحده بلا بوّابة", () => {
    const plan = planApproval({ actor: STAFF, trigger: null });
    const rec = soloExecutionRecord({
      actor: { userId: 7, branchId: 1, isOwner: false },
      plan,
      trigger: null,
      subject: "استلام بضاعة GRN-9",
    });
    expect(rec?.outcome).toBe("NOT_REQUIRED");
  });

  it("ولا يُسجَّل ما ينتظر المالك — لأنّه لم يُنفَّذ بعد", () => {
    const plan = planApproval({ actor: STAFF, trigger: "MONEY_OUT" });
    expect(
      soloExecutionRecord({
        actor: { userId: 7, branchId: 1, isOwner: false },
        plan,
        trigger: "MONEY_OUT",
        subject: "س",
      }),
    ).toBeNull();
  });
});

describe("الضابطُ المُستبقى بقرار مالك — retainLegacy", () => {
  beforeEach(() => {
    process.env[FLAG] = "ON";
  });

  it("⭐ يُنفَّذ الضابطُ القائم رغم أنّ التصنيف null والسياسةُ الجديدة تعمل", () => {
    // سندُ القبض العاديّ: لا مالَ يخرج ولا أثرَ يُمحى ⇒ تصنيفُه null. وبلا الاستبقاء كان
    // تشغيلُ السياسة يُسقط **الضابط الوحيد** على نقدٍ مجهول المصدر يدخل الخزينة.
    const legacy = vi.fn();
    assertApprover({ actor: STAFF, trigger: null, subject: "سند V-1", legacy, retainLegacy: true });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("ورميُ الضابط المُستبقى يمرّ كما هو — الاستبقاء ليس تخفيفاً", () => {
    const legacy = () => {
      throw new Error("لا يجوز اعتماد سند أنشأته بنفسك");
    };
    expect(() =>
      assertApprover({ actor: STAFF, trigger: null, subject: "سند V-1", legacy, retainLegacy: true }),
    ).toThrow(/أنشأته بنفسك/);
  });

  it("المالك مستثنى منه لأن فعله نفسه هو الموافقة النهائية", () => {
    const legacy = vi.fn();
    assertApprover({ actor: OWNER, trigger: null, subject: "سند V-1", legacy, retainLegacy: true });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("وبلا العلَم لا فرق — الضابطُ يعمل في الوضعين", () => {
    delete process.env[FLAG];
    const legacy = vi.fn();
    assertApprover({ actor: STAFF, trigger: null, subject: "سند V-1", legacy, retainLegacy: true });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("ولا يُزدوج على فعلٍ له مُطلِقٌ أصلاً: الضابطُ ثمّ البوّابة معاً", () => {
    // صرفٌ (MONEY_OUT) مع استبقاء: يُنفَّذ الضابط القديم **ثمّ** تُطبَّق البوّابة الجديدة —
    // فلا يُفلت غيرُ المالك بحجّة أنّ الضابط القديم مرّ.
    const legacy = vi.fn();
    expect(() =>
      assertApprover({ actor: STAFF, trigger: "MONEY_OUT", subject: "سند V-2", legacy, retainLegacy: true }),
    ).toThrow(/المالك/);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("والسلوك بلا retainLegacy لم يتغيّر — null يمرّ بلا استدعاء الضابط", () => {
    const legacy = vi.fn();
    assertApprover({ actor: STAFF, trigger: null, subject: "س", legacy });
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe("عقدُ الوصل — لا يبلغ البوّابةَ فاعلٌ لم تُحسَم ملكيّتُه من القاعدة", () => {
  /**
   * ⭐ هذا الاختبار يُغلق **النصف الذي لا يمسكه النوع**.
   *
   * جعلُ `isOwner` إلزاميةً في `ResolvedApprovalActor` يمنع تمريرَ `Actor` خامّاً (يُحمِّر
   * `tsc` — وهو ما كشف ثمانيةَ عشرَ موضعاً معطوباً صامتاً). لكنّه **لا يمنع إسكاتَه كذباً**:
   * `actor: { ...actor, isOwner: actor.isOwner === true }` يُرضي النوعَ ويُعيد العطبَ نفسَه،
   * لأنّ `undefined` تصير `false` فيُرفَض المالكُ الحقيقيّ.
   *
   * الجذرُ المقيس: **٥٥ من ٦٤ راوتراً** تبني الفاعل بلا `isOwner`. ولذلك المصدرُ المقبول
   * واحدٌ لا غير: `resolveApprovalActor(tx, actor)` — تقرأ `users.isOwner` و`isActive` داخل
   * المعاملة نفسها، فلا راوترَ ينسى ولا حمولةَ طلبٍ تدّعي.
   */
  function approvalSites(src: string, file: string) {
    const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const imports = new Map<string, string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || !/(?:approval\/ownerGate|\.\/ownerGate)$/.test(statement.moduleSpecifier.text)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        imports.set(binding.name.text, (binding.propertyName ?? binding.name).text);
      }
    }
    function resolved(expression: ts.Expression, call: ts.Node, seen = new Set<ts.Node>()): boolean {
      if (seen.has(expression)) return false;
      seen = new Set(Array.from(seen).concat(expression));
      if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression))
        return resolved(expression.expression, call, seen);
      if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        return resolved(expression.right, call, seen);
      if (ts.isCallExpression(expression)) {
        let callee: ts.Expression = expression.expression;
        while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
        if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
          if (!ts.isBlock(callee.body)) return resolved(callee.body, callee, seen);
          const returns: ts.ReturnStatement[] = [];
          const visitReturns = (node: ts.Node) => {
            if (ts.isFunctionLike(node)) return;
            if (ts.isReturnStatement(node)) returns.push(node);
            else ts.forEachChild(node, visitReturns);
          };
          ts.forEachChild(callee.body, visitReturns);
          return returns.length > 0 && returns.every(node => node.expression && resolved(node.expression, node, seen));
        }
        return ts.isIdentifier(callee) && imports.get(callee.text) === "resolveApprovalActor"
          && expression.arguments[0]?.getText(source) === "tx"
          && expression.arguments[1]?.getText(source) === "actor";
      }
      if (!ts.isIdentifier(expression)) return false;
      // Only a preceding immutable binding in this callback's lexical scope is proof.
      // A resolver in another branch/function, or a mutable/forged binding, is not.
      for (let scope: ts.Node | undefined = call.parent; scope; scope = scope.parent) {
        if (ts.isBlock(scope)) {
          for (const statement of scope.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            const declaration = statement.declarationList.declarations.find(d => ts.isIdentifier(d.name) && d.name.text === expression.text);
            if (declaration) return statement.getStart(source) < call.getStart(source)
              && Boolean(statement.declarationList.flags & ts.NodeFlags.Const)
              && Boolean(declaration.initializer && resolved(declaration.initializer, call, seen));
          }
        }
        if (ts.isFunctionLike(scope)) break;
      }
      return false;
    }
    const sites: Array<{ file: string; snippet: string; resolved: boolean }> = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && imports.get(node.expression.text) === "assertApprover") {
        const input = node.arguments[0];
        const actor = input && ts.isObjectLiteralExpression(input)
          ? input.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === "actor") : undefined;
        sites.push({ file, snippet: node.getText(source), resolved: Boolean(actor && ts.isPropertyAssignment(actor) && resolved(actor.initializer, node)) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return sites;
  }

  function serviceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        out.push(...serviceFiles(full));
      } else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  const ROOT = join(__dirname, "..");
  const sites: ReturnType<typeof approvalSites> = [];
  for (const file of serviceFiles(ROOT)) {
    const src = readFileSync(file, "utf8");
    // ⚠️ قيدٌ ضروريّ: `inventory/adjustmentApproval.ts` فيه دالّةٌ **محلّية** بالاسم نفسه
    // وتوقيعٍ مختلف تماماً. بلا هذا الشرط يُنذر الاختبارُ كذباً على شيفرةٍ لا علاقة لها.
    if (!/from "[^"]*approval\/ownerGate"/.test(src) && !/from "\.\/ownerGate"/.test(src)) continue;
    sites.push(...approvalSites(src, file.slice(ROOT.length + 1).split("\\").join("/")));
  }

  it("تُوجد مواضعُ وصلٍ فعلاً — وإلّا كان الاختبار أخضرَ على الفراغ", () => {
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });

  it("⭐ كلُّ موضعٍ يمرّ بـresolveApprovalActor — لا فاعلَ خامّ ولا حسمٌ يدويّ", () => {
    const offenders = sites.filter((s) => !s.resolved);
    expect(offenders.map((o) => `${o.file}: ${o.snippet.slice(0, 90)}`)).toEqual([]);
  });

  it("يتتبع الربط الثابت نفسه ويرفض إثباتا غير متعلق أو مزورا أو خارج النطاق", () => {
    const scan = (body: string) => approvalSites(`import { assertApprover, resolveApprovalActor } from "./ownerGate"; async function run(tx, actor) { ${body} }`, "control.ts").map(s => s.resolved);
    expect(scan("const approved = await resolveApprovalActor(tx, actor); assertApprover({ actor: approved });")).toEqual([true]);
    expect(scan("assertApprover({ actor: await resolveApprovalActor(tx, actor) });")).toEqual([true]);
    expect(scan("assertApprover({ actor: await (async () => { const approved = await resolveApprovalActor(tx, actor); return approved; })() });")).toEqual([true]);
    for (const body of [
      "const unrelated = await resolveApprovalActor(tx, actor); assertApprover({ actor });",
      "const approved = { ...actor, isOwner: actor.isOwner === true }; assertApprover({ actor: approved });",
      "if (true) { const approved = await resolveApprovalActor(tx, actor); } assertApprover({ actor: approved });",
      "assertApprover({ actor: approved }); const approved = await resolveApprovalActor(tx, actor);",
      "let approved = await resolveApprovalActor(tx, actor); approved = actor; assertApprover({ actor: approved });",
      "const approved = await resolveApprovalActor(otherTx, actor); assertApprover({ actor: approved });",
      "assertApprover({ actor: await (async () => { const approved = await resolveApprovalActor(tx, actor); if (actor.isOwner) return actor; return approved; })() });",
    ]) expect(scan(body), body).toEqual([false]);
  });

  it("ولا يُحسَم بـ`=== true` يدوياً — يُرضي النوعَ ويُعيد العطب", () => {
    const faked = sites.filter((s) => /isOwner:\s*[^,\n]*===\s*true/.test(s.snippet));
    expect(faked.map((o) => o.file)).toEqual([]);
  });
});
