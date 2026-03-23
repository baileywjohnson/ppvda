import { loadConfig } from './config.js';
import { buildApp } from './server/index.js';
import { closeBrowser } from './extractor/index.js';
import { setupMullvad, teardownMullvad } from './mullvad/index.js';
import { createLogger } from './utils/logger.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

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

  const app = await buildApp(config);
  await app.listen({ port: config.port, host: config.host });

  // Graceful shutdown
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down...`);
      await app.close();
      await closeBrowser();
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
