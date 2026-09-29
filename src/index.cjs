const { buildServer } = require('./server.cjs');
const { TronWeb } = require('tronweb');
const { getRelayerWeb } = require('./tron.cjs');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  if (!process.env.NILE_FACTORY_ADDRESS || !TronWeb.isAddress(process.env.NILE_FACTORY_ADDRESS)) {
    throw new Error('NILE_FACTORY_ADDRESS must be configured with the deployed clone Factory');
  }
  if (!process.env.GASFREE_API_KEY || !process.env.GASFREE_API_SECRET) {
    throw new Error('GasFree API credentials are required');
  }
  getRelayerWeb();
  const app = buildServer({ logger: true });

  const close = async () => {
    app.log.info('Shutting down server...');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  try {
    const address = await app.listen({ port: PORT, host: HOST });
    app.log.info(`TRON Batch Payment API running at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
