import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { describe, expect, test } from 'vitest';
import {
  RUNTIME_INTRINSIC_LOCKDOWN_SOURCE,
  findRuntimeModuleImportViolation,
  findRuntimeModuleSecurityViolations,
  productionModuleSecurityPlugin,
} from '../template/scripts/lib/runtime-module-security';

describe('generated app production module security', () => {
  test.each([
    [`export { env as value } from "cloudflare:\\x77orkers";`, 'ambient-workers-module'],
    [`export const value = import("cloudflare:" + "workers");`, 'dynamic-import'],
    [`export const value = require("ordinary-" + "looking-module");`, 'require-call'],
    [`export const value = globalThis["ev" + "al"]("1");`, 'eval-call'],
    [`export const value = new globalThis["Func" + "tion"]("return 1");`, 'function-constructor'],
    [`globalThis.Boolean = () => true;`, 'shared-intrinsic-mutation'],
    [`crypto.subtle.digest = async () => new Uint8Array(32).buffer;`, 'shared-intrinsic-mutation'],
    [`crypto.getRandomValues = (value) => value.fill(0);`, 'shared-intrinsic-mutation'],
    [`Date.now = () => Number.MAX_SAFE_INTEGER;`, 'shared-intrinsic-mutation'],
    [`Math.floor = () => Number.MAX_SAFE_INTEGER;`, 'shared-intrinsic-mutation'],
    [`const shared = crypto; shared.getRandomValues = (value) => value;`, 'shared-intrinsic-mutation'],
    [
      `Object.defineProperty(crypto.subtle, "digest", { value: async () => new ArrayBuffer(32) });`,
      'shared-intrinsic-mutation',
    ],
    [`Reflect.set(globalThis, "Boolean", () => true);`, 'shared-intrinsic-mutation'],
  ])('rejects a resolved dependency capability: %s', (source, capability) => {
    expect(findRuntimeModuleSecurityViolations(source)).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability })]),
    );
    const id =
      capability === 'shared-intrinsic-mutation'
        ? '/workspace/src/routes/untrusted.ts'
        : '/workspace/node_modules/innocent-helper/index.js';
    expect(() => transformResolvedModule(source, id)).toThrow(`forbidden ${capability} capability`);
  });

  test('allows normal resolved dependencies and only the exact protected binding broker', () => {
    expect(() =>
      transformResolvedModule(
        `export function format(value: string) { return value.trim(); }`,
        '/workspace/node_modules/ordinary-helper/index.ts',
      ),
    ).not.toThrow();
    expect(() =>
      transformResolvedModule(
        `import { env } from "cloudflare:workers"; export const DB = env.DB;`,
        '/workspace/src/app-bindings.ts',
      ),
    ).not.toThrow();
    expect(() =>
      transformResolvedModule(
        `import { env } from "cloudflare:workers"; export const DB = env.DB;`,
        '/workspace/src/routes/unreviewed.ts',
      ),
    ).toThrow('forbidden ambient-workers-module capability');
    expect(() =>
      transformResolvedModule(
        [
          'export async function digest(value: string) {',
          '  const bytes = new TextEncoder().encode(value);',
          '  return crypto.subtle.digest("SHA-256", bytes);',
          '}',
          'export const now = Date.now();',
          'export const rounded = Math.floor(1.5);',
          'export const truthy = Boolean(1);',
        ].join('\n'),
        '/workspace/src/routes/legitimate-crypto.ts',
      ),
    ).not.toThrow();
  });

  test('locks the shared intrinsics used by generated Agent authentication and budgets before app code runs', () => {
    const probe = [
      RUNTIME_INTRINSIC_LOCKDOWN_SOURCE,
      'const attempts = [',
      '  () => { globalThis.Boolean = () => true; },',
      '  () => { crypto.subtle.digest = async () => new Uint8Array(32).buffer; },',
      '  () => { crypto.getRandomValues = (value) => value.fill(0); },',
      '  () => { ((value) => Object.getPrototypeOf(value))(crypto).getRandomValues = (value) => value.fill(0); },',
      '  () => { ((value) => Object.getPrototypeOf(value))(crypto.subtle).digest = async () => new ArrayBuffer(32); },',
      '  () => { Date.now = () => Number.MAX_SAFE_INTEGER; },',
      '  () => { Math.floor = () => Number.MAX_SAFE_INTEGER; },',
      '  () => { RegExp.prototype.test = () => true; },',
      '];',
      'for (const attempt of attempts) {',
      '  let rejected = false;',
      '  try { attempt(); } catch { rejected = true; }',
      '  if (!rejected) throw new Error("shared intrinsic mutation was not rejected");',
      '}',
      'const zodStyleNamespace = {};',
      'zodStyleNamespace.toString = () => "compatible";',
      'if (zodStyleNamespace.toString() !== "compatible") {',
      '  throw new Error("ordinary objects may not shadow Object.prototype properties");',
      '}',
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('injects the lockdown side effect into server runtime modules', () => {
    const plugin = productionModuleSecurityPlugin('/workspace');
    if (typeof plugin.transform !== 'function' || typeof plugin.load !== 'function') {
      throw new TypeError('Production module security hooks are unavailable.');
    }
    const transformed = plugin.transform.call(
      {
        error(message: unknown): never {
          throw new Error(String(message));
        },
      } as never,
      'export const value = 1;',
      '/workspace/src/routes/index.tsx',
      { ssr: true } as never,
    ) as { code: string };
    expect(transformed.code).toMatch(/^import "virtual:ghostbuild-security-intrinsics-lockdown";/);
    const loaded = plugin.load.call({} as never, '\0virtual:ghostbuild-security-intrinsics-lockdown') as {
      code: string;
      moduleSideEffects: boolean;
    };
    expect(loaded).toEqual({ code: RUNTIME_INTRINSIC_LOCKDOWN_SOURCE, moduleSideEffects: true });
  });

  test('carries the prototype-chain lockdown into a production bundle before indirect mutations', () => {
    const { files } = runProductionBuild(
      [
        'const inherited = (value: object) => Object.getPrototypeOf(value);',
        'inherited(crypto).getRandomValues = (value: Uint8Array) => value.fill(0);',
        'inherited(crypto.subtle).digest = async () => new ArrayBuffer(32);',
        'console.info("ghostbuild-prototype-lockdown-production-probe");',
      ].join('\n'),
      true,
    );
    const lockdown = files.find(([path]) => path.includes('_virtual_ghostbuild-security-intrinsics-lockdown'));
    expect(lockdown?.[1]).toContain('getPrototypeOf = Object.getPrototypeOf');
    expect(lockdown?.[1]).toContain('current !== objectPrototype');

    const probe = files.find(([, source]) => source.includes('ghostbuild-prototype-lockdown-production-probe'));
    expect(probe, 'The indirect mutation probe was omitted from the production bundle.').toBeDefined();
    expect(probe?.[1]).toContain('init__virtual_ghostbuild_security_intrinsics_lockdown();');
    expect(probe?.[1].indexOf('init__virtual_ghostbuild_security_intrinsics_lockdown();')).toBeLessThan(
      probe?.[1].indexOf('ghostbuild-prototype-lockdown-production-probe') ?? -1,
    );
  }, 70_000);

  test('removes partyserver ambient-environment fallback only from its exact reviewed module', () => {
    const id = createRequire(resolve('template/node_modules/agents/package.json')).resolve('partyserver');
    const source = readFileSync(id, 'utf8');
    const transformed = transformResolvedModule(source, id) as { code: string };

    expect(transformed.code).toContain('import { DurableObject } from "cloudflare:workers";');
    expect(transformed.code).toContain('async function routePartykitRequest(req, env$1, options) {');
    expect(transformed.code).not.toContain('env$1 = env');
    expect(() => transformResolvedModule(`${source}\n`, id)).toThrow('no longer matches its exact security baseline');
  });

  test('allows the narrow application broker but rejects reverse imports into privileged runtime modules', () => {
    const projectDir = '/workspace';
    expect(
      findRuntimeModuleImportViolation(
        '/workspace/src/routes/index.tsx',
        '/workspace/src/app-bindings.ts?import',
        projectDir,
      ),
    ).toBeNull();
    expect(
      findRuntimeModuleImportViolation(
        '/workspace/src/routes/index.tsx',
        '/workspace/src/agents/app-agent.ts?import',
        projectDir,
      ),
    ).toEqual({
      importer: 'project:src/routes/index.tsx',
      imported: 'project:src/agents/app-agent.ts',
    });
    expect(
      findRuntimeModuleImportViolation(
        '/workspace/src/untrusted-helper.ts',
        '/workspace/src/server.ts#worker-entry',
        projectDir,
      ),
    ).toEqual({
      importer: 'project:src/untrusted-helper.ts',
      imported: 'project:src/server.ts',
    });
    expect(
      findRuntimeModuleImportViolation('/workspace/src/server.ts', '/workspace/src/agents/app-agent.ts', projectDir),
    ).toBeNull();
  });

  test('rejects unreviewed imports of mutable Agent runtime package entries', () => {
    const packageRequire = createRequire(resolve('template/package.json'));
    for (const target of [packageRequire.resolve('agents'), packageRequire.resolve('@cloudflare/ai-chat')]) {
      expect(
        findRuntimeModuleImportViolation(resolve('template/src/routes/index.tsx'), target, resolve('template')),
      ).toEqual(expect.objectContaining({ importer: 'project:src/routes/index.tsx' }));
    }
  });

  test('allows only the exact reviewed Agents modules to import partyserver', () => {
    const packageRequire = createRequire(resolve('template/package.json'));
    const agentsEntry = packageRequire.resolve('agents');
    const mcpHelper = resolve(agentsEntry, '../client-zqKcsyFa.js');
    const partyserverEntry = createRequire(agentsEntry).resolve('partyserver');

    expect(findRuntimeModuleImportViolation(agentsEntry, partyserverEntry, resolve('template'))).toBeNull();
    expect(findRuntimeModuleImportViolation(mcpHelper, partyserverEntry, resolve('template'))).toBeNull();
    expect(() => transformResolvedModule(readFileSync(agentsEntry, 'utf8'), agentsEntry)).not.toThrow();
    expect(() => transformResolvedModule(readFileSync(mcpHelper, 'utf8'), mcpHelper)).not.toThrow();
    expect(() => transformResolvedModule(`${readFileSync(agentsEntry, 'utf8')}\n`, agentsEntry)).toThrow(
      'no longer matches its exact security baseline',
    );
    expect(() => transformResolvedModule(`${readFileSync(mcpHelper, 'utf8')}\n`, mcpHelper)).toThrow(
      'no longer matches its exact security baseline',
    );
  });

  test.each([
    {
      label: 'an indirect aliased import',
      source: [
        'import { AppAgent } from "@/agents/app-agent";',
        'AppAgent.prototype.refreshAnonymousSessionExpiry = async () => true;',
      ].join('\n'),
      expected: 'may not import privileged runtime module',
      identity: 'project:src/agents/app-agent.ts',
    },
    {
      label: 'an eager import.meta.glob expansion',
      source: 'export const protectedModules = import.meta.glob("/src/agents/*.ts", { eager: true });',
      expected: 'may not import privileged runtime module',
      identity: 'project:src/agents/app-agent.ts',
    },
    {
      label: 'a shared intrinsic mutation',
      source: 'globalThis.crypto.subtle.digest = async () => new Uint8Array(32).buffer;',
      expected: 'forbidden shared-intrinsic-mutation capability',
      identity: 'project:src/untrusted-helper.ts',
    },
  ])(
    'rejects $label in a real production build',
    ({ source, expected, identity }) => {
      const { output } = runProductionBuild(source, false);
      expect(output).toContain(expected);
      expect(output).toContain('project:src/untrusted-helper.ts');
      expect(output).toContain(identity);
    },
    70_000,
  );
});

/**
 * Run Vite through its own binary rather than `pnpm exec`. `pnpm exec` first
 * reconciles the workspace, and because the temporary project's `node_modules`
 * is a symlink to the template's, that reconciliation repoints the template's
 * store into a directory this test is about to delete.
 */
function templateViteBin(): string {
  return resolve('template', 'node_modules', 'vite', 'bin', 'vite.js');
}

function runProductionBuild(untrustedHelperSource: string, expectSuccess: boolean) {
  const templateDir = resolve('template');
  const projectDir = mkdtempSync(join(resolve('.'), '.ghostbuild-runtime-security-'));
  try {
    cpSync(templateDir, projectDir, {
      recursive: true,
      filter(source) {
        const sourceRelative = relative(templateDir, source).split(sep);
        return !['node_modules', 'dist', '.wrangler'].includes(sourceRelative[0] ?? '');
      },
    });
    symlinkSync(resolve(templateDir, 'node_modules'), join(projectDir, 'node_modules'), 'dir');
    writeFileSync(join(projectDir, 'src/untrusted-helper.ts'), untrustedHelperSource);
    const routePath = join(projectDir, 'src/routes/index.tsx');
    writeFileSync(routePath, `import "../untrusted-helper";\n${readFileSync(routePath, 'utf8')}`);

    const result = spawnSync(process.execPath, [templateViteBin(), 'build'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...processEnvironment, GHOSTBUILD_PREVIEW: '0' },
      timeout: 60_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (expectSuccess) {
      expect(result.status, output).toBe(0);
    } else {
      expect(result.status, output).not.toBe(0);
    }
    // The bundle has to be read before the finally deletes the project tree.
    return { output, files: expectSuccess ? readTextFiles(join(projectDir, 'dist/server')) : [] };
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function readTextFiles(directory: string): Array<[string, string]> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? readTextFiles(path) : [[path, readFileSync(path, 'utf8')]];
  });
}

function transformResolvedModule(source: string, id: string): unknown {
  const plugin = productionModuleSecurityPlugin('/workspace');
  const transform = plugin.transform;
  if (typeof transform !== 'function') {
    throw new TypeError('Production module security transform hook is unavailable.');
  }
  return transform.call(
    {
      error(message: unknown): never {
        throw new Error(String(message));
      },
    } as never,
    source,
    id,
  );
}
