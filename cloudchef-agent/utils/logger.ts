const levelOrder = ['trace', 'debug', 'info', 'warn', 'error'] as const;
type DebugLevel = (typeof levelOrder)[number];

type LoggerFunction = (...messages: unknown[]) => void;

interface Logger {
  trace: LoggerFunction;
  debug: LoggerFunction;
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
}

const currentLevel: DebugLevel = 'warn';

export const logger: Logger = {
  trace: (...messages: unknown[]) => log('trace', undefined, messages),
  debug: (...messages: unknown[]) => log('debug', undefined, messages),
  info: (...messages: unknown[]) => log('info', undefined, messages),
  warn: (...messages: unknown[]) => log('warn', undefined, messages),
  error: (...messages: unknown[]) => log('error', undefined, messages),
};

export function createScopedLogger(scope: string): Logger {
  return {
    trace: (...messages: unknown[]) => log('trace', scope, messages),
    debug: (...messages: unknown[]) => log('debug', scope, messages),
    info: (...messages: unknown[]) => log('info', scope, messages),
    warn: (...messages: unknown[]) => log('warn', scope, messages),
    error: (...messages: unknown[]) => log('error', scope, messages),
  };
}

function log(level: DebugLevel, scope: string | undefined, messages: unknown[]) {
  if (levelOrder.indexOf(level) < levelOrder.indexOf(currentLevel)) {
    return;
  }

  let labelText = `[${level.toUpperCase()}] `;
  if (scope) {
    labelText = `${labelText}[${scope}] `;
  }

  const consoleLevel = level === 'trace' ? 'debug' : level;
  console[consoleLevel](labelText, ...messages);
}

export const renderLogger = createScopedLogger('Render');
