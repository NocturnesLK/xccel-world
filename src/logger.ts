// =============================================================================
// logger.ts — Level-based logging system
// =============================================================================

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const LEVEL_STYLES: Record<LogLevel, string> = {
  trace: 'color: #888',
  debug: 'color: #00bcd4',
  info: 'color: #4caf50',
  warn: 'color: #ff9800',
  error: 'color: #f44336; font-weight: bold',
  fatal: 'color: #fff; background: #f44336; font-weight: bold; padding: 2px 6px',
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function log(level: LogLevel, tag: string, message: string, ...data: unknown[]): void {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = `%c[${timestamp}][${level.toUpperCase()}][${tag}]`;
  if (data.length > 0) {
    console.log(prefix, LEVEL_STYLES[level], message, ...data);
  } else {
    console.log(prefix, LEVEL_STYLES[level], message);
  }
}

export function createLogger(tag: string) {
  return {
    trace: (msg: string, ...data: unknown[]) => log('trace', tag, msg, ...data),
    debug: (msg: string, ...data: unknown[]) => log('debug', tag, msg, ...data),
    info: (msg: string, ...data: unknown[]) => log('info', tag, msg, ...data),
    warn: (msg: string, ...data: unknown[]) => log('warn', tag, msg, ...data),
    error: (msg: string, ...data: unknown[]) => log('error', tag, msg, ...data),
    fatal: (msg: string, ...data: unknown[]) => log('fatal', tag, msg, ...data),
  };
}
