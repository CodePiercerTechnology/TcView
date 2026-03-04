const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function getDefaultExtraCaCertPath() {
    return 'C:\\certs\\zscaler.pem';
}

function relaunchWithExtraCaIfAvailable() {
    if (process.env.TCVIEW_INTEGRATION_CA_BOOTSTRAPPED === '1') {
        return;
    }

    const configuredPath = (process.env.TCVIEW_NODE_EXTRA_CA_CERTS || '').trim();
    const nodeExtraPath = (process.env.NODE_EXTRA_CA_CERTS || '').trim();
    const candidatePaths = [];
    if (configuredPath) {
        candidatePaths.push(configuredPath);
    }
    if (nodeExtraPath) {
        candidatePaths.push(nodeExtraPath);
    }
    candidatePaths.push(getDefaultExtraCaCertPath());

    const resolvedPath = candidatePaths.find(candidate => candidate && fs.existsSync(candidate));
    if (!resolvedPath) {
        if (configuredPath && !fs.existsSync(configuredPath)) {
            console.warn(`[TcView Integration] Configured CA file does not exist: ${configuredPath}`);
        }
        return;
    }

    if (nodeExtraPath && path.normalize(nodeExtraPath).toLowerCase() === path.normalize(resolvedPath).toLowerCase()) {
        return;
    }

    console.warn(`[TcView Integration] Using NODE_EXTRA_CA_CERTS=${resolvedPath}`);
    const child = spawnSync(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: resolvedPath,
            TCVIEW_INTEGRATION_CA_BOOTSTRAPPED: '1'
        }
    });

    if (typeof child.status === 'number') {
        process.exit(child.status);
    }

    if (child.error) {
        throw child.error;
    }

    process.exit(1);
}

relaunchWithExtraCaIfAvailable();

const { runTests } = require('vscode-test');

function printTlsHelp(error) {
    const message = String(error && error.message ? error.message : error);
    if (/UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|unable to get local issuer certificate/i.test(message)) {
        console.error('[TcView Integration] VS Code test runtime download failed due TLS trust settings.');
        console.error('[TcView Integration] If your environment uses a private CA, set TCVIEW_NODE_EXTRA_CA_CERTS to your PEM file or place zscaler.pem at C:\\certs\\zscaler.pem.');
        console.error('[TcView Integration] As a last resort, run with TCVIEW_INTEGRATION_ALLOW_INSECURE_TLS=1.');
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

