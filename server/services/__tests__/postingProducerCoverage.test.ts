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
  const symbol = resolvedSymbol(checker, call.expression);
  if (!symbol || symbol.getName() !== "postEntry") return false;
  return (symbol.declarations ?? []).some((declaration) =>
    normalizedPath(declaration.getSourceFile().fileName).endsWith(
      LEDGER_SERVICE_SUFFIX,
    ),
  );
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
    return new Set([...whenTrue, ...whenFalse]);
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
    profiles: new Set(parts.flatMap((part) => [...part.profiles])),
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

function collectProducerFailures(): ProducerFailure[] {
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
  const program = ts.createProgram({
    // The guard is repo-wide for server producers. Client roots add no
    // postEntry call-sites and roughly double Program construction time.
    rootNames: parsed.fileNames.filter((fileName) =>
      normalizedPath(path.resolve(fileName)).startsWith(serverRoot),
    ),
    options: parsed.options,
  });
  const checker = program.getTypeChecker();
  const failures: ProducerFailure[] = [];

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
      if (!ts.isCallExpression(node) || !isPostEntryCall(checker, node)) {
        ts.forEachChild(node, visit);
        return;
      }
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
      for (const profile of profileResolution.profiles) {
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
          [...profileResolution.profiles].every(
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
          const requiringComponents = [...profileResolution.profiles].filter(
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
        const [profile] = [...profileResolution.profiles];
        const [actual] = [...entryTypes];
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

  return failures.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  );
}

describe("canonical double-entry producer coverage", () => {
  it(
    "keeps every postEntry producer explicit, non-optional, and independently sourced",
    () => {
      const failures = collectProducerFailures();
      expect(formatFailures(failures), formatFailures(failures)).toBe("");
    },
    60_000,
  );
});
