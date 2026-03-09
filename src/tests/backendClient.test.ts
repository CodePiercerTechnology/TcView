import * as assert from 'assert';
import * as path from 'path';
import {
    formatBackendCommandError,
    getBackendInvocationCandidates,
    getBackendMissingErrorMessage,
    resolveBackendInvocationFromCandidates
} from '../backend/tcViewBackendRuntime';

export async function runBackendClientUtilityTests(): Promise<void> {
    const extensionPath = path.join('C:', 'TcViewExtension');
    const configuredOverride = path.join('C:', 'custom', 'TcView.Backend.exe');
    const releaseExe = path.join(extensionPath, 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.exe');
    const releaseDll = path.join(extensionPath, 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows', 'TcView.Backend.dll');

    const withOverride = getBackendInvocationCandidates(extensionPath, configuredOverride);
    assert.strictEqual(withOverride[0], configuredOverride, 'Configured override should be first.');
    assert.strictEqual(withOverride[1], releaseExe, 'Bundled release exe should be preferred after override.');
    assert.strictEqual(withOverride[2], releaseDll, 'Bundled release dll should follow release exe.');

    const fallbackInvocation = resolveBackendInvocationFromCandidates(
        withOverride,
        candidate => candidate === releaseExe
    );
    assert.ok(fallbackInvocation, 'Fallback invocation should resolve when bundled release exe exists.');
    assert.strictEqual(fallbackInvocation?.command, releaseExe, 'Stale override should fall back to bundled release exe.');
    assert.deepStrictEqual(fallbackInvocation?.args, []);

    const dllOverride = path.join('C:', 'custom', 'TcView.Backend.dll');
    const dllInvocation = resolveBackendInvocationFromCandidates(
        getBackendInvocationCandidates(extensionPath, dllOverride),
        candidate => candidate === dllOverride
    );
    assert.ok(dllInvocation, 'DLL override should resolve.');
    assert.strictEqual(dllInvocation?.command, 'dotnet', 'DLL invocation should use dotnet host.');
    assert.deepStrictEqual(dllInvocation?.args, [dllOverride]);

    const missingInvocation = resolveBackendInvocationFromCandidates(
        getBackendInvocationCandidates(extensionPath, ''),
        () => false
    );
    assert.strictEqual(missingInvocation, undefined, 'Resolution should fail when no backend candidates exist.');

    const missingMessage = formatBackendCommandError(new Error(getBackendMissingErrorMessage()));
    assert.ok(missingMessage.includes('clear twincat.backend.executablePath'), 'Missing-backend guidance should mention clearing stale override paths.');

    const dotnetMessage = formatBackendCommandError(new Error('spawn dotnet ENOENT'));
    assert.ok(dotnetMessage.includes('.NET 8 runtime'), 'Missing-dotnet guidance should mention the .NET 8 runtime.');
}

if (require.main === module) {
    Promise.resolve(runBackendClientUtilityTests()).then(() => {
        console.log('Backend client utility tests passed.');
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
