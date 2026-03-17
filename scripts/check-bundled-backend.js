const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, 'package.json');
const backendDir = path.join(repoRoot, 'backend', 'TcView.Backend', 'bin', 'Release', 'net8.0-windows');
const requiredBackendFiles = [
    'TcView.Backend.exe',
    'TcView.Backend.dll',
    'TcView.Backend.deps.json',
    'TcView.Backend.runtimeconfig.json'
];

function fail(message) {
    console.error(`[BACKEND][FAIL] ${message}`);
    process.exit(1);
}

function pass(message) {
    console.log(`[BACKEND][PASS] ${message}`);
}

function parseVsixPath(argv) {
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--vsix' && argv[i + 1]) {
            return path.resolve(repoRoot, argv[i + 1]);
        }
    }

    if (process.env.TCVIEW_VSIX_PATH) {
        return path.resolve(repoRoot, process.env.TCVIEW_VSIX_PATH);
    }

    return undefined;
}

function listVsixEntries(vsixPath) {
    const script = [
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '$vsixPath = $env:TCVIEW_VSIX_CHECK_PATH',
        '$archive = [System.IO.Compression.ZipFile]::OpenRead($vsixPath)',
        'try {',
        '  $archive.Entries | ForEach-Object { $_.FullName }',
        '} finally {',
        '  $archive.Dispose()',
        '}'
    ].join('; ');

    const result = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', script],
        {
            encoding: 'utf8',
            env: {
                ...process.env,
                TCVIEW_VSIX_CHECK_PATH: vsixPath
            }
        }
    );

    if (result.status !== 0) {
        fail(`Could not inspect VSIX contents for ${vsixPath}: ${result.stderr || result.stdout}`);
    }

    return new Set(
        result.stdout
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
    );
}

function main() {
    if (!fs.existsSync(packageJsonPath)) {
        fail(`package.json was not found at ${packageJsonPath}`);
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const filesWhitelist = Array.isArray(packageJson.files) ? packageJson.files : [];
    if (!filesWhitelist.includes('backend/TcView.Backend/bin/Release/net8.0-windows/**')) {
        fail('package.json does not whitelist backend/TcView.Backend/bin/Release/net8.0-windows/**');
    }

    if (!fs.existsSync(backendDir)) {
        fail(`Bundled backend directory is missing: ${backendDir}`);
    }

    for (const relativeFile of requiredBackendFiles) {
        const absoluteFile = path.join(backendDir, relativeFile);
        if (!fs.existsSync(absoluteFile)) {
            fail(`Required bundled backend file is missing: ${absoluteFile}`);
        }
    }
    pass(`Bundled backend build output exists in ${backendDir}`);

    const vsixPath = parseVsixPath(process.argv.slice(2));
    if (!vsixPath) {
        pass('VSIX inspection skipped (no --vsix or TCVIEW_VSIX_PATH provided)');
        return;
    }

    if (!fs.existsSync(vsixPath)) {
        fail(`VSIX file does not exist: ${vsixPath}`);
    }

    const vsixEntries = listVsixEntries(vsixPath);
    for (const relativeFile of requiredBackendFiles) {
        const expectedEntry = `extension/backend/TcView.Backend/bin/Release/net8.0-windows/${relativeFile}`;
        if (!vsixEntries.has(expectedEntry)) {
            fail(`Packaged VSIX is missing bundled backend file: ${expectedEntry}`);
        }
    }

    pass(`Bundled backend files are present in ${path.basename(vsixPath)}`);
}

main();
