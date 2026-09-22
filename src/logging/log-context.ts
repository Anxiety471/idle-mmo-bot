export interface LogContext {
  cycle: number;
  accountSlug?: string;
  characterName?: string;
}

let currentContext: LogContext = { cycle: 0 };

export function setLogContext(context: Partial<LogContext>): void {
  currentContext = { ...currentContext, ...context };
}

export function getLogContext(): LogContext {
  return currentContext;
}
