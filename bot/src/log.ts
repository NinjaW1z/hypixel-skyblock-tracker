function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
let debugEnabled = false;
export const log = {
  setDebug(on: boolean): void { debugEnabled = on; },
  info: (...a: unknown[]) => console.log(ts(), '[info]', ...a),
  warn: (...a: unknown[]) => console.warn(ts(), '[warn]', ...a),
  error: (...a: unknown[]) => console.error(ts(), '[error]', ...a),
  debug: (...a: unknown[]) => { if (debugEnabled) console.log(ts(), '[debug]', ...a); },
};
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolve with the first of: the promise, or a timeout error after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
