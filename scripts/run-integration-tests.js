const path = require('path');
const { runTests } = require('vscode-test');

async function main() {
    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    const extensionTestsPath = path.resolve(__dirname, '..', 'out', 'tests', 'integration', 'index.js');
    const workspacePath = path.resolve(__dirname, '..');

    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [workspacePath, '--disable-extensions']
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

