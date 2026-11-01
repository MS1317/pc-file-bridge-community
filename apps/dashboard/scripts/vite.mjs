import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build, createServer, preview } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

function getConfig() {
  return {
    configFile: false,
    root,
    plugins: [react()],
    server: {
      port: 4778,
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4777',
          rewrite: (requestPath) => requestPath.replace(/^\/api/, ''),
        },
      },
    },
    preview: {
      port: 4173,
      host: '127.0.0.1',
    },
  };
}

async function run() {
  const command = process.argv[2];
  const config = getConfig();

  if (command === 'build') {
    await build(config);
    return;
  }

  if (command === 'dev') {
    const server = await createServer(config);
    await server.listen();
    server.printUrls();
    return;
  }

  if (command === 'preview') {
    const previewServer = await preview(config);
    previewServer.printUrls();
    return;
  }

  throw new Error(`Unsupported dashboard Vite command: ${command ?? '<missing>'}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
