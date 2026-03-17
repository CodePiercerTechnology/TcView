const { execFileSync } = require('child_process');

function runGit(args, { capture = false } = {}) {
    const options = {
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        encoding: capture ? 'utf8' : undefined
    };

    return execFileSync('git', args, options);
}

function parseArgs(argv) {
    const options = {
        command: '',
        kind: '',
        name: '',
        remote: 'origin',
        main: 'main',
        develop: 'develop',
        push: false
    };

    const positionals = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--remote':
                options.remote = argv[++i] || options.remote;
                break;
            case '--main':
                options.main = argv[++i] || options.main;
                break;
            case '--develop':
                options.develop = argv[++i] || options.develop;
                break;
            case '--push':
                options.push = true;
                break;
            default:
                positionals.push(arg);
                break;
        }
    }

    options.command = positionals[0] || '';
    options.kind = positionals[1] || '';
    options.name = positionals[2] || '';
    return options;
}

function printUsage() {
    console.log('Usage:');
    console.log('  node scripts/gitflow.js bootstrap [--push]');
    console.log('  node scripts/gitflow.js start feature <name> [--push]');
    console.log('  node scripts/gitflow.js start release <version> [--push]');
    console.log('  node scripts/gitflow.js start hotfix <version> [--push]');
}

function ensureCleanWorktree() {
    const status = runGit(['status', '--porcelain'], { capture: true }).trim();
    if (status) {
        throw new Error('Working tree is not clean. Commit or stash changes before running gitflow helpers.');
    }
}

function localBranchExists(branch) {
    try {
        runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        return true;
    } catch {
        return false;
    }
}

function remoteBranchExists(remote, branch) {
    try {
        runGit(['ls-remote', '--exit-code', '--heads', remote, branch], { capture: true });
        return true;
    } catch {
        return false;
    }
}

function resolveStartPoint(branch, remote) {
    if (remoteBranchExists(remote, branch)) {
        return `${remote}/${branch}`;
    }

    if (localBranchExists(branch)) {
        return branch;
    }

    throw new Error(`Could not resolve start point for branch "${branch}" from local refs or remote "${remote}".`);
}

function sanitizeBranchSegment(name) {
    return name
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^A-Za-z0-9._/-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-/]+|[-/]+$/g, '');
}

function createBranch(branch, startPoint, remote, push) {
    if (localBranchExists(branch) || remoteBranchExists(remote, branch)) {
        throw new Error(`Branch already exists: ${branch}`);
    }

    console.log(`[GITFLOW] Creating ${branch} from ${startPoint}`);
    runGit(['switch', '-c', branch, startPoint]);

    if (push) {
        console.log(`[GITFLOW] Pushing ${branch} to ${remote}`);
        runGit(['push', '-u', remote, branch]);
    }
}

function bootstrap(options) {
    ensureCleanWorktree();

    const startPoint = resolveStartPoint(options.main, options.remote);
    if (!localBranchExists(options.develop)) {
        createBranch(options.develop, startPoint, options.remote, options.push);
        return;
    }

    console.log(`[GITFLOW] Local branch already exists: ${options.develop}`);
    if (options.push) {
        console.log(`[GITFLOW] Ensuring ${options.develop} is pushed to ${options.remote} with upstream tracking`);
        runGit(['push', '-u', options.remote, options.develop]);
    }
}

function startBranch(options) {
    ensureCleanWorktree();

    const branchKinds = {
        feature: { prefix: 'feature', base: options.develop },
        release: { prefix: 'release', base: options.develop },
        hotfix: { prefix: 'hotfix', base: options.main }
    };

    const config = branchKinds[options.kind];
    if (!config || !options.name) {
        printUsage();
        throw new Error('Start requires a branch kind and name/version.');
    }

    const segment = sanitizeBranchSegment(options.name);
    if (!segment) {
        throw new Error('Branch name/version resolved to an empty value.');
    }

    const branch = `${config.prefix}/${segment}`;
    const startPoint = resolveStartPoint(config.base, options.remote);
    createBranch(branch, startPoint, options.remote, options.push);
}

function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.command === 'bootstrap') {
        bootstrap(options);
        return;
    }

    if (options.command === 'start') {
        startBranch(options);
        return;
    }

    printUsage();
    throw new Error('Unknown or missing gitflow command.');
}

try {
    main();
} catch (error) {
    console.error(`[GITFLOW][FAIL] ${String(error.message || error)}`);
    process.exit(1);
}
