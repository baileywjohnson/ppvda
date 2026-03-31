import { loadConfig } from './config.js';
import { buildApp } from './server/index.js';
import { closeBrowser } from './extractor/index.js';
import { setupMullvad, teardownMullvad } from './mullvad/index.js';
import { createLogger } from './utils/logger.js';
import { DB } from './db/index.js';
import { SessionStore } from './auth/sessions.js';
import { bootstrapAdmin } from './auth/index.js';
import { isStrongPassword } from './crypto/index.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // Initialize database
  const db = new DB(config.dbPath);
  logger.info({ dbPath: config.dbPath }, 'Database initialized');

  // Bootstrap admin user on first run
  if (db.getUserCount() === 0) {
    if (!config.adminPassword) {
      throw new Error('PPVDA_ADMIN_PASSWORD must be set for first-run admin bootstrap');
    }
    if (!isStrongPassword(config.adminPassword)) {
      throw new Error('PPVDA_ADMIN_PASSWORD must be 16+ characters with at least one letter, one number, and one symbol');
    }
    const masterKey = bootstrapAdmin(db, config.adminUsername, config.adminPassword);
    // Zero the master key — it will be decrypted on login
    masterKey.fill(0);
    logger.info({ username: config.adminUsername }, 'Admin user created');
  }

  // Initialize session store
  const sessions = new SessionStore();

  // Set up Mullvad WireGuard tunnel if configured
  if (config.mullvadAccount) {
    if (!config.mullvadLocation) {
      throw new Error('MULLVAD_LOCATION is required when MULLVAD_ACCOUNT is set');
    }
    await setupMullvad(
      {
        accountNumber: config.mullvadAccount,
        location: config.mullvadLocation,
        configDir: config.mullvadConfigDir,
      },
      logger,
    );
  }

  const app = await buildApp(config, db, sessions);
  await app.listen({ port: config.port, host: config.host });

  // Graceful shutdown
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down...`);
      sessions.clear();
      await app.close();
      await closeBrowser();
      db.close();
      if (config.mullvadAccount) {
        await teardownMullvad(logger);
      }
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
