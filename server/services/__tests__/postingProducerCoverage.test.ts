import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  PROFILE_POLICIES,
  type PostingProfile,
} from "../accounting/postingEngine";

type ProducerFailure = {
  file: string;
  line: number;
  code:
    | "POST_ENTRY_ARGUMENT_NOT_LITERAL"
    | "POSTING_INTENT_MISSING"
    | "POSTING_INTENT_OPTIONAL"
    | "POSTING_INTENT_UNVERIFIABLE"
    | "POSTING_SOURCE_MISSING"
    | "POSTING_SOURCE_OPTIONAL"
    | "POSTING_SOURCE_UNVERIFIABLE"
    | "POSTING_PROFILE_UNKNOWN"
    | "POSTING_PROFILE_UNRESOLVED"
    | "POSTING_ENTRY_TYPE_MISMATCH";
  detail: string;
};

type ProfileResolution = {
  profiles: Set<string>;
  resolved: boolean;
};

const PROJECT_ROOT = process.cwd();
const LEDGER_SERVICE_SUFFIX = "/server/services/ledgerService.ts";

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolvedSymbol(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function isPostEntryCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): boolean {
  const expression = unwrapExpression(call.expression);
  const symbol = resolvedSymbol(
    checker,
    ts.isElementAccessExpression(expression)
      ? expression.argumentExpression
      : expression,
  );
  if (!symbol || symbol.getName() !== "postEntry") return false;
  return (symbol.declarations ?? []).some((declaration) =>
    normalizedPath(declaration.getSourceFile().fileName).endsWith(
      LEDGER_SERVICE_SUFFIX,
    ),
  );
}

/** Resolve only import/export aliases once, then verify each candidate's symbol.
 * Global names conservatively cover re-export chains, nested namespaces and
 * local namespace aliases without resolving unrelated call-expression types.
 */
function producerCandidateNames(
  program: ts.Program,
  checker: ts.TypeChecker,
): Set<string> {
  const names = new Set(["postEntry", "default"]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportSpecifier(node) ||
      ts.isExportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      if (
        node.name &&
        resolvedSymbol(checker, node.name)?.getName() === "postEntry"
      ) {
        names.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const source of program.getSourceFiles()) visit(source);
  return names;
}
function isProducerCandidate(
  call: ts.CallExpression,
  names: Set<string>,
): boolean {
  const expression = unwrapExpression(call.expression);
  return ts.isIdentifier(expression)
    ? names.has(expression.text)
    : ts.isPropertyAccessExpression(expression)
      ? names.has(expression.name.text)
      : ts.isElementAccessExpression(expression) &&
        ts.isStringLiteralLike(expression.argumentExpression) &&
        names.has(expression.argumentExpression.text);
}

function propertyExpression(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }
    const propertyName = property.name
      .getText(object.getSourceFile())
      .replace(/["']/g, "");
    if (propertyName !== name) continue;
    return ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name;
  }
  return undefined;
}

function typeContainsNullish(type: ts.Type): boolean {
  if (
    type.flags &
    (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)
  ) {
    return true;
  }
  return type.isUnion() && type.types.some(typeContainsNullish);
}

function typeIsUnverifiable(type: ts.Type): boolean {
  if (
    type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
  ) {
    return true;
  }
  return type.isUnion() && type.types.some(typeIsUnverifiable);
}

function finiteStringValues(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): Set<string> | null {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current)) return new Set([current.text]);
  if (ts.isConditionalExpression(current)) {
    const whenTrue = finiteStringValues(checker, current.whenTrue);
    const whenFalse = finiteStringValues(checker, current.whenFalse);
    if (!whenTrue || !whenFalse) return null;
    return new Set(Array.from(whenTrue).concat(Array.from(whenFalse)));
  }

  const type = checker.getTypeAtLocation(current);
  const members = type.isUnion() ? type.types : [type];
  const values = new Set<string>();
  for (const member of members) {
    if (!(member.flags & ts.TypeFlags.StringLiteral)) return null;
    values.add((member as ts.StringLiteralType).value);
  }
  return values.size > 0 ? values : null;
}

function directReturnExpressions(body: ts.ConciseBody): ts.Expression[] {
  if (!ts.isBlock(body)) return [body];
  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returns;
}

function mergeProfiles(parts: ProfileResolution[]): ProfileResolution {
  return {
    profiles: new Set(parts.flatMap((part) => Array.from(part.profiles))),
    resolved: parts.length > 0 && parts.every((part) => part.resolved),
  };
}

/**
 * Resolves the finite profile set for direct factories and narrow helpers that
 * return a PostingIntent. Unknown data-flow remains unknown and is never put on
 * a permanent call-site/line allowlist.
 */
function profilesForIntent(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): ProfileResolution {
  const current = unwrapExpression(expression);
  if (ts.isConditionalExpression(current)) {
    return mergeProfiles([
      profilesForIntent(checker, current.whenTrue, new Set(seen)),
      profilesForIntent(checker, current.whenFalse, new Set(seen)),
    ]);
  }

  if (ts.isCallExpression(current)) {
    const calleeSymbol = resolvedSymbol(checker, current.expression);
    if (calleeSymbol?.getName() === "createPostingIntent") {
      const profileArg = current.arguments[0];
      const profiles = profileArg
        ? finiteStringValues(checker, profileArg)
        : null;
      return profiles
        ? { profiles, resolved: true }
        : { profiles: new Set(), resolved: false };
    }
    if (!calleeSymbol || seen.has(calleeSymbol)) {
      return { profiles: new Set(), resolved: false };
    }
    seen.add(calleeSymbol);
    const returned: ProfileResolution[] = [];
    for (const declaration of calleeSymbol.declarations ?? []) {
      if (
        (ts.isFunctionDeclaration(declaration) ||
          ts.isFunctionExpression(declaration) ||
          ts.isArrowFunction(declaration) ||
          ts.isMethodDeclaration(declaration)) &&
        declaration.body
      ) {
        returned.push(
          ...directReturnExpressions(declaration.body).map((value) =>
            profilesForIntent(checker, value, new Set(seen)),
          ),
        );
      }
    }
    return mergeProfiles(returned);
  }

  if (ts.isIdentifier(current)) {
    const symbol = resolvedSymbol(checker, current);
    if (!symbol || seen.has(symbol)) {
      return { profiles: new Set(), resolved: false };
    }
    seen.add(symbol);
    const initializers = (symbol.declarations ?? []).flatMap((declaration) =>
      ts.isVariableDeclaration(declaration) && declaration.initializer
        ? [declaration.initializer]
        : [],
    );
    return mergeProfiles(
      initializers.map((value) =>
        profilesForIntent(checker, value, new Set(seen)),
      ),
    );
  }

  return { profiles: new Set(), resolved: false };
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return {
    file: normalizedPath(path.relative(PROJECT_ROOT, sourceFile.fileName)),
    line: line + 1,
  };
}

function formatFailures(failures: ProducerFailure[]): string {
  return failures
    .map(
      ({ file, line, code, detail }) => `${file}:${line} [${code}] ${detail}`,
    )
    .join("\n");
}

function createProducerProgram(): ts.Program {
  const configPath = ts.findConfigFile(
    PROJECT_ROOT,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) throw new Error("tsconfig.json is missing");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
  );
  const serverRoot = `${normalizedPath(PROJECT_ROOT)}/server/`;
  return ts.createProgram({
    // The guard is repo-wide for server producers. Client roots add no
    // postEntry call-sites and roughly double Program construction time.
    rootNames: parsed.fileNames.filter((fileName) =>
      normalizedPath(path.resolve(fileName)).startsWith(serverRoot),
    ),
    options: parsed.options,
  });
}

function collectProducerFailures(
  fixtureProgram?: ts.Program,
): ProducerFailure[] {
  const started = performance.now();
  const program = fixtureProgram ?? createProducerProgram();
  const serverRoot = `${normalizedPath(PROJECT_ROOT)}/server/`;
  const checker = program.getTypeChecker();
  const names = producerCandidateNames(program, checker);
  const constructed = performance.now();
  const failures: ProducerFailure[] = [];
  let calls = 0,
    candidates = 0,
    producers = 0;

  for (const sourceFile of program.getSourceFiles()) {
    const fileName = normalizedPath(sourceFile.fileName);
    if (
      sourceFile.isDeclarationFile ||
      !fileName.startsWith(serverRoot) ||
      fileName.includes("/__tests__/") ||
      fileName.endsWith(".test.ts")
    ) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      calls++;
      const candidate = isProducerCandidate(node, names);
      if (process.env.POSTING_COVERAGE_VERIFY_CANDIDATES === "1") {
        if (isPostEntryCall(checker, node) && !candidate)
          throw new Error(
            `Producer excluded: ${sourceFile.fileName}:${node.getStart(sourceFile)}`,
          );
      }
      if (candidate) candidates++;
      if (!candidate || !isPostEntryCall(checker, node)) {
        ts.forEachChild(node, visit);
        return;
      }
      producers++;
      const location = locationOf(sourceFile, node);
      const input = node.arguments[1];
      if (!input || !ts.isObjectLiteralExpression(unwrapExpression(input))) {
        failures.push({
          ...location,
          code: "POST_ENTRY_ARGUMENT_NOT_LITERAL",
          detail: "postEntry must receive an auditable object literal",
        });
        return;
      }
      const object = unwrapExpression(input) as ts.ObjectLiteralExpression;
      const intent = propertyExpression(object, "postingIntent");
      if (!intent) {
        failures.push({
          ...location,
          code: "POSTING_INTENT_MISSING",
          detail: "financial producer has no canonical postingIntent",
        });
        return;
      }

      const intentType = checker.getTypeAtLocation(intent);
      if (typeContainsNullish(intentType)) {
        failures.push({
          ...location,
          code: "POSTING_INTENT_OPTIONAL",
          detail: checker.typeToString(
            intentType,
            intent,
            ts.TypeFormatFlags.NoTruncation,
          ),
        });
      } else if (typeIsUnverifiable(intentType)) {
        failures.push({
          ...location,
          code: "POSTING_INTENT_UNVERIFIABLE",
          detail: checker.typeToString(
            intentType,
            intent,
            ts.TypeFormatFlags.NoTruncation,
          ),
        });
      }

      const profileResolution = profilesForIntent(checker, intent);
      for (const profile of Array.from(profileResolution.profiles)) {
        if (!(profile in PROFILE_POLICIES)) {
          failures.push({
            ...location,
            code: "POSTING_PROFILE_UNKNOWN",
            detail: profile,
          });
        }
      }

      const source = propertyExpression(object, "postingSourceComponents");
      if (source) {
        const sourceType = checker.getTypeAtLocation(source);
        const everyResolvedProfileRequiresComponents =
          profileResolution.resolved &&
          profileResolution.profiles.size > 0 &&
          Array.from(profileResolution.profiles).every(
            (profile) =>
              profile in PROFILE_POLICIES &&
              PROFILE_POLICIES[profile as PostingProfile].requireRoleComponents
                .length > 0,
          );
        // Optional components are valid only for a proven branch-correlated
        // plan whose possible profiles do not all require them (for example a
        // memo-only gift versus a mixed owned gift). A nullable intent never
        // earns that exception: there is no posting contract on that path.
        if (
          typeContainsNullish(sourceType) &&
          (typeContainsNullish(intentType) ||
            everyResolvedProfileRequiresComponents)
        ) {
          failures.push({
            ...location,
            code: "POSTING_SOURCE_OPTIONAL",
            detail: checker.typeToString(
              sourceType,
              source,
              ts.TypeFormatFlags.NoTruncation,
            ),
          });
        } else if (typeIsUnverifiable(sourceType)) {
          failures.push({
            ...location,
            code: "POSTING_SOURCE_UNVERIFIABLE",
            detail: checker.typeToString(
              sourceType,
              source,
              ts.TypeFormatFlags.NoTruncation,
            ),
          });
        }
      }

      if (!source) {
        if (!profileResolution.resolved) {
          failures.push({
            ...location,
            code: "POSTING_PROFILE_UNRESOLVED",
            detail:
              "postingSourceComponents is absent and the helper's profile set cannot be proven",
          });
        } else {
          const requiringComponents = Array.from(
            profileResolution.profiles,
          ).filter(
            (profile): profile is PostingProfile =>
              profile in PROFILE_POLICIES &&
              PROFILE_POLICIES[profile as PostingProfile].requireRoleComponents
                .length > 0,
          );
          if (requiringComponents.length > 0) {
            failures.push({
              ...location,
              code: "POSTING_SOURCE_MISSING",
              detail: requiringComponents.sort().join(", "),
            });
          }
        }
      }

      const entryType = propertyExpression(object, "entryType");
      const entryTypes = entryType
        ? finiteStringValues(checker, entryType)
        : null;
      // Multi-profile/multi-entry helpers can correlate their branches. Without
      // argument substitution, comparing their Cartesian product creates false
      // positives. Exact singletons remain statically provable and guarded.
      if (
        entryTypes?.size === 1 &&
        profileResolution.resolved &&
        profileResolution.profiles.size === 1
      ) {
        const [profile] = Array.from(profileResolution.profiles);
        const [actual] = Array.from(entryTypes);
        if (profile in PROFILE_POLICIES) {
          const expected =
            PROFILE_POLICIES[profile as PostingProfile].entryType;
          if (actual !== expected) {
            failures.push({
              ...location,
              code: "POSTING_ENTRY_TYPE_MISMATCH",
              detail: `${profile} requires ${expected}; producer emits ${actual}`,
            });
          }
        }
      }
    };
    visit(sourceFile);
  }

  if (process.env.POSTING_COVERAGE_PROFILE === "1")
    console.info(
      JSON.stringify({
        programMs: Math.round(constructed - started),
        scanMs: Math.round(performance.now() - constructed),
        calls,
        candidates,
        producers,
        exhaustive: process.env.POSTING_COVERAGE_VERIFY_CANDIDATES === "1",
      }),
    );
  return failures.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  );
}

function createAliasFixture(): ts.Program {
  const ledger = path.join(PROJECT_ROOT, "server/services/ledgerService.ts");
  const barrel = path.join(PROJECT_ROOT, "server/services/coverage-barrel.ts");
  const caller = path.join(PROJECT_ROOT, "server/services/coverage-caller.ts");
  const chain = path.join(PROJECT_ROOT, "server/services/coverage-chain.ts");
  const impostor = path.join(
    PROJECT_ROOT,
    "server/services/coverage-impostor.ts",
  );
  const sources = new Map([
    [
      normalizedPath(ledger),
      "export function postEntry(...args: unknown[]) {}",
    ],
    [
      normalizedPath(barrel),
      'export { postEntry as forward, postEntry as default } from "./ledgerService";',
    ],
    [
      normalizedPath(chain),
      `export { forward as relay } from "./coverage-barrel";
        export * from "./coverage-barrel";
        export * as nested from "./coverage-barrel";
        import * as ledger from "./ledgerService";
        export namespace scoped { export import routed = ledger.postEntry; }`,
    ],
    [
      normalizedPath(impostor),
      "export function forward(...args: unknown[]) {}",
    ],
    [
      normalizedPath(caller),
      `import { postEntry, postEntry as renamed } from "./ledgerService";
        import { forward } from "./coverage-barrel";
        import * as ledger from "./ledgerService";
        import * as barrel from "./coverage-barrel";
        import * as chain from "./coverage-chain";
        import * as impostor from "./coverage-impostor";
        import defaultProducer from "./coverage-barrel";
        import importedAlias = barrel.forward;
        postEntry(); renamed(); forward(); ledger.postEntry(); ledger["postEntry"]();
        const tx = {};
        barrel.forward(tx, {}); barrel["forward"](tx, {});
        chain.relay(tx, {}); chain["relay"](tx, {});
        chain.forward(tx, {}); chain.nested.forward(tx, {});
        const alias = chain.nested;
        alias.forward(tx, {}); alias["forward"](tx, {});
        chain.scoped.routed(tx, {}); chain.scoped["routed"](tx, {});
        barrel.default(tx, {}); defaultProducer(tx, {}); importedAlias(tx, {});
        function createPostingIntent(profile: string) { return { profile }; }
        barrel.forward(tx, { postingIntent: createPostingIntent("AFTERCARE_ISSUE_RETURN") });
        impostor.forward(tx, {}); impostor["forward"](tx, {});
        function unrelated() { function postEntry() {} postEntry(); } unrelated();`,
    ],
  ]);
  const options: ts.CompilerOptions = {
    noLib: true,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = (file) => sources.has(normalizedPath(file));
  host.readFile = (file) => sources.get(normalizedPath(file));
  host.getSourceFile = (file, languageVersion) => {
    const text = sources.get(normalizedPath(file));
    return text == null
      ? undefined
      : ts.createSourceFile(file, text, languageVersion, true);
  };
  return ts.createProgram(
    [caller, barrel, chain, impostor, ledger],
    options,
    host,
  );
}

describe("canonical double-entry producer coverage", () => {
  it("retains direct, renamed, re-exported and namespace producers while rejecting same-name impostors", () => {
    const program = createAliasFixture();
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(
      path.join(PROJECT_ROOT, "server/services/coverage-caller.ts"),
    )!;
    const names = producerCandidateNames(program, checker);
    const canonical: string[] = [],
      optimized: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        if (isPostEntryCall(checker, node))
          canonical.push(node.getText(source));
        if (isProducerCandidate(node, names) && isPostEntryCall(checker, node))
          optimized.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(canonical).toEqual([
      "postEntry()",
      "renamed()",
      "forward()",
      "ledger.postEntry()",
      'ledger["postEntry"]()',
      "barrel.forward(tx, {})",
      'barrel["forward"](tx, {})',
      "chain.relay(tx, {})",
      'chain["relay"](tx, {})',
      "chain.forward(tx, {})",
      "chain.nested.forward(tx, {})",
      "alias.forward(tx, {})",
      'alias["forward"](tx, {})',
      "chain.scoped.routed(tx, {})",
      'chain.scoped["routed"](tx, {})',
      "barrel.default(tx, {})",
      "defaultProducer(tx, {})",
      "importedAlias(tx, {})",
      'barrel.forward(tx, { postingIntent: createPostingIntent("AFTERCARE_ISSUE_RETURN") })',
    ]);
    expect(optimized).toEqual(canonical);
  });
  it("reports existing posting policy failures for renamed namespace producers", () => {
    const failures = collectProducerFailures(createAliasFixture());
    expect(
      failures.filter((failure) => failure.code === "POSTING_INTENT_MISSING"),
    ).toHaveLength(13);
    expect(
      failures.filter((failure) => failure.code === "POSTING_SOURCE_MISSING"),
    ).toHaveLength(1);
    expect(
      failures.filter((failure) => failure.code === "POSTING_SOURCE_MISSING")[0]
        ?.detail,
    ).toBe("AFTERCARE_ISSUE_RETURN");
  });
  it("keeps every postEntry producer explicit, non-optional, and independently sourced", () => {
    const failures = collectProducerFailures();
    expect(formatFailures(failures), formatFailures(failures)).toBe("");
  }, 120_000);
});
