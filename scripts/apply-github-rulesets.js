const fs = require('fs');
const path = require('path');

const {
    DEFAULT_API_BASE,
    applyRuleset,
    resolvePath
} = require('./apply-github-ruleset');

const DEFAULT_CONFIG_DIR = '.github/rulesets';

function parseArgs(argv) {
    const options = {
        apply: false,
        owner: process.env.GITHUB_OWNER || '',
        repo: process.env.GITHUB_REPO || '',
        token: process.env.GITHUB_TOKEN || '',
        apiBaseUrl: process.env.GITHUB_API_BASE_URL || DEFAULT_API_BASE,
        configDir: process.env.GITHUB_RULESET_DIR || DEFAULT_CONFIG_DIR
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--apply':
                options.apply = true;
                break;
            case '--owner':
                options.owner = argv[++i] || '';
                break;
            case '--repo':
                options.repo = argv[++i] || '';
                break;
            case '--token':
                options.token = argv[++i] || '';
                break;
            case '--api-base-url':
                options.apiBaseUrl = argv[++i] || DEFAULT_API_BASE;
                break;
            case '--config-dir':
                options.configDir = argv[++i] || DEFAULT_CONFIG_DIR;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

function printUsage() {
    console.log('Usage:');
    console.log('  node scripts/apply-github-rulesets.js --owner CodePiercerTechnology --repo TcView');
    console.log('  node scripts/apply-github-rulesets.js --owner CodePiercerTechnology --repo TcView --apply');
    console.log('');
    console.log('Environment variables:');
    console.log('  GITHUB_TOKEN         token with repository Administration:write (required only for --apply)');
    console.log('  GITHUB_OWNER         repository owner');
    console.log('  GITHUB_REPO          repository name');
    console.log('  GITHUB_API_BASE_URL  optional GitHub API base URL');
    console.log('  GITHUB_RULESET_DIR   optional ruleset config directory');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const configDir = resolvePath(options.configDir);

    if (!options.owner || !options.repo) {
        printUsage();
        throw new Error('Both owner and repo are required.');
    }

    if (!fs.existsSync(configDir)) {
        throw new Error(`Ruleset config directory not found: ${configDir}`);
    }

    const configPaths = fs.readdirSync(configDir)
        .filter(entry => entry.toLowerCase().endsWith('.json'))
        .sort((a, b) => a.localeCompare(b))
        .map(entry => path.join(configDir, entry));

    if (configPaths.length === 0) {
        throw new Error(`No ruleset configs were found in ${configDir}`);
    }

    console.log(`[RULESETS] Processing ${configPaths.length} config(s) from ${configDir}`);
    for (const configPath of configPaths) {
        await applyRuleset({
            ...options,
            configPath
        });
    }
}

Promise.resolve(main()).catch(error => {
    console.error(`[RULESETS][FAIL] ${String(error)}`);
    process.exit(1);
});
