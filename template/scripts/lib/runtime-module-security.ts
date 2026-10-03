import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { Plugin } from "vite";

const AMBIENT_WORKERS_MODULE = "cloudflare:workers";
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/i;
const INTRINSIC_LOCKDOWN_MODULE =
  "virtual:cloudchef-security-intrinsics-lockdown";
const RESOLVED_INTRINSIC_LOCKDOWN_MODULE = `\0${INTRINSIC_LOCKDOWN_MODULE}`;

export const RUNTIME_INTRINSIC_LOCKDOWN_SOURCE = `
const freeze = Object.freeze;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const objectPrototype = Object.prototype;
const functionPrototype = Function.prototype;
const protectedGlobalBindings = [
  "crypto",
  "Boolean",
  "Date",
  "Math",
  "Object",
  "Reflect",
  "Array",
  "ArrayBuffer",
  "Uint8Array",
  "TextEncoder",
  "String",
  "Number",
  "RegExp",
  "URL",
  "Request",
  "Response",
  "Headers",
  "Promise",
  "JSON",
  "btoa",
];
for (const name of protectedGlobalBindings) {
  const descriptor = getOwnPropertyDescriptor(globalThis, name);
  if (!descriptor) continue;
  defineProperty(
    globalThis,
    name,
    "value" in descriptor
      ? { ...descriptor, writable: false, configurable: false }
      : { ...descriptor, configurable: false },
  );
}
const protectedValues = [
  globalThis.crypto?.subtle,
  globalThis.crypto,
  globalThis.Boolean,
  globalThis.Boolean?.prototype,
  globalThis.Date,
  globalThis.Date?.prototype,
  globalThis.Math,
  globalThis.Object,
  globalThis.Reflect,
  globalThis.Array,
  globalThis.Array?.prototype,
  globalThis.ArrayBuffer,
  globalThis.ArrayBuffer?.prototype,
  globalThis.Uint8Array,
  globalThis.Uint8Array?.prototype,
  globalThis.TextEncoder,
  globalThis.TextEncoder?.prototype,
  globalThis.String,
  globalThis.String?.prototype,
  globalThis.Number,
  globalThis.Number?.prototype,
  globalThis.RegExp,
  globalThis.RegExp?.prototype,
  globalThis.URL,
  globalThis.URL?.prototype,
  globalThis.Request,
  globalThis.Request?.prototype,
  globalThis.Response,
  globalThis.Response?.prototype,
  globalThis.Headers,
  globalThis.Headers?.prototype,
  globalThis.Promise,
  globalThis.Promise?.prototype,
  globalThis.JSON,
  globalThis.btoa,
];
const seen = new Set();
for (const value of protectedValues) {
  let current = value;
  while (
    current &&
    current !== objectPrototype &&
    current !== functionPrototype &&
    !seen.has(current)
  ) {
    if (typeof current !== "object" && typeof current !== "function") break;
    seen.add(current);
    freeze(current);
    current = getPrototypeOf(current);
  }
}
`;

type RuntimeCapability =
  | "ambient-workers-module"
  | "dynamic-import"
  | "require-call"
  | "eval-call"
  | "function-constructor"
  | "shared-intrinsic-mutation"
  | "global-object-escape";

const PROTECTED_INTRINSIC_ROOTS = new Set([
  "globalThis",
  "self",
  "window",
  "crypto",
  "Boolean",
  "Date",
  "Math",
  "Object",
  "Reflect",
  "Array",
  "ArrayBuffer",
  "Uint8Array",
  "TextEncoder",
  "String",
  "Number",
  "RegExp",
  "URL",
  "Request",
  "Response",
  "Headers",
  "Promise",
  "JSON",
  "btoa",
]);

/**
 * Runtime libraries may stash Worker state on the global object under an unregistered symbol
 * (capnweb keeps the whole `cloudflare:workers` module there). Reading such a property needs the
 * global object itself as a value - enumerated, spread, aliased, or passed along - so project code
 * may only reach these roots through property access.
 */
const GLOBAL_OBJECT_ROOTS = new Set(["globalThis", "self", "window"]);

const SHARED_INTRINSIC_MUTATORS = new Map([
  [
    "Object",
    new Set(["assign", "defineProperties", "defineProperty", "setPrototypeOf"]),
  ],
  [
    "Reflect",
    new Set(["defineProperty", "deleteProperty", "set", "setPrototypeOf"]),
  ],
]);

type RuntimeModuleSecurityViolation = {
  capability: RuntimeCapability;
  line: number;
  column: number;
};

type RuntimeModuleImportViolation = {
  importer: string;
  imported: string;
};

/**
 * Production bundles receive privileged Agent bindings, so every resolved
 * runtime module is inspected before Vite transforms it. The allowlist is
 * intentionally capability-specific: reviewed framework modules may use Worker
 * primitives, but generated application modules and arbitrary dependencies may
 * not acquire the ambient environment or dynamic code. Package identities are
 * version-free: the project lockfile pins each package's exact content, and the
 * Agent capability always installs the latest Agents release.
 */
const REVIEWED_MODULE_CAPABILITIES = new Map<
  string,
  ReadonlySet<RuntimeCapability>
>([
  ["project:src/app-bindings.ts", new Set(["ambient-workers-module"])],
  ["package:ajv/dist/compile/index.js", new Set(["function-constructor"])],
  [
    "package:core-js-pure/internals/global-this.js",
    new Set(["function-constructor"]),
  ],
]);

/** Agent runtime packages; their modules are privileged and may import each other. */
const AGENT_RUNTIME_PACKAGES = new Set(["agents", "@cloudflare/ai-chat"]);

/** Packages whose every module may use Worker primitives: the Agent runtime and its RPC layer. */
const REVIEWED_PACKAGE_CAPABILITIES = new Map<
  string,
  ReadonlySet<RuntimeCapability>
>([
  ["agents", new Set(["ambient-workers-module"])],
  ["@cloudflare/ai-chat", new Set(["ambient-workers-module"])],
  ["capnweb", new Set(["ambient-workers-module"])],
]);

/** Browser entry points of the Agent packages that application UI may import. */
const AGENT_CLIENT_ENTRIES = new Set([
  "package:agents/dist/react.js",
  "package:agents/dist/client.js",
  "package:@cloudflare/ai-chat/dist/react.js",
]);

/**
 * These modules export mutable Worker handlers or Agent base classes. Letting
 * generated routes import them would allow a route's module initializer to
 * replace methods on the same objects used by the protected Worker runtime.
 * The application binding broker is intentionally absent from this set: it is
 * the narrow, reviewed surface generated routes are expected to import.
 */
const PRIVILEGED_PROJECT_MODULES = new Set([
  "project:src/server.ts",
  "project:src/agents/app-agent.ts",
]);

/** Checks that bind generated application code; dependencies legitimately use these patterns. */
const PROJECT_ONLY_CAPABILITIES: ReadonlySet<RuntimeCapability> = new Set([
  "shared-intrinsic-mutation",
  "global-object-escape",
]);

function agentRuntimePackage(identity: string): string | undefined {
  const name = packageName(identity);
  return name && AGENT_RUNTIME_PACKAGES.has(name) ? name : undefined;
}

function isPrivilegedRuntimeModule(identity: string): boolean {
  return (
    PRIVILEGED_PROJECT_MODULES.has(identity) ||
    (agentRuntimePackage(identity) !== undefined &&
      !AGENT_CLIENT_ENTRIES.has(identity))
  );
}

function isReviewedPrivilegedImporter(identity: string): boolean {
  return (
    PRIVILEGED_PROJECT_MODULES.has(identity) ||
    agentRuntimePackage(identity) !== undefined
  );
}

function allowedCapabilities(identity: string): ReadonlySet<RuntimeCapability> {
  return (
    REVIEWED_MODULE_CAPABILITIES.get(identity) ??
    REVIEWED_PACKAGE_CAPABILITIES.get(packageName(identity) ?? "") ??
    new Set<RuntimeCapability>()
  );
}

export function productionModuleSecurityPlugin(projectDir: string): Plugin {
  const canonicalProjectDir = resolve(projectDir);
  return {
    name: "cloudchef-production-module-security",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source === INTRINSIC_LOCKDOWN_MODULE) {
        return RESOLVED_INTRINSIC_LOCKDOWN_MODULE;
      }
      if (!importer || importer.includes("\0")) {
        return null;
      }
      const resolvedModule = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (resolvedModule) {
        const violation = findRuntimeModuleImportViolation(
          importer,
          resolvedModule.id,
          canonicalProjectDir,
        );
        if (violation) {
          this.error(importViolationMessage(violation));
        }
      }
      return null;
    },
    load(id) {
      if (id === RESOLVED_INTRINSIC_LOCKDOWN_MODULE) {
        return {
          code: RUNTIME_INTRINSIC_LOCKDOWN_SOURCE,
          moduleSideEffects: true,
        };
      }
      return null;
    },
    transform(code, id, options) {
      const cleanId = id.split("?", 1)[0];
      if (!SOURCE_EXTENSION.test(cleanId) || cleanId.includes("\0")) {
        return null;
      }
      const identity = moduleIdentity(cleanId, canonicalProjectDir);
      const allowed = allowedCapabilities(identity);
      const violations = findRuntimeModuleSecurityViolations(code).filter(
        (violation) =>
          !allowed.has(violation.capability) &&
          (!PROJECT_ONLY_CAPABILITIES.has(violation.capability) ||
            identity.startsWith("project:")),
      );
      if (violations.length > 0) {
        const first = violations[0];
        this.error(
          `Production module ${identity} uses forbidden ${first.capability} capability at ` +
            `${first.line}:${first.column}. Generated application code and unreviewed dependencies ` +
            "must use the protected CloudChef binding broker.",
        );
      }
      const runtimeCode = options?.ssr
        ? `import ${JSON.stringify(INTRINSIC_LOCKDOWN_MODULE)};\n${code}`
        : code;
      return runtimeCode === code ? null : { code: runtimeCode, map: null };
    },
    moduleParsed(module) {
      for (const imported of [
        ...module.importedIds,
        ...module.dynamicallyImportedIds,
      ]) {
        const violation = findRuntimeModuleImportViolation(
          module.id,
          imported,
          canonicalProjectDir,
        );
        if (violation) {
          this.error(importViolationMessage(violation));
        }
      }
    },
  };
}

export function findRuntimeModuleImportViolation(
  importerId: string,
  importedId: string,
  projectDir: string,
): RuntimeModuleImportViolation | null {
  if (importerId.includes("\0") || importedId.includes("\0")) {
    return null;
  }
  const importer = moduleIdentity(cleanModuleId(importerId), projectDir);
  const imported = moduleIdentity(cleanModuleId(importedId), projectDir);
  if (
    !isPrivilegedRuntimeModule(imported) ||
    isReviewedPrivilegedImporter(importer)
  ) {
    return null;
  }
  return { importer, imported };
}

function importViolationMessage(
  violation: RuntimeModuleImportViolation,
): string {
  return (
    `Production module ${violation.importer} may not import privileged runtime module ` +
    `${violation.imported}. Generated application code must use src/app-bindings.ts ` +
    "and public client adapters instead."
  );
}

export function findRuntimeModuleSecurityViolations(
  source: string,
): RuntimeModuleSecurityViolation[] {
  const file = ts.createSourceFile(
    "module.tsx",
    normalizeJavaScriptEscapes(source),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: RuntimeModuleSecurityViolation[] = [];
  const seen = new Set<string>();
  const protectedAliases = collectProtectedIntrinsicAliases(file);

  function add(node: ts.Node, capability: RuntimeCapability) {
    const start = node.getStart(file);
    const key = `${start}:${capability}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const position = file.getLineAndCharacterOfPosition(start);
    violations.push({
      capability,
      line: position.line + 1,
      column: position.character + 1,
    });
  }

  function visit(node: ts.Node) {
    if (
      ts.isIdentifier(node) &&
      GLOBAL_OBJECT_ROOTS.has(node.text) &&
      isGlobalObjectValueUse(node)
    ) {
      add(node, "global-object-escape");
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      isProtectedMutationTarget(node.left, protectedAliases)
    ) {
      add(node.left, "shared-intrinsic-mutation");
    }
    if (
      ((ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)) ||
        (ts.isPostfixUnaryExpression(node) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken ||
            node.operator === ts.SyntaxKind.MinusMinusToken))) &&
      isProtectedMutationTarget(node.operand, protectedAliases)
    ) {
      add(node.operand, "shared-intrinsic-mutation");
    }
    if (
      ts.isDeleteExpression(node) &&
      isProtectedMutationTarget(node.expression, protectedAliases)
    ) {
      add(node.expression, "shared-intrinsic-mutation");
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === AMBIENT_WORKERS_MODULE
    ) {
      add(node.moduleSpecifier, "ambient-workers-module");
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      node.moduleReference.expression.text === AMBIENT_WORKERS_MODULE
    ) {
      add(node.moduleReference.expression, "ambient-workers-module");
    }
    if (ts.isCallExpression(node)) {
      if (isSharedIntrinsicMutatorCall(node, protectedAliases)) {
        add(node.expression, "shared-intrinsic-mutation");
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!isStaticModuleSpecifierCall(node)) {
          add(node.expression, "dynamic-import");
        }
      } else {
        const called = dangerousCallee(node.expression);
        if (
          called &&
          !(called === "require-call" && isStaticModuleSpecifierCall(node))
        ) {
          add(node.expression, called);
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const constructed = dangerousCallee(node.expression);
      if (constructed === "function-constructor") {
        add(node.expression, constructed);
      }
    }
    if (
      ts.isStringLiteralLike(node) &&
      node.text === AMBIENT_WORKERS_MODULE &&
      !isReviewedModuleSpecifierNode(node)
    ) {
      add(node, "ambient-workers-module");
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return violations;
}

/** Whether a global-object identifier is used as a value rather than read through. */
function isGlobalObjectValueUse(node: ts.Identifier): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
      parent.expression === child) ||
    ts.isTypeOfExpression(parent)
  ) {
    return false;
  }
  // A property or member named like a global, a declaration of that name, or a type position.
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return false;
  }
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    if (ts.isTypeNode(current)) {
      return false;
    }
  }
  return true;
}

function collectProtectedIntrinsicAliases(
  file: ts.SourceFile,
): ReadonlySet<string> {
  const aliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        isProtectedIntrinsicValue(node.initializer, aliases)
      ) {
        for (const name of bindingNames(node.name)) {
          if (!aliases.has(name)) {
            aliases.add(name);
            changed = true;
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isProtectedIntrinsicValue(node.right, aliases) &&
        !aliases.has(node.left.text)
      ) {
        aliases.add(node.left.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return aliases;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function isProtectedMutationTarget(
  expression: ts.Expression,
  aliases: ReadonlySet<string>,
): boolean {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    return PROTECTED_INTRINSIC_ROOTS.has(target.text);
  }
  if (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    return isProtectedIntrinsicValue(target.expression, aliases);
  }
  return isProtectedIntrinsicValue(target, aliases);
}

function isProtectedIntrinsicValue(
  expression: ts.Expression,
  aliases: ReadonlySet<string>,
): boolean {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    return PROTECTED_INTRINSIC_ROOTS.has(value.text) || aliases.has(value.text);
  }
  if (
    ts.isPropertyAccessExpression(value) ||
    ts.isElementAccessExpression(value)
  ) {
    return isProtectedIntrinsicValue(value.expression, aliases);
  }
  if (ts.isCallExpression(value)) {
    const member = staticMember(value.expression);
    return (
      member?.root === "Object" &&
      [
        "getOwnPropertyDescriptor",
        "getOwnPropertyDescriptors",
        "getPrototypeOf",
      ].includes(member.name) &&
      value.arguments.some((argument) =>
        isProtectedIntrinsicValue(argument, aliases),
      )
    );
  }
  if (ts.isConditionalExpression(value)) {
    return (
      isProtectedIntrinsicValue(value.whenTrue, aliases) ||
      isProtectedIntrinsicValue(value.whenFalse, aliases)
    );
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) =>
        ts.isExpression(element) && isProtectedIntrinsicValue(element, aliases),
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return isProtectedIntrinsicValue(property.initializer, aliases);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return (
          PROTECTED_INTRINSIC_ROOTS.has(property.name.text) ||
          aliases.has(property.name.text)
        );
      }
      return false;
    });
  }
  return false;
}

function isSharedIntrinsicMutatorCall(
  node: ts.CallExpression,
  aliases: ReadonlySet<string>,
): boolean {
  const member = staticMember(node.expression);
  if (
    !member ||
    !SHARED_INTRINSIC_MUTATORS.get(member.root)?.has(member.name)
  ) {
    return false;
  }
  const target = node.arguments[0];
  return Boolean(target && isProtectedIntrinsicValue(target, aliases));
}

function staticMember(
  expression: ts.Expression,
): { root: string; name: string } | null {
  const value = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(value) &&
    ts.isIdentifier(value.expression)
  ) {
    return { root: value.expression.text, name: value.name.text };
  }
  if (
    ts.isElementAccessExpression(value) &&
    ts.isIdentifier(value.expression)
  ) {
    const name = staticString(value.argumentExpression);
    return name === null ? null : { root: value.expression.text, name };
  }
  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function isStaticModuleSpecifierCall(node: ts.CallExpression): boolean {
  return (
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    node.arguments[0].text !== AMBIENT_WORKERS_MODULE
  );
}

function dangerousCallee(expression: ts.Expression): RuntimeCapability | null {
  if (ts.isIdentifier(expression)) {
    if (expression.text === "require") {
      return "require-call";
    }
    if (expression.text === "eval") {
      return "eval-call";
    }
    if (expression.text === "Function") {
      return "function-constructor";
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return dangerousProperty(expression.name.text);
  }
  if (ts.isElementAccessExpression(expression)) {
    return dangerousProperty(staticString(expression.argumentExpression));
  }
  return null;
}

function dangerousProperty(name: string | null): RuntimeCapability | null {
  if (name === "eval") {
    return "eval-call";
  }
  if (name === "Function") {
    return "function-constructor";
  }
  return null;
}

function staticString(node: ts.Expression | undefined): string | null {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) {
    return staticString(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  return null;
}

function isReviewedModuleSpecifierNode(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    (ts.isExternalModuleReference(parent) && parent.expression === node)
  );
}

function moduleIdentity(id: string, projectDir: string): string {
  const normalized = id.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const lastNodeModules = normalized.lastIndexOf(marker);
  if (lastNodeModules !== -1) {
    return `package:${normalized.slice(lastNodeModules + marker.length)}`;
  }
  const projectRelative = relative(projectDir, resolve(id))
    .split(sep)
    .join("/");
  return projectRelative.startsWith("../")
    ? `external:${normalized}`
    : `project:${projectRelative}`;
}

function packageName(identity: string): string | undefined {
  if (!identity.startsWith("package:")) {
    return undefined;
  }
  const parts = identity.slice("package:".length).split("/");
  return parts.slice(0, parts[0]?.startsWith("@") ? 2 : 1).join("/");
}

function cleanModuleId(id: string): string {
  return id.split(/[?#]/, 1)[0];
}

function normalizeJavaScriptEscapes(source: string): string {
  return source
    .replace(/\\\r?\n/g, "")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}
