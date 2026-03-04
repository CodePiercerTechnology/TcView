const path = require('path');
const { runTests } = require('vscode-test');

function printTlsHelp(error) {
    const message = String(error && error.message ? error.message : error);
    if (/UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|unable to get local issuer certificate/i.test(message)) {
        console.error('[TcView Integration] VS Code test runtime download failed due TLS trust settings.');
        console.error('[TcView Integration] If your environment uses a private CA, configure Node trust or run with TCVIEW_INTEGRATION_ALLOW_INSECURE_TLS=1.');
        return;
    }

    if (/Failed to get VS Code archive location|Failed to download and unzip VS Code/i.test(message)) {
        console.error('[TcView Integration] VS Code test runtime download failed due network/proxy restrictions.');
        console.error('[TcView Integration] Verify outbound access to update.code.visualstudio.com or configure your proxy settings for Node.');
    }
}

let fatalHandled = false;
function handleFatal(error) {
    if (fatalHandled) {
        return;
    }
    fatalHandled = true;
    printTlsHelp(error);
    console.error(error);
    process.exit(1);
}

process.on('uncaughtException', handleFatal);
process.on('unhandledRejection', handleFatal);

async function main() {
    if (process.env.TCVIEW_INTEGRATION_ALLOW_INSECURE_TLS === '1') {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        console.warn('[TcView Integration] NODE_TLS_REJECT_UNAUTHORIZED=0 is enabled for this run.');
    }

    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    const extensionTestsPath = path.resolve(__dirname, '..', 'out', 'tests', 'integration', 'index.js');
    const workspacePath = path.resolve(__dirname, '..');

    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [workspacePath, '--disable-extensions']
    });
}

main().catch(handleFatal);

