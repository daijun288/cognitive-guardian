import { GuardianMcpServer } from './mcp/server.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  // v1.0: Auto-initialize focusing on the current working directory (CWD)
  // This is where the user starts the Claude CLI.
  const currentDir = process.cwd();
  const lspCommand = 'npx';
  const lspArgs = ['typescript-language-server', '--stdio'];

  const server = new GuardianMcpServer(
    lspCommand,
    lspArgs,
    undefined as any // Let context manager resolve DB path per project
  );

  console.error(`[SYSTEM] Starting Cognitive Guardian (v1.0)...`);
  console.error(`[SYSTEM] Working directory: ${currentDir}`);

  const rootUri = `file:///${currentDir.replace(/\\/g, '/')}`;

  try {
    // v1.0: Immediately triggers discovery and scan for the CWD
    await server.run(rootUri);
    console.error('[SYSTEM] Guardian Server is active. Project protection initialized.');
  } catch (err) {
    console.error('[SYSTEM] Critical failure during startup:', err);
    process.exit(1);
  }
}

main();
