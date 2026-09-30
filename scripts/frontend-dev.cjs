// Local development only. The browser never receives the engine bearer token.
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const {createFrontendBridge}=require('../src/frontendBridge.cjs');
const server=createFrontendBridge();
server.requestTimeout = 20000;
server.listen(3478, '127.0.0.1', () => {
  console.log('Local API bridge: http://127.0.0.1:3478 (local wallet execution and read endpoints)');
});
// Only the bridge gets API credentials. Vite's process receives no wallet/API secrets.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/SECRET|PRIVATE_KEY|BEARER|API_KEY|PASSWORD/i.test(key)));
const child = spawn(process.execPath, [path.join(__dirname, '../web/node_modules/vite/bin/vite.js')], { cwd: path.join(__dirname, '../web'), stdio: 'inherit', env: childEnv });
function close() { child.kill('SIGTERM'); server.close(); }
process.on('SIGTERM', close); process.on('SIGINT', close);
child.on('exit', (code) => { server.close(); process.exitCode = code || 0; });
server.on('error', (error) => { console.error(error.message); child.kill('SIGTERM'); process.exitCode = 1; });
