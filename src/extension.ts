import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { TwinCATFileExplorerProvider, TwinCATFileTreeItem } from './tcViewFileExplorerProvider';
import { TwinCATFileSystemProvider } from './tcViewFileSystemProvider';
import { registerLanguageFeatures } from './iecStLanguageFeatures';
import { disposeProjectAnalyzer, getProjectAnalyzer, initializeProjectAnalyzer, onProjectAnalyzerCreated } from './tcViewProjectAnalyzer';
import { disposeTelemetry, logError, showPerfSummary, withPerfMetric } from './tcViewTelemetry';

let analyzerInitPromise: Promise<void> | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('TcView extension is now active!');
    const supportedTwinCATExts = new Set(['.tcpou', '.tcgvl', '.tcdut', '.tcprg', '.tcapp', '.tccom', '.tcvar', '.tcgds', '.tcio', '.tcitf']);
    const libraryPanels = new Map<string, vscode.WebviewPanel>();
    const libraryViewCache = new Map<string, { revision: number; html: string }>();
    const maxLibraryViewCacheEntries = 16;
    const redirectInProgress = new Set<string>();
    const skipNextAutoRedirect = new Set<string>();
    const lastFragmentBySource = new Map<string, string>();
    const updateTreeDiscoveryContext = async (state: { hasTwinCATFiles: boolean; isLoading: boolean; discoveryComplete: boolean }) => {
        await vscode.commands.executeCommand('setContext', 'tcview.hasTwinCATFiles', state.hasTwinCATFiles);
        await vscode.commands.executeCommand('setContext', 'tcview.isLookingForTwinCAT', state.isLoading);
        await vscode.commands.executeCommand('setContext', 'tcview.discoveryComplete', state.discoveryComplete);
    };

    const ensureAnalyzerInitialized = async (): Promise<void> => {
        if (!analyzerInitPromise) {
            analyzerInitPromise = initializeProjectAnalyzer().then(() => {
                console.log('TwinCAT Project Analyzer initialized');
            }).catch(err => {
                console.error('Failed to initialize TwinCAT Project Analyzer:', err);
            });
        }
        await analyzerInitPromise;
    };

    const getCachedLibraryViewHtml = (libraryName: string, revision: number) => {
        const key = libraryName.toUpperCase();
        const cached = libraryViewCache.get(key);
        if (!cached || cached.revision !== revision) {
            if (cached) {
                libraryViewCache.delete(key);
            }
            return undefined;
        }

        // Refresh LRU position on hit.
        libraryViewCache.delete(key);
        libraryViewCache.set(key, cached);
        return cached.html;
    };

    const setCachedLibraryViewHtml = (libraryName: string, revision: number, html: string) => {
        const key = libraryName.toUpperCase();
        libraryViewCache.delete(key);
        libraryViewCache.set(key, { revision, html });
        while (libraryViewCache.size > maxLibraryViewCacheEntries) {
            const oldestKey = libraryViewCache.keys().next().value;
            if (!oldestKey) {
                break;
            }
            libraryViewCache.delete(oldestKey);
        }
    };

    // Register language features (IntelliSense, snippets, diagnostics)
    registerLanguageFeatures(context);


    // Register the file explorer provider

    const fileExplorerProvider = new TwinCATFileExplorerProvider(
        vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined,
        state => { void updateTreeDiscoveryContext(state); }
    );
    
    const treeRegistration = vscode.window.registerTreeDataProvider('twincat.files', fileExplorerProvider);
    void updateTreeDiscoveryContext({
        hasTwinCATFiles: false,
        isLoading: true,
        discoveryComplete: false
    });

    // Register the file system provider for editable virtual documents
    const fileSystemProvider = new TwinCATFileSystemProvider();
    const registration = vscode.workspace.registerFileSystemProvider(
        TwinCATFileSystemProvider.scheme,
        fileSystemProvider,
        { isCaseSensitive: true }
    );

    // Command: Refresh files in sidebar
    const refreshCommand = vscode.commands.registerCommand('tcview.refreshFiles', () => {
        fileExplorerProvider.refresh();
    });

    // Command: Open file from sidebar
    const openFileCommand = vscode.commands.registerCommand('tcview.openFile', async (item: TwinCATFileTreeItem | vscode.Uri) => {
        // Handle both direct URI and TreeItem with resourceUri
        let fileUri: vscode.Uri;
        
        if (item instanceof vscode.Uri) {
            fileUri = item;
        } else if (item && item.resourceUri) {
            fileUri = item.resourceUri;
        } else {
            vscode.window.showErrorMessage('No file selected');
            return;
        }
        
        await openTwinCATFile(fileUri);
    });


    // Command: Open file from explorer context menu
    const openFromExplorerCommand = vscode.commands.registerCommand('tcview.openFromExplorer', async (uri: vscode.Uri) => {
        await openTwinCATFile(uri);
    });

    // Command: Switch to XML view
    const switchToXmlCommand = vscode.commands.registerCommand('tcview.switchToXml', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const document = editor.document;
        const viewColumn = editor.viewColumn;
        const cursor = editor.selection.active;

        try {
            if (document.uri.scheme === TwinCATFileSystemProvider.scheme) {
                // Switch virtual ST -> source XML (same editor column)
                const originalPath = TwinCATFileSystemProvider.getOriginalPath(document.uri);
                const originalUri = vscode.Uri.file(originalPath);
                lastFragmentBySource.set(originalPath.toLowerCase(), document.uri.fragment || '');
                skipNextAutoRedirect.add(originalUri.toString());

                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                const xmlDocument = await vscode.workspace.openTextDocument(originalUri);
                const xmlEditor = await vscode.window.showTextDocument(xmlDocument, {
                    preview: false,
                    viewColumn
                });

                const line = Math.max(0, Math.min(cursor.line, Math.max(0, xmlDocument.lineCount - 1)));
                const char = Math.max(0, Math.min(cursor.character, xmlDocument.lineAt(line).text.length));
                const position = new vscode.Position(line, char);
                xmlEditor.selection = new vscode.Selection(position, position);
                xmlEditor.revealRange(new vscode.Range(position, position));
                return;
            }

            if (document.uri.scheme === 'file') {
                const ext = path.extname(document.uri.fsPath).toLowerCase();
                if (!supportedTwinCATExts.has(ext)) {
                    vscode.window.showErrorMessage('Not a TwinCAT XML file');
                    return;
                }

                const rememberedFragment = lastFragmentBySource.get(document.uri.fsPath.toLowerCase()) || '';
                const targetUri = rememberedFragment
                    ? document.uri.with({ fragment: rememberedFragment })
                    : document.uri;

                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                await openTwinCATFile(targetUri);
                return;
            }

            vscode.window.showErrorMessage('Not a TwinCAT file');
        } catch (error) {
            logError(`Switch to XML failed: ${String(error)}`);
            vscode.window.showErrorMessage('Failed to switch TcView view: ' + error);
        }
    });

    const showPerfStatsCommand = vscode.commands.registerCommand('tcview.showPerfStats', () => {
        showPerfSummary();
        vscode.window.showInformationMessage('TcView performance stats written to the TcView output channel.');
    });

    const buildOutput = vscode.window.createOutputChannel('TcView Build');
    const buildDiagnostics = vscode.languages.createDiagnosticCollection('tcview-build');
    const projectDiagnostics = vscode.languages.createDiagnosticCollection('tcview-project');
    const activeSolutionStateKey = 'tcview.activeSolutionPath';

    const isDirectory = async (candidate: vscode.Uri) => {
        try {
            const stat = await vscode.workspace.fs.stat(candidate);
            return (stat.type & vscode.FileType.Directory) !== 0;
        } catch {
            return false;
        }
    };

    const firstMatchInDirectory = async (folderUri: vscode.Uri, extension: '.plcproj' | '.sln') => {
        try {
            const entries = await vscode.workspace.fs.readDirectory(folderUri);
            const files = entries
                .filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith(extension))
                .map(([name]) => path.join(folderUri.fsPath, name))
                .sort((a, b) => a.localeCompare(b));
            return files[0];
        } catch {
            return undefined;
        }
    };

    const findWorkspaceSolutions = async () => {
        return vscode.workspace.findFiles('**/*.sln', '**/node_modules/**', 50);
    };

    const readExpectedPlcTmcName = async (plcprojPath: string) => {
        try {
            const text = await fs.promises.readFile(plcprojPath, 'utf8');
            const explicitName = text.match(/<Name>\s*([^<]+?)\s*<\/Name>/i)?.[1]?.trim();
            if (explicitName) {
                return explicitName;
            }
        } catch {
            // Fall back to plcproj file stem below.
        }

        return path.basename(plcprojPath, '.plcproj');
    };

    const updateMissingTmcDiagnostic = async () => {
        projectDiagnostics.clear();

        if (!vscode.workspace.workspaceFolders?.length) {
            return;
        }

        const plcProjects = await vscode.workspace.findFiles('**/*.plcproj', '**/{node_modules,.git,_*}/**', 100);
        if (plcProjects.length === 0) {
            return;
        }

        for (const plcProject of plcProjects) {
            const plcFolder = path.dirname(plcProject.fsPath);
            const expectedTmcName = await readExpectedPlcTmcName(plcProject.fsPath);
            let hasExpectedTmc = false;
            try {
                const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(plcFolder));
                hasExpectedTmc = entries.some(([name, type]) =>
                    type === vscode.FileType.File &&
                    name.toLowerCase() === `${expectedTmcName.toLowerCase()}.tmc`
                );
            } catch {
                hasExpectedTmc = false;
            }

            if (hasExpectedTmc) {
                continue;
            }

            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 1),
                `Expected build file '${expectedTmcName}.tmc' was not found for this PLC project. Some references may be missing until a successful build completes.`,
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = 'TcView';
            projectDiagnostics.set(plcProject, [diagnostic]);
        }
    };

    const chooseBestSolutionFromPaths = (solutionPaths: string[], anchorPath?: string) => {
        if (solutionPaths.length === 0) {
            return undefined;
        }
        if (solutionPaths.length === 1 || !anchorPath) {
            return solutionPaths[0];
        }

        const anchorLower = anchorPath.toLowerCase();
        const score = (candidatePath: string) => {
            const lower = candidatePath.toLowerCase();
            if (anchorLower.startsWith(path.dirname(lower))) {
                return 100000 + path.dirname(lower).length;
            }
            let sharedPrefix = 0;
            const max = Math.min(anchorLower.length, lower.length);
            while (sharedPrefix < max && anchorLower[sharedPrefix] === lower[sharedPrefix]) {
                sharedPrefix++;
            }
            return sharedPrefix;
        };

        return [...solutionPaths].sort((a, b) => score(b) - score(a))[0];
    };

    const chooseBestSolution = async (anchorPath?: string) => {
        const solutions = await findWorkspaceSolutions();
        if (solutions.length === 0) {
            return undefined;
        }
        return chooseBestSolutionFromPaths(solutions.map(s => s.fsPath), anchorPath);
    };

    const isInsideWorkspace = (filePath: string) => {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const normalized = path.normalize(filePath).toLowerCase();
        return workspaceFolders.some(folder => {
            const workspacePath = path.normalize(folder.uri.fsPath).toLowerCase();
            return normalized === workspacePath || normalized.startsWith(workspacePath + path.sep);
        });
    };

    const resolveActiveSolutionPath = async (anchorPath?: string) => {
        const workspaceSolutions = (await findWorkspaceSolutions()).map(item => item.fsPath);
        const stored = context.workspaceState.get<string>(activeSolutionStateKey);
        if (stored && fs.existsSync(stored) && isInsideWorkspace(stored)) {
            return stored;
        }
        return chooseBestSolutionFromPaths(workspaceSolutions, anchorPath);
    };

    const setActiveSolutionContext = async (solutionPath?: string) => {
        if (solutionPath) {
            await context.workspaceState.update(activeSolutionStateKey, solutionPath);
        } else {
            await context.workspaceState.update(activeSolutionStateKey, undefined);
        }
        await vscode.commands.executeCommand('setContext', 'tcview.hasSolution', !!solutionPath);
        fileExplorerProvider.setHasActiveSolution(!!solutionPath);
    };

    const refreshActiveSolutionContext = async (anchorPath?: string) => {
        const resolved = await resolveActiveSolutionPath(anchorPath);
        await setActiveSolutionContext(resolved);
        return resolved;
    };

    const findTwinCATProjectMarkers = async (folderPath: string) => {
        try {
            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
            const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
            const solution = files.find(name => name.toLowerCase().endsWith('.sln'));
            const tsproj = files.find(name => name.toLowerCase().endsWith('.tsproj'));
            const plcproj = files.find(name => name.toLowerCase().endsWith('.plcproj'));
            return {
                solutionPath: solution ? path.join(folderPath, solution) : undefined,
                tsprojPath: tsproj ? path.join(folderPath, tsproj) : undefined,
                plcprojPath: plcproj ? path.join(folderPath, plcproj) : undefined
            };
        } catch {
            return {
                solutionPath: undefined,
                tsprojPath: undefined,
                plcprojPath: undefined
            };
        }
    };

    const resolveTwinCATFolderCandidate = async (folderPath: string, depth = 2): Promise<{ folderPath: string; solutionPath?: string } | undefined> => {
        const markers = await findTwinCATProjectMarkers(folderPath);
        if (markers.solutionPath || markers.tsprojPath || markers.plcprojPath) {
            return { folderPath, solutionPath: markers.solutionPath };
        }

        if (depth <= 0) {
            return undefined;
        }

        try {
            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
            const childDirs = entries
                .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
                .map(entry => path.join(folderPath, entry.name))
                .sort((a, b) => a.localeCompare(b));

            for (const childDir of childDirs) {
                const resolved = await resolveTwinCATFolderCandidate(childDir, depth - 1);
                if (resolved) {
                    return resolved;
                }
            }
        } catch {
            return undefined;
        }

        return undefined;
    };

    const resolveOpenableTwinCATRoot = async (targetPath: string): Promise<{ folderPath: string; solutionPath?: string } | undefined> => {
        try {
            const stat = await fs.promises.stat(targetPath);
            if (stat.isDirectory()) {
                return resolveTwinCATFolderCandidate(targetPath);
            }
        } catch {
            // Fall through to file handling.
        }

        const ext = path.extname(targetPath).toLowerCase();
        if (!['.sln', '.tsproj', '.plcproj'].includes(ext)) {
            return undefined;
        }

        const folderPath = path.dirname(targetPath);
        return {
            folderPath,
            solutionPath: ext === '.sln' ? targetPath : undefined
        };
    };

    const resolveSolutionTarget = async (uri?: vscode.Uri): Promise<string | undefined> => {
        const activeSolution = await resolveActiveSolutionPath(uri?.scheme === 'file' ? uri.fsPath : undefined);
        if (activeSolution) {
            return activeSolution;
        }

        if (uri?.scheme === 'file') {
            const lower = uri.fsPath.toLowerCase();
            if (lower.endsWith('.sln')) {
                return uri.fsPath;
            }
            if (await isDirectory(uri)) {
                const slnInDirectory = await firstMatchInDirectory(uri, '.sln');
                if (slnInDirectory) {
                    return slnInDirectory;
                }
                return chooseBestSolution(uri.fsPath);
            }
            return chooseBestSolution(path.dirname(uri.fsPath));
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return chooseBestSolution(workspaceFolder);
    };

    const parseMsBuildDiagnostics = (lines: string[]) => {
        const result = new Map<string, vscode.Diagnostic[]>();
        const addDiagnostic = (filePath: string, diagnostic: vscode.Diagnostic) => {
            const normalized = path.normalize(filePath);
            const list = result.get(normalized) ?? [];
            list.push(diagnostic);
            result.set(normalized, list);
        };

        const regex = /^(?<file>(?:[A-Za-z]:\\|\/)[^:(]+)\((?<line>\d+)(?:,(?<col>\d+))?\)\s*:\s*(?<severity>error|warning)\s*(?<code>[A-Za-z0-9]+)?\s*:?\s*(?<message>.+)$/i;
        for (const raw of lines) {
            const line = raw.trim();
            const match = line.match(regex);
            if (!match?.groups) {
                continue;
            }

            const filePath = match.groups.file;
            const lineNum = Math.max(0, Number(match.groups.line) - 1);
            const colNum = Math.max(0, Number(match.groups.col ?? '1') - 1);
            const severity = match.groups.severity.toLowerCase() === 'error'
                ? vscode.DiagnosticSeverity.Error
                : vscode.DiagnosticSeverity.Warning;
            const code = match.groups.code?.trim();
            const message = code ? `${code}: ${match.groups.message.trim()}` : match.groups.message.trim();
            const range = new vscode.Range(lineNum, colNum, lineNum, colNum + 1);
            addDiagnostic(filePath, new vscode.Diagnostic(range, message, severity));
        }

        buildDiagnostics.clear();
        for (const [filePath, diagnostics] of result) {
            buildDiagnostics.set(vscode.Uri.file(filePath), diagnostics);
        }
    };

    type BuildInvocation = {
        command: string;
        prefixArgs: string[];
        description: string;
    };

    const fileExists = (filePath: string | undefined): filePath is string => !!filePath && fs.existsSync(filePath);

    const resolveBuildInvocations = (): BuildInvocation[] => {
        const invocations: BuildInvocation[] = [];
        const addInvocation = (inv: BuildInvocation) => {
            const key = `${inv.command}|${inv.prefixArgs.join(' ')}`.toLowerCase();
            if (invocations.some(existing => `${existing.command}|${existing.prefixArgs.join(' ')}`.toLowerCase() === key)) {
                return;
            }
            invocations.push(inv);
        };

        const configured = vscode.workspace.getConfiguration('twincat').get<string>('build.msbuildPath', '').trim();
        if (fileExists(configured)) {
            addInvocation({ command: configured, prefixArgs: [], description: `configured msbuild path (${configured})` });
        }

        if (fileExists(process.env.MSBUILD_EXE_PATH)) {
            addInvocation({ command: process.env.MSBUILD_EXE_PATH!, prefixArgs: [], description: `MSBUILD_EXE_PATH (${process.env.MSBUILD_EXE_PATH})` });
        }

        if (process.platform === 'win32') {
            const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
            const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
            if (fileExists(vswhere)) {
                const probe = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], {
                    windowsHide: true,
                    encoding: 'utf8'
                });
                const candidate = probe.stdout
                    ?.split(/\r?\n/)
                    .map(line => line.trim())
                    .find(line => fileExists(line));
                if (candidate) {
                    addInvocation({ command: candidate, prefixArgs: [], description: `vswhere discovery (${candidate})` });
                }
            }

            const knownRoots = [
                'BuildTools',
                'Enterprise',
                'Professional',
                'Community'
            ].map(edition => path.join(programFilesX86, 'Microsoft Visual Studio', '2022', edition, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'));
            for (const knownPath of knownRoots) {
                if (fileExists(knownPath)) {
                    addInvocation({ command: knownPath, prefixArgs: [], description: `known VS path (${knownPath})` });
                }
            }
        }

        addInvocation({ command: 'msbuild', prefixArgs: [], description: 'msbuild from PATH' });
        addInvocation({ command: 'dotnet', prefixArgs: ['msbuild'], description: 'dotnet msbuild fallback' });
        return invocations;
    };

    const runExternalProcess = async (
        invocation: BuildInvocation,
        args: string[],
        cwd: string,
        buildLabel: string
    ): Promise<{ code: number; lines: string[]; spawnError?: Error }> => {
        return new Promise(resolve => {
            const collectedLines: string[] = [];
            let stdoutBuffer = '';
            let stderrBuffer = '';
            const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
                cwd,
                windowsHide: true,
                shell: false
            });

            child.stdout.on('data', chunk => {
                const text = chunk.toString();
                buildOutput.append(text);
                stdoutBuffer += text;
                const parts = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = parts.pop() ?? '';
                collectedLines.push(...parts);
            });
            child.stderr.on('data', chunk => {
                const text = chunk.toString();
                buildOutput.append(text);
                stderrBuffer += text;
                const parts = stderrBuffer.split(/\r?\n/);
                stderrBuffer = parts.pop() ?? '';
                collectedLines.push(...parts);
            });
            child.on('error', err => {
                buildOutput.appendLine(`[TcView Build] ${buildLabel}: invocation failed (${invocation.description}): ${err.message}`);
                resolve({ code: -1, lines: collectedLines, spawnError: err });
            });
            child.on('close', code => {
                if (stdoutBuffer.trim()) collectedLines.push(stdoutBuffer.trim());
                if (stderrBuffer.trim()) collectedLines.push(stderrBuffer.trim());
                resolve({ code: code ?? -1, lines: collectedLines });
            });
        });
    };

    const runBuildProcess = async (invocation: BuildInvocation, targetPath: string, buildLabel: string, extraArgs: string[]): Promise<{ code: number; lines: string[]; spawnError?: Error }> => {
        return runExternalProcess(invocation, [targetPath, '/m', ...extraArgs], path.dirname(targetPath), buildLabel);
    };

    const runMsBuild = async (targetPath: string, displayName?: string) => {
        const buildLabel = `Solution ${displayName ?? path.basename(targetPath)}`;
        const buildConfig = vscode.workspace.getConfiguration('twincat');
        const suppressedWarningCodes = new Set<string>(
            (buildConfig.get<string[]>('build.msbuildNoWarn', []) ?? [])
                .map(code => code.trim())
                .filter(code => code.length > 0)
                .map(code => code.toUpperCase())
        );
        if (buildConfig.get<boolean>('build.suppressUnsupportedTsprojWarning', true)) {
            suppressedWarningCodes.add('MSB4078');
        }
        const extraArgs: string[] = [];
        if (suppressedWarningCodes.size > 0) {
            extraArgs.push(`/nowarn:${[...suppressedWarningCodes].join(';')}`);
        }

        const targetArgsVariants = [[]];

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `TcView: Building ${buildLabel}`,
            cancellable: false
        }, async () => new Promise<void>(async (resolve, reject) => {
            buildOutput.appendLine(`[TcView Build] Starting build for ${buildLabel}: ${targetPath}`);
            buildOutput.show(true);

            const invocations = resolveBuildInvocations();
            let notFoundCount = 0;
            let anyToolRan = false;

            for (const invocation of invocations) {
                let invocationRan = false;
                for (const targetArgs of targetArgsVariants) {
                    const targetLabel = targetArgs.length > 0 ? targetArgs.join(' ') : '(default target)';
                    buildOutput.appendLine(`[TcView Build] Trying ${invocation.description} ${targetLabel}`);
                    const attempt = await runBuildProcess(invocation, targetPath, buildLabel, [...targetArgs, ...extraArgs]);
                    parseMsBuildDiagnostics(attempt.lines);

                    if (attempt.spawnError) {
                        const message = String(attempt.spawnError.message ?? attempt.spawnError);
                        if (/ENOENT|not found|cannot find|not recognized/i.test(message)) {
                            notFoundCount++;
                            break;
                        }
                        reject(attempt.spawnError);
                        return;
                    }
                    invocationRan = true;
                    anyToolRan = true;

                    if (attempt.code === 0) {
                        buildOutput.appendLine(`[TcView Build] Build succeeded for ${buildLabel}: ${targetPath}`);
                        resolve();
                        return;
                    }

                    const output = attempt.lines.join('\n');
                    const isTargetMissing = /MSB4057/i.test(output);
                    if (isTargetMissing) {
                        buildOutput.appendLine('[TcView Build] MSBuild reported a missing target.');
                    }

                    reject(new Error(`msbuild exited with code ${attempt.code}`));
                    return;
                }
            }

            if (!anyToolRan && notFoundCount > 0) {
                reject(new Error('MSBUILD_NOT_FOUND'));
                return;
            }
            reject(new Error('MSBUILD_UNKNOWN_FAILURE'));
        }));
    };

    const toFileUri = (target?: vscode.Uri | TwinCATFileTreeItem): vscode.Uri | undefined => {
        if (!target) {
            return undefined;
        }
        if (target instanceof vscode.Uri) {
            return target;
        }
        if ((target as TwinCATFileTreeItem).resourceUri) {
            return (target as TwinCATFileTreeItem).resourceUri;
        }
        return undefined;
    };

    const showSolutionNotOpenWarning = () => {
        vscode.window.showWarningMessage('TcView: Open a TwinCAT solution first.');
    };

    const openSolutionCommand = vscode.commands.registerCommand('tcview.openSolution', async () => {
        const workspaceSolutions = (await findWorkspaceSolutions())
            .map(uri => uri.fsPath)
            .sort((a, b) => a.localeCompare(b));

        if (workspaceSolutions.length > 0) {
            const picks = workspaceSolutions.map(solutionPath => ({
                label: path.basename(solutionPath),
                description: solutionPath,
                solutionPath
            }));
            picks.push({
                label: 'Browse for TwinCAT Solution...',
                description: 'Open a different solution folder in this window',
                solutionPath: ''
            });

            const selected = await vscode.window.showQuickPick(picks, {
                placeHolder: 'Select the TwinCAT solution to use for TcView'
            });
            if (!selected) {
                return;
            }
            if (selected.solutionPath) {
                await setActiveSolutionContext(selected.solutionPath);
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selected.solutionPath));
                await vscode.window.showTextDocument(document, { preview: false });
                return;
            }
        }

        const selection = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Open TwinCAT Solution or Project'
        });
        if (!selection || selection.length === 0) {
            return;
        }

        const target = selection[0];
        const targetPath = target.fsPath;
        const resolvedRoot = await resolveOpenableTwinCATRoot(targetPath);
        if (!resolvedRoot) {
            vscode.window.showWarningMessage('TcView: Select a TwinCAT solution, TwinCAT project, or a folder containing one.');
            return;
        }

        const folderToOpen = vscode.Uri.file(resolvedRoot.folderPath);
        await setActiveSolutionContext(resolvedRoot.solutionPath);
        await vscode.commands.executeCommand('vscode.openFolder', folderToOpen, false);
    });

    const buildSolutionWithMsBuildCommand = vscode.commands.registerCommand('tcview.buildSolutionWithMsBuild', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        const uri = toFileUri(targetArg);
        const solutionPath = await resolveSolutionTarget(uri);
        if (!solutionPath) {
            showSolutionNotOpenWarning();
            return;
        }
        await setActiveSolutionContext(solutionPath);

        try {
            await runMsBuild(solutionPath, path.basename(solutionPath));
            vscode.window.showInformationMessage(`TcView: Solution build succeeded (${path.basename(solutionPath)}).`);
        } catch (error) {
            const message = String(error);
            if (/MSBUILD_NOT_FOUND|not recognized|ENOENT|could not be found/i.test(message)) {
                vscode.window.showErrorMessage('TcView: msbuild was not found in PATH. Open a Developer Command Prompt or add MSBuild to PATH.');
            } else {
                vscode.window.showErrorMessage(`TcView: Solution build failed for ${path.basename(solutionPath)}. See TcView Build output.`);
            }
            buildOutput.appendLine(`[TcView Build] Solution build failed for ${solutionPath}: ${message}`);
            buildOutput.show(true);
        }
    });

    const showLibrariesCommand = vscode.commands.registerCommand('tcview.showLibraries', async () => {
        await ensureAnalyzerInitialized();
        const analyzer = getProjectAnalyzer();
        const libs = analyzer.getLibraryReferences();
        if (libs.length === 0) {
            vscode.window.showInformationMessage('TcView: no TwinCAT libraries detected yet. Run after project scan.');
            return;
        }

        const lines = libs.map(lib =>
            `${lib.vendor ?? 'Unknown vendor'} | ${lib.name} | ${lib.version} | ${lib.mode}`
        );

        const doc = await vscode.workspace.openTextDocument({
            language: 'plaintext',
            content: ['Detected TwinCAT Libraries', '==========================', '', ...lines].join('\n')
        });
        await vscode.window.showTextDocument(doc, { preview: false });
    });

    const escapeHtml = (value: string) =>
        value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

    const renderLibraryApiHtml = (
        libraryName: string,
        api: ReturnType<ReturnType<typeof getProjectAnalyzer>['getLibraryApi']>
    ) => {
        const reference = api.reference;
        const hasResolvedApi = api.symbols.length > 0 || api.dataTypes.length > 0;
        const coverageLabel = hasResolvedApi
            ? 'TMC-derived API: partial/project-scoped'
            : reference?.mode === 'metadata_only'
                ? 'Metadata only'
                : 'No TMC API found';
        const coverageTone = hasResolvedApi ? 'partial' : reference?.mode === 'metadata_only' ? 'metadata' : 'missing';
        const functionBlockNames = new Set(api.symbols.filter(symbol => symbol.kind === 'functionBlock').map(symbol => symbol.name.toUpperCase()));
        const programNames = new Set(api.symbols.filter(symbol => symbol.kind === 'program').map(symbol => symbol.name.toUpperCase()));
        const typeItems = api.dataTypes.filter(typeInfo => !functionBlockNames.has(typeInfo.name.toUpperCase()) && !programNames.has(typeInfo.name.toUpperCase()));
        const functionBlocks = api.symbols
            .filter(symbol => symbol.kind === 'functionBlock')
            .map(symbol => ({ symbol, dataType: api.dataTypes.find(typeInfo => typeInfo.name.toUpperCase() === symbol.name.toUpperCase()) }));
        const functions = api.symbols.filter(symbol => symbol.kind === 'function');
        const variables = api.symbols.filter(symbol => symbol.kind === 'variable');
        const programs = api.symbols.filter(symbol => symbol.kind === 'program');

        const renderMembers = (members?: Map<string, string>) => {
            if (!members || members.size === 0) {
                return '<div class="muted">No members published in TMC.</div>';
            }
            return `<table class="members"><tbody>${[...members.entries()]
                .map(([name, type]) => `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(type)}</td></tr>`)
                .join('')}</tbody></table>`;
        };

        const renderSymbolCards = (
            title: string,
            items: Array<{ name: string; type?: string; documentation?: string; members?: Map<string, string>; kindLabel?: string }>
        ) => {
            if (items.length === 0) {
                return '';
            }
            return `
                <section class="group">
                    <h2>${escapeHtml(title)} <span>${items.length}</span></h2>
                    ${items.map(item => `
                        <article class="card" data-search="${escapeHtml(`${item.name} ${item.type ?? ''} ${item.documentation ?? ''}`.toLowerCase())}">
                            <div class="card-head">
                                <div>
                                    <h3>${escapeHtml(item.name)}</h3>
                                    ${item.kindLabel ? `<div class="kind">${escapeHtml(item.kindLabel)}</div>` : ''}
                                </div>
                                ${item.type ? `<code>${escapeHtml(item.type)}</code>` : ''}
                            </div>
                            ${item.documentation ? `<p class="doc">${escapeHtml(item.documentation)}</p>` : ''}
                            ${item.members ? renderMembers(item.members) : ''}
                        </article>
                    `).join('')}
                </section>
            `;
        };

        const emptyState = api.symbols.length === 0 && api.dataTypes.length === 0
            ? `<div class="empty">No published library API was resolved for this reference yet. Build the owning PLC project to generate a matching TMC, or configure additional TMC roots. TMC-based library views are project-scoped and may only include items compiled into or required by the current PLC project.</div>`
            : '';
        const scopeNotice = `<div class="notice">Library API is derived from the current PLC project's <code>.tmc</code>. This is project-scoped and may only include items compiled into or required by this PLC project, not the library's full catalog.</div>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(libraryName)}</title>
    <style>
        :root {
            color-scheme: light dark;
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --muted: var(--vscode-descriptionForeground);
            --panel: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-editorWidget-border) 12%);
            --border: var(--vscode-editorWidget-border);
            --accent: var(--vscode-textLink-foreground);
            --code-bg: color-mix(in srgb, var(--vscode-textCodeBlock-background) 80%, transparent 20%);
        }
        body {
            margin: 0;
            padding: 24px;
            background: radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 14%, transparent 86%), transparent 35%), var(--bg);
            color: var(--fg);
            font: 13px/1.5 Consolas, "Courier New", monospace;
        }
        header {
            margin-bottom: 20px;
            padding: 18px;
            border: 1px solid var(--border);
            background: var(--panel);
        }
        h1, h2, h3, p { margin: 0; }
        h1 { font-size: 22px; margin-bottom: 8px; }
        .meta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; color: var(--muted); }
        .pill { padding: 2px 8px; border: 1px solid var(--border); background: var(--code-bg); }
        .pill.coverage.partial { border-color: color-mix(in srgb, var(--accent) 45%, var(--border) 55%); }
        .pill.coverage.metadata { border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 55%, var(--border) 45%); }
        .pill.coverage.missing { border-color: color-mix(in srgb, var(--vscode-errorForeground) 55%, var(--border) 45%); }
        .toolbar { margin: 18px 0; }
        input {
            width: min(520px, 100%);
            box-sizing: border-box;
            padding: 8px 10px;
            border: 1px solid var(--border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        .group { margin: 22px 0; }
        .group h2 { display: flex; gap: 8px; align-items: baseline; margin-bottom: 12px; font-size: 16px; }
        .group h2 span { color: var(--muted); font-size: 12px; }
        .card {
            border: 1px solid var(--border);
            background: var(--panel);
            padding: 14px;
            margin-bottom: 12px;
        }
        .card-head {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: start;
            margin-bottom: 8px;
        }
        .kind, .muted { color: var(--muted); }
        .doc { white-space: pre-wrap; margin: 8px 0 10px; color: var(--muted); }
        code {
            background: var(--code-bg);
            padding: 2px 6px;
            border: 1px solid var(--border);
            white-space: nowrap;
        }
        .members {
            width: 100%;
            border-collapse: collapse;
            margin-top: 8px;
        }
        .members td {
            border-top: 1px solid var(--border);
            padding: 6px 8px 6px 0;
            vertical-align: top;
        }
        .members td:first-child { width: 42%; }
        .empty {
            border: 1px dashed var(--border);
            padding: 18px;
            color: var(--muted);
            background: var(--panel);
        }
        .notice {
            border: 1px solid var(--border);
            border-left: 4px solid var(--accent);
            padding: 12px 14px;
            margin: 0 0 18px;
            background: var(--panel);
            color: var(--muted);
        }
    </style>
</head>
<body>
    <header>
        <h1>${escapeHtml(libraryName)}</h1>
        <p class="muted">TwinCAT library API view from locally resolved metadata and TMC symbols.</p>
        <div class="meta">
            <span class="pill">Vendor: ${escapeHtml(reference?.vendor ?? 'Unknown vendor')}</span>
            <span class="pill">Version: ${escapeHtml(reference?.version ?? 'unknown')}</span>
            <span class="pill">Mode: ${escapeHtml(reference?.mode ?? 'unknown')}</span>
            <span class="pill coverage ${escapeHtml(coverageTone)}">${escapeHtml(coverageLabel)}</span>
            ${reference?.path ? `<span class="pill">${escapeHtml(path.basename(reference.path))}</span>` : ''}
        </div>
    </header>
    ${scopeNotice}
    <div class="toolbar">
        <input id="filter" type="search" placeholder="Filter API items..." />
    </div>
    ${emptyState}
    ${renderSymbolCards('Function Blocks', functionBlocks.map(item => ({
            name: item.symbol.name,
            type: item.symbol.type,
            documentation: item.symbol.documentation,
            members: item.dataType?.members,
            kindLabel: 'FUNCTION_BLOCK'
        })))}
    ${renderSymbolCards('Data Types', typeItems.map(typeInfo => ({
            name: typeInfo.name,
            type: typeInfo.kind.toUpperCase(),
            documentation: typeInfo.documentation,
            members: typeInfo.members,
            kindLabel: typeInfo.kind.toUpperCase()
        })))}
    ${renderSymbolCards('Functions', functions.map(symbol => ({
            name: symbol.name,
            type: symbol.type,
            documentation: symbol.documentation,
            kindLabel: 'FUNCTION'
        })))}
    ${renderSymbolCards('Variables', variables.map(symbol => ({
            name: symbol.name,
            type: symbol.type,
            documentation: symbol.documentation,
            kindLabel: 'VARIABLE'
        })))}
    ${renderSymbolCards('Programs', programs.map(symbol => ({
            name: symbol.name,
            type: symbol.type,
            documentation: symbol.documentation,
            kindLabel: 'PROGRAM'
        })))}
    <script>
        const input = document.getElementById('filter');
        const cards = Array.from(document.querySelectorAll('.card'));
        input?.addEventListener('input', () => {
            const query = (input.value || '').trim().toLowerCase();
            cards.forEach(card => {
                const haystack = card.getAttribute('data-search') || '';
                card.style.display = !query || haystack.includes(query) ? '' : 'none';
            });
        });
    </script>
</body>
</html>`;
    };

    const openLibraryReferenceCommand = vscode.commands.registerCommand('tcview.openLibraryReference', async (item?: TwinCATFileTreeItem) => {
        if (!item) {
            vscode.window.showInformationMessage('TcView: Select a library reference from the TcView sidebar.');
            return;
        }
        const libraryName = (item.label?.toString() || '').trim();
        if (!libraryName) {
            vscode.window.showWarningMessage('TcView: Library reference name was not found.');
            return;
        }

        await ensureAnalyzerInitialized();
        const analyzer = getProjectAnalyzer();
        const revision = analyzer.getIndexRevision();
        let html = getCachedLibraryViewHtml(libraryName, revision);
        if (!html) {
            const api = analyzer.getLibraryApi(libraryName);
            html = renderLibraryApiHtml(libraryName, api);
            setCachedLibraryViewHtml(libraryName, revision, html);
        }
        const panelKey = libraryName.toUpperCase();
        const existing = libraryPanels.get(panelKey);
        if (existing) {
            existing.webview.html = html;
            existing.reveal(vscode.ViewColumn.Active);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tcviewLibraryReference',
            `Library: ${libraryName}`,
            vscode.ViewColumn.Active,
            {
                enableFindWidget: true,
                retainContextWhenHidden: true
            }
        );
        panel.webview.html = html;
        panel.onDidDispose(() => {
            libraryPanels.delete(panelKey);
        });
        libraryPanels.set(panelKey, panel);
    });

    let activeAnalyzerRefreshDisposable: vscode.Disposable | undefined;
    const refreshOpenLibraryPanels = () => {
        libraryViewCache.clear();
        if (libraryPanels.size === 0) {
            return;
        }

        const analyzer = getProjectAnalyzer();
        const revision = analyzer.getIndexRevision();
        for (const [panelKey, panel] of libraryPanels) {
            const titleMatch = panel.title.match(/^Library:\s*(.+)$/);
            const libraryName = titleMatch?.[1]?.trim() || panelKey;
            let html = getCachedLibraryViewHtml(libraryName, revision);
            if (!html) {
                const api = analyzer.getLibraryApi(libraryName);
                html = renderLibraryApiHtml(libraryName, api);
                setCachedLibraryViewHtml(libraryName, revision, html);
            }
            panel.webview.html = html;
        }
    };
    const analyzerRefreshListener = onProjectAnalyzerCreated(analyzer => {
        activeAnalyzerRefreshDisposable?.dispose();
        activeAnalyzerRefreshDisposable = analyzer.onDidRefreshIndex(refreshOpenLibraryPanels);
    });

    const solutionWatcher = vscode.workspace.createFileSystemWatcher('**/*.sln');
    const tmcWatcher = vscode.workspace.createFileSystemWatcher('**/*.{tmc,plcproj,tsproj,sln}');
    const solutionContextRefresh = () => {
        void refreshActiveSolutionContext();
    };
    const projectDiagnosticsRefresh = () => {
        void updateMissingTmcDiagnostic();
    };
    solutionWatcher.onDidCreate(solutionContextRefresh);
    solutionWatcher.onDidDelete(solutionContextRefresh);
    solutionWatcher.onDidChange(solutionContextRefresh);
    tmcWatcher.onDidCreate(projectDiagnosticsRefresh);
    tmcWatcher.onDidDelete(projectDiagnosticsRefresh);
    tmcWatcher.onDidChange(projectDiagnosticsRefresh);
    const workspaceFolderChangeListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        fileExplorerProvider.setWorkspaceRoot(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined);
        void refreshActiveSolutionContext();
        void updateMissingTmcDiagnostic();
    });

    // Helper function to open TwinCAT file
    async function openTwinCATFile(uri: vscode.Uri) {
        try {
            const fragment = uri.fragment;
            if (fragment) {
                const baseUri = uri.with({ fragment: '' });
                const virtualUri = await withPerfMetric(`preload fragment ${path.basename(baseUri.fsPath)}#${fragment}`, () =>
                    fileSystemProvider.preloadFile(baseUri.fsPath, fragment)
                );

                const document = await withPerfMetric(`open fragment doc ${path.basename(baseUri.fsPath)}#${fragment}`, () =>
                    vscode.workspace.openTextDocument(virtualUri)
                );
                await withPerfMetric(`show fragment editor ${path.basename(baseUri.fsPath)}#${fragment}`, () =>
                    vscode.window.showTextDocument(document, { preview: false })
                );

                await vscode.languages.setTextDocumentLanguage(document, 'iec-st');
            } else {
                // Regular file - preload and open
                const virtualUri = await withPerfMetric(`preload ${path.basename(uri.fsPath)}`, () =>
                    fileSystemProvider.preloadFile(uri.fsPath)
                );
                
                // Open the virtual file
                const document = await withPerfMetric(`open doc ${path.basename(uri.fsPath)}`, () =>
                    vscode.workspace.openTextDocument(virtualUri)
                );
                await withPerfMetric(`show editor ${path.basename(uri.fsPath)}`, () =>
                    vscode.window.showTextDocument(document, { preview: false })
                );
                
                // Set language mode explicitly for syntax highlighting
                await vscode.languages.setTextDocumentLanguage(document, 'iec-st');
            }
            
        } catch (error) {
            logError(`Open TcView file failed: ${String(error)}`);
            vscode.window.showErrorMessage('Failed to open TcView file: ' + error);
        }
    }



    // Auto-save: Listen for native save events and sync to XML
    const saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (document.uri.scheme === TwinCATFileSystemProvider.scheme) {
            try {
                await withPerfMetric('save to original XML', () => fileSystemProvider.saveToOriginal(document.uri));
                const showSaveMessage = vscode.workspace.getConfiguration('twincat').get<boolean>('showSaveNotification', false);
                if (showSaveMessage) {
                    vscode.window.showInformationMessage('Saved to ' + path.basename(TwinCATFileSystemProvider.getOriginalPath(document.uri)));
                }
            } catch (error) {
                logError(`Auto-save failed: ${String(error)}`);
                vscode.window.showErrorMessage('Failed to auto-save: ' + error);
            }
        }
    });

    // Auto-open: Intercept TwinCAT file opens and redirect to ST editor
    const openListener = vscode.workspace.onDidOpenTextDocument(async (document) => {
        if (document.uri.scheme !== 'file') {
            return;
        }

        const uriKey = document.uri.toString();
        if (skipNextAutoRedirect.has(uriKey)) {
            skipNextAutoRedirect.delete(uriKey);
            return;
        }

        const fileName = document.uri.fsPath;
        const ext = path.extname(fileName).toLowerCase();
        if (!supportedTwinCATExts.has(ext)) {
            return;
        }

        // Only redirect if this is the actively visible editor document.
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.toString() !== document.uri.toString()) {
            return;
        }

        if (redirectInProgress.has(document.uri.toString())) {
            return;
        }

        redirectInProgress.add(document.uri.toString());
        try {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await openTwinCATFile(document.uri);
        } finally {
            redirectInProgress.delete(document.uri.toString());
        }
    });

    // Recovery for restored virtual tabs from previous session.
    const recoverRestoredTwincatTabs = async () => {
        const active = vscode.window.activeTextEditor;
        const docs = vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === TwinCATFileSystemProvider.scheme);
        if (docs.length === 0) {
            return;
        }

        for (const doc of docs) {
            try {
                const originalPath = TwinCATFileSystemProvider.getOriginalPath(doc.uri);
                if (!originalPath) continue;
                const originalUri = vscode.Uri.file(originalPath);
                const fragment = doc.uri.fragment || '';
                const targetUri = fragment ? originalUri.with({ fragment }) : originalUri;
                await openTwinCATFile(targetUri);
            } catch (error) {
                logError(`Recovered tab open failed for ${doc.uri.toString()}: ${String(error)}`);
            }
        }

        if (active && active.document.uri.scheme === 'file') {
            await vscode.window.showTextDocument(active.document, { preview: false, viewColumn: active.viewColumn });
        }
    };

    const startupTasksTimer = setTimeout(() => {
        void refreshActiveSolutionContext();
        void updateMissingTmcDiagnostic();
        void recoverRestoredTwincatTabs();
    }, 250);

    // Clean up on deactivate

    context.subscriptions.push(
        registration,
        treeRegistration,
        fileExplorerProvider,
        refreshCommand,
        openFileCommand,
        openFromExplorerCommand,
        switchToXmlCommand,
        showPerfStatsCommand,
        openSolutionCommand,
        buildSolutionWithMsBuildCommand,
        openLibraryReferenceCommand,
        showLibrariesCommand,
        analyzerRefreshListener,
        { dispose: () => activeAnalyzerRefreshDisposable?.dispose() },
        saveListener,
        openListener,
        solutionWatcher,
        tmcWatcher,
        workspaceFolderChangeListener,
        { dispose: () => clearTimeout(startupTasksTimer) },
        buildOutput,
        buildDiagnostics,
        projectDiagnostics
    );




}

export function deactivate() {
    disposeProjectAnalyzer();
    analyzerInitPromise = undefined;
    disposeTelemetry();
}
