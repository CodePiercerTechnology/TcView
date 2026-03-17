const {
    DEFAULT_API_BASE,
    githubRequest,
    readJson,
    resolvePath
} = require('./apply-github-ruleset');

const DEFAULT_CONFIG_PATH = '.github/settings/repository.json';

function parseArgs(argv) {
    const options = {
        apply: false,
        owner: process.env.GITHUB_OWNER || '',
        repo: process.env.GITHUB_REPO || '',
        token: process.env.GITHUB_TOKEN || '',
        apiBaseUrl: process.env.GITHUB_API_BASE_URL || DEFAULT_API_BASE,
        configPath: process.env.GITHUB_REPO_SETTINGS_CONFIG || DEFAULT_CONFIG_PATH
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

function printUsage() {
    console.log('Usage:');
    console.log('  node scripts/apply-github-repo-settings.js --owner CodePiercerTechnology --repo TcView');
    console.log('  node scripts/apply-github-repo-settings.js --owner CodePiercerTechnology --repo TcView --apply');
    console.log('');
    console.log('Environment variables:');
    console.log('  GITHUB_TOKEN                 token with repository Administration:write (required only for --apply)');
    console.log('  GITHUB_OWNER                 repository owner');
    console.log('  GITHUB_REPO                  repository name');
    console.log('  GITHUB_API_BASE_URL          optional GitHub API base URL');
    console.log('  GITHUB_REPO_SETTINGS_CONFIG  optional repository settings config path');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const configPath = resolvePath(options.configPath);
    const payload = readJson(configPath, 'repository settings config');

    if (!options.owner || !options.repo) {
        printUsage();
        throw new Error('Both owner and repo are required.');
    }

    const repoUrl = `${options.apiBaseUrl.replace(/\/$/, '')}/repos/${options.owner}/${options.repo}`;
    console.log(`[REPO] TARGET ${options.owner}/${options.repo}`);
    console.log(`[REPO] Config: ${configPath}`);

    if (!options.apply) {
        console.log('[REPO] Dry run only. No GitHub API call was made.');
        return;
    }

    if (!options.token) {
        printUsage();
        throw new Error('GITHUB_TOKEN is required for --apply.');
    }

    const result = await githubRequest({
        method: 'PATCH',
        url: repoUrl,
        token: options.token,
        body: payload,
        userAgent: 'tcview-repo-settings-script'
    });

    console.log(`[REPO] Applied settings to ${result.full_name}`);
    console.log(`[REPO] merge_commit=${result.allow_merge_commit} squash=${result.allow_squash_merge} rebase=${result.allow_rebase_merge} delete_branch_on_merge=${result.delete_branch_on_merge}`);
}

Promise.resolve(main()).catch(error => {
    console.error(`[REPO][FAIL] ${String(error)}`);
    process.exit(1);
});
