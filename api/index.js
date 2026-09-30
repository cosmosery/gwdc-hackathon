const { buildServer } = require('../src/server.cjs');

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const app = buildServer({ logger: true });
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

module.exports = async (req, res) => {
  const app = await getApp();
  app.server.emit('request', req, res);
};
