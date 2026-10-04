export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Logs to stderr only: stdout is reserved for MCP JSON-RPC messages on the stdio transport.
 */
export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = ORDER[level];
  const write = (lvl: Exclude<LogLevel, "silent">, message: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    const line = { ts: new Date().toISOString(), level: lvl, msg: message, ...meta };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };
  return {
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
  };
}

export const silentLogger: Logger = createLogger("silent");
