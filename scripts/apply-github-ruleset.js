const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = '.github/rulesets/main.json';
const DEFAULT_API_BASE = 'https://api.github.com';

function parseArgs(argv) {
    const options = {
        apply: false,
        owner: process.env.GITHUB_OWNER || '',
        repo: process.env.GITHUB_REPO || '',
        token: process.env.GITHUB_TOKEN || '',
        apiBaseUrl: process.env.GITHUB_API_BASE_URL || DEFAULT_API_BASE,
        configPath: process.env.GITHUB_RULESET_CONFIG || DEFAULT_CONFIG_PATH
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
            case '--config':
                options.configPath = argv[++i] || DEFAULT_CONFIG_PATH;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

function resolvePath(inputPath) {
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function readJson(filePath, label) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${label} not found: ${filePath}`);
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`Failed to parse ${label} ${filePath}: ${String(error)}`);
    }
}

function stripNulls(value) {
    if (Array.isArray(value)) {
        return value
            .map(stripNulls)
            .filter(entry => entry !== undefined);
    }

    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            const cleaned = stripNulls(nestedValue);
            if (cleaned !== undefined) {
                result[key] = cleaned;
            }
        }
        return result;
    }

    return value === null ? undefined : value;
}

async function githubRequest({ method, url, token, body, userAgent = 'tcview-ruleset-script' }) {
    const response = await fetch(url, {
        method,
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': userAgent,
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`${method} ${url} failed: ${response.status} ${response.statusText}\n${text}`);
    }

    if (response.status === 204) {
        return undefined;
    }

    return response.json();
}

function printUsage() {
    console.log('Usage:');
    console.log('  node scripts/apply-github-ruleset.js --owner CodePiercerTechnology --repo TcView');
    console.log('  node scripts/apply-github-ruleset.js --owner CodePiercerTechnology --repo TcView --apply');
    console.log('');
    console.log('Environment variables:');
    console.log('  GITHUB_TOKEN           token with repository Administration:write (required only for --apply)');
    console.log('  GITHUB_OWNER           repository owner');
    console.log('  GITHUB_REPO            repository name');
    console.log('  GITHUB_API_BASE_URL    optional GitHub API base URL');
    console.log('  GITHUB_RULESET_CONFIG  optional ruleset config path');
}

async function applyRuleset(options) {
    const configPath = resolvePath(options.configPath);
    const payload = stripNulls(readJson(configPath, 'ruleset config'));

    if (!options.owner || !options.repo) {
        printUsage();
        throw new Error('Both owner and repo are required.');
    }

    const baseUrl = `${options.apiBaseUrl.replace(/\/$/, '')}/repos/${options.owner}/${options.repo}/rulesets`;
    console.log(`[RULESET] TARGET ${payload.name} for ${options.owner}/${options.repo}`);
    console.log(`[RULESET] Config: ${configPath}`);

    if (!options.apply) {
        console.log('[RULESET] Dry run only. No GitHub API call was made.');
        return;
    }

    if (!options.token) {
        printUsage();
        throw new Error('GITHUB_TOKEN is required for --apply.');
    }

    const existingRulesets = await githubRequest({
        method: 'GET',
        url: baseUrl,
        token: options.token
    });

    const existing = Array.isArray(existingRulesets)
        ? existingRulesets.find(ruleset => ruleset.name === payload.name && ruleset.target === payload.target)
        : undefined;

    const targetUrl = existing ? `${baseUrl}/${existing.id}` : baseUrl;
    console.log(`[RULESET] ${(existing ? 'update' : 'create').toUpperCase()} endpoint: ${targetUrl}`);

    const result = await githubRequest({
        method: existing ? 'PUT' : 'POST',
        url: targetUrl,
        token: options.token,
        body: payload
    });

    console.log(`[RULESET] Applied ruleset id=${result.id} enforcement=${result.enforcement} target=${result.target}`);
    if (result._links?.html?.href) {
        console.log(`[RULESET] View: ${result._links.html.href}`);
    }
}

async function main() {
    await applyRuleset(parseArgs(process.argv.slice(2)));
}

module.exports = {
    DEFAULT_API_BASE,
    DEFAULT_CONFIG_PATH,
    applyRuleset,
    githubRequest,
    parseArgs,
    printUsage,
    readJson,
    stripNulls,
    resolvePath
};

if (require.main === module) {
    Promise.resolve(main()).catch(error => {
        console.error(`[RULESET][FAIL] ${String(error)}`);
        process.exit(1);
    });
}
