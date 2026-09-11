import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';

const RUNTIME_LOG_SOURCES = ['app/agents/builder-agent.ts', 'app/lib/.server/llm/pi-agent-runner.ts'] as const;
const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error', 'log']);

describe('runtime log privacy', () => {
  test.each(RUNTIME_LOG_SOURCES)('%s excludes stable identities and arbitrary errors from direct logs', (path) => {
    const logArguments = directLogArguments(path);

    expect(logArguments.length).toBeGreaterThan(0);
    for (const args of logArguments) {
      expect(args).not.toMatch(/\b(?:agentName|chatInitialId|requestId)\b/);
      expect(args).not.toMatch(/\b(?:error|message)\b|Error\b|\bString\s*\(/);
    }
  });
});

function directLogArguments(path: string): string[] {
  const sourceText = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === 'logger' || node.expression.expression.text === 'console') &&
      LOG_METHODS.has(node.expression.name.text)
    ) {
      result.push(node.arguments.map((argument) => argument.getText(source)).join('\n'));
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return result;
}
