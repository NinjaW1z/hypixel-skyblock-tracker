import { resolve } from 'node:path';
import { loadConfig, modsocketUrl } from './config.js';
import { log } from './log.js';
import { BridgeClient } from './feed.js';
import { MinecraftClient } from './minecraft.js';
import { Store } from './store.js';
import { Flipper } from './flipper.js';

process.on('unhandledRejection', (reason) => log.error('unhandled rejection (continuing):', reason instanceof Error ? reason.stack ?? reason.message : reason));
process.on('uncaughtException', (err) => log.error('uncaught exception (continuing):', err.stack ?? err.message));

function main(): void {
  const cfg = loadConfig();
  log.setDebug(cfg.debug);
  const dataDir = resolve(cfg.dataDir);
  const url = modsocketUrl(cfg.feed.url, cfg.feed.token)!;
  log.info(`skyflip bot starting · mode=${cfg.mode} · bridge=${url.replace(/\/modsocket\/.+/, '/modsocket/<token>')} · data=${dataDir}`);
  if (cfg.mode === 'live') log.warn('LIVE mode: this account will buy and list auctions on its own. Automated purchasing is against Hypixel\'s rules; use an account you can afford to lose.');
  const store = new Store(dataDir);
  const feed = new BridgeClient(url);
  const mc = cfg.mode === 'offline' ? undefined : new MinecraftClient({
    host: cfg.minecraft.host, port: cfg.minecraft.port, version: cfg.minecraft.version, account: cfg.minecraft.account,
    authDir: resolve(cfg.minecraft.authDir), auth: process.env.MC_AUTH === 'offline' ? 'offline' : 'microsoft', timing: cfg.timing,
  });
  const flipper = new Flipper(cfg, feed, mc, store);
  flipper.start();
  const shutdown = () => { log.info('shutting down'); flipper.stop(); feed.stop(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
