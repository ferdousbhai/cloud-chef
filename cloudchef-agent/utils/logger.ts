type LoggerFunction = (...messages: unknown[]) => void;

interface Logger {
  warn: LoggerFunction;
  error: LoggerFunction;
}

export function createScopedLogger(scope: string | undefined): Logger {
  const label = (level: 'warn' | 'error') => `[${level.toUpperCase()}] ${scope ? `[${scope}] ` : ''}`;
  return {
    warn: (...messages: unknown[]) => console.warn(label('warn'), ...messages),
    error: (...messages: unknown[]) => console.error(label('error'), ...messages),
  };
}
