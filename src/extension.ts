import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import { randomUUID } from 'crypto';
import { TwinCATFileExplorerProvider, TwinCATFileTreeItem, TwinCATItemType } from './tcViewFileExplorerProvider';
import { TwinCATFileSystemProvider } from './tcViewFileSystemProvider';
import { TwinCATWebviewExplorerProvider } from './tcViewWebviewExplorerProvider';
import { TwinCATXmlConverter } from './tcViewXmlConverter';
import { formatBackendCommandError, TwinCATBackendClient } from './backend/tcViewBackendClient';
import { registerLanguageFeatures } from './iecStLanguageFeatures';
import { disposeProjectAnalyzer, getProjectAnalyzer, initializeProjectAnalyzer, onProjectAnalyzerCreated, refreshProjectAnalyzerLibraryMetadata } from './tcViewProjectAnalyzer';
import { disposeTelemetry, logError, showPerfSummary, withPerfMetric, writePerfSnapshot, writePerfTrace } from './tcViewTelemetry';

let analyzerInitPromise: Promise<void> | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('TcView extension is now active!');
    const metadataConverter = new TwinCATXmlConverter();
    const backendClient = new TwinCATBackendClient(context.extensionPath);
    // TwinCAT solutions can be represented by either .tsproj or .tspproj sibling files.
    const solutionProjectExtensions = ['.tsproj', '.tspproj'];
    const supportedTwinCATExts = new Set(['.tcpou', '.tcgvl', '.tcdut', '.tcprg', '.tcapp', '.tccom', '.tcvar', '.tcgds', '.tcio', '.tcitf']);
    const libraryPanels = new Map<string, vscode.WebviewPanel>();
    const libraryViewCache = new Map<string, { revision: number; html: string }>();
    const maxLibraryViewCacheEntries = 16;
    const libraryOutput = vscode.window.createOutputChannel('TcView Libraries');
    type PendingFilesystemClipboard = {
        mode: 'copy' | 'cut';
        kind: 'filesystem';
        plcprojPath: string;
        targetPath: string;
        isFile: boolean;
    };

    type PendingInternalClipboard = {
        mode: 'copy' | 'cut';
        kind: 'internal';
        sourceFilePath: string;
        sourceFolderName?: string;
        payload:
            | {
                type: 'folder';
                name: string;
                folderTree: any;
                methods: any[];
                properties: any[];
                actions: any[];
                transitions: any[];
            }
            | {
                type: 'method' | 'property' | 'action' | 'transition';
                name: string;
                entry: any;
            };
    };

    let pendingTreeClipboard: PendingFilesystemClipboard | PendingInternalClipboard | undefined;
    const redirectInProgress = new Set<string>();
    const skipNextAutoRedirect = new Set<string>();
    const lastFragmentBySource = new Map<string, string>();
    const isInterfaceAccessorFragment = (uri: vscode.Uri) => {
        const fragment = (uri.fragment || '').toLowerCase();
        if (fragment !== 'propertyget' && !fragment.startsWith('propertyget:') && fragment !== 'propertyset' && !fragment.startsWith('propertyset:')) {
            return false;
        }

        const ext = path.extname(uri.fsPath).toLowerCase();
        return ext === '.tcitf' || ext === '.tcio';
    };
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

    let openFileCommandRef = async (item: TwinCATFileTreeItem) => {
        await openTwinCATFile(item.targetUri);
    };
    let runTreeActionCommandRef = async (action: string, item: TwinCATFileTreeItem, value?: string) => {
        switch (action) {
            case 'openSolution':
                await vscode.commands.executeCommand('tcview.openSolution');
                return;
            case 'renameTwinCatItem':
                await vscode.commands.executeCommand('tcview.renameTwinCATItem', item, value);
                return;
            case 'createTwinCatFolder':
                await vscode.commands.executeCommand('tcview.createTwinCATFolder', item, value);
                return;
            case 'createTwinCatFileTemplate': {
                let templateId = value;
                let providedName: string | undefined;
                if (value) {
                    try {
                        const parsed = JSON.parse(value) as { templateId?: string; name?: string };
                        templateId = parsed.templateId;
                        providedName = parsed.name;
                    } catch {
                        // Older payload shape passed the template id directly.
                    }
                }
                await vscode.commands.executeCommand('tcview.createTwinCATFileFromTemplate', item, templateId, providedName);
                return;
            }
            case 'createTwinCatMethod':
                await vscode.commands.executeCommand('tcview.createTwinCATMember', item, 'method', value);
                return;
            case 'createTwinCatProperty':
                await vscode.commands.executeCommand('tcview.createTwinCATMember', item, 'property', value);
                return;
            case 'createTwinCatAction':
                await vscode.commands.executeCommand('tcview.createTwinCATMember', item, 'action', value);
                return;
            case 'createTwinCatTransition':
                await vscode.commands.executeCommand('tcview.createTwinCATMember', item, 'transition', value);
                return;
            case 'copyTwinCatItem':
                await vscode.commands.executeCommand('tcview.copyTwinCATItem', item);
                return;
            case 'cutTwinCatItem':
                await vscode.commands.executeCommand('tcview.cutTwinCATItem', item);
                return;
            case 'pasteTwinCatItem':
                await vscode.commands.executeCommand('tcview.pasteTwinCATItem', item);
                return;
            case 'deleteTwinCatItem':
                switch (item.itemType) {
                    case TwinCATItemType.File:
                        await vscode.commands.executeCommand('tcview.deleteTwinCATFile', item);
                        return;
                    case TwinCATItemType.Folder:
                        await vscode.commands.executeCommand('tcview.deleteTwinCATFolder', item);
                        return;
                    case TwinCATItemType.POUFolder:
                    case TwinCATItemType.Method:
                    case TwinCATItemType.Property:
                    case TwinCATItemType.PropertyGet:
                    case TwinCATItemType.PropertySet:
                    case TwinCATItemType.Action:
                    case TwinCATItemType.Transition:
                        await vscode.commands.executeCommand('tcview.deleteTwinCATMember', item);
                        return;
                    default:
                        return;
                }
            case 'dropTwinCatItem':
                await vscode.commands.executeCommand('tcview.dropTwinCATItem', item, value);
                return;
            default:
                return;
        }
    };

    // Register the file explorer provider

    const fileExplorerProvider = new TwinCATFileExplorerProvider(
        vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined,
        state => { void updateTreeDiscoveryContext(state); }
    );
    const webviewExplorerProvider = new TwinCATWebviewExplorerProvider(
        context,
        fileExplorerProvider,
        async item => {
            if (item.itemType === TwinCATItemType.ReferenceItem) {
                await vscode.commands.executeCommand('tcview.openLibraryReference', item);
                return;
            }
            await openFileCommandRef(item);
        },
        async (action, item, value) => runTreeActionCommandRef(action, item, value)
    );
    
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
        void withPerfMetric('tree.refresh.manual', async () => {
            fileExplorerProvider.refresh();
        });
    });

    const treeDiagnosticsListener = vscode.languages.onDidChangeDiagnostics(() => {
        fileExplorerProvider.handleDiagnosticsChanged();
    });
    const webviewRegistration = vscode.window.registerWebviewViewProvider(
        TwinCATWebviewExplorerProvider.viewType,
        webviewExplorerProvider
    );

    // Command: Open file from sidebar
    const openFileCommand = vscode.commands.registerCommand('tcview.openFile', async (item: TwinCATFileTreeItem | vscode.Uri) => {
        // Handle both direct URI and TreeItem with resourceUri
        let fileUri: vscode.Uri;
        
        if (item instanceof vscode.Uri) {
            fileUri = item;
        } else if (item && item.targetUri) {
            fileUri = item.targetUri;
        } else {
            vscode.window.showErrorMessage('No file selected');
            return;
        }
        
        await openTwinCATFile(fileUri);
    });
    openFileCommandRef = async (item: TwinCATFileTreeItem) => {
        if (item.itemType === TwinCATItemType.ReferenceItem) {
            await vscode.commands.executeCommand('tcview.openLibraryReference', item);
            return;
        }
        await openTwinCATFile(item.targetUri);
    };


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
                await vscode.languages.setTextDocumentLanguage(xmlDocument, 'xml');
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
    const exportPerfBaselineCommand = vscode.commands.registerCommand('tcview.exportPerfBaseline', async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const defaultUri = workspaceRoot
            ? vscode.Uri.file(path.join(workspaceRoot, '.test-results', 'perf', 'runtime-baseline.json'))
            : undefined;
        const target = await vscode.window.showSaveDialog({
            defaultUri,
            filters: {
                JSON: ['json']
            },
            saveLabel: 'Export TcView Perf Baseline'
        });
        if (!target) {
            return;
        }

        try {
            await writePerfSnapshot(target.fsPath);
            vscode.window.showInformationMessage(`TcView performance baseline exported: ${target.fsPath}`);
        } catch (error) {
            logError(`Perf baseline export failed: ${String(error)}`);
            vscode.window.showErrorMessage(`Failed to export TcView performance baseline: ${String(error)}`);
        }
    });
    const exportPerfTraceCommand = vscode.commands.registerCommand('tcview.exportPerfTrace', async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const defaultUri = workspaceRoot
            ? vscode.Uri.file(path.join(workspaceRoot, '.test-results', 'perf', 'runtime-trace.json'))
            : undefined;
        const target = await vscode.window.showSaveDialog({
            defaultUri,
            filters: {
                JSON: ['json']
            },
            saveLabel: 'Export TcView Perf Trace'
        });
        if (!target) {
            return;
        }

        try {
            await writePerfTrace(target.fsPath);
            vscode.window.showInformationMessage(`TcView performance trace exported: ${target.fsPath}`);
        } catch (error) {
            logError(`Perf trace export failed: ${String(error)}`);
            vscode.window.showErrorMessage(`Failed to export TcView performance trace: ${String(error)}`);
        }
    });

    const buildOutput = vscode.window.createOutputChannel('TcView Build');
    const buildDiagnostics = vscode.languages.createDiagnosticCollection('tcview-build');
    const projectDiagnostics = vscode.languages.createDiagnosticCollection('tcview-project');
    const activeSolutionStateKey = 'tcview.activeSolutionPath';
    type TwinCATProjectMarkers = {
        solutionPath: string | undefined;
        tsprojPath: string | undefined;
        plcprojPath: string | undefined;
        isTwinCATSolution: boolean;
        isStandalonePlcProject: boolean;
        hasTwinCATFiles: boolean;
    };
    const workspaceSolutionsCacheTtlMs = 1000;
    let workspaceSolutionsCache: { expiresAt: number; solutions: vscode.Uri[] } | undefined;
    const markerCache = new Map<string, { mtimeMs: number; markers: TwinCATProjectMarkers }>();
    const emptyProjectMarkers = (): TwinCATProjectMarkers => ({
        solutionPath: undefined,
        tsprojPath: undefined,
        plcprojPath: undefined,
        isTwinCATSolution: false,
        isStandalonePlcProject: false,
        hasTwinCATFiles: false
    });
    const getFolderCacheKey = (folderPath: string) => path.normalize(folderPath).toLowerCase();
    const invalidateWorkspaceDiscoveryCaches = () => {
        workspaceSolutionsCache = undefined;
        markerCache.clear();
    };

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
        const now = Date.now();
        if (workspaceSolutionsCache && workspaceSolutionsCache.expiresAt > now) {
            return [...workspaceSolutionsCache.solutions];
        }

        const candidates = await vscode.workspace.findFiles('**/*.sln', '**/{node_modules,.git,_*}/**', 50);
        const validSolutions: vscode.Uri[] = [];
        for (const candidate of candidates) {
            const markers = await findTwinCATProjectMarkers(path.dirname(candidate.fsPath));
            if (markers.isTwinCATSolution) {
                validSolutions.push(candidate);
            }
        }
        workspaceSolutionsCache = {
            expiresAt: now + workspaceSolutionsCacheTtlMs,
            solutions: [...validSolutions]
        };
        return validSolutions;
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

    const updateProjectDiagnostics = async () => {
        projectDiagnostics.clear();

        if (!vscode.workspace.workspaceFolders?.length) {
            return;
        }

        const plcProjects = await vscode.workspace.findFiles('**/*.plcproj', '**/{node_modules,.git,_*}/**', 100);
        if (plcProjects.length === 0) {
            return;
        }

        const activeSolutionPath = await resolveActiveSolutionPath();
        const hasActiveSolution = !!activeSolutionPath;
        const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

        const addProjectDiagnostic = (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
            const key = uri.toString();
            const existing = diagnosticsByFile.get(key) ?? [];
            existing.push(diagnostic);
            diagnosticsByFile.set(key, existing);
        };

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
            addProjectDiagnostic(plcProject, diagnostic);
        }

        for (const plcProject of plcProjects) {
            const fileDiagnostics = diagnosticsByFile.get(plcProject.toString());
            if (fileDiagnostics?.length) {
                projectDiagnostics.set(plcProject, fileDiagnostics);
            }
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
            const markers = await findTwinCATProjectMarkers(path.dirname(stored));
            if (markers.isTwinCATSolution) {
                return markers.solutionPath;
            }
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
        await updateProjectDiagnostics();
        return resolved;
    };

    const findTwinCATProjectMarkers = async (folderPath: string) => {
        const cacheKey = getFolderCacheKey(folderPath);
        try {
            const folderStat = await fs.promises.stat(folderPath);
            const cached = markerCache.get(cacheKey);
            if (cached && cached.mtimeMs === folderStat.mtimeMs) {
                return cached.markers;
            }

            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
            const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
            const solution = files.find(name => name.toLowerCase().endsWith('.sln'));
            const tsproj = files.find(name =>
                solutionProjectExtensions.some(extension => name.toLowerCase().endsWith(extension))
            );
            const plcproj = files.find(name => name.toLowerCase().endsWith('.plcproj'));
            let resolvedTsprojPath = tsproj ? path.join(folderPath, tsproj) : undefined;
            if (solution && !resolvedTsprojPath) {
                const slnText = await fs.promises.readFile(path.join(folderPath, solution), 'utf8');
                const projectRegex = /Project\([^)]*\)\s*=\s*"[^"]+",\s*"([^"]+\.(?:tsproj|tspproj))"/i;
                const match = slnText.match(projectRegex)?.[1];
                if (match) {
                    resolvedTsprojPath = path.normalize(path.join(folderPath, match));
                }
            }
            const isTwinCATSolution = !!(solution && resolvedTsprojPath);
            const isStandalonePlcProject = !!plcproj;
            const markers = {
                solutionPath: isTwinCATSolution && solution ? path.join(folderPath, solution) : undefined,
                tsprojPath: resolvedTsprojPath,
                plcprojPath: plcproj ? path.join(folderPath, plcproj) : undefined,
                isTwinCATSolution,
                isStandalonePlcProject,
                hasTwinCATFiles: isTwinCATSolution || isStandalonePlcProject
            };
            markerCache.set(cacheKey, { mtimeMs: folderStat.mtimeMs, markers });
            return markers;
        } catch {
            markerCache.delete(cacheKey);
            return emptyProjectMarkers();
        }
    };

    const resolveTwinCATFolderCandidate = async (folderPath: string, depth = 2): Promise<{ folderPath: string; solutionPath?: string } | undefined> => {
        const markers = await findTwinCATProjectMarkers(folderPath);
        if (markers.isTwinCATSolution) {
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
        // The open command is intentionally solution-only; project files are handled by tree discovery.
        if (ext !== '.sln') {
            return undefined;
        }

        const folderPath = path.dirname(targetPath);
        const markers = await findTwinCATProjectMarkers(folderPath);
        if (!markers.isTwinCATSolution) {
            return undefined;
        }
        return {
            folderPath,
            solutionPath: markers.solutionPath
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
                const markers = await findTwinCATProjectMarkers(path.dirname(uri.fsPath));
                return markers.isTwinCATSolution ? markers.solutionPath : undefined;
            }
            if (await isDirectory(uri)) {
                const markers = await findTwinCATProjectMarkers(uri.fsPath);
                if (markers.isTwinCATSolution && markers.solutionPath) {
                    return markers.solutionPath;
                }
                return chooseBestSolution(uri.fsPath);
            }
            return chooseBestSolution(path.dirname(uri.fsPath));
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return chooseBestSolution(workspaceFolder);
    };

    const resolveTsprojForSolution = async (solutionPath: string) => {
        const markers = await findTwinCATProjectMarkers(path.dirname(solutionPath));
        return markers.tsprojPath;
    };

    const resolvePlcProjectTarget = async (target?: vscode.Uri | TwinCATFileTreeItem): Promise<string | undefined> => {
        if (!target) {
            return undefined;
        }

        if (target instanceof TwinCATFileTreeItem) {
            if ((target.itemType === TwinCATItemType.ReferenceItem || target.itemType === TwinCATItemType.ReferencesRoot) &&
                target.parentPath?.toLowerCase().endsWith('.plcproj')) {
                return target.parentPath;
            }
            return resolvePlcProjectTarget(target.targetUri);
        }

        if (target.scheme !== 'file') {
            return undefined;
        }

        const ext = path.extname(target.fsPath).toLowerCase();
        if (ext === '.plcproj') {
            return target.fsPath;
        }

        if (await isDirectory(target)) {
            return firstMatchInDirectory(target, '.plcproj');
        }

        return undefined;
    };

    const findNearestPlcProject = async (startPath: string): Promise<string | undefined> => {
        let current = startPath;
        for (let depth = 0; depth < 16; depth += 1) {
            const candidate = await resolveLibraryProjectFile(current);
            if (candidate) {
                return candidate;
            }

            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
        return undefined;
    };

    const parseLibraryReferenceIdentity = (referenceName: string, displayName?: string) => {
        const trimmedDisplay = displayName?.trim();
        if (trimmedDisplay) {
            const match = trimmedDisplay.match(/^(?<name>[^,]+),\s*(?<version>[^()]+?)\s*\((?<vendor>[^)]+)\)\s*$/);
            if (match?.groups) {
                return {
                    name: match.groups.name.trim(),
                    version: match.groups.version.trim(),
                    vendor: match.groups.vendor.trim(),
                    displayName: trimmedDisplay
                };
            }
        }

        return {
            name: referenceName.trim(),
            version: undefined,
            vendor: undefined,
            displayName: trimmedDisplay
        };
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
        if ((target as TwinCATFileTreeItem).targetUri) {
            return (target as TwinCATFileTreeItem).targetUri;
        }
        return undefined;
    };

    const showSolutionNotOpenWarning = () => {
        vscode.window.showWarningMessage('TcView: Open a TwinCAT solution (.sln) first.');
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
                label: 'Browse for TwinCAT Solution File...',
                description: 'Open a different TwinCAT solution in this window',
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

        while (true) {
            const selection = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Open TwinCAT Solution',
                filters: {
                    'TwinCAT Solutions': ['sln']
                }
            });
            if (!selection || selection.length === 0) {
                return;
            }

            const target = selection[0];
            const targetPath = target.fsPath;
            const resolvedRoot = await resolveOpenableTwinCATRoot(targetPath);
            if (!resolvedRoot) {
                vscode.window.showWarningMessage('TcView: That solution is not a TwinCAT solution. Select a .sln whose folder also contains a .tsproj or .tspproj.');
                continue;
            }

            const folderToOpen = vscode.Uri.file(resolvedRoot.folderPath);
            await setActiveSolutionContext(resolvedRoot.solutionPath);
            await vscode.commands.executeCommand('vscode.openFolder', folderToOpen, false);
            return;
        }
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
            [
                lib.vendor ?? 'Unknown vendor',
                lib.name,
                lib.version,
                lib.mode,
                lib.category,
                lib.suppliedWith,
                lib.installPath
            ].filter(Boolean).join(' | ')
        );

        const doc = await vscode.workspace.openTextDocument({
            language: 'plaintext',
            content: ['Detected TwinCAT Libraries', '==========================', '', ...lines].join('\n')
        });
        await vscode.window.showTextDocument(doc, { preview: false });
    });

    type WorkspaceLibraryCatalogEntry = {
        name: string;
        vendor?: string;
        version?: string;
        infoUrl?: string;
        dependencies?: string[];
        functionBlocks?: Array<{ name: string; documentation?: string; members?: Record<string, string> }>;
        functions?: Array<{ name: string; returnType?: string; documentation?: string }>;
        programs?: Array<{ name: string; documentation?: string; members?: Record<string, string> }>;
        variables?: Array<{ name: string; type?: string; documentation?: string }>;
        dataTypes?: Array<{ name: string; kind?: 'struct' | 'enum' | 'alias'; documentation?: string; members?: Record<string, string> }>;
    };

    type WorkspaceLibraryCatalog = {
        libraries: WorkspaceLibraryCatalogEntry[];
    };

    const libraryMetadataTemplate: WorkspaceLibraryCatalog = {
        libraries: [
            {
                name: 'MyCompanyLib',
                vendor: 'My Company',
                version: '1.0.0',
                infoUrl: 'https://example.invalid/docs/mycompanylib',
                dependencies: ['Tc2_System'],
                functionBlocks: [
                    {
                        name: 'FB_Device',
                        documentation: 'Describe the function block here.',
                        members: {
                            bEnable: 'BOOL',
                            bReady: 'BOOL'
                        }
                    }
                ],
                dataTypes: [
                    {
                        name: 'ST_DeviceConfig',
                        kind: 'struct',
                        members: {
                            sName: 'STRING',
                            nTimeoutMs: 'UDINT'
                        }
                    }
                ]
            }
        ]
    };

    const libraryArchiveExtensions = new Set(['.library', '.compiled-library', '.compiled-library-v3', '.compiled-library-ge33']);
    const normalizeLibraryKey = (name: string, vendor?: string) =>
        `${name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}|${(vendor ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;

    const getGlobalLibraryMetadataUri = () => {
        const appDataRoot = process.env.APPDATA
            || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : undefined)
            || context.globalStorageUri.fsPath;
        return vscode.Uri.file(path.join(appDataRoot, 'TcView', 'tcview.libraries.json'));
    };

    const readWorkspaceLibraryCatalog = async (targetUri: vscode.Uri): Promise<WorkspaceLibraryCatalog> => {
        try {
            const bytes = await vscode.workspace.fs.readFile(targetUri);
            const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<WorkspaceLibraryCatalog>;
            return {
                libraries: Array.isArray(parsed.libraries) ? parsed.libraries : []
            };
        } catch {
            return { libraries: [] };
        }
    };

    const writeWorkspaceLibraryCatalog = async (targetUri: vscode.Uri, catalog: WorkspaceLibraryCatalog) => {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath)));
        const payload = `${JSON.stringify(catalog, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(payload, 'utf8'));
    };

    const ensureGlobalLibraryCatalog = async (seedWithTemplate: boolean, suppressWarning = false) => {
        const targetUri = getGlobalLibraryMetadataUri();

        const exists = fs.existsSync(targetUri.fsPath);
        if (!exists) {
            await writeWorkspaceLibraryCatalog(targetUri, seedWithTemplate ? libraryMetadataTemplate : { libraries: [] });
        }
        return targetUri;
    };

    const isVersionLikeSegment = (segment: string) => /^\d+(\.\d+)*$/.test(segment.trim());

    const findVersionDirectoryForImport = async (targetPath: string): Promise<string | undefined> => {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(targetPath);
        } catch {
            return undefined;
        }

        if (stat.isFile()) {
            const ext = path.extname(targetPath).toLowerCase();
            if (libraryArchiveExtensions.has(ext) || path.basename(targetPath).toLowerCase() === 'dependencies') {
                return path.dirname(targetPath);
            }
            return undefined;
        }

        if (!stat.isDirectory()) {
            return undefined;
        }

        try {
            const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
            const hasLibraryMarkers = entries.some(entry =>
                (entry.isFile() && (libraryArchiveExtensions.has(path.extname(entry.name).toLowerCase()) || entry.name.toLowerCase() === 'dependencies'))
            );
            if (hasLibraryMarkers) {
                return targetPath;
            }

            const versionDirs = entries
                .filter(entry => entry.isDirectory() && isVersionLikeSegment(entry.name))
                .map(entry => entry.name)
                .sort((a, b) => b.localeCompare(a));
            for (const versionDir of versionDirs) {
                const candidate = path.join(targetPath, versionDir);
                const resolved = await findVersionDirectoryForImport(candidate);
                if (resolved) {
                    return resolved;
                }
            }
        } catch {
            return undefined;
        }

        return undefined;
    };

    const readDependencyFile = async (versionDir: string) => {
        try {
            const text = await fs.promises.readFile(path.join(versionDir, 'dependencies'), 'utf8');
            return text
                .split(/\r?\n/)
                .map(line => line.trim().replace(/^#/, '').trim())
                .filter(Boolean);
        } catch {
            return [] as string[];
        }
    };

    const deriveLibraryMetadataFromPath = async (targetPath: string): Promise<WorkspaceLibraryCatalogEntry | undefined> => {
        const versionDir = await findVersionDirectoryForImport(targetPath);
        if (!versionDir) {
            return undefined;
        }

        const versionSegment = path.basename(versionDir);
        const libraryDir = path.dirname(versionDir);
        const vendorDir = path.dirname(libraryDir);
        const version = isVersionLikeSegment(versionSegment) ? versionSegment : undefined;
        const name = version ? path.basename(libraryDir) : path.basename(versionDir);
        const vendor = version ? path.basename(vendorDir) : undefined;
        const dependencies = await readDependencyFile(versionDir);

        return {
            name,
            vendor,
            version,
            dependencies,
            functionBlocks: [],
            functions: [],
            programs: [],
            variables: [],
            dataTypes: []
        };
    };

    const normalizeDeclarationType = (rawType: string | undefined) =>
        (rawType ?? '')
            .trim()
            .replace(/:=.*$/, '')
            .replace(/\bAT\b.*$/i, '')
            .replace(/\s+/g, ' ')
            .trim();

    const parseMembersFromDeclarationBlock = (block: string | undefined) => {
        const members: Record<string, string> = {};
        if (!block) {
            return members;
        }

        for (const rawLine of block.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('//') || line.startsWith('(*')) {
                continue;
            }

            const match = line.match(/^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*([^;]+);/);
            if (!match) {
                continue;
            }

            const names = match[1].split(',').map(name => name.trim()).filter(Boolean);
            const resolvedType = normalizeDeclarationType(match[2]);
            for (const name of names) {
                members[name] = resolvedType || 'ANY';
            }
        }

        return members;
    };

    const mapToSortedObject = (input: Record<string, string>) =>
        Object.fromEntries(Object.entries(input).sort((a, b) => a[0].localeCompare(b[0])));

    const parseTwinCATSourceMetadata = async (filePath: string): Promise<Partial<WorkspaceLibraryCatalogEntry>> => {
        const ext = path.extname(filePath).toLowerCase();
        const xml = await fs.promises.readFile(filePath, 'utf8');
        const st = await metadataConverter.convertXmlToST(xml);

        const result: Partial<WorkspaceLibraryCatalogEntry> = {
            functionBlocks: [],
            functions: [],
            programs: [],
            variables: [],
            dataTypes: []
        };

        if (ext === '.tcpou' || ext === '.tcprg' || ext === '.tcapp' || ext === '.tccom') {
            const declarationMatch = st.match(/\b(FUNCTION_BLOCK|FUNCTION|PROGRAM)\s+([A-Za-z_]\w*)(?:\s*:\s*([A-Za-z_][\w\.]*))?/i);
            if (!declarationMatch) {
                return result;
            }

            const kind = declarationMatch[1].toUpperCase();
            const name = declarationMatch[2];
            const returnType = normalizeDeclarationType(declarationMatch[3]);
            const varBlocks = [...st.matchAll(/\bVAR(?:_[A-Z_]+)?\b([\s\S]*?)\bEND_VAR\b/gi)];
            const members = Object.assign({}, ...varBlocks.map(match => parseMembersFromDeclarationBlock(match[1])));
            if (kind === 'FUNCTION_BLOCK') {
                result.functionBlocks = [{ name, members: mapToSortedObject(members) }];
            } else if (kind === 'PROGRAM') {
                result.programs = [{ name, members: mapToSortedObject(members) }];
            } else {
                result.functions = [{ name, returnType: returnType || 'VOID' }];
            }
            return result;
        }

        if (ext === '.tcdut') {
            const typeMatch = st.match(/\bTYPE\s+([A-Za-z_]\w*)\s*:\s*([\s\S]*?)\bEND_TYPE\b/i);
            if (!typeMatch) {
                return result;
            }

            const name = typeMatch[1];
            const body = typeMatch[2];
            const structMatch = body.match(/\bSTRUCT\b([\s\S]*?)\bEND_STRUCT\b/i);
            if (structMatch) {
                result.dataTypes = [{
                    name,
                    kind: 'struct',
                    members: mapToSortedObject(parseMembersFromDeclarationBlock(structMatch[1]))
                }];
                return result;
            }

            const enumMatch = body.match(/\(([\s\S]*?)\)/);
            if (enumMatch) {
                const members = Object.fromEntries(enumMatch[1]
                    .split(',')
                    .map(item => item.trim())
                    .filter(Boolean)
                    .map(item => {
                        const [memberName, assignedValue] = item.split(':=').map(part => part.trim());
                        return [memberName, assignedValue || 'enum'];
                    }));
                result.dataTypes = [{
                    name,
                    kind: 'enum',
                    members: mapToSortedObject(members)
                }];
                return result;
            }

            const aliasTarget = normalizeDeclarationType(body.replace(/END_TYPE/gi, '').trim());
            result.dataTypes = [{
                name,
                kind: 'alias',
                members: aliasTarget ? { baseType: aliasTarget } : {}
            }];
            return result;
        }

        if (ext === '.tcgvl' || ext === '.tcvar') {
            const members = Object.assign({}, ...[...st.matchAll(/\bVAR(?:_[A-Z_]+)?\b([\s\S]*?)\bEND_VAR\b/gi)]
                .map(match => parseMembersFromDeclarationBlock(match[1]))) as Record<string, string>;
            result.variables = Object.entries(members).map(([name, type]) => ({ name, type }));
            return result;
        }

        return result;
    };

    const collectTwinCATSourceFiles = async (rootPath: string): Promise<string[]> => {
        const results: string[] = [];
        const supportedExts = new Set(['.tcpou', '.tcprg', '.tcapp', '.tccom', '.tcdut', '.tcgvl', '.tcvar']);

        const visit = async (directoryPath: string) => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'node_modules') {
                    continue;
                }

                const fullPath = path.join(directoryPath, entry.name);
                if (entry.isDirectory()) {
                    await visit(fullPath);
                    continue;
                }

                if (entry.isFile() && supportedExts.has(path.extname(entry.name).toLowerCase())) {
                    results.push(fullPath);
                }
            }
        };

        await visit(rootPath);
        return results.sort((a, b) => a.localeCompare(b));
    };

    const resolveLibraryProjectFile = async (targetPath: string): Promise<string | undefined> => {
        try {
            const stat = await fs.promises.stat(targetPath);
            if (stat.isFile() && path.extname(targetPath).toLowerCase() === '.plcproj') {
                return targetPath;
            }

            if (!stat.isDirectory()) {
                return undefined;
            }

            const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
            const plcproj = entries
                .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.plcproj'))
                .map(entry => path.join(targetPath, entry.name))
                .sort((a, b) => a.localeCompare(b))[0];
            return plcproj;
        } catch {
            return undefined;
        }
    };

    const deriveLibraryProjectMetadata = async (targetPath: string): Promise<WorkspaceLibraryCatalogEntry | undefined> => {
        const plcprojPath = await resolveLibraryProjectFile(targetPath);
        if (!plcprojPath) {
            return undefined;
        }

        const plcprojText = await fs.promises.readFile(plcprojPath, 'utf8');
        const projectDir = path.dirname(plcprojPath);
        const projectName = plcprojText.match(/<Name>([^<]+)<\/Name>/i)?.[1]?.trim() || path.basename(plcprojPath, '.plcproj');
        const version = plcprojText.match(/<ProgramVersion>([^<]+)<\/ProgramVersion>/i)?.[1]?.trim();
        const dependencies = [...plcprojText.matchAll(/<PlaceholderReference\b[^>]*Include="([^"]+)"/gi)]
            .map(match => match[1].trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));

        const sourceFiles = await collectTwinCATSourceFiles(projectDir);
        const functionBlocks = new Map<string, { name: string; documentation?: string; members?: Record<string, string> }>();
        const functions = new Map<string, { name: string; returnType?: string; documentation?: string }>();
        const programs = new Map<string, { name: string; documentation?: string; members?: Record<string, string> }>();
        const variables = new Map<string, { name: string; type?: string; documentation?: string }>();
        const dataTypes = new Map<string, { name: string; kind?: 'struct' | 'enum' | 'alias'; documentation?: string; members?: Record<string, string> }>();

        for (const filePath of sourceFiles) {
            const parsed = await parseTwinCATSourceMetadata(filePath);
            for (const item of parsed.functionBlocks ?? []) {
                functionBlocks.set(item.name, item);
            }
            for (const item of parsed.functions ?? []) {
                functions.set(item.name, item);
            }
            for (const item of parsed.programs ?? []) {
                programs.set(item.name, item);
            }
            for (const item of parsed.variables ?? []) {
                variables.set(item.name, item);
            }
            for (const item of parsed.dataTypes ?? []) {
                dataTypes.set(item.name, item);
            }
        }

        return {
            name: projectName,
            vendor: path.basename(path.dirname(projectDir)),
            version,
            dependencies,
            functionBlocks: [...functionBlocks.values()].sort((a, b) => a.name.localeCompare(b.name)),
            functions: [...functions.values()].sort((a, b) => a.name.localeCompare(b.name)),
            programs: [...programs.values()].sort((a, b) => a.name.localeCompare(b.name)),
            variables: [...variables.values()].sort((a, b) => a.name.localeCompare(b.name)),
            dataTypes: [...dataTypes.values()].sort((a, b) => a.name.localeCompare(b.name))
        };
    };

    const loadCatalogLibraryEntries = async (catalogPath: string) => {
        try {
            const text = await fs.promises.readFile(catalogPath, 'utf8');
            const parsed = JSON.parse(text) as WorkspaceLibraryCatalog;
            return Array.isArray(parsed.libraries) ? parsed.libraries : [];
        } catch {
            return [] as WorkspaceLibraryCatalogEntry[];
        }
    };

    const getConfiguredLibraryMetadataPaths = () => {
        const configuredPaths = vscode.workspace.getConfiguration('twincat').get<string[]>('library.metadataFiles', []);
        return configuredPaths.map(candidate => {
            if (path.isAbsolute(candidate)) {
                return candidate;
            }
            const basePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
            return path.resolve(basePath, candidate);
        });
    };

    const collectKnownLibraryCandidates = async () => {
        const known = new Map<string, { name: string; version?: string; vendor?: string; source: string }>();
        const addCandidate = (name: string | undefined, version: string | undefined, vendor: string | undefined, source: string) => {
            const trimmedName = name?.trim();
            if (!trimmedName) {
                return;
            }
            const key = `${trimmedName.toUpperCase()}|${(vendor ?? '').toUpperCase()}|${version ?? ''}`;
            if (!known.has(key)) {
                known.set(key, { name: trimmedName, version, vendor, source });
            }
        };

        const builtInPath = path.join(context.extensionPath, 'resources', 'library-metadata.json');
        const catalogPaths = [
            builtInPath,
            getGlobalLibraryMetadataUri().fsPath,
            ...getConfiguredLibraryMetadataPaths()
        ];

        for (const catalogPath of catalogPaths) {
            for (const entry of await loadCatalogLibraryEntries(catalogPath)) {
                addCandidate(entry.name, entry.version, entry.vendor, path.basename(catalogPath));
            }
        }

        const managedRoots = [
            ...new Set([
                ...vscode.workspace.getConfiguration('twincat').get<string[]>('library.managedRoots', []),
                'C:\\ProgramData\\Beckhoff\\TwinCAT\\PlcEngineering\\Managed Libraries',
                'C:\\ProgramData\\Beckhoff\\TwinCAT\\3.1\\Components\\Plc\\Managed Libraries'
            ].filter(root => !!root && fs.existsSync(root)))
        ];
        for (const managedRoot of managedRoots) {
            let vendors: fs.Dirent[];
            try {
                vendors = await fs.promises.readdir(managedRoot, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const vendorEntry of vendors) {
                if (!vendorEntry.isDirectory() || vendorEntry.name.startsWith('.') || vendorEntry.name.startsWith('_')) {
                    continue;
                }
                const vendorPath = path.join(managedRoot, vendorEntry.name);
                let libraries: fs.Dirent[];
                try {
                    libraries = await fs.promises.readdir(vendorPath, { withFileTypes: true });
                } catch {
                    continue;
                }
                for (const libraryEntry of libraries) {
                    if (!libraryEntry.isDirectory() || libraryEntry.name.startsWith('.') || libraryEntry.name.startsWith('_')) {
                        continue;
                    }
                    const libraryPath = path.join(vendorPath, libraryEntry.name);
                    let versions: fs.Dirent[];
                    try {
                        versions = await fs.promises.readdir(libraryPath, { withFileTypes: true });
                    } catch {
                        versions = [];
                    }

                    if (versions.length === 0) {
                        addCandidate(libraryEntry.name, undefined, vendorEntry.name, 'Managed Libraries');
                        continue;
                    }

                    for (const versionEntry of versions) {
                        if (!versionEntry.isDirectory()) {
                            continue;
                        }
                        addCandidate(libraryEntry.name, versionEntry.name, vendorEntry.name, 'Managed Libraries');
                    }
                }
            }
        }

        return [...known.values()]
            .sort((a, b) => a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? ''))
            .map(candidate => ({
                label: candidate.name,
                description: [candidate.version, candidate.vendor].filter(Boolean).join(' | '),
                detail: candidate.source,
                candidate
            }));
    };

    const mergeWorkspaceLibraryEntry = (
        existing: WorkspaceLibraryCatalogEntry | undefined,
        imported: WorkspaceLibraryCatalogEntry
    ): WorkspaceLibraryCatalogEntry => ({
        name: imported.name,
        vendor: imported.vendor ?? existing?.vendor,
        version: imported.version ?? existing?.version,
        infoUrl: imported.infoUrl ?? existing?.infoUrl,
        dependencies: [...new Set([...(existing?.dependencies ?? []), ...(imported.dependencies ?? [])])].sort((a, b) => a.localeCompare(b)),
        functionBlocks: (imported.functionBlocks && imported.functionBlocks.length > 0) ? imported.functionBlocks : (existing?.functionBlocks ?? []),
        functions: (imported.functions && imported.functions.length > 0) ? imported.functions : (existing?.functions ?? []),
        programs: (imported.programs && imported.programs.length > 0) ? imported.programs : (existing?.programs ?? []),
        variables: (imported.variables && imported.variables.length > 0) ? imported.variables : (existing?.variables ?? []),
        dataTypes: (imported.dataTypes && imported.dataTypes.length > 0) ? imported.dataTypes : (existing?.dataTypes ?? [])
    });

    const upsertWorkspaceLibraryMetadataEntry = async (
        importedEntry: WorkspaceLibraryCatalogEntry,
        options?: { revealFile?: boolean }
    ): Promise<WorkspaceLibraryCatalogEntry | undefined> => {
        const metadataUri = await ensureGlobalLibraryCatalog(false, true);
        if (!metadataUri) {
            return importedEntry;
        }

        const catalog = await readWorkspaceLibraryCatalog(metadataUri);
        const importKey = normalizeLibraryKey(importedEntry.name, importedEntry.vendor);
        const existingIndex = catalog.libraries.findIndex(entry => normalizeLibraryKey(entry.name, entry.vendor) === importKey);
        const mergedEntry = mergeWorkspaceLibraryEntry(existingIndex >= 0 ? catalog.libraries[existingIndex] : undefined, importedEntry);

        if (existingIndex >= 0) {
            catalog.libraries[existingIndex] = mergedEntry;
        } else {
            catalog.libraries.push(mergedEntry);
            catalog.libraries.sort((a, b) => a.name.localeCompare(b.name));
        }

        await writeWorkspaceLibraryCatalog(metadataUri, catalog);

        if (options?.revealFile) {
            const document = await vscode.workspace.openTextDocument(metadataUri);
            await vscode.window.showTextDocument(document, { preview: false });
        }

        return mergedEntry;
    };

    const upsertWorkspaceLibraryMetadata = async (
        targetPath: string,
        options?: { revealFile?: boolean }
    ): Promise<WorkspaceLibraryCatalogEntry | undefined> => {
        const importedEntry = await deriveLibraryMetadataFromPath(targetPath);
        if (!importedEntry) {
            return undefined;
        }
        return upsertWorkspaceLibraryMetadataEntry(importedEntry, options);
    };

    const matchesLibraryIdentity = (
        entry: WorkspaceLibraryCatalogEntry,
        identity: { name: string; vendor?: string; version?: string }
    ) => {
        if (entry.name.trim().toUpperCase() !== identity.name.trim().toUpperCase()) {
            return false;
        }
        if (identity.vendor && (entry.vendor ?? '').trim().toUpperCase() !== identity.vendor.trim().toUpperCase()) {
            return false;
        }
        if (identity.version && (entry.version ?? '').trim() !== identity.version.trim()) {
            return false;
        }
        return true;
    };

    const removeWorkspaceLibraryMetadataEntries = async (
        predicate: (entry: WorkspaceLibraryCatalogEntry) => boolean
    ): Promise<number> => {
        const metadataUri = await ensureGlobalLibraryCatalog(false, true);
        if (!metadataUri) {
            return 0;
        }

        const catalog = await readWorkspaceLibraryCatalog(metadataUri);
        const originalCount = catalog.libraries.length;
        catalog.libraries = catalog.libraries.filter(entry => !predicate(entry));
        if (catalog.libraries.length === originalCount) {
            return 0;
        }

        await writeWorkspaceLibraryCatalog(metadataUri, catalog);
        await refreshProjectAnalyzerLibraryMetadata();
        fileExplorerProvider.refresh();
        return originalCount - catalog.libraries.length;
    };

    const readPlcprojReferenceIdentities = async (plcprojPath: string): Promise<Array<{ name: string; vendor?: string; version?: string }>> => {
        try {
            const text = await fs.promises.readFile(plcprojPath, 'utf8');
            const refs = [...text.matchAll(/<PlaceholderReference\b[^>]*Include="([^"]+)"[^>]*>([\s\S]*?)<\/PlaceholderReference>/gi)];
            return refs.map(match => {
                const name = match[1].trim();
                const body = match[2] ?? '';
                const namespaceValue = body.match(/<Namespace>([^<]+)<\/Namespace>/i)?.[1]?.trim();
                const defaultResolution = body.match(/<DefaultResolution>([^<]+)<\/DefaultResolution>/i)?.[1]?.trim();
                const parsed = parseLibraryReferenceIdentity(name, defaultResolution || namespaceValue);
                return {
                    name: parsed.name,
                    vendor: parsed.vendor,
                    version: parsed.version
                };
            });
        } catch {
            return [];
        }
    };

    const resolveWebviewCommandTarget = (targetArg?: vscode.Uri | TwinCATFileTreeItem) =>
        targetArg instanceof vscode.Uri || targetArg instanceof TwinCATFileTreeItem
            ? targetArg
            : webviewExplorerProvider.getCurrentContextItem();

    const resolveTwinCATFileCommandTarget = async (target?: vscode.Uri | TwinCATFileTreeItem): Promise<{ plcprojPath: string; folderPath: string; filePath?: string } | undefined> => {
        const treeItem = target instanceof TwinCATFileTreeItem ? target : undefined;
        const uri = treeItem?.targetUri ?? (target instanceof vscode.Uri ? target : undefined);
        if (!uri?.fsPath) {
            return undefined;
        }

        if (treeItem?.itemType === TwinCATItemType.PlcProjectFolder) {
            const plcprojPath = treeItem.parentPath || await resolvePlcProjectTarget(treeItem) || await findNearestPlcProject(treeItem.targetUri.fsPath);
            if (!plcprojPath) {
                return undefined;
            }
            return {
                plcprojPath,
                folderPath: treeItem.targetUri.fsPath
            };
        }

        if (treeItem?.itemType === TwinCATItemType.Folder || (await isDirectory(uri))) {
            const plcprojPath = await resolvePlcProjectTarget(treeItem ?? uri) || await findNearestPlcProject(uri.fsPath);
            if (!plcprojPath) {
                return undefined;
            }
            return {
                plcprojPath,
                folderPath: uri.fsPath
            };
        }

        const lowerExt = path.extname(uri.fsPath).toLowerCase();
        if (supportedTwinCATExts.has(lowerExt)) {
            const plcprojPath = await findNearestPlcProject(path.dirname(uri.fsPath));
            if (!plcprojPath) {
                return undefined;
            }
            return {
                plcprojPath,
                folderPath: path.dirname(uri.fsPath),
                filePath: uri.fsPath
            };
        }

        if (lowerExt === '.plcproj') {
            return {
                plcprojPath: uri.fsPath,
                folderPath: path.dirname(uri.fsPath)
            };
        }

        return undefined;
    };

    const structuredTwinCATFolderExtensions = new Set(['.tcpou', '.tcprg', '.tcapp', '.tccom', '.tcgvl', '.tcio', '.tcitf']);

    const getTwinCATStructuredFileKind = (treeItem?: TwinCATFileTreeItem): 'functionBlock' | 'program' | 'function' | 'interface' | 'gvl' | 'dut' | undefined => {
        if (!treeItem) {
            return undefined;
        }

        const sourcePath = treeItem.itemType === TwinCATItemType.File
            ? treeItem.targetUri.fsPath
            : treeItem.parentPath || '';
        const ext = path.extname(sourcePath).toLowerCase();
        if (ext === '.tcgvl') {
            return 'gvl';
        }
        if (ext === '.tcitf' || ext === '.tcio') {
            return 'interface';
        }
        if (ext === '.tcdut') {
            return 'dut';
        }
        if (ext === '.tcprg') {
            return 'program';
        }
        if (ext === '.tcpou' || ext === '.tcapp' || ext === '.tccom') {
            const description = typeof treeItem.description === 'string' ? treeItem.description : undefined;
            if (description === 'FUN') {
                return 'function';
            }
            if (description === 'PRG') {
                return 'program';
            }
            return 'functionBlock';
        }
        return undefined;
    };

    const resolveTwinCATFolderCommandTarget = async (target?: vscode.Uri | TwinCATFileTreeItem): Promise<{ plcprojPath?: string; folderPath?: string; sourceFilePath?: string; internalFolderName?: string; itemType?: TwinCATItemType } | undefined> => {
        const treeItem = target instanceof TwinCATFileTreeItem ? target : undefined;
        const uri = treeItem?.targetUri ?? (target instanceof vscode.Uri ? target : undefined);
        if (!uri?.fsPath) {
            return undefined;
        }

        if (treeItem?.itemType === TwinCATItemType.POUFolder) {
            const internalTarget = resolveInternalTwinCATTarget(treeItem);
            return {
                sourceFilePath: treeItem.parentPath,
                internalFolderName: internalTarget?.itemName,
                itemType: treeItem.itemType
            };
        }

        if (treeItem?.itemType === TwinCATItemType.File && structuredTwinCATFolderExtensions.has(path.extname(uri.fsPath).toLowerCase())) {
            const fileTarget = await resolveTwinCATFileCommandTarget(target);
            if (!fileTarget) {
                return undefined;
            }
            return {
                plcprojPath: fileTarget.plcprojPath,
                sourceFilePath: uri.fsPath,
                itemType: treeItem.itemType
            };
        }

        const fileTarget = await resolveTwinCATFileCommandTarget(target);
        if (fileTarget) {
            return {
                plcprojPath: fileTarget.plcprojPath,
                folderPath: fileTarget.filePath ? path.dirname(fileTarget.filePath) : fileTarget.folderPath,
                itemType: treeItem?.itemType
            };
        }

        return undefined;
    };

    const resolveTwinCATRenameDeleteTarget = async (target?: vscode.Uri | TwinCATFileTreeItem): Promise<{
        plcprojPath: string;
        targetPath: string;
        isFile: boolean;
        itemType?: TwinCATItemType;
    } | undefined> => {
        const treeItem = target instanceof TwinCATFileTreeItem ? target : undefined;
        const uri = treeItem?.targetUri ?? (target instanceof vscode.Uri ? target : undefined);
        if (!uri?.fsPath) {
            return undefined;
        }

        const fileTarget = await resolveTwinCATFileCommandTarget(target);
        if (fileTarget?.filePath) {
            return {
                plcprojPath: fileTarget.plcprojPath,
                targetPath: fileTarget.filePath,
                isFile: true,
                itemType: treeItem?.itemType
            };
        }

        const folderTarget = await resolveTwinCATFolderCommandTarget(target);
        if (folderTarget?.plcprojPath && folderTarget.folderPath && folderTarget.itemType !== TwinCATItemType.POUFolder) {
            return {
                plcprojPath: folderTarget.plcprojPath,
                targetPath: folderTarget.folderPath,
                isFile: false,
                itemType: folderTarget.itemType
            };
        }

        return undefined;
    };

    const normalizePlcprojRelativePath = (relativePath: string) => relativePath.split(path.sep).join('\\');
    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapeXmlAttribute = (value: string) =>
        value
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    const createGuid = () => `{${randomUUID()}}`;

    type TwinCATNewFileTemplate = {
        id: string;
        label: string;
        extension: string;
        defaultFolder: string;
        buildXml: (name: string) => string;
    };

    const twinCatNewFileTemplates: TwinCATNewFileTemplate[] = [
        {
            id: 'functionBlock',
            label: 'POU (Function Block)',
            extension: '.TcPOU',
            defaultFolder: 'POUs',
            buildXml: name => `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <POU Name="${name}" Id="${createGuid()}" SpecialFunc="None">\r\n    <Declaration><![CDATA[FUNCTION_BLOCK ${name}\r\nVAR\r\nEND_VAR\r\n]]></Declaration>\r\n    <Implementation>\r\n      <ST><![CDATA[]]></ST>\r\n    </Implementation>\r\n  </POU>\r\n</TcPlcObject>\r\n`
        },
        {
            id: 'function',
            label: 'Function',
            extension: '.TcPOU',
            defaultFolder: 'POUs',
            buildXml: name => `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <POU Name="${name}" Id="${createGuid()}" SpecialFunc="None">\r\n    <Declaration><![CDATA[FUNCTION ${name} : BOOL\r\nVAR_INPUT\r\nEND_VAR\r\n]]></Declaration>\r\n    <Implementation>\r\n      <ST><![CDATA[]]></ST>\r\n    </Implementation>\r\n  </POU>\r\n</TcPlcObject>\r\n`
        },
        {
            id: 'program',
            label: 'Program',
            extension: '.TcPRG',
            defaultFolder: 'POUs',
            buildXml: name => `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <POU Name="${name}" Id="${createGuid()}" SpecialFunc="None">\r\n    <Declaration><![CDATA[PROGRAM ${name}\r\nVAR\r\nEND_VAR\r\n]]></Declaration>\r\n    <Implementation>\r\n      <ST><![CDATA[]]></ST>\r\n    </Implementation>\r\n  </POU>\r\n</TcPlcObject>\r\n`
        },
        {
            id: 'gvl',
            label: 'Global Variable List',
            extension: '.TcGVL',
            defaultFolder: 'GVLs',
            buildXml: name => `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <GVL Name="${name}" Id="${createGuid()}">\r\n    <Declaration><![CDATA[VAR_GLOBAL\r\nEND_VAR\r\n]]></Declaration>\r\n  </GVL>\r\n</TcPlcObject>\r\n`
        },
        {
            id: 'dut',
            label: 'Data Type (STRUCT)',
            extension: '.TcDUT',
            defaultFolder: 'DUTs',
            buildXml: name => `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <DUT Name="${name}" Id="${createGuid()}">\r\n    <Declaration><![CDATA[TYPE ${name} :\r\nSTRUCT\r\nEND_STRUCT\r\nEND_TYPE\r\n]]></Declaration>\r\n  </DUT>\r\n</TcPlcObject>\r\n`
        },
        {
            id: 'interface',
            label: 'Interface',
            extension: '.TcITF',
            defaultFolder: 'POUs',
            buildXml: name => `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n  <ITF Name="${name}" Id="${createGuid()}">\r\n    <Declaration><![CDATA[INTERFACE ${name}\r\nEND_INTERFACE\r\n]]></Declaration>\r\n  </ITF>\r\n</TcPlcObject>\r\n`
        }
    ];

    const insertIntoProjectItemGroup = (projectXml: string, marker: 'Compile' | 'Folder', block: string) => {
        const itemGroupRegex = /<ItemGroup>[\s\S]*?<\/ItemGroup>/gi;
        const matches = [...projectXml.matchAll(itemGroupRegex)];
        const target = matches.find(match => match[0].includes(`<${marker} `) || match[0].includes(`<${marker}>`));
        if (target?.index !== undefined) {
            const group = target[0];
            const updated = group.replace(/<\/ItemGroup>\s*$/i, `${block}\r\n  </ItemGroup>`);
            return `${projectXml.slice(0, target.index)}${updated}${projectXml.slice(target.index + group.length)}`;
        }

        const insertion = `  <ItemGroup>\r\n${block}\r\n  </ItemGroup>\r\n`;
        const projectExtensionsIndex = projectXml.search(/^\s*<ProjectExtensions>/im);
        const projectEndIndex = projectXml.search(/^\s*<\/Project>/im);
        const insertAt = projectExtensionsIndex >= 0 ? projectExtensionsIndex : projectEndIndex;
        if (insertAt >= 0) {
            return `${projectXml.slice(0, insertAt)}${insertion}${projectXml.slice(insertAt)}`;
        }
        return `${projectXml.trimEnd()}\r\n${insertion}`;
    };

    const upsertTwinCATCompileEntry = (projectXml: string, relativePath: string) => {
        const normalizedRelativePath = normalizePlcprojRelativePath(relativePath);
        const includePattern = new RegExp(`<Compile\\s+Include="${escapeRegExp(normalizedRelativePath)}"`, 'i');
        if (includePattern.test(projectXml)) {
            return projectXml;
        }

        const compileBlock = `    <Compile Include="${escapeXmlAttribute(normalizedRelativePath)}">\r\n      <SubType>Code</SubType>\r\n    </Compile>`;
        let updated = insertIntoProjectItemGroup(projectXml, 'Compile', compileBlock);

        const folderPath = path.dirname(normalizedRelativePath).replace(/[\\/]+/g, '\\');
        if (folderPath && folderPath !== '.') {
            const segments = folderPath.split('\\').filter(Boolean);
            let current = '';
            for (const segment of segments) {
                current = current ? `${current}\\${segment}` : segment;
                const folderPattern = new RegExp(`<Folder\\s+Include="${escapeRegExp(current)}"\\s*/>`, 'i');
                if (!folderPattern.test(updated)) {
                    const folderBlock = `    <Folder Include="${escapeXmlAttribute(current)}" />`;
                    updated = insertIntoProjectItemGroup(updated, 'Folder', folderBlock);
                }
            }
        }

        return updated;
    };

    const removeTwinCATCompileEntry = (projectXml: string, relativePath: string) => {
        const normalizedRelativePath = normalizePlcprojRelativePath(relativePath);
        const blockPattern = new RegExp(`\\r?\\n\\s*<Compile\\s+Include="${escapeRegExp(normalizedRelativePath)}">[\\s\\S]*?<\\/Compile>`, 'i');
        if (blockPattern.test(projectXml)) {
            return projectXml.replace(blockPattern, '');
        }
        const selfClosingPattern = new RegExp(`\\r?\\n\\s*<Compile\\s+Include="${escapeRegExp(normalizedRelativePath)}"\\s*\\/?>`, 'i');
        return projectXml.replace(selfClosingPattern, '');
    };

    const upsertTwinCATFolderEntry = (projectXml: string, relativeFolderPath: string) => {
        const normalizedRelativePath = normalizePlcprojRelativePath(relativeFolderPath).replace(/[\\\/]+$/, '');
        if (!normalizedRelativePath || normalizedRelativePath === '.') {
            return projectXml;
        }

        let updated = projectXml;
        const segments = normalizedRelativePath.split('\\').filter(Boolean);
        let current = '';
        for (const segment of segments) {
            current = current ? `${current}\\${segment}` : segment;
            const folderPattern = new RegExp(`<Folder\\s+Include="${escapeRegExp(current)}"\\s*/>`, 'i');
            if (!folderPattern.test(updated)) {
                const folderBlock = `    <Folder Include="${escapeXmlAttribute(current)}" />`;
                updated = insertIntoProjectItemGroup(updated, 'Folder', folderBlock);
            }
        }

        return updated;
    };

    const remapTwinCATProjectEntries = (projectXml: string, oldRelativePath: string, newRelativePath: string) => {
        const oldNormalized = normalizePlcprojRelativePath(oldRelativePath).replace(/[\\\/]+$/, '');
        const newNormalized = normalizePlcprojRelativePath(newRelativePath).replace(/[\\\/]+$/, '');
        if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) {
            return projectXml;
        }

        return projectXml.replace(
            /<(Compile|Folder)\b([^>]*?)Include="([^"]+)"([^>]*)>/gi,
            (match, tagName, beforeInclude, includeValue, afterInclude) => {
                const normalizedInclude = normalizePlcprojRelativePath(includeValue).replace(/[\\\/]+$/, '');
                if (normalizedInclude !== oldNormalized && !normalizedInclude.startsWith(`${oldNormalized}\\`)) {
                    return match;
                }

                const suffix = normalizedInclude === oldNormalized ? '' : normalizedInclude.slice(oldNormalized.length);
                const remapped = `${newNormalized}${suffix}`;
                return `<${tagName}${beforeInclude}Include="${escapeXmlAttribute(remapped)}"${afterInclude}>`;
            }
        );
    };

    const removeTwinCATFolderEntries = (projectXml: string, relativeFolderPath: string) => {
        const normalizedRelativePath = normalizePlcprojRelativePath(relativeFolderPath).replace(/[\\\/]+$/, '');
        if (!normalizedRelativePath || normalizedRelativePath === '.') {
            return projectXml;
        }

        return projectXml.replace(
            /\r?\n\s*<(Compile|Folder)\b([^>]*?)Include="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>|\r?\n\s*<(Compile|Folder)\b([^>]*?)Include="([^"]+)"([^>]*)\/>/gi,
            (match, tagA, beforeA, includeA, afterA, _contentA, tagB, beforeB, includeB) => {
                const includeValue = includeA ?? includeB;
                if (!includeValue) {
                    return match;
                }
                const normalizedInclude = normalizePlcprojRelativePath(includeValue).replace(/[\\\/]+$/, '');
                if (normalizedInclude === normalizedRelativePath || normalizedInclude.startsWith(`${normalizedRelativePath}\\`)) {
                    return '';
                }
                return match;
            }
        );
    };

    const collectTwinCATProjectEntries = async (rootPath: string): Promise<{ folders: string[]; files: string[] }> => {
        const folders: string[] = [];
        const files: string[] = [];
        const visit = async (currentPath: string) => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    folders.push(entryPath);
                    await visit(entryPath);
                } else if (supportedTwinCATExts.has(path.extname(entry.name).toLowerCase())) {
                    files.push(entryPath);
                }
            }
        };
        await visit(rootPath);
        return { folders, files };
    };

    const addTwinCATProjectEntries = async (plcprojPath: string, targetPath: string) => {
        const projectDir = path.dirname(plcprojPath);
        let plcprojText = await fs.promises.readFile(plcprojPath, 'utf8');
        const stat = await fs.promises.stat(targetPath);
        if (stat.isDirectory()) {
            const { folders, files } = await collectTwinCATProjectEntries(targetPath);
            for (const folder of folders) {
                plcprojText = upsertTwinCATFolderEntry(plcprojText, path.relative(projectDir, folder));
            }
            for (const file of files) {
                plcprojText = upsertTwinCATCompileEntry(plcprojText, path.relative(projectDir, file));
            }
        } else {
            plcprojText = upsertTwinCATCompileEntry(plcprojText, path.relative(projectDir, targetPath));
        }
        await fs.promises.writeFile(plcprojPath, plcprojText, 'utf8');
    };

    const ensureUniquePath = async (candidatePath: string) => {
        if (!fs.existsSync(candidatePath)) {
            return candidatePath;
        }

        const directory = path.dirname(candidatePath);
        const extension = path.extname(candidatePath);
        const baseName = path.basename(candidatePath, extension);
        let suffix = 1;
        while (true) {
            const nextPath = path.join(directory, `${baseName}_${suffix}${extension}`);
            if (!fs.existsSync(nextPath)) {
                return nextPath;
            }
            suffix += 1;
        }
    };

    const ensureUniqueTwinCATSourcePath = async (plcprojPath: string, candidatePath: string, excludePath?: string) => {
        const directory = path.dirname(candidatePath);
        const extension = path.extname(candidatePath);
        const baseName = path.basename(candidatePath, extension);

        let suffix = 0;
        while (true) {
            const nextBaseName = suffix === 0 ? baseName : `${baseName}_${suffix}`;
            const nextPath = path.join(directory, `${nextBaseName}${extension}`);
            const existsOnDisk = fs.existsSync(nextPath) && (!excludePath || path.normalize(nextPath) !== path.normalize(excludePath));
            const existsInProject = await hasDuplicateTwinCATSourceName(plcprojPath, nextBaseName, excludePath);
            if (!existsOnDisk && !existsInProject) {
                return nextPath;
            }
            suffix += 1;
        }
    };

    const resolveInternalTwinCATTarget = (target?: vscode.Uri | TwinCATFileTreeItem) => {
        const treeItem = target instanceof TwinCATFileTreeItem ? target : undefined;
        if (!treeItem) {
            return undefined;
        }

        const fragmentValue = treeItem.targetUri.fragment.includes(':')
            ? treeItem.targetUri.fragment.split(':').slice(1).join(':')
            : undefined;

        switch (treeItem.itemType) {
            case TwinCATItemType.POUFolder:
                return {
                    sourceFilePath: treeItem.parentPath || '',
                    itemType: treeItem.itemType,
                    itemName: normalizeStructuredFolderPath(fragmentValue || treeItem.label?.toString())
                };
            case TwinCATItemType.Method:
            case TwinCATItemType.Property:
            case TwinCATItemType.Action:
            case TwinCATItemType.Transition:
                return {
                    sourceFilePath: treeItem.parentPath || '',
                    itemType: treeItem.itemType,
                    itemName: treeItem.label?.toString()
                };
            case TwinCATItemType.PropertyGet:
            case TwinCATItemType.PropertySet:
                return {
                    sourceFilePath: treeItem.parentPath || '',
                    itemType: treeItem.itemType,
                    propertyName: treeItem.targetUri.fragment.split(':').slice(1).join(':')
                };
            default:
                return undefined;
        }
    };

    const getStructuredTwinCATXmlRoot = (xml: any) =>
        xml.TcPOU?.[0] ??
        xml.TcGVL?.[0] ??
        xml.TcITF?.[0] ??
        xml.TcItf?.[0] ??
        xml.TcIO?.[0] ??
        xml.TcPlcObject?.POU?.[0] ??
        xml.TcPlcObject?.GVL?.[0] ??
        xml.TcPlcObject?.TcGVL?.[0] ??
        xml.TcPlcObject?.ITF?.[0] ??
        xml.TcPlcObject?.Itf?.[0] ??
        xml.TcPlcObject?.TcITF?.[0] ??
        xml.TcPlcObject?.TcItf?.[0] ??
        xml.TcPlcObject?.TcIO?.[0];

    const getStructuredTwinCATSourceKind = (sourceFilePath: string, root?: any): 'functionBlock' | 'program' | 'function' | 'interface' | 'gvl' | 'dut' | 'other' => {
        const ext = path.extname(sourceFilePath).toLowerCase();
        if (ext === '.tcprg') return 'program';
        if (ext === '.tcitf' || ext === '.tcio') return 'interface';
        if (ext === '.tcgvl') return 'gvl';
        if (ext === '.tcdut') return 'dut';
        if (ext === '.tcpou' || ext === '.tcapp' || ext === '.tccom') {
            const declaration = Array.isArray(root?.Declaration) ? root.Declaration[0] : root?.Declaration;
            if (typeof declaration === 'string') {
                if (/^\s*FUNCTION_BLOCK\b/im.test(declaration)) return 'functionBlock';
                if (/^\s*FUNCTION\b/im.test(declaration)) return 'function';
                if (/^\s*PROGRAM\b/im.test(declaration)) return 'program';
            }
            return 'functionBlock';
        }
        return 'other';
    };

    const getStructuredEntryName = (entry: any) => (Array.isArray(entry?.Name) ? entry.Name[0] : entry?.Name)?.toString();

    const normalizeStructuredFolderPath = (folderPath?: string) =>
        folderPath
            ?.split('\\')
            .map(segment => segment.trim())
            .filter(Boolean)
            .join('\\');

    const getStructuredFolderPath = (entry: any) =>
        normalizeStructuredFolderPath(entry?.FolderPath?.toString?.().replace(/\\$/, ''));

    const getStructuredFolderLeafName = (folderPath?: string) => {
        const normalized = normalizeStructuredFolderPath(folderPath);
        if (!normalized) {
            return undefined;
        }
        const segments = normalized.split('\\');
        return segments[segments.length - 1];
    };

    const joinStructuredFolderPath = (parentFolderPath: string | undefined, folderName: string) =>
        normalizeStructuredFolderPath(parentFolderPath ? `${parentFolderPath}\\${folderName}` : folderName);

    const getStructuredFolderEntries = (container: any): any[] =>
        Array.isArray(container?.Folder) ? container.Folder : [];

    const findStructuredFolderContainer = (container: any, folderPath?: string): any | undefined => {
        const normalizedTarget = normalizeStructuredFolderPath(folderPath);
        if (!normalizedTarget) {
            return container;
        }
        return findStructuredFolderEntry(container, normalizedTarget);
    };

    const findStructuredFolderEntry = (container: any, folderPath?: string): any | undefined => {
        const normalizedTarget = normalizeStructuredFolderPath(folderPath);
        if (!normalizedTarget) {
            return undefined;
        }
        const segments = normalizedTarget.split('\\');
        let currentContainer = container;
        let currentEntry: any;
        for (const segment of segments) {
            currentEntry = getStructuredFolderEntries(currentContainer).find((entry: any) => getStructuredEntryName(entry) === segment);
            if (!currentEntry) {
                return undefined;
            }
            currentContainer = currentEntry;
        }
        return currentEntry;
    };

    const removeStructuredFolderEntry = (container: any, folderPath?: string): boolean => {
        const normalizedTarget = normalizeStructuredFolderPath(folderPath);
        if (!normalizedTarget) {
            return false;
        }
        const segments = normalizedTarget.split('\\');
        const leafName = segments.pop();
        let currentContainer = container;
        for (const segment of segments) {
            const nextEntry = getStructuredFolderEntries(currentContainer).find((entry: any) => getStructuredEntryName(entry) === segment);
            if (!nextEntry) {
                return false;
            }
            currentContainer = nextEntry;
        }
        const folders = getStructuredFolderEntries(currentContainer);
        const nextFolders = folders.filter((entry: any) => getStructuredEntryName(entry) !== leafName);
        if (nextFolders.length === folders.length) {
            return false;
        }
        currentContainer.Folder = nextFolders;
        return true;
    };

    const cloneStructuredXmlValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

    const structuredMemberCollectionNames = ['Method', 'Property', 'Action', 'Transition'] as const;
    type StructuredMemberCollectionName = typeof structuredMemberCollectionNames[number];

    const getStructuredMemberCollectionName = (
        itemType: TwinCATItemType.Method
            | TwinCATItemType.Property
            | TwinCATItemType.Action
            | TwinCATItemType.Transition
            | 'method'
            | 'property'
            | 'action'
            | 'transition'
    ): StructuredMemberCollectionName => {
        switch (itemType) {
            case TwinCATItemType.Method:
            case 'method':
                return 'Method';
            case TwinCATItemType.Property:
            case 'property':
                return 'Property';
            case TwinCATItemType.Action:
            case 'action':
                return 'Action';
            case TwinCATItemType.Transition:
            case 'transition':
                return 'Transition';
        }
    };

    const hasStructuredFolderNameConflictAtLevel = (container: any, candidateName: string, excludeName?: string) =>
        getStructuredFolderEntries(container).some((entry: any) => {
            const entryName = getStructuredEntryName(entry);
            return entryName === candidateName && entryName !== excludeName;
        });

    const canStructuredSourceContain = (
        sourceKind: ReturnType<typeof getStructuredTwinCATSourceKind>,
        itemType: 'folder' | 'method' | 'property' | 'action' | 'transition'
    ) => {
        if (sourceKind === 'function' || sourceKind === 'dut' || sourceKind === 'other') {
            return false;
        }
        if (sourceKind === 'gvl') {
            return itemType === 'folder' || itemType === 'property';
        }
        if (sourceKind === 'interface') {
            return itemType === 'folder' || itemType === 'method' || itemType === 'property';
        }
        return true;
    };

    const applyStructuredFolderPath = (entry: any, folderPath?: string) => {
        const normalizedFolderPath = normalizeStructuredFolderPath(folderPath);
        if (normalizedFolderPath) {
            entry.FolderPath = `${normalizedFolderPath}\\`;
            return;
        }
        delete entry.FolderPath;
    };

    const deleteInternalTwinCATItem = async (target: ReturnType<typeof resolveInternalTwinCATTarget>) => {
        if (!target?.sourceFilePath) {
            return false;
        }

        const parser = new xml2js.Parser({ explicitArray: true, mergeAttrs: true });
        const builder = new xml2js.Builder({ headless: true });
        const sourceXml = await fs.promises.readFile(target.sourceFilePath, 'utf8');
        const xml = await parser.parseStringPromise(sourceXml);
        const root = getStructuredTwinCATXmlRoot(xml);

        if (!root) {
            return false;
        }

        const getEntryName = (entry: any) => (Array.isArray(entry?.Name) ? entry.Name[0] : entry?.Name)?.toString();
        const removeByName = (collectionName: 'Method' | 'Property' | 'Action' | 'Transition', name?: string) => {
            const existing = Array.isArray(root[collectionName]) ? root[collectionName] : [];
            root[collectionName] = existing.filter((entry: any) => getEntryName(entry) !== name);
        };

        switch (target.itemType) {
            case TwinCATItemType.Method:
                removeByName('Method', target.itemName);
                break;
            case TwinCATItemType.Property:
                removeByName('Property', target.itemName);
                break;
            case TwinCATItemType.Action:
                removeByName('Action', target.itemName);
                break;
            case TwinCATItemType.Transition:
                removeByName('Transition', target.itemName);
                break;
            case TwinCATItemType.PropertyGet:
            case TwinCATItemType.PropertySet: {
                const properties = Array.isArray(root.Property) ? root.Property : [];
                const property = properties.find((entry: any) => getEntryName(entry) === target.propertyName);
                if (!property) {
                    return false;
                }
                if (target.itemType === TwinCATItemType.PropertyGet) {
                    property.Get = [];
                } else {
                    property.Set = [];
                }
                break;
            }
            case TwinCATItemType.POUFolder: {
                const folderName = normalizeStructuredFolderPath(target.itemName);
                const removed = removeStructuredFolderEntry(root, folderName);
                for (const collectionName of ['Method', 'Property', 'Action', 'Transition'] as const) {
                    const entries = Array.isArray(root[collectionName]) ? root[collectionName] : [];
                    root[collectionName] = entries.filter((entry: any) => {
                        const entryFolderPath = getStructuredFolderPath(entry);
                        return !(entryFolderPath === folderName || entryFolderPath?.startsWith(`${folderName}\\`));
                    });
                }
                if (!removed) {
                    return false;
                }
                break;
            }
            default:
                return false;
        }

        const updatedXml = `${builder.buildObject(xml)}\r\n`;
        if (updatedXml === sourceXml) {
            return false;
        }

        await fs.promises.writeFile(target.sourceFilePath, updatedXml, 'utf8');
        return true;
    };

    const renameInternalTwinCATItem = async (
        target: ReturnType<typeof resolveInternalTwinCATTarget>,
        newName: string
    ): Promise<'ok' | 'exists' | 'unsupported' | 'failed'> => {
        if (!target?.sourceFilePath) {
            return 'unsupported';
        }

        const parser = new xml2js.Parser({ explicitArray: true, mergeAttrs: true });
        const builder = new xml2js.Builder({ headless: true });
        const sourceXml = await fs.promises.readFile(target.sourceFilePath, 'utf8');
        const xml = await parser.parseStringPromise(sourceXml);
        const root = getStructuredTwinCATXmlRoot(xml);

        if (!root) {
            return 'unsupported';
        }

        const getEntryName = (entry: any) => (Array.isArray(entry?.Name) ? entry.Name[0] : entry?.Name)?.toString();
        const setEntryName = (entry: any, value: string) => {
            if (Array.isArray(entry?.Name)) {
                entry.Name[0] = value;
            } else {
                entry.Name = [value];
            }
        };
        const replaceDeclarationName = (entry: any, keyword: 'METHOD' | 'PROPERTY', oldName: string, replacement: string) => {
            const declaration = Array.isArray(entry?.Declaration) ? entry.Declaration[0] : entry?.Declaration;
            if (typeof declaration !== 'string') {
                return;
            }
            const updated = declaration.replace(
                new RegExp(`(^\\s*${keyword}\\s+)${escapeRegExp(oldName)}(\\b)`, 'im'),
                `$1${replacement}$2`
            );
            if (Array.isArray(entry.Declaration)) {
                entry.Declaration[0] = updated;
            } else {
                entry.Declaration = [updated];
            }
        };
        const collectionHasName = (collectionName: 'Method' | 'Property' | 'Action' | 'Transition' | 'Folder', value: string, excludeName?: string) =>
            (Array.isArray(root[collectionName]) ? root[collectionName] : []).some((entry: any) => {
                const entryName = getEntryName(entry);
                return entryName === value && entryName !== excludeName;
            });
        const hasAnyStructuredMemberName = (value: string, excludeName?: string) =>
            (['Method', 'Property', 'Action', 'Transition'] as const).some(collectionName =>
                collectionHasName(collectionName, value, excludeName)
            );

        switch (target.itemType) {
            case TwinCATItemType.POUFolder: {
                const oldFolderPath = normalizeStructuredFolderPath(target.itemName);
                if (!oldFolderPath) {
                    return 'failed';
                }
                const parentFolderPath = oldFolderPath.includes('\\') ? oldFolderPath.slice(0, oldFolderPath.lastIndexOf('\\')) : undefined;
                const parentContainer = findStructuredFolderContainer(root, parentFolderPath);
                if (!parentContainer) {
                    return 'failed';
                }
                if (hasStructuredFolderNameConflictAtLevel(parentContainer, newName, getStructuredFolderLeafName(oldFolderPath))) {
                    return 'exists';
                }
                const folder = findStructuredFolderEntry(root, oldFolderPath);
                if (!folder) {
                    return 'failed';
                }
                setEntryName(folder, newName);
                const newFolderPath = joinStructuredFolderPath(
                    parentFolderPath,
                    newName
                );
                for (const collectionName of ['Method', 'Property', 'Action', 'Transition'] as const) {
                    const entries = Array.isArray(root[collectionName]) ? root[collectionName] : [];
                    for (const entry of entries) {
                        const folderPath = getStructuredFolderPath(entry);
                        if (!folderPath || (folderPath !== oldFolderPath && !folderPath.startsWith(`${oldFolderPath}\\`))) {
                            continue;
                        }
                        const suffix = folderPath === oldFolderPath ? '' : folderPath.slice(oldFolderPath.length + 1);
                        applyStructuredFolderPath(entry, suffix ? joinStructuredFolderPath(newFolderPath, suffix) : newFolderPath);
                    }
                }
                break;
            }
            case TwinCATItemType.Method: {
                if (hasAnyStructuredMemberName(newName, target.itemName)) {
                    return 'exists';
                }
                const methods = Array.isArray(root.Method) ? root.Method : [];
                const method = methods.find((entry: any) => getEntryName(entry) === target.itemName);
                if (!method) {
                    return 'failed';
                }
                setEntryName(method, newName);
                replaceDeclarationName(method, 'METHOD', target.itemName || '', newName);
                break;
            }
            case TwinCATItemType.Property: {
                if (hasAnyStructuredMemberName(newName, target.itemName)) {
                    return 'exists';
                }
                const properties = Array.isArray(root.Property) ? root.Property : [];
                const property = properties.find((entry: any) => getEntryName(entry) === target.itemName);
                if (!property) {
                    return 'failed';
                }
                setEntryName(property, newName);
                replaceDeclarationName(property, 'PROPERTY', target.itemName || '', newName);
                break;
            }
            case TwinCATItemType.Action: {
                if (hasAnyStructuredMemberName(newName, target.itemName)) {
                    return 'exists';
                }
                const actions = Array.isArray(root.Action) ? root.Action : [];
                const action = actions.find((entry: any) => getEntryName(entry) === target.itemName);
                if (!action) {
                    return 'failed';
                }
                setEntryName(action, newName);
                break;
            }
            case TwinCATItemType.Transition: {
                if (hasAnyStructuredMemberName(newName, target.itemName)) {
                    return 'exists';
                }
                const transitions = Array.isArray(root.Transition) ? root.Transition : [];
                const transition = transitions.find((entry: any) => getEntryName(entry) === target.itemName);
                if (!transition) {
                    return 'failed';
                }
                setEntryName(transition, newName);
                break;
            }
            default:
                return 'unsupported';
        }

        const updatedXml = `${builder.buildObject(xml)}\r\n`;
        if (updatedXml === sourceXml) {
            return 'failed';
        }

        await fs.promises.writeFile(target.sourceFilePath, updatedXml, 'utf8');
        return 'ok';
    };

    const hasDuplicateTwinCATSourceName = async (plcprojPath: string, candidateName: string, excludePath?: string) => {
        const projectDir = path.dirname(plcprojPath);
        const normalizedExclude = excludePath ? path.normalize(excludePath) : undefined;
        const sourceFiles = await collectTwinCATSourceFiles(projectDir);
        return sourceFiles.some(filePath =>
            path.basename(filePath, path.extname(filePath)).localeCompare(candidateName, undefined, { sensitivity: 'accent' }) === 0 &&
            (!normalizedExclude || path.normalize(filePath) !== normalizedExclude)
        );
    };

    const resolveTwinCATMemberTarget = async (target?: vscode.Uri | TwinCATFileTreeItem) => {
        const treeItem = target instanceof TwinCATFileTreeItem ? target : undefined;
        const uri = treeItem?.targetUri ?? (target instanceof vscode.Uri ? target : undefined);
        if (!uri?.fsPath) {
            return undefined;
        }

        if (treeItem?.itemType === TwinCATItemType.POUFolder) {
            const internalTarget = resolveInternalTwinCATTarget(treeItem);
            return {
                sourceFilePath: treeItem.parentPath || '',
                folderName: internalTarget?.itemName
            };
        }

        if (treeItem?.itemType === TwinCATItemType.File && structuredTwinCATFolderExtensions.has(path.extname(uri.fsPath).toLowerCase())) {
            return {
                sourceFilePath: uri.fsPath
            };
        }

        return undefined;
    };

    const appendTwinCATMember = async (sourceFilePath: string, kind: 'method' | 'property' | 'action' | 'transition', name: string, folderName?: string) => {
        const parser = new xml2js.Parser({ explicitArray: true, mergeAttrs: true });
        const builder = new xml2js.Builder({ headless: true });
        const sourceXml = await fs.promises.readFile(sourceFilePath, 'utf8');
        const xml = await parser.parseStringPromise(sourceXml);
        const root = getStructuredTwinCATXmlRoot(xml);

        if (!root) {
            return { ok: false, reason: 'unsupported' as const };
        }

        const sourceKind = getStructuredTwinCATSourceKind(sourceFilePath, root);
        if (
            sourceKind === 'function' ||
            sourceKind === 'dut' ||
            sourceKind === 'other' ||
            (sourceKind === 'gvl' && kind !== 'property') ||
            (sourceKind === 'interface' && (kind === 'action' || kind === 'transition'))
        ) {
            return { ok: false, reason: 'invalid-kind' as const };
        }

        const hasName = (collectionName: 'Method' | 'Property' | 'Action' | 'Transition' | 'Folder') =>
            (Array.isArray(root[collectionName]) ? root[collectionName] : []).some((entry: any) => ((Array.isArray(entry?.Name) ? entry.Name[0] : entry?.Name)?.toString()) === name);
        const hasAnyStructuredMemberName = () =>
            (['Method', 'Property', 'Action', 'Transition'] as const).some(collectionName => hasName(collectionName));

        const folderPathValue = folderName ? `${folderName}\\` : undefined;
        const withFolder = (entry: any) => {
            if (folderPathValue) {
                entry.FolderPath = folderPathValue;
            }
            return entry;
        };

        switch (kind) {
            case 'method':
                if (hasAnyStructuredMemberName()) return { ok: false, reason: 'exists' as const };
                root.Method = Array.isArray(root.Method) ? root.Method : [];
                root.Method.push(withFolder({
                    Name: name,
                    Declaration: sourceKind === 'interface' ? `METHOD ${name}` : `METHOD ${name}\r\nVAR\r\nEND_VAR`,
                    ...(sourceKind === 'interface' ? {} : { Implementation: [{ ST: [''] }] })
                }));
                break;
            case 'property':
                if (hasAnyStructuredMemberName()) return { ok: false, reason: 'exists' as const };
                root.Property = Array.isArray(root.Property) ? root.Property : [];
                root.Property.push(withFolder({
                    Name: name,
                    Declaration: `PROPERTY ${name} : BOOL`,
                    Get: [{ Declaration: '', ...(sourceKind === 'interface' ? {} : { Implementation: [{ ST: [''] }] }) }],
                    Set: [{ Declaration: 'VAR_INPUT\r\n    value : BOOL;\r\nEND_VAR', ...(sourceKind === 'interface' ? {} : { Implementation: [{ ST: [''] }] }) }]
                }));
                break;
            case 'action':
                if (hasAnyStructuredMemberName()) return { ok: false, reason: 'exists' as const };
                root.Action = Array.isArray(root.Action) ? root.Action : [];
                root.Action.push(withFolder({
                    Name: name,
                    Implementation: [{ ST: [''] }]
                }));
                break;
            case 'transition':
                if (hasAnyStructuredMemberName()) return { ok: false, reason: 'exists' as const };
                root.Transition = Array.isArray(root.Transition) ? root.Transition : [];
                root.Transition.push(withFolder({
                    Name: name,
                    Implementation: [{ ST: [''] }]
                }));
                break;
        }

        const updatedXml = `${builder.buildObject(xml)}\r\n`;
        await fs.promises.writeFile(sourceFilePath, updatedXml, 'utf8');
        return { ok: true as const };
    };

    const resolveTwinCATPasteTarget = async (target?: vscode.Uri | TwinCATFileTreeItem): Promise<{ plcprojPath: string; folderPath: string } | undefined> => {
        const folderTarget = await resolveTwinCATFolderCommandTarget(target);
        if (folderTarget?.plcprojPath && folderTarget.folderPath && !folderTarget.sourceFilePath) {
            return {
                plcprojPath: folderTarget.plcprojPath,
                folderPath: folderTarget.folderPath
            };
        }

        const fileTarget = await resolveTwinCATFileCommandTarget(target);
        if (fileTarget?.plcprojPath) {
            return {
                plcprojPath: fileTarget.plcprojPath,
                folderPath: fileTarget.filePath ? path.dirname(fileTarget.filePath) : fileTarget.folderPath
            };
        }

        return undefined;
    };

    const resolveTwinCATInternalPasteTarget = async (target?: vscode.Uri | TwinCATFileTreeItem) => {
        const memberTarget = await resolveTwinCATMemberTarget(target);
        if (memberTarget?.sourceFilePath) {
            return memberTarget;
        }

        const internalTarget = resolveInternalTwinCATTarget(target);
        if (internalTarget?.sourceFilePath) {
            const folderName = internalTarget.itemType === TwinCATItemType.POUFolder
                ? internalTarget.itemName
                : getStructuredFolderPath((target as TwinCATFileTreeItem)?.xmlContent);
            return {
                sourceFilePath: internalTarget.sourceFilePath,
                folderName
            };
        }

        return undefined;
    };

    const extractInternalClipboardPayload = async (
        target: NonNullable<ReturnType<typeof resolveInternalTwinCATTarget>>,
        mode: 'copy' | 'cut'
    ): Promise<PendingInternalClipboard | undefined> => {
        const parser = new xml2js.Parser({ explicitArray: true, mergeAttrs: true });
        const sourceXml = await fs.promises.readFile(target.sourceFilePath, 'utf8');
        const xml = await parser.parseStringPromise(sourceXml);
        const root = getStructuredTwinCATXmlRoot(xml);
        if (!root) {
            return undefined;
        }

        const findEntry = (collectionName: 'Method' | 'Property' | 'Action' | 'Transition', name?: string) =>
            (Array.isArray(root[collectionName]) ? root[collectionName] : []).find((entry: any) => getStructuredEntryName(entry) === name);

        switch (target.itemType) {
            case TwinCATItemType.POUFolder: {
                const folderPath = normalizeStructuredFolderPath(target.itemName);
                const folderTree = findStructuredFolderEntry(root, folderPath);
                if (!folderTree || !folderPath) {
                    return undefined;
                }

                const inFolderTree = (collectionName: 'Method' | 'Property' | 'Action' | 'Transition') =>
                    (Array.isArray(root[collectionName]) ? root[collectionName] : [])
                        .filter((entry: any) => {
                            const entryFolderPath = getStructuredFolderPath(entry);
                            return entryFolderPath === folderPath || entryFolderPath?.startsWith(`${folderPath}\\`);
                        })
                        .map(cloneStructuredXmlValue);

                return {
                    mode,
                    kind: 'internal',
                    sourceFilePath: target.sourceFilePath,
                    payload: {
                        type: 'folder',
                        name: folderPath,
                        folderTree: cloneStructuredXmlValue(folderTree),
                        methods: inFolderTree('Method'),
                        properties: inFolderTree('Property'),
                        actions: inFolderTree('Action'),
                        transitions: inFolderTree('Transition')
                    }
                };
            }
            case TwinCATItemType.Method:
            case TwinCATItemType.Property:
            case TwinCATItemType.Action:
            case TwinCATItemType.Transition: {
                const collectionName = target.itemType === TwinCATItemType.Method
                    ? 'Method'
                    : target.itemType === TwinCATItemType.Property
                        ? 'Property'
                        : target.itemType === TwinCATItemType.Action
                            ? 'Action'
                            : 'Transition';
                const entry = findEntry(collectionName, target.itemName);
                if (!entry || !target.itemName) {
                    return undefined;
                }
                return {
                    mode,
                    kind: 'internal',
                    sourceFilePath: target.sourceFilePath,
                    sourceFolderName: getStructuredFolderPath(entry),
                    payload: {
                        type: target.itemType,
                        name: target.itemName,
                        entry: cloneStructuredXmlValue(entry)
                    }
                };
            }
            default:
                return undefined;
        }
    };

    const removeInternalClipboardSourceFromRoot = (root: any, clipboard: PendingInternalClipboard) => {
        if (clipboard.payload.type === 'folder') {
            const folderName = normalizeStructuredFolderPath(clipboard.payload.name);
            removeStructuredFolderEntry(root, folderName);
            for (const collectionName of ['Method', 'Property', 'Action', 'Transition'] as const) {
                root[collectionName] = (Array.isArray(root[collectionName]) ? root[collectionName] : []).filter((entry: any) => {
                    const entryFolderPath = getStructuredFolderPath(entry);
                    return !(entryFolderPath === folderName || entryFolderPath?.startsWith(`${folderName}\\`));
                });
            }
            return;
        }

        const collectionName = getStructuredMemberCollectionName(clipboard.payload.type);
        root[collectionName] = (Array.isArray(root[collectionName]) ? root[collectionName] : []).filter((entry: any) => getStructuredEntryName(entry) !== clipboard.payload.name);
    };

    const applyInternalClipboardToTarget = async (
        destination: NonNullable<Awaited<ReturnType<typeof resolveTwinCATInternalPasteTarget>>>,
        clipboard: PendingInternalClipboard
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
        const parser = new xml2js.Parser({ explicitArray: true, mergeAttrs: true });
        const builder = new xml2js.Builder({ headless: true });
        const destinationXml = await fs.promises.readFile(destination.sourceFilePath, 'utf8');
        const destinationDoc = await parser.parseStringPromise(destinationXml);
        const destinationRoot = getStructuredTwinCATXmlRoot(destinationDoc);
        if (!destinationRoot) {
            return { ok: false, reason: 'unsupported' };
        }

        const destinationKind = getStructuredTwinCATSourceKind(destination.sourceFilePath, destinationRoot);
        const destinationFolderName = destination.folderName;

        const sourceDoc = clipboard.mode === 'cut' && path.normalize(clipboard.sourceFilePath) !== path.normalize(destination.sourceFilePath)
            ? await parser.parseStringPromise(await fs.promises.readFile(clipboard.sourceFilePath, 'utf8'))
            : undefined;
        const sourceRoot = sourceDoc ? getStructuredTwinCATXmlRoot(sourceDoc) : undefined;

        if (clipboard.mode === 'cut' && path.normalize(clipboard.sourceFilePath) === path.normalize(destination.sourceFilePath)) {
            removeInternalClipboardSourceFromRoot(destinationRoot, clipboard);
        }

        const ensureNoMemberConflict = (name: string) => {
            if (structuredMemberCollectionNames.some(collectionName =>
                (Array.isArray(destinationRoot[collectionName]) ? destinationRoot[collectionName] : []).some((entry: any) => getStructuredEntryName(entry) === name)
            )) {
                return false;
            }
            return true;
        };

        if (clipboard.payload.type === 'folder') {
            if (!canStructuredSourceContain(destinationKind, 'folder')) {
                return { ok: false, reason: 'invalid-kind' };
            }
            const sourceFolderPath = normalizeStructuredFolderPath(clipboard.payload.name);
            const sourceLeafName = getStructuredFolderLeafName(sourceFolderPath);
            if (!sourceLeafName || !sourceFolderPath) {
                return { ok: false, reason: 'unsupported' };
            }
            if (destinationFolderName && (destinationFolderName === sourceFolderPath || destinationFolderName.startsWith(`${sourceFolderPath}\\`))) {
                return { ok: false, reason: 'invalid-target' };
            }
            const destinationFolderContainer = findStructuredFolderContainer(destinationRoot, destinationFolderName);
            if (!destinationFolderContainer) {
                return { ok: false, reason: 'unsupported' };
            }
            const destinationRootFolderPath = joinStructuredFolderPath(destinationFolderName, sourceLeafName);
            const allItems = [
                ...clipboard.payload.methods.map((entry: any) => ({ type: 'method' as const, name: getStructuredEntryName(entry) || '' })),
                ...clipboard.payload.properties.map((entry: any) => ({ type: 'property' as const, name: getStructuredEntryName(entry) || '' })),
                ...clipboard.payload.actions.map((entry: any) => ({ type: 'action' as const, name: getStructuredEntryName(entry) || '' })),
                ...clipboard.payload.transitions.map((entry: any) => ({ type: 'transition' as const, name: getStructuredEntryName(entry) || '' }))
            ];
            if (hasStructuredFolderNameConflictAtLevel(destinationFolderContainer, sourceLeafName)) {
                return { ok: false, reason: 'exists' };
            }
            for (const item of allItems) {
                if (!item.name || !canStructuredSourceContain(destinationKind, item.type) || !ensureNoMemberConflict(item.name)) {
                    return { ok: false, reason: !canStructuredSourceContain(destinationKind, item.type) ? 'invalid-kind' : 'exists' };
                }
            }

            destinationRoot.Folder = Array.isArray(destinationRoot.Folder) ? destinationRoot.Folder : [];
            const clonedFolderTree = cloneStructuredXmlValue(clipboard.payload.folderTree);
            const targetContainer = destinationFolderContainer;
            if (!targetContainer) {
                return { ok: false, reason: 'unsupported' };
            }
            targetContainer.Folder = Array.isArray(targetContainer.Folder) ? targetContainer.Folder : [];
            targetContainer.Folder.push(clonedFolderTree);

            const pushEntries = (collectionName: 'Method' | 'Property' | 'Action' | 'Transition', entries: any[]) => {
                destinationRoot[collectionName] = Array.isArray(destinationRoot[collectionName]) ? destinationRoot[collectionName] : [];
                for (const entry of entries) {
                    const clone = cloneStructuredXmlValue(entry);
                    const entryFolderPath = getStructuredFolderPath(entry);
                    const relativeFolderPath = entryFolderPath === sourceFolderPath
                        ? ''
                        : entryFolderPath?.startsWith(`${sourceFolderPath}\\`)
                            ? entryFolderPath.slice(sourceFolderPath.length + 1)
                            : '';
                    applyStructuredFolderPath(
                        clone,
                        relativeFolderPath ? joinStructuredFolderPath(destinationRootFolderPath, relativeFolderPath) : destinationRootFolderPath
                    );
                    destinationRoot[collectionName].push(clone);
                }
            };

            pushEntries('Method', clipboard.payload.methods);
            pushEntries('Property', clipboard.payload.properties);
            pushEntries('Action', clipboard.payload.actions);
            pushEntries('Transition', clipboard.payload.transitions);
        } else {
            if (!canStructuredSourceContain(destinationKind, clipboard.payload.type)) {
                return { ok: false, reason: 'invalid-kind' };
            }
            if (!ensureNoMemberConflict(clipboard.payload.name)) {
                return { ok: false, reason: 'exists' };
            }

            const collectionName = getStructuredMemberCollectionName(clipboard.payload.type);
            destinationRoot[collectionName] = Array.isArray(destinationRoot[collectionName]) ? destinationRoot[collectionName] : [];
            const clone = cloneStructuredXmlValue(clipboard.payload.entry);
            applyStructuredFolderPath(clone, destinationFolderName);
            destinationRoot[collectionName].push(clone);
        }

        await fs.promises.writeFile(destination.sourceFilePath, `${builder.buildObject(destinationDoc)}\r\n`, 'utf8');

        if (clipboard.mode === 'cut' && path.normalize(clipboard.sourceFilePath) !== path.normalize(destination.sourceFilePath) && sourceRoot) {
            removeInternalClipboardSourceFromRoot(sourceRoot, clipboard);
            await fs.promises.writeFile(clipboard.sourceFilePath, `${builder.buildObject(sourceDoc)}\r\n`, 'utf8');
        }
        return { ok: true };
    };

    const createTwinCATInternalFolder = async (sourceFilePath: string, folderName: string, parentFolderPath?: string) => {
        const parser = new xml2js.Parser({ explicitArray: true, mergeAttrs: true });
        const builder = new xml2js.Builder({ headless: true });
        const sourceXml = await fs.promises.readFile(sourceFilePath, 'utf8');
        const xml = await parser.parseStringPromise(sourceXml);
        const root = getStructuredTwinCATXmlRoot(xml);
        if (!root) {
            return { ok: false as const, reason: 'unsupported' as const };
        }
        const sourceKind = getStructuredTwinCATSourceKind(sourceFilePath, root);
        if (!canStructuredSourceContain(sourceKind, 'folder')) {
            return { ok: false as const, reason: 'invalid-kind' as const };
        }
        root.Folder = Array.isArray(root.Folder) ? root.Folder : [];
        const folderEntry: any = { Name: [folderName] };
        if (parentFolderPath) {
            const parentFolder = findStructuredFolderEntry(root, parentFolderPath);
            if (!parentFolder) {
                return { ok: false as const, reason: 'unsupported' as const };
            }
            if (hasStructuredFolderNameConflictAtLevel(parentFolder, folderName)) {
                return { ok: false as const, reason: 'exists' as const };
            }
            parentFolder.Folder = Array.isArray(parentFolder.Folder) ? parentFolder.Folder : [];
            parentFolder.Folder.push(folderEntry);
        } else {
            if (hasStructuredFolderNameConflictAtLevel(root, folderName)) {
                return { ok: false as const, reason: 'exists' as const };
            }
            root.Folder.push(folderEntry);
        }
        await fs.promises.writeFile(sourceFilePath, `${builder.buildObject(xml)}\r\n`, 'utf8');
        return { ok: true as const };
    };

    const refreshAfterProjectMutation = async (...changedPaths: Array<string | undefined>) => {
        for (const changedPath of changedPaths) {
            if (changedPath) {
                const ext = path.extname(changedPath).toLowerCase();
                if (supportedTwinCATExts.has(ext)) {
                    fileSystemProvider.invalidateOriginalPath(changedPath);
                }
                fileExplorerProvider.markFileChanged(changedPath);
            }
        }
        fileExplorerProvider.refresh();
        void refreshProjectAnalyzerLibraryMetadata();
        void updateProjectDiagnostics();
    };

    const ensureExpandedWebviewTarget = (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        if (targetArg instanceof TwinCATFileTreeItem) {
            webviewExplorerProvider.ensureExpanded(targetArg);
        }
    };

    const closeTabsMatching = async (predicate: (uri: vscode.Uri) => boolean) => {
        const tabsToClose: vscode.Tab[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (input instanceof vscode.TabInputText && predicate(input.uri)) {
                    tabsToClose.push(tab);
                }
            }
        }
        if (tabsToClose.length > 0) {
            await vscode.window.tabGroups.close(tabsToClose, true);
        }
    };

    const closeTabsForDeletedFilesystemPath = async (deletedPath: string) => {
        const normalizedDeletedPath = path.normalize(deletedPath);
        const deletedFolderPrefix = `${normalizedDeletedPath}${path.sep}`;
        await closeTabsMatching(uri => {
            if (uri.scheme === TwinCATFileSystemProvider.scheme) {
                const originalPath = TwinCATFileSystemProvider.getOriginalPath(uri);
                return originalPath === normalizedDeletedPath || originalPath.startsWith(deletedFolderPrefix);
            }
            if (uri.scheme === 'file') {
                const normalizedUriPath = path.normalize(uri.fsPath);
                return normalizedUriPath === normalizedDeletedPath || normalizedUriPath.startsWith(deletedFolderPrefix);
            }
            return false;
        });
    };

    const closeTabsForDeletedInternalTarget = async (target: NonNullable<ReturnType<typeof resolveInternalTwinCATTarget>>) => {
        await closeTabsMatching(uri => {
            if (uri.scheme !== TwinCATFileSystemProvider.scheme) {
                return false;
            }
            if (TwinCATFileSystemProvider.getOriginalPath(uri) !== target.sourceFilePath) {
                return false;
            }
            const fragment = uri.fragment || '';
            switch (target.itemType) {
                case TwinCATItemType.POUFolder:
                    return fragment === `Folder:${target.itemName}`;
                case TwinCATItemType.Method:
                    return fragment === `method:${target.itemName}` || fragment === `Method:${target.itemName}`;
                case TwinCATItemType.Property:
                    return fragment === `property:${target.itemName}` || fragment === `Property:${target.itemName}`;
                case TwinCATItemType.PropertyGet:
                    return fragment === `PropertyGet:${target.propertyName}`;
                case TwinCATItemType.PropertySet:
                    return fragment === `PropertySet:${target.propertyName}`;
                case TwinCATItemType.Action:
                    return fragment === `action:${target.itemName}` || fragment === `Action:${target.itemName}`;
                case TwinCATItemType.Transition:
                    return fragment === `transition:${target.itemName}` || fragment === `Transition:${target.itemName}`;
                default:
                    return false;
            }
        });
    };

    const reopenTabsForRenamedInternalTarget = async (
        target: NonNullable<ReturnType<typeof resolveInternalTwinCATTarget>>,
        newName: string
    ) => {
        const oldItemName = target.itemName;
        const oldPropertyName = target.propertyName;
        const remapFragment = (fragment: string) => {
            switch (target.itemType) {
                case TwinCATItemType.Method:
                    return fragment === `Method:${oldItemName}` || fragment === `method:${oldItemName}`
                        ? `Method:${newName}`
                        : undefined;
                case TwinCATItemType.Property:
                    if (fragment === `Property:${oldItemName}` || fragment === `property:${oldItemName}`) {
                        return `Property:${newName}`;
                    }
                    if (fragment === `PropertyGet:${oldItemName}`) {
                        return `PropertyGet:${newName}`;
                    }
                    if (fragment === `PropertySet:${oldItemName}`) {
                        return `PropertySet:${newName}`;
                    }
                    return undefined;
                case TwinCATItemType.Action:
                    return fragment === `Action:${oldItemName}` || fragment === `action:${oldItemName}`
                        ? `Action:${newName}`
                        : undefined;
                case TwinCATItemType.Transition:
                    return fragment === `Transition:${oldItemName}` || fragment === `transition:${oldItemName}`
                        ? `Transition:${newName}`
                        : undefined;
                case TwinCATItemType.PropertyGet:
                    return fragment === `PropertyGet:${oldPropertyName}`
                        ? `PropertyGet:${newName}`
                        : undefined;
                case TwinCATItemType.PropertySet:
                    return fragment === `PropertySet:${oldPropertyName}`
                        ? `PropertySet:${newName}`
                        : undefined;
                default:
                    return undefined;
            }
        };

        const tabsToClose: vscode.Tab[] = [];
        const reopenTargets: string[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (!(input instanceof vscode.TabInputText) || input.uri.scheme !== TwinCATFileSystemProvider.scheme) {
                    continue;
                }
                if (TwinCATFileSystemProvider.getOriginalPath(input.uri) !== target.sourceFilePath) {
                    continue;
                }
                const nextFragment = remapFragment(input.uri.fragment || '');
                if (!nextFragment) {
                    continue;
                }
                tabsToClose.push(tab);
                reopenTargets.push(nextFragment);
            }
        }

        if (tabsToClose.length > 0) {
            await vscode.window.tabGroups.close(tabsToClose, true);
        }

        for (const reopenTarget of reopenTargets) {
            const targetUri = vscode.Uri.file(target.sourceFilePath).with({ fragment: reopenTarget });
            await openTwinCATFile(targetUri);
        }
    };


    const createTwinCATFileCommand = vscode.commands.registerCommand('tcview.createTwinCATFile', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const treeItem = targetArg instanceof TwinCATFileTreeItem ? targetArg : undefined;
        if (
            treeItem?.itemType === TwinCATItemType.POUFolder ||
            (treeItem?.itemType === TwinCATItemType.File && structuredTwinCATFolderExtensions.has(path.extname(treeItem.targetUri.fsPath).toLowerCase()))
        ) {
            vscode.window.showWarningMessage('TcView: New File is only supported in PLC project folders and filesystem folders, not inside a POU or interface structure.');
            return;
        }
        const resolvedTarget = await resolveTwinCATFileCommandTarget(targetArg);
        if (!resolvedTarget) {
            vscode.window.showWarningMessage('TcView: Select a PLC project, folder, or TwinCAT source file inside a PLC project.');
            return;
        }

        const selectedTemplate = await vscode.window.showQuickPick(
            twinCatNewFileTemplates.map(template => ({
                label: template.label,
                description: `${template.extension} -> ${template.defaultFolder}`,
                template
            })),
            { placeHolder: 'Select the TwinCAT file type to create.' }
        );
        if (!selectedTemplate) {
            return;
        }

        const name = (await vscode.window.showInputBox({
            prompt: `Enter the ${selectedTemplate.template.label} name.`,
            validateInput: value => /^[A-Za-z_]\w*$/.test(value.trim()) ? undefined : 'Use a valid TwinCAT identifier.'
        }))?.trim();
        if (!name) {
            return;
        }

        if (await hasDuplicateTwinCATSourceName(resolvedTarget.plcprojPath, name)) {
            vscode.window.showWarningMessage(`TcView: A TwinCAT source named ${name} already exists in this PLC project.`);
            return;
        }

        const projectDir = path.dirname(resolvedTarget.plcprojPath);
        const baseFolder = resolvedTarget.filePath ? path.dirname(resolvedTarget.filePath) : resolvedTarget.folderPath;
        const targetFolder = path.normalize(
            baseFolder === projectDir
                ? path.join(projectDir, selectedTemplate.template.defaultFolder)
                : baseFolder
        );
        const filePath = path.join(targetFolder, `${name}${selectedTemplate.template.extension}`);
        if (fs.existsSync(filePath)) {
            vscode.window.showWarningMessage(`TcView: ${path.basename(filePath)} already exists.`);
            return;
        }

        await fs.promises.mkdir(targetFolder, { recursive: true });
        await fs.promises.writeFile(filePath, selectedTemplate.template.buildXml(name), 'utf8');

        const plcprojText = await fs.promises.readFile(resolvedTarget.plcprojPath, 'utf8');
        const relativePath = path.relative(projectDir, filePath);
        const updatedProject = upsertTwinCATCompileEntry(plcprojText, relativePath);
        if (updatedProject !== plcprojText) {
            await fs.promises.writeFile(resolvedTarget.plcprojPath, updatedProject, 'utf8');
        }

        ensureExpandedWebviewTarget(targetArg);
        await refreshAfterProjectMutation(resolvedTarget.plcprojPath, filePath);
        await openTwinCATFile(vscode.Uri.file(filePath));
    });

    const createTwinCATFileFromTemplateCommand = vscode.commands.registerCommand('tcview.createTwinCATFileFromTemplate', async (targetArg?: vscode.Uri | TwinCATFileTreeItem, templateId?: string, providedName?: string) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const treeItem = targetArg instanceof TwinCATFileTreeItem ? targetArg : undefined;
        if (
            treeItem?.itemType === TwinCATItemType.POUFolder ||
            (treeItem?.itemType === TwinCATItemType.File && structuredTwinCATFolderExtensions.has(path.extname(treeItem.targetUri.fsPath).toLowerCase()))
        ) {
            vscode.window.showWarningMessage('TcView: New File is only supported in PLC project folders and filesystem folders, not inside a POU or interface structure.');
            return;
        }

        const resolvedTarget = await resolveTwinCATFileCommandTarget(targetArg);
        if (!resolvedTarget) {
            vscode.window.showWarningMessage('TcView: Select a PLC project or filesystem folder inside a PLC project.');
            return;
        }

        const selectedTemplate = twinCatNewFileTemplates.find(template => template.id === templateId);
        if (!selectedTemplate) {
            vscode.window.showWarningMessage('TcView: File template could not be resolved.');
            return;
        }

        const trimmedProvidedName = providedName?.trim();
        const baseName = trimmedProvidedName
            ? path.basename(trimmedProvidedName, path.extname(trimmedProvidedName))
            : undefined;
        const name = baseName && /^[A-Za-z_]\w*$/.test(baseName)
            ? baseName
            : undefined;
        if (!name) {
            vscode.window.showWarningMessage('TcView: Use a valid TwinCAT identifier for the new file name.');
            return;
        }

        if (await hasDuplicateTwinCATSourceName(resolvedTarget.plcprojPath, name)) {
            vscode.window.showWarningMessage(`TcView: A TwinCAT source named ${name} already exists in this PLC project.`);
            return;
        }

        const projectDir = path.dirname(resolvedTarget.plcprojPath);
        const baseFolder = resolvedTarget.filePath ? path.dirname(resolvedTarget.filePath) : resolvedTarget.folderPath;
        const targetFolder = path.normalize(baseFolder);
        const filePath = path.join(targetFolder, `${name}${selectedTemplate.extension}`);
        if (fs.existsSync(filePath)) {
            vscode.window.showWarningMessage(`TcView: ${path.basename(filePath)} already exists.`);
            return;
        }

        await fs.promises.mkdir(targetFolder, { recursive: true });
        await fs.promises.writeFile(filePath, selectedTemplate.buildXml(name), 'utf8');

        const plcprojText = await fs.promises.readFile(resolvedTarget.plcprojPath, 'utf8');
        const relativePath = path.relative(projectDir, filePath);
        const updatedProject = upsertTwinCATCompileEntry(plcprojText, relativePath);
        if (updatedProject !== plcprojText) {
            await fs.promises.writeFile(resolvedTarget.plcprojPath, updatedProject, 'utf8');
        }

        ensureExpandedWebviewTarget(targetArg);
        await refreshAfterProjectMutation(resolvedTarget.plcprojPath, filePath);
        await openTwinCATFile(vscode.Uri.file(filePath));
    });

    const deleteTwinCATFileCommand = vscode.commands.registerCommand('tcview.deleteTwinCATFile', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const resolvedTarget = await resolveTwinCATFileCommandTarget(targetArg);
        const filePath = resolvedTarget?.filePath;
        if (!resolvedTarget || !filePath || !supportedTwinCATExts.has(path.extname(filePath).toLowerCase())) {
            vscode.window.showWarningMessage('TcView: Select a TwinCAT source file to delete.');
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Delete ${path.basename(filePath)} from the PLC project and remove it from ${path.basename(resolvedTarget.plcprojPath)}?`,
            { modal: true },
            'Delete'
        );
        if (confirmation !== 'Delete') {
            return;
        }

        const projectDir = path.dirname(resolvedTarget.plcprojPath);
        const relativePath = path.relative(projectDir, filePath);
        const plcprojText = await fs.promises.readFile(resolvedTarget.plcprojPath, 'utf8');
        const updatedProject = removeTwinCATCompileEntry(plcprojText, relativePath);
        if (updatedProject !== plcprojText) {
            await fs.promises.writeFile(resolvedTarget.plcprojPath, updatedProject, 'utf8');
        }

        await closeTabsForDeletedFilesystemPath(filePath);
        await fs.promises.unlink(filePath);
        await refreshAfterProjectMutation(resolvedTarget.plcprojPath, filePath);
        vscode.window.showInformationMessage(`TcView: Deleted ${path.basename(filePath)}.`);
    });

    const createTwinCATFolderCommand = vscode.commands.registerCommand('tcview.createTwinCATFolder', async (targetArg?: vscode.Uri | TwinCATFileTreeItem, providedFolderName?: string) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const resolvedTarget = await resolveTwinCATFolderCommandTarget(targetArg);
        if (!resolvedTarget) {
            vscode.window.showWarningMessage('TcView: Select a PLC project folder or TwinCAT folder node.');
            return;
        }

        const folderName = (providedFolderName?.trim() || await vscode.window.showInputBox({
            prompt: 'Enter the new folder name.',
            validateInput: value => value.trim().length > 0 && !/[<>:"/\\|?*]/.test(value) ? undefined : 'Use a valid folder name.'
        }))?.trim();
        if (!folderName) {
            return;
        }

        if (resolvedTarget.sourceFilePath) {
            const created = await createTwinCATInternalFolder(
                resolvedTarget.sourceFilePath,
                folderName,
                resolvedTarget.internalFolderName
            );
            if (!created.ok) {
                if (created.reason === 'exists') {
                    vscode.window.showWarningMessage(`TcView: ${folderName} already exists.`);
                } else if (created.reason === 'invalid-kind') {
                    vscode.window.showWarningMessage('TcView: This TwinCAT source type cannot contain internal folders.');
                } else {
                    vscode.window.showWarningMessage('TcView: Internal folder creation is not supported for this source file.');
                }
                return;
            }
            await refreshAfterProjectMutation(resolvedTarget.sourceFilePath);
            return;
        }

        if (!resolvedTarget.plcprojPath || !resolvedTarget.folderPath) {
            vscode.window.showWarningMessage('TcView: Folder creation target could not be resolved.');
            return;
        }

        const newFolderPath = path.join(resolvedTarget.folderPath, folderName);
        if (fs.existsSync(newFolderPath)) {
            vscode.window.showWarningMessage(`TcView: Folder ${folderName} already exists.`);
            return;
        }

        await fs.promises.mkdir(newFolderPath, { recursive: true });
        const projectDir = path.dirname(resolvedTarget.plcprojPath);
        const relativeFolderPath = path.relative(projectDir, newFolderPath);
        const plcprojText = await fs.promises.readFile(resolvedTarget.plcprojPath, 'utf8');
        const updatedProject = upsertTwinCATFolderEntry(plcprojText, relativeFolderPath);
        if (updatedProject !== plcprojText) {
            await fs.promises.writeFile(resolvedTarget.plcprojPath, updatedProject, 'utf8');
        }

        ensureExpandedWebviewTarget(targetArg);
        await refreshAfterProjectMutation(resolvedTarget.plcprojPath, newFolderPath);
    });

    const renameTwinCATItemCommand = vscode.commands.registerCommand('tcview.renameTwinCATItem', async (targetArg?: vscode.Uri | TwinCATFileTreeItem, providedNewName?: string) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const internalTarget = resolveInternalTwinCATTarget(targetArg);
        if (internalTarget) {

            if (internalTarget.itemType === TwinCATItemType.PropertyGet || internalTarget.itemType === TwinCATItemType.PropertySet) {
                vscode.window.showWarningMessage('TcView: Rename the parent property instead of individual Get/Set accessors.');
                return;
            }

            const currentName = internalTarget.itemType === TwinCATItemType.POUFolder
                ? internalTarget.itemName || ''
                : internalTarget.itemName || '';
            const newName = (providedNewName?.trim() || await vscode.window.showInputBox({
                prompt: `Rename ${currentName}`,
                value: currentName,
                validateInput: value => /^[A-Za-z_]\w*$/.test(value.trim()) ? undefined : 'Use a valid TwinCAT identifier.'
            }))?.trim();
            if (!newName || newName === currentName) {
                return;
            }

            const renameResult = await renameInternalTwinCATItem(internalTarget, newName);
            if (renameResult === 'exists') {
                vscode.window.showWarningMessage(`TcView: ${newName} already exists.`);
                return;
            }
            if (renameResult !== 'ok') {
                vscode.window.showWarningMessage('TcView: Failed to rename the selected internal item.');
                return;
            }

            ensureExpandedWebviewTarget(targetArg);
            await reopenTabsForRenamedInternalTarget(internalTarget, newName);
            await refreshAfterProjectMutation(internalTarget.sourceFilePath);
            vscode.window.showInformationMessage(`TcView: Renamed ${currentName} to ${newName}.`);
            return;
        }

        const resolvedTarget = await resolveTwinCATRenameDeleteTarget(targetArg);
        if (!resolvedTarget) {
            vscode.window.showWarningMessage('TcView: Select a TwinCAT file, folder, or internal member to rename.');
            return;
        }

        if (resolvedTarget.itemType === TwinCATItemType.PlcProjectFolder || resolvedTarget.itemType === TwinCATItemType.POUFolder) {
            vscode.window.showWarningMessage('TcView: Select a TwinCAT file or folder to rename.');
            return;
        }

        const currentName = path.basename(resolvedTarget.targetPath);
        const validateInput = (value: string) => {
            const trimmed = value.trim();
            if (!trimmed) {
                return 'Enter a name.';
            }
            if (/[<>:"/\\|?*]/.test(trimmed)) {
                return 'Use a valid file or folder name.';
            }
            if (resolvedTarget.isFile) {
                const ext = path.extname(currentName);
                if (!trimmed.toLowerCase().endsWith(ext.toLowerCase())) {
                    return `File name must keep the ${ext} extension.`;
                }
            }
            return undefined;
        };

        const newName = (providedNewName?.trim() || await vscode.window.showInputBox({
            prompt: `Rename ${currentName}`,
            value: currentName,
            validateInput
        }))?.trim();
        if (!newName || newName === currentName) {
            return;
        }

        if (resolvedTarget.isFile) {
            const candidateBaseName = path.basename(newName, path.extname(newName));
            if (await hasDuplicateTwinCATSourceName(resolvedTarget.plcprojPath, candidateBaseName, resolvedTarget.targetPath)) {
                vscode.window.showWarningMessage(`TcView: A TwinCAT source named ${candidateBaseName} already exists in this PLC project.`);
                return;
            }
        }

        const nextPath = path.join(path.dirname(resolvedTarget.targetPath), newName);
        if (fs.existsSync(nextPath)) {
            vscode.window.showWarningMessage(`TcView: ${newName} already exists.`);
            return;
        }

        const projectDir = path.dirname(resolvedTarget.plcprojPath);
        const oldRelativePath = path.relative(projectDir, resolvedTarget.targetPath);
        const newRelativePath = path.relative(projectDir, nextPath);
        const plcprojText = await fs.promises.readFile(resolvedTarget.plcprojPath, 'utf8');
        const updatedProject = remapTwinCATProjectEntries(plcprojText, oldRelativePath, newRelativePath);
        if (updatedProject !== plcprojText) {
            await fs.promises.writeFile(resolvedTarget.plcprojPath, updatedProject, 'utf8');
        }

        await fs.promises.rename(resolvedTarget.targetPath, nextPath);
        await refreshAfterProjectMutation(resolvedTarget.plcprojPath, resolvedTarget.targetPath, nextPath);
        vscode.window.showInformationMessage(`TcView: Renamed ${currentName} to ${newName}.`);
    });

    const deleteTwinCATFolderCommand = vscode.commands.registerCommand('tcview.deleteTwinCATFolder', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const resolvedTarget = await resolveTwinCATRenameDeleteTarget(targetArg);
        if (!resolvedTarget || resolvedTarget.isFile) {
            vscode.window.showWarningMessage('TcView: Select a TwinCAT folder to delete.');
            return;
        }

        if (resolvedTarget.itemType === TwinCATItemType.PlcProjectFolder || resolvedTarget.itemType === TwinCATItemType.POUFolder) {
            vscode.window.showWarningMessage('TcView: Deleting PLC project roots and internal member folders is not supported yet.');
            return;
        }

        const folderName = path.basename(resolvedTarget.targetPath);
        const confirmation = await vscode.window.showWarningMessage(
            `Delete folder ${folderName} and remove all contained TwinCAT project entries from ${path.basename(resolvedTarget.plcprojPath)}?`,
            { modal: true },
            'Delete'
        );
        if (confirmation !== 'Delete') {
            return;
        }

        const projectDir = path.dirname(resolvedTarget.plcprojPath);
        const relativeFolderPath = path.relative(projectDir, resolvedTarget.targetPath);
        const plcprojText = await fs.promises.readFile(resolvedTarget.plcprojPath, 'utf8');
        const updatedProject = removeTwinCATFolderEntries(plcprojText, relativeFolderPath);
        if (updatedProject !== plcprojText) {
            await fs.promises.writeFile(resolvedTarget.plcprojPath, updatedProject, 'utf8');
        }

        await closeTabsForDeletedFilesystemPath(resolvedTarget.targetPath);
        await fs.promises.rm(resolvedTarget.targetPath, { recursive: true, force: true });
        await refreshAfterProjectMutation(resolvedTarget.plcprojPath, resolvedTarget.targetPath);
        vscode.window.showInformationMessage(`TcView: Deleted folder ${folderName}.`);
    });

    const deleteTwinCATMemberCommand = vscode.commands.registerCommand('tcview.deleteTwinCATMember', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const target = resolveInternalTwinCATTarget(targetArg);
        if (!target) {
            vscode.window.showWarningMessage('TcView: Select an internal POU/ITF item to delete.');
            return;
        }

        const displayName = target.itemType === TwinCATItemType.POUFolder
            ? `folder ${target.itemName}`
            : target.itemType === TwinCATItemType.PropertyGet
                ? `property getter ${target.propertyName}`
                : target.itemType === TwinCATItemType.PropertySet
                    ? `property setter ${target.propertyName}`
                    : `${target.itemType} ${target.itemName}`;

        const confirmation = await vscode.window.showWarningMessage(
            `Delete ${displayName}?`,
            { modal: true },
            'Delete'
        );
        if (confirmation !== 'Delete') {
            return;
        }

        const deleted = await deleteInternalTwinCATItem(target);
        if (!deleted) {
            vscode.window.showWarningMessage('TcView: Failed to delete the selected internal item.');
            return;
        }

        await closeTabsForDeletedInternalTarget(target);
        await refreshAfterProjectMutation(target.sourceFilePath);
    });

    const copyTwinCATItemCommand = vscode.commands.registerCommand('tcview.copyTwinCATItem', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const internalTarget = resolveInternalTwinCATTarget(targetArg);
        if (internalTarget) {
            const clipboard = await extractInternalClipboardPayload(internalTarget, 'copy');
            if (!clipboard) {
                vscode.window.showWarningMessage('TcView: Copy is not supported for this internal item.');
                return;
            }
            pendingTreeClipboard = clipboard;
            webviewExplorerProvider.setCutNodeId();
            return;
        }
        const resolvedTarget = await resolveTwinCATRenameDeleteTarget(targetArg);
        if (!resolvedTarget || resolvedTarget.itemType === TwinCATItemType.PlcProjectFolder || resolvedTarget.itemType === TwinCATItemType.POUFolder) {
            vscode.window.showWarningMessage('TcView: Copy is supported for TwinCAT files, folders, and internal POU items.');
            return;
        }
        pendingTreeClipboard = {
            mode: 'copy',
            kind: 'filesystem',
            plcprojPath: resolvedTarget.plcprojPath,
            targetPath: resolvedTarget.targetPath,
            isFile: resolvedTarget.isFile
        };
        webviewExplorerProvider.setCutNodeId();
    });

    const cutTwinCATItemCommand = vscode.commands.registerCommand('tcview.cutTwinCATItem', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const internalTarget = resolveInternalTwinCATTarget(targetArg);
        if (internalTarget) {
            const clipboard = await extractInternalClipboardPayload(internalTarget, 'cut');
            if (!clipboard) {
                vscode.window.showWarningMessage('TcView: Cut is not supported for this internal item.');
                return;
            }
            pendingTreeClipboard = clipboard;
            webviewExplorerProvider.setCutNodeId(webviewExplorerProvider.getCurrentContextItemId());
            return;
        }
        const resolvedTarget = await resolveTwinCATRenameDeleteTarget(targetArg);
        if (!resolvedTarget || resolvedTarget.itemType === TwinCATItemType.PlcProjectFolder || resolvedTarget.itemType === TwinCATItemType.POUFolder) {
            vscode.window.showWarningMessage('TcView: Cut is supported for TwinCAT files, folders, and internal POU items.');
            return;
        }
        pendingTreeClipboard = {
            mode: 'cut',
            kind: 'filesystem',
            plcprojPath: resolvedTarget.plcprojPath,
            targetPath: resolvedTarget.targetPath,
            isFile: resolvedTarget.isFile
        };
        webviewExplorerProvider.setCutNodeId(webviewExplorerProvider.getCurrentContextItemId());
    });

    const pasteTwinCATItemCommand = vscode.commands.registerCommand('tcview.pasteTwinCATItem', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        if (!pendingTreeClipboard) {
            return;
        }

        if (pendingTreeClipboard.kind === 'internal') {
            const clipboard = pendingTreeClipboard;
            const destination = await resolveTwinCATInternalPasteTarget(targetArg);
            if (!destination) {
                vscode.window.showWarningMessage('TcView: Select a TwinCAT POU, interface, GVL, or internal folder as the paste target.');
                return;
            }
            const result = await applyInternalClipboardToTarget(destination, clipboard);
            if (!result.ok) {
                if (result.reason === 'exists') {
                    vscode.window.showWarningMessage('TcView: An internal item with that name already exists.');
                } else if (result.reason === 'invalid-kind') {
                    vscode.window.showWarningMessage('TcView: The selected target cannot contain this internal item type.');
                } else if (result.reason === 'invalid-target') {
                    vscode.window.showWarningMessage('TcView: Cannot paste an internal folder into itself or one of its descendants.');
                } else {
                    vscode.window.showWarningMessage('TcView: Failed to paste the internal TwinCAT item.');
                }
                return;
            }
            ensureExpandedWebviewTarget(targetArg);
            await refreshAfterProjectMutation(destination.sourceFilePath, clipboard.sourceFilePath);
            if (clipboard.mode === 'cut') {
                pendingTreeClipboard = undefined;
                webviewExplorerProvider.setCutNodeId();
            }
            return;
        }

        const destination = await resolveTwinCATPasteTarget(targetArg);
        if (!destination) {
            vscode.window.showWarningMessage('TcView: Select a filesystem TwinCAT folder as the paste target.');
            return;
        }

        const source = pendingTreeClipboard;
        if (source.kind !== 'filesystem') {
            return;
        }
        const rawDestinationPath = path.join(destination.folderPath, path.basename(source.targetPath));
        const destinationPath = source.isFile
            ? await ensureUniqueTwinCATSourcePath(
                destination.plcprojPath,
                rawDestinationPath,
                source.mode === 'cut' ? source.targetPath : undefined
            )
            : source.mode === 'copy'
                ? await ensureUniquePath(rawDestinationPath)
                : rawDestinationPath;

        if (source.mode === 'cut' && path.normalize(source.targetPath) === path.normalize(destinationPath)) {
            return;
        }
        if (source.mode === 'cut' && fs.existsSync(destinationPath)) {
            vscode.window.showWarningMessage(`TcView: ${path.basename(destinationPath)} already exists.`);
            return;
        }

        if (source.mode === 'copy') {
            if (source.isFile) {
                await fs.promises.copyFile(source.targetPath, destinationPath);
            } else {
                await fs.promises.cp(source.targetPath, destinationPath, { recursive: true });
            }
            await addTwinCATProjectEntries(destination.plcprojPath, destinationPath);
        } else {
            if (path.normalize(source.plcprojPath) === path.normalize(destination.plcprojPath)) {
                const projectDir = path.dirname(source.plcprojPath);
                const sourceRelative = path.relative(projectDir, source.targetPath);
                const destinationRelative = path.relative(projectDir, destinationPath);
                const plcprojText = await fs.promises.readFile(source.plcprojPath, 'utf8');
                const updatedProject = remapTwinCATProjectEntries(plcprojText, sourceRelative, destinationRelative);
                if (updatedProject !== plcprojText) {
                    await fs.promises.writeFile(source.plcprojPath, updatedProject, 'utf8');
                }
            } else {
                const sourceProjectDir = path.dirname(source.plcprojPath);
                let sourceProjectXml = await fs.promises.readFile(source.plcprojPath, 'utf8');
                sourceProjectXml = source.isFile
                    ? removeTwinCATCompileEntry(sourceProjectXml, path.relative(sourceProjectDir, source.targetPath))
                    : removeTwinCATFolderEntries(sourceProjectXml, path.relative(sourceProjectDir, source.targetPath));
                await fs.promises.writeFile(source.plcprojPath, sourceProjectXml, 'utf8');
            }

            await fs.promises.rename(source.targetPath, destinationPath);
            await addTwinCATProjectEntries(destination.plcprojPath, destinationPath);
            pendingTreeClipboard = undefined;
            webviewExplorerProvider.setCutNodeId();
        }

        ensureExpandedWebviewTarget(targetArg);
        await refreshAfterProjectMutation(source.plcprojPath, destination.plcprojPath, source.targetPath, destinationPath);
    });

    const createTwinCATMemberCommand = vscode.commands.registerCommand('tcview.createTwinCATMember', async (targetArg?: vscode.Uri | TwinCATFileTreeItem, kindArg?: 'method' | 'property' | 'action' | 'transition', providedName?: string) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const target = await resolveTwinCATMemberTarget(targetArg);
        if (!target?.sourceFilePath) {
            vscode.window.showWarningMessage('TcView: Select a TwinCAT POU, interface, or internal folder.');
            return;
        }

        const kind = kindArg;
        if (!kind) {
            return;
        }

        const labelMap = {
            method: 'method',
            property: 'property',
            action: 'action',
            transition: 'transition'
        } as const;
        const trimmedName = providedName?.trim() || (await vscode.window.showInputBox({
            prompt: `Enter the new ${labelMap[kind]} name.`,
            validateInput: value => /^[A-Za-z_]\w*$/.test(value.trim()) ? undefined : 'Use a valid TwinCAT identifier.'
        }))?.trim();
        if (!trimmedName) {
            return;
        }

        if (kind === 'method' || kind === 'property' || kind === 'action' || kind === 'transition') {
            // appendTwinCATMember enforces same-kind duplicates; folder-level placement stays allowed.
        }

        const result = await appendTwinCATMember(target.sourceFilePath, kind, trimmedName, target.folderName);
        if (!result.ok) {
            if (result.reason === 'exists') {
                vscode.window.showWarningMessage(`TcView: ${trimmedName} already exists.`);
            } else if (result.reason === 'invalid-kind') {
                vscode.window.showWarningMessage(`TcView: ${labelMap[kind]} is not valid for this TwinCAT source type.`);
            } else {
                vscode.window.showWarningMessage('TcView: Failed to create the requested TwinCAT member.');
            }
            return;
        }

        ensureExpandedWebviewTarget(targetArg);
        await refreshAfterProjectMutation(target.sourceFilePath);
    });

    const createTwinCATMethodCommand = vscode.commands.registerCommand('tcview.createTwinCATMethod', async () => {
        webviewExplorerProvider.startInlineCreateMemberCurrentSelection('method');
    });

    const createTwinCATPropertyCommand = vscode.commands.registerCommand('tcview.createTwinCATProperty', async () => {
        webviewExplorerProvider.startInlineCreateMemberCurrentSelection('property');
    });

    const createTwinCATActionCommand = vscode.commands.registerCommand('tcview.createTwinCATAction', async () => {
        webviewExplorerProvider.startInlineCreateMemberCurrentSelection('action');
    });

    const createTwinCATTransitionCommand = vscode.commands.registerCommand('tcview.createTwinCATTransition', async () => {
        webviewExplorerProvider.startInlineCreateMemberCurrentSelection('transition');
    });

    const webExplorerStartRenameCommand = vscode.commands.registerCommand('tcview.webExplorerStartRename', async () => {
        webviewExplorerProvider.startInlineRenameCurrentSelection();
    });

    const webExplorerStartCreateFolderCommand = vscode.commands.registerCommand('tcview.webExplorerStartCreateFolder', async () => {
        webviewExplorerProvider.startInlineCreateFolderCurrentSelection();
    });

    const webExplorerAddFunctionBlockCommand = vscode.commands.registerCommand('tcview.webExplorerAddFunctionBlock', async () => {
        webviewExplorerProvider.startInlineCreateFileCurrentSelection('functionBlock', '.TcPOU');
    });

    const webExplorerAddFunctionCommand = vscode.commands.registerCommand('tcview.webExplorerAddFunction', async () => {
        webviewExplorerProvider.startInlineCreateFileCurrentSelection('function', '.TcPOU');
    });

    const webExplorerAddProgramCommand = vscode.commands.registerCommand('tcview.webExplorerAddProgram', async () => {
        webviewExplorerProvider.startInlineCreateFileCurrentSelection('program', '.TcPRG');
    });

    const webExplorerAddGvlCommand = vscode.commands.registerCommand('tcview.webExplorerAddGvl', async () => {
        webviewExplorerProvider.startInlineCreateFileCurrentSelection('gvl', '.TcGVL');
    });

    const webExplorerAddDutCommand = vscode.commands.registerCommand('tcview.webExplorerAddDut', async () => {
        webviewExplorerProvider.startInlineCreateFileCurrentSelection('dut', '.TcDUT');
    });

    const webExplorerAddInterfaceCommand = vscode.commands.registerCommand('tcview.webExplorerAddInterface', async () => {
        webviewExplorerProvider.startInlineCreateFileCurrentSelection('interface', '.TcITF');
    });

    const deleteSelectedWebExplorerItemCommand = vscode.commands.registerCommand('tcview.deleteSelectedWebExplorerItem', async () => {
        const target = resolveWebviewCommandTarget();
        if (!(target instanceof TwinCATFileTreeItem)) {
            return;
        }

        switch (target.itemType) {
            case TwinCATItemType.File:
                await vscode.commands.executeCommand('tcview.deleteTwinCATFile', target);
                return;
            case TwinCATItemType.Folder:
                await vscode.commands.executeCommand('tcview.deleteTwinCATFolder', target);
                return;
            case TwinCATItemType.POUFolder:
            case TwinCATItemType.Method:
            case TwinCATItemType.Property:
            case TwinCATItemType.PropertyGet:
            case TwinCATItemType.PropertySet:
            case TwinCATItemType.Action:
            case TwinCATItemType.Transition:
                await vscode.commands.executeCommand('tcview.deleteTwinCATMember', target);
                return;
        }
    });


    const createLibraryMetadataTemplateCommand = vscode.commands.registerCommand('tcview.createLibraryMetadataTemplate', async () => {
        const targetUri = await ensureGlobalLibraryCatalog(true);
        if (!targetUri) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(document, { preview: false });
    });

    const importLibraryMetadataCommand = vscode.commands.registerCommand('tcview.importLibraryMetadata', async (targetArg?: vscode.Uri) => {
        let targetUri = targetArg;
        if (!targetUri) {
            const selection = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Import TwinCAT Library Metadata'
            });
            if (!selection || selection.length === 0) {
                return;
            }
            targetUri = selection[0];
        }

        const importedEntry = await deriveLibraryMetadataFromPath(targetUri.fsPath);
        if (!importedEntry) {
            vscode.window.showWarningMessage('TcView: Select a TwinCAT managed library version folder, a .library file, or a compiled library file.');
            return;
        }

        const mergedEntry = await upsertWorkspaceLibraryMetadata(targetUri.fsPath, { revealFile: true });
        if (!mergedEntry) {
            vscode.window.showWarningMessage('TcView: Failed to update the global library metadata catalog.');
            return;
        }

        vscode.window.showInformationMessage(`TcView: Imported library metadata for ${mergedEntry.name}.`);
    });

    const importLibraryProjectMetadataCommand = vscode.commands.registerCommand('tcview.importLibraryProjectMetadata', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        let targetPath = targetArg instanceof TwinCATFileTreeItem
            ? await resolvePlcProjectTarget(targetArg) || targetArg.targetUri.fsPath
            : targetArg?.fsPath;
        let targetUri = targetPath ? vscode.Uri.file(targetPath) : undefined;
        if (!targetUri) {
            const selection = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Import TwinCAT Library Project Metadata',
                filters: {
                    'TwinCAT PLC Projects': ['plcproj']
                }
            });
            if (!selection || selection.length === 0) {
                return;
            }
            targetUri = selection[0];
        }

        const importedEntry = await deriveLibraryProjectMetadata(targetUri.fsPath);
        if (!importedEntry) {
            vscode.window.showWarningMessage('TcView: Select a TwinCAT library project folder or .plcproj file.');
            return;
        }

        try {
            libraryOutput.appendLine(`[TcView Libraries] Importing library project metadata for ${importedEntry.name}`);
            const mergedEntry = await upsertWorkspaceLibraryMetadataEntry(importedEntry, { revealFile: true });
            await refreshProjectAnalyzerLibraryMetadata();
            fileExplorerProvider.refresh();

            const importedLabel = mergedEntry?.name ?? importedEntry.name;
            vscode.window.showInformationMessage(`TcView: Imported library project metadata for ${importedLabel}.`);
        } catch (error) {
            libraryOutput.appendLine(`[TcView Libraries] Library project metadata import failed: ${String(error)}`);
            libraryOutput.show(true);
            vscode.window.showErrorMessage(`TcView: Library project metadata import failed. ${String(error)}`);
        }
    });

    const removeLibraryMetadataCommand = vscode.commands.registerCommand('tcview.removeLibraryMetadata', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        let identity: { name: string; vendor?: string; version?: string; displayName: string } | undefined;

        if (targetArg instanceof TwinCATFileTreeItem && targetArg.itemType === TwinCATItemType.ReferenceItem) {
            const displayName = typeof targetArg.tooltip === 'string' ? targetArg.tooltip : undefined;
            const parsed = parseLibraryReferenceIdentity(targetArg.label?.toString() || '', displayName);
            identity = {
                name: parsed.name,
                vendor: parsed.vendor,
                version: parsed.version,
                displayName: parsed.displayName ?? parsed.name
            };
        } else {
            const targetPath = targetArg instanceof TwinCATFileTreeItem
                ? await resolvePlcProjectTarget(targetArg) || targetArg.targetUri.fsPath
                : targetArg?.fsPath;
            if (!targetPath) {
                vscode.window.showWarningMessage('TcView: Select a TwinCAT library project folder, PLC project, or library reference.');
                return;
            }
            const importedEntry = await deriveLibraryProjectMetadata(targetPath);
            if (!importedEntry) {
                vscode.window.showWarningMessage('TcView: Select a TwinCAT library project folder, PLC project, or library reference.');
                return;
            }
            identity = {
                name: importedEntry.name,
                vendor: importedEntry.vendor,
                version: importedEntry.version,
                displayName: importedEntry.name
            };
        }

        const confirm = await vscode.window.showWarningMessage(
            `Remove stored TcView metadata for ${identity.displayName}?`,
            { modal: true },
            'Remove'
        );
        if (confirm !== 'Remove') {
            return;
        }

        const removedCount = await removeWorkspaceLibraryMetadataEntries(entry => matchesLibraryIdentity(entry, identity!));
        if (removedCount === 0) {
            vscode.window.showInformationMessage(`TcView: No stored metadata matched ${identity.displayName}.`);
            return;
        }

        vscode.window.showInformationMessage(`TcView: Removed stored metadata for ${identity.displayName}.`);
    });

    const pruneUnusedLibraryMetadataCommand = vscode.commands.registerCommand('tcview.pruneUnusedLibraryMetadata', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);

        let referencedIdentities: Array<{ name: string; vendor?: string; version?: string }> = [];
        let scopeLabel = 'the current workspace';

        const scopedPlcprojPath = await resolvePlcProjectTarget(targetArg);
        if (scopedPlcprojPath) {
            referencedIdentities = await readPlcprojReferenceIdentities(scopedPlcprojPath);
            scopeLabel = path.basename(scopedPlcprojPath);
        } else {
            await ensureAnalyzerInitialized();
            referencedIdentities = getProjectAnalyzer().getLibraryReferences().map(ref => ({
                name: ref.name,
                vendor: ref.vendor,
                version: ref.version
            }));
        }

        const referenced = referencedIdentities.filter(identity => identity.name.trim().length > 0);
        const confirm = await vscode.window.showWarningMessage(
            `Prune stored TcView metadata not referenced by ${scopeLabel}?`,
            { modal: true },
            'Prune'
        );
        if (confirm !== 'Prune') {
            return;
        }

        const removedCount = await removeWorkspaceLibraryMetadataEntries(entry =>
            !referenced.some(identity => matchesLibraryIdentity(entry, identity))
        );
        vscode.window.showInformationMessage(
            removedCount > 0
                ? `TcView: Pruned ${removedCount} unused metadata entr${removedCount === 1 ? 'y' : 'ies'}.`
                : 'TcView: No unused metadata entries were found.'
        );
    });

    const installLibraryProjectCommand = vscode.commands.registerCommand('tcview.installLibraryProject', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        const plcprojPath = await resolvePlcProjectTarget(targetArg);
        if (!plcprojPath) {
            vscode.window.showWarningMessage('TcView: Select a TwinCAT library project (.plcproj) or folder containing one.');
            return;
        }

        const solutionPath = await resolveSolutionTarget(vscode.Uri.file(plcprojPath));
        if (!solutionPath) {
            showSolutionNotOpenWarning();
            return;
        }
        const tsprojPath = await resolveTsprojForSolution(solutionPath);
        if (!tsprojPath) {
            vscode.window.showWarningMessage('TcView: No TwinCAT .tsproj or .tspproj was found for the active solution.');
            return;
        }

        try {
            const result = await backendClient.installLibraryProject({
                tsprojPath,
                plcprojPath,
                solutionPath,
                outputDirectory: path.join(context.globalStorageUri.fsPath, 'libraries')
            });
            for (const line of result.diagnostics) {
                libraryOutput.appendLine(`[TcView Libraries] ${line}`);
            }
            libraryOutput.show(true);

            if (!result.success) {
                vscode.window.showErrorMessage('TcView: TwinCAT library project install failed. See TcView Libraries output.');
                return;
            }

            await refreshProjectAnalyzerLibraryMetadata();
            fileExplorerProvider.refresh();
            vscode.window.showInformationMessage(`TcView: Installed library project ${path.basename(plcprojPath)} in TwinCAT.`);
        } catch (error) {
            libraryOutput.appendLine(`[TcView Libraries] Install library project failed: ${String(error)}`);
            libraryOutput.show(true);
            vscode.window.showErrorMessage(`TcView: TwinCAT library project install failed. ${formatBackendCommandError(error)}`);
        }
    });

    const addLibraryReferenceCommand = vscode.commands.registerCommand('tcview.addLibraryReference', async (targetArg?: vscode.Uri | TwinCATFileTreeItem) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        const plcprojPath = await resolvePlcProjectTarget(targetArg);
        if (!plcprojPath) {
            vscode.window.showWarningMessage('TcView: Select a PLC project References node.');
            return;
        }

        const solutionPath = await resolveSolutionTarget(vscode.Uri.file(plcprojPath));
        const tsprojPath = solutionPath ? await resolveTsprojForSolution(solutionPath) : undefined;
        if (!tsprojPath) {
            libraryOutput.appendLine('[TcView Libraries] Add reference: .tsproj fallback is unavailable; using .plcproj primary path only.');
        }

        const picks = await collectKnownLibraryCandidates();
        const manualPick = {
            label: 'Enter library name manually...',
            description: 'Use name/version/vendor input',
            detail: 'Manual entry',
            candidate: undefined as { name: string; version?: string; vendor?: string; source: string } | undefined
        };
        const selected = await vscode.window.showQuickPick([manualPick, ...picks], {
            placeHolder: 'Select the TwinCAT library to add to the project'
        });
        if (!selected) {
            return;
        }

        let libraryName = selected.candidate?.name;
        let version = selected.candidate?.version;
        let vendor = selected.candidate?.vendor;

        if (!libraryName) {
            libraryName = await vscode.window.showInputBox({
                prompt: 'TwinCAT library name',
                ignoreFocusOut: true
            });
            if (!libraryName?.trim()) {
                return;
            }
            version = await vscode.window.showInputBox({
                prompt: 'TwinCAT library version (optional)',
                ignoreFocusOut: true
            });
            vendor = await vscode.window.showInputBox({
                prompt: 'TwinCAT library vendor/company (optional)',
                ignoreFocusOut: true
            });
        }

        try {
            const result = await backendClient.addLibraryReference({
                tsprojPath,
                plcprojPath,
                solutionPath,
                libraryName: libraryName.trim(),
                version: version?.trim(),
                vendor: vendor?.trim()
            });
            for (const line of result.diagnostics) {
                libraryOutput.appendLine(`[TcView Libraries] ${line}`);
            }
            libraryOutput.show(true);

            if (!result.success) {
                vscode.window.showErrorMessage('TcView: Add library reference failed. See TcView Libraries output.');
                return;
            }

            await refreshProjectAnalyzerLibraryMetadata();
            fileExplorerProvider.refresh();
            vscode.window.showInformationMessage(`TcView: Added library reference ${libraryName.trim()} to ${path.basename(plcprojPath)}.`);
        } catch (error) {
            libraryOutput.appendLine(`[TcView Libraries] Add library reference failed: ${String(error)}`);
            libraryOutput.show(true);
            vscode.window.showErrorMessage(`TcView: Add library reference failed. ${formatBackendCommandError(error)}`);
        }
    });

    const removeLibraryReferenceCommand = vscode.commands.registerCommand('tcview.removeLibraryReference', async (targetArg?: TwinCATFileTreeItem | vscode.Uri) => {
        targetArg = resolveWebviewCommandTarget(targetArg);
        if (!targetArg || !(targetArg instanceof TwinCATFileTreeItem) || targetArg.itemType !== TwinCATItemType.ReferenceItem) {
            vscode.window.showWarningMessage('TcView: Select a library reference under a PLC project References node.');
            return;
        }

        const plcprojPath = targetArg.parentPath;
        if (!plcprojPath || !plcprojPath.toLowerCase().endsWith('.plcproj')) {
            vscode.window.showWarningMessage('TcView: The owning PLC project for this reference could not be determined.');
            return;
        }

        const solutionPath = await resolveSolutionTarget(vscode.Uri.file(plcprojPath));
        const tsprojPath = solutionPath ? await resolveTsprojForSolution(solutionPath) : undefined;
        if (!tsprojPath) {
            libraryOutput.appendLine('[TcView Libraries] Remove reference: .tsproj fallback is unavailable; using .plcproj primary path only.');
        }

        const displayName = typeof targetArg.tooltip === 'string' ? targetArg.tooltip : undefined;
        const identity = parseLibraryReferenceIdentity(targetArg.label?.toString() || '', displayName);
        const confirm = await vscode.window.showWarningMessage(
            `Remove library reference ${identity.displayName ?? identity.name} from ${path.basename(plcprojPath)}?`,
            { modal: true },
            'Remove'
        );
        if (confirm !== 'Remove') {
            return;
        }

        try {
            const result = await backendClient.removeLibraryReference({
                tsprojPath,
                plcprojPath,
                solutionPath,
                referenceName: identity.name,
                version: identity.version,
                vendor: identity.vendor,
                displayName: identity.displayName
            });
            for (const line of result.diagnostics) {
                libraryOutput.appendLine(`[TcView Libraries] ${line}`);
            }
            libraryOutput.show(true);

            if (!result.success) {
                vscode.window.showErrorMessage('TcView: Remove library reference failed. See TcView Libraries output.');
                return;
            }

            await refreshProjectAnalyzerLibraryMetadata();
            fileExplorerProvider.refresh();
            vscode.window.showInformationMessage(`TcView: Removed library reference ${identity.name} from ${path.basename(plcprojPath)}.`);
        } catch (error) {
            libraryOutput.appendLine(`[TcView Libraries] Remove library reference failed: ${String(error)}`);
            libraryOutput.show(true);
            vscode.window.showErrorMessage(`TcView: Remove library reference failed. ${formatBackendCommandError(error)}`);
        }
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
        const formatMetadataSourceLabel = (metadataSource?: string) => {
            switch (metadataSource) {
                case 'system_global':
                    return 'System global';
                case 'built_in':
                    return 'Built-in catalog';
                case 'managed_libraries':
                    return 'Managed Libraries';
                case 'plcproj':
                    return 'PLC project';
                case 'tmc':
                    return 'TMC';
                case 'user':
                    return 'User metadata';
                default:
                    return metadataSource ?? 'Unknown';
            }
        };
        const provenances = new Set([
            ...api.symbols.map(symbol => symbol.provenance).filter(Boolean),
            ...api.dataTypes.map(typeInfo => typeInfo.provenance).filter(Boolean)
        ]);
        const hasTmcApi = provenances.has('tmc');
        const hasBuiltInApi = provenances.has('built_in');
        const hasUserApi = provenances.has('user');
        const isSystemGlobal = reference?.metadataSource === 'system_global';
        const hasResolvedApi = api.symbols.length > 0 || api.dataTypes.length > 0;
        const coverageLabel = hasTmcApi
            ? 'TMC-derived API: partial/project-scoped'
            : isSystemGlobal
                ? 'System global metadata API'
            : hasUserApi
                ? 'User metadata API'
                : hasBuiltInApi
                    ? 'Built-in metadata API'
                    : reference?.mode === 'metadata_only'
                        ? 'Metadata only'
                        : 'No TMC API found';
        const coverageTone = hasTmcApi ? 'partial' : hasResolvedApi ? 'metadata' : 'missing';
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
                return '<div class="muted">No members available.</div>';
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
            ? `<div class="empty">No published library API was resolved for this reference yet. Build the owning PLC project to generate a matching TMC, or extend TcView metadata for this library. TMC-based library views are project-scoped and may only include items compiled into or required by the current PLC project.</div>`
            : '';
        const scopeNotice = hasTmcApi
            ? `<div class="notice">Library API is derived from the current PLC project's <code>.tmc</code>. This is project-scoped and may only include items compiled into or required by this PLC project, not the library's full catalog.</div>`
            : isSystemGlobal
                ? `<div class="notice">This library is exposed as a TwinCAT system-global type source. TcView treats it as implicitly available based on the current PLC project's TwinCAT build and global-type metadata, not because it was explicitly referenced in the <code>.plcproj</code>.</div>`
            : `<div class="notice">Library API is currently sourced from TcView metadata rather than the current PLC project's <code>.tmc</code>. It is useful for recognition and navigation, but it is not compiler-validated project truth.</div>`;
        const dependencyMarkup = reference?.dependencies?.length
            ? `<div class="notice"><strong>Dependencies</strong><br />${reference.dependencies.map(dep => `<code>${escapeHtml(dep)}</code>`).join(' ')}</div>`
            : '';
        const installPathMarkup = reference?.installPath
            ? `<span class="pill">Managed library: ${escapeHtml(reference.installPath)}</span>`
            : '';
        const metadataSourceMarkup = reference?.metadataSource
            ? `<span class="pill">Metadata: ${escapeHtml(formatMetadataSourceLabel(reference.metadataSource))}</span>`
            : '';
        const infoUrlMarkup = reference?.infoUrl
            ? `<span class="pill"><a href="${escapeHtml(reference.infoUrl)}">Docs</a></span>`
            : '';
        const categoryMarkup = reference?.category
            ? `<span class="pill">Category: ${escapeHtml(reference.category)}</span>`
            : '';
        const suppliedWithMarkup = reference?.suppliedWith
            ? `<span class="pill">Supplied with: ${escapeHtml(reference.suppliedWith)}</span>`
            : '';
        const summaryMarkup = reference?.summary
            ? `<div class="notice"><strong>Summary</strong><br />${escapeHtml(reference.summary)}</div>`
            : '';

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
            ${reference?.path ? `<span class="pill">Project: ${escapeHtml(path.basename(reference.path))}</span>` : ''}
            ${metadataSourceMarkup}
            ${categoryMarkup}
            ${suppliedWithMarkup}
            ${installPathMarkup}
            ${infoUrlMarkup}
        </div>
    </header>
    ${scopeNotice}
    ${summaryMarkup}
    ${dependencyMarkup}
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

    const openLibraryReferenceCommand = vscode.commands.registerCommand('tcview.openLibraryReference', async (item?: TwinCATFileTreeItem | vscode.Uri | string) => {
        if (!item) {
            vscode.window.showInformationMessage('TcView: Select a library reference from the TcView sidebar.');
            return;
        }
        const libraryName = (
            typeof item === 'string'
                ? item
                : item instanceof vscode.Uri
                    ? path.basename(item.fsPath, path.extname(item.fsPath))
                    : item.label?.toString()
        )?.trim();
        if (!libraryName) {
            vscode.window.showWarningMessage('TcView: Library reference name was not found.');
            return;
        }

        const aliases = new Set<string>([libraryName]);
        if (item instanceof TwinCATFileTreeItem) {
            const refData = item.xmlContent as { Include?: string | string[]; Namespace?: string | string[]; name?: string } | undefined;
            const include = Array.isArray(refData?.Include) ? refData?.Include[0] : refData?.Include;
            const namespaceValue = Array.isArray(refData?.Namespace) ? refData?.Namespace[0] : refData?.Namespace;
            if (typeof include === 'string' && include.trim()) {
                aliases.add(include.trim());
            }
            if (typeof namespaceValue === 'string' && namespaceValue.trim()) {
                aliases.add(namespaceValue.trim());
            }
            if (typeof refData?.name === 'string' && refData.name.trim()) {
                aliases.add(refData.name.trim());
            }
        }

        await ensureAnalyzerInitialized();
        const analyzer = getProjectAnalyzer();
        const revision = analyzer.getIndexRevision();
        let html = getCachedLibraryViewHtml(libraryName, revision);
        if (!html) {
            const api = analyzer.getLibraryApi(libraryName, [...aliases]);
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
    const refreshLibraryUi = () => {
        refreshOpenLibraryPanels();
        fileExplorerProvider.refresh();
    };
    const analyzerRefreshListener = onProjectAnalyzerCreated(analyzer => {
        activeAnalyzerRefreshDisposable?.dispose();
        activeAnalyzerRefreshDisposable = analyzer.onDidRefreshIndex(refreshLibraryUi);
    });

    const solutionWatcher = vscode.workspace.createFileSystemWatcher('**/*.sln');
    const tmcWatcher = vscode.workspace.createFileSystemWatcher('**/*.{tmc,plcproj,tsproj,tspproj,sln}');
    const solutionContextRefresh = () => {
        invalidateWorkspaceDiscoveryCaches();
        void refreshActiveSolutionContext();
    };
    const projectDiagnosticsRefresh = () => {
        invalidateWorkspaceDiscoveryCaches();
        void updateProjectDiagnostics();
    };
    solutionWatcher.onDidCreate(solutionContextRefresh);
    solutionWatcher.onDidDelete(solutionContextRefresh);
    solutionWatcher.onDidChange(solutionContextRefresh);
    tmcWatcher.onDidCreate(projectDiagnosticsRefresh);
    tmcWatcher.onDidDelete(projectDiagnosticsRefresh);
    tmcWatcher.onDidChange(projectDiagnosticsRefresh);
    const workspaceFolderChangeListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        invalidateWorkspaceDiscoveryCaches();
        fileExplorerProvider.setWorkspaceRoot(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined);
        void refreshActiveSolutionContext();
        void updateProjectDiagnostics();
    });

    // Helper function to open TwinCAT file
    async function openTwinCATFile(uri: vscode.Uri) {
        try {
            if (path.extname(uri.fsPath).toLowerCase() === '.library') {
                await vscode.commands.executeCommand('tcview.openLibraryReference', uri);
                return;
            }
            if (isInterfaceAccessorFragment(uri)) {
                vscode.window.showInformationMessage('Interface property GET/SET entries are listed for navigation only and cannot be opened.');
                return;
            }

            const fragment = uri.fragment;
            if (fragment) {
                const baseUri = uri.with({ fragment: '' });
                const virtualUri = await withPerfMetric('open.fragment.preload', () =>
                    fileSystemProvider.preloadFile(baseUri.fsPath, fragment)
                );

                const document = await withPerfMetric('open.fragment.document', () =>
                    vscode.workspace.openTextDocument(virtualUri)
                );
                await withPerfMetric('open.fragment.editor', () =>
                    vscode.window.showTextDocument(document, { preview: false })
                );

                await vscode.languages.setTextDocumentLanguage(document, 'iec-st');
            } else {
                // Regular file - preload and open
                const virtualUri = await withPerfMetric('open.file.preload', () =>
                    fileSystemProvider.preloadFile(uri.fsPath)
                );
                
                // Open the virtual file
                const document = await withPerfMetric('open.file.document', () =>
                    vscode.workspace.openTextDocument(virtualUri)
                );
                await withPerfMetric('open.file.editor', () =>
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
                await withPerfMetric('save.toOriginalXml', () => fileSystemProvider.saveToOriginal(document.uri));
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
        void updateProjectDiagnostics();
        void recoverRestoredTwincatTabs();
    }, 250);

    // Clean up on deactivate

    context.subscriptions.push(
        registration,
        fileExplorerProvider,
        webviewExplorerProvider,
        webviewRegistration,
        refreshCommand,
        treeDiagnosticsListener,
        openFileCommand,
        openFromExplorerCommand,
        switchToXmlCommand,
        showPerfStatsCommand,
        exportPerfBaselineCommand,
        exportPerfTraceCommand,
        openSolutionCommand,
        buildSolutionWithMsBuildCommand,
        openLibraryReferenceCommand,
        showLibrariesCommand,
        createLibraryMetadataTemplateCommand,
        importLibraryMetadataCommand,
        importLibraryProjectMetadataCommand,
        removeLibraryMetadataCommand,
        pruneUnusedLibraryMetadataCommand,
        installLibraryProjectCommand,
        createTwinCATFileCommand,
        createTwinCATFileFromTemplateCommand,
        deleteTwinCATFileCommand,
        createTwinCATFolderCommand,
        renameTwinCATItemCommand,
        deleteTwinCATFolderCommand,
        deleteTwinCATMemberCommand,
        copyTwinCATItemCommand,
        cutTwinCATItemCommand,
        pasteTwinCATItemCommand,
        createTwinCATMethodCommand,
        createTwinCATPropertyCommand,
        createTwinCATActionCommand,
        createTwinCATTransitionCommand,
        webExplorerStartRenameCommand,
        webExplorerStartCreateFolderCommand,
        webExplorerAddFunctionBlockCommand,
        webExplorerAddFunctionCommand,
        webExplorerAddProgramCommand,
        webExplorerAddGvlCommand,
        webExplorerAddDutCommand,
        webExplorerAddInterfaceCommand,
        deleteSelectedWebExplorerItemCommand,
        addLibraryReferenceCommand,
        removeLibraryReferenceCommand,
        analyzerRefreshListener,
        { dispose: () => activeAnalyzerRefreshDisposable?.dispose() },
        saveListener,
        openListener,
        solutionWatcher,
        tmcWatcher,
        workspaceFolderChangeListener,
        { dispose: () => clearTimeout(startupTasksTimer) },
        buildOutput,
        libraryOutput,
        buildDiagnostics,
        projectDiagnostics
    );




}

export function deactivate() {
    disposeProjectAnalyzer();
    analyzerInitPromise = undefined;
    disposeTelemetry();
}
