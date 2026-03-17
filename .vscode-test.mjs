// .vscode-test.mjs
import { defineConfig } from '@vscode/test-cli';

const localVSCode = process.env.VSCODE_EXECUTABLE_PATH;

export default defineConfig({
  files: 'out/tests/integration/index.js',
  extensionDevelopmentPath: process.cwd(),
  workspaceFolder: process.cwd(),
  version: '1.110.0',
  mocha: {
    timeout: 30000,
  },
  ...(localVSCode ? { fromPath: localVSCode } : {}),
  env: {
    ...process.env,
  },
});
