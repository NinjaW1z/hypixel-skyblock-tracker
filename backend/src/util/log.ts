import { config } from '../config.js';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
export const log = {
  info: (...a: unknown[]) => console.log(ts(), '[info]', ...a),
  warn: (...a: unknown[]) => console.warn(ts(), '[warn]', ...a),
  error: (...a: unknown[]) => console.error(ts(), '[error]', ...a),
  debug: (...a: unknown[]) => { if (config.debug) console.log(ts(), '[debug]', ...a); },
};
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
