import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import { getProjectAnalyzer, initializeProjectAnalyzer } from './tcViewProjectAnalyzer';
import { TwinCATFileSystemProvider } from './tcViewFileSystemProvider';
import { withPerfMetric } from './tcViewTelemetry';

export enum TwinCATItemType {
    StatusInfo = 'statusInfo',
    StatusWarning = 'statusWarning',
    SystemRoot = 'systemRoot',
    PlcRoot = 'plcRoot',
    IoRoot = 'ioRoot',
    ReferencesRoot = 'referencesRoot',
    ReferenceItem = 'referenceItem',
    Folder = 'folder',
    PlcProjectFolder = 'plcProjectFolder',
    File = 'file',
    POUFolder = 'pouFolder',
    Method = 'method',
    Property = 'property',
    PropertyGet = 'propertyGet',
    PropertySet = 'propertySet',
    Action = 'action',
    Transition = 'transition'
}

// -----------------------------------------------------
// Utilities
// -----------------------------------------------------

const OPENABLE_TYPES = new Set<TwinCATItemType>([
    TwinCATItemType.File,
    TwinCATItemType.Method,
    TwinCATItemType.Property,
    TwinCATItemType.PropertyGet,
    TwinCATItemType.PropertySet,
    TwinCATItemType.Action,
    TwinCATItemType.Transition
]);

const TREE_FILE_EXTENSIONS = new Set([
    '.tcpou',
    '.tcprg',
    '.tcapp',
    '.tccom',
    '.tcgvl',
    '.tcdut',
    '.tcvar',
    '.tcgds',
    '.tcio',
    '.tcitf'
]);

const EXPANDABLE_POU_EXTENSIONS = new Set([
    '.tcpou',
    '.tcprg',
    '.tcapp',
    '.tccom',
    '.tcio',
    '.tcitf'
]);

const SOLUTION_PROJECT_EXTENSIONS = ['.tsproj', '.tspproj'];

const toArray = <T>(value: T | T[] | undefined): T[] =>
    Array.isArray(value) ? value : value ? [value] : [];

const extractText = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
        return extractText(value[0]);
    }
    if (value === undefined || value === null) {
        return undefined;
    }

    const text = value.toString().trim();
    return text.length > 0 ? text : undefined;
};

const sortItems = (items: TwinCATFileTreeItem[]) =>
    items.sort((a, b) =>
        (a.label?.toString() || '').localeCompare(b.label?.toString() || '')
    );

const collapsibleState = (hasChildren: boolean) =>
    hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

type TwinCATFileKind = 'pou' | 'program' | 'gvl' | 'dut' | 'interface' | 'io' | 'var' | 'gds' | 'other';

const getTwinCATFileKind = (filePath: string): TwinCATFileKind => {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.tcpou':
        case '.tcapp':
        case '.tccom':
            return 'pou';
        case '.tcprg':
            return 'program';
        case '.tcgvl':
            return 'gvl';
        case '.tcdut':
            return 'dut';
        case '.tcitf':
            return 'interface';
        case '.tcio':
            return 'interface';
        case '.tcvar':
            return 'var';
        case '.tcgds':
            return 'gds';
        default:
            return 'other';
    }
};

const getTwinCATFileKindLabel = (filePath: string): string | undefined => {
    const kind = getTwinCATFileKind(filePath);
    switch (kind) {
        case 'pou':
            return 'POU';
        case 'program':
            return 'PROGRAM';
        case 'gvl':
            return 'GVL';
        case 'dut':
            return 'DUT';
        case 'interface':
            return 'INTERFACE';
        case 'io':
            return 'I/O';
        case 'var':
            return 'VAR';
        case 'gds':
            return 'GDS';
        default:
            return undefined;
    }
};

const mapPouTypeLabel = (rawType: string): string | undefined => {
    switch (rawType.replace(/\s+/g, '_').toUpperCase()) {
        case 'FUNCTION_BLOCK':
        case 'FUNCTIONBLOCK':
            return 'FB';
        case 'FUNCTION':
            return 'FUN';
        case 'PROGRAM':
            return 'PRG';
        default:
            return undefined;
    }
};

const TREE_ICON_COLOR = {
    folder: 'charts.orange',
    plcRoot: 'charts.blue',
    plcProject: 'terminal.ansiCyan',
    folderMembers: 'charts.orange',
    pou: 'terminal.ansiBrightBlue',
    program: 'charts.green',
    gvl: 'charts.green',
    dut: 'charts.purple',
    interface: 'terminal.ansiBrightMagenta',
    io: 'charts.green',
    variable: 'charts.yellow',
    array: 'charts.purple',
    reference: 'charts.purple',
    library: 'terminal.ansiCyan',
    info: 'charts.blue',
    warning: 'problemsWarningIcon.foreground',
    system: 'charts.purple',
    method: 'charts.purple',
    property: 'charts.red',
    propertyGet: 'charts.green',
    propertySet: 'charts.blue',
    action: 'charts.green',
    transition: 'terminal.ansiYellow'
} as const;

type DiagnosticBreadcrumb = {
    errors: number;
    warnings: number;
};

const EMPTY_DIAGNOSTIC_BREADCRUMB: DiagnosticBreadcrumb = {
    errors: 0,
    warnings: 0
};

const combineDiagnosticBreadcrumb = (
    left: DiagnosticBreadcrumb,
    right: DiagnosticBreadcrumb
): DiagnosticBreadcrumb => ({
    errors: left.errors + right.errors,
    warnings: left.warnings + right.warnings
});

const summarizeDiagnostics = (diagnostics: readonly vscode.Diagnostic[]): DiagnosticBreadcrumb => {
    let errors = 0;
    let warnings = 0;

    for (const diagnostic of diagnostics) {
        if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
            errors += 1;
        } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
            warnings += 1;
        }
    }

    return { errors, warnings };
};

const PROBLEM_ERROR_COLOR = 'problemsErrorIcon.foreground';
const PROBLEM_WARNING_COLOR = 'problemsWarningIcon.foreground';

const formatDiagnosticTooltip = (summary: DiagnosticBreadcrumb | undefined): string | undefined => {
    if (!summary || (summary.errors === 0 && summary.warnings === 0)) {
        return undefined;
    }

    const parts: string[] = [];
    if (summary.errors > 0) {
        parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
    }
    if (summary.warnings > 0) {
        parts.push(`${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`);
    }
    return parts.join(', ');
};

const formatDiagnosticBadge = (summary: DiagnosticBreadcrumb | undefined): string | undefined => {
    if (!summary || (summary.errors === 0 && summary.warnings === 0)) {
        return undefined;
    }

    const parts: string[] = [];
    if (summary.errors > 0) {
        parts.push(`[x${summary.errors}]`);
    }
    if (summary.warnings > 0) {
        parts.push(`[!${summary.warnings}]`);
    }
    return parts.join(' ');
};

type ThemeIconSpec = {
    id: string;
    colorId?: string;
};

const getProblemColorId = (summary: DiagnosticBreadcrumb | undefined): string | undefined => {
    if (!summary) {
        return undefined;
    }
    if (summary.errors > 0) {
        return PROBLEM_ERROR_COLOR;
    }
    if (summary.warnings > 0) {
        return PROBLEM_WARNING_COLOR;
    }
    return undefined;
};

const toThemeIcon = (spec: ThemeIconSpec, overrideColorId?: string): vscode.ThemeIcon =>
    overrideColorId || spec.colorId
        ? new vscode.ThemeIcon(spec.id, new vscode.ThemeColor(overrideColorId || spec.colorId!))
        : new vscode.ThemeIcon(spec.id);

const getTwinCATFileKindIconSpec = (filePath: string): ThemeIconSpec => {
    const kind = getTwinCATFileKind(filePath);
    switch (kind) {
        case 'pou':
            return { id: 'symbol-class', colorId: TREE_ICON_COLOR.pou };
        case 'program':
            return { id: 'symbol-method', colorId: TREE_ICON_COLOR.program };
        case 'gvl':
            return { id: 'symbol-variable', colorId: TREE_ICON_COLOR.gvl };
        case 'dut':
            return { id: 'symbol-struct', colorId: TREE_ICON_COLOR.dut };
        case 'interface':
            return { id: 'type-hierarchy-super', colorId: TREE_ICON_COLOR.interface };
        case 'io':
            return { id: 'plug', colorId: TREE_ICON_COLOR.io };
        case 'var':
            return { id: 'symbol-field', colorId: TREE_ICON_COLOR.variable };
        case 'gds':
            return { id: 'symbol-array', colorId: TREE_ICON_COLOR.array };
        default:
            return { id: 'file-code' };
    }
};

const getTwinCATFileKindIcon = (filePath: string, summary?: DiagnosticBreadcrumb): vscode.ThemeIcon =>
    toThemeIcon(getTwinCATFileKindIconSpec(filePath), getProblemColorId(summary));

const getExplorerSortWeight = (item: TwinCATFileTreeItem): number => {
    if (item.itemType === TwinCATItemType.PlcProjectFolder) {
        return 0;
    }
    if (item.itemType === TwinCATItemType.Folder) {
        return 1;
    }
    if (item.itemType !== TwinCATItemType.File) {
        return 9;
    }

    const kind = getTwinCATFileKind(item.targetUri.fsPath);
    switch (kind) {
        case 'gvl':
            return 2;
        case 'dut':
            return 3;
        case 'interface':
            return 4;
        case 'program':
            return 5;
        case 'pou':
            return 6;
        case 'io':
            return 7;
        case 'var':
        case 'gds':
        case 'other':
        default:
            return 8;
    }
};

const sortExplorerItems = (items: TwinCATFileTreeItem[]) =>
    items.sort((a, b) => {
        const byWeight = getExplorerSortWeight(a) - getExplorerSortWeight(b);
        if (byWeight !== 0) {
            return byWeight;
        }
        return (a.label?.toString() || '').localeCompare(b.label?.toString() || '');
    });

// -----------------------------------------------------
// Tree Item
// -----------------------------------------------------

export class TwinCATFileTreeItem extends vscode.TreeItem {
    private readonly baseLabel: string;
    private readonly baseTooltip: string;
    private baseDescription?: string;

    constructor(
        public readonly targetUri: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: TwinCATItemType,
        public readonly parentPath?: string,
        public readonly xmlContent?: any,
        customLabel?: string,
        isOpenable = OPENABLE_TYPES.has(itemType)
    ) {
        super(customLabel ?? TwinCATFileTreeItem.getLabel(targetUri, itemType));

        this.baseLabel = customLabel ?? TwinCATFileTreeItem.getLabel(targetUri, itemType);
        this.label = this.baseLabel;
        this.id = `${itemType}:${targetUri.toString()}`;
        this.baseTooltip = targetUri.fsPath;
        this.tooltip = this.baseTooltip;
        this.contextValue = itemType;
        this.setIcon();

        if (isOpenable) {
            this.command = {
                command: 'tcview.openFile',
                title: 'Open in TcView',
                arguments: [this]
            };
        } else if (itemType === TwinCATItemType.ReferenceItem) {
            this.command = {
                command: 'tcview.openLibraryReference',
                title: 'Open TwinCAT Library Reference',
                arguments: [this]
            };
        }
    }

    setDescriptionText(description?: string) {
        this.baseDescription = description;
        this.description = description;
    }

    applyDiagnosticState(summary?: DiagnosticBreadcrumb) {
        const tooltip = formatDiagnosticTooltip(summary);
        this.tooltip = tooltip
            ? `${this.baseTooltip}\nProblems: ${tooltip}`
            : this.baseTooltip;
        const badge = formatDiagnosticBadge(summary);
        this.description = this.baseDescription;
        this.label = badge ? `${this.baseLabel} ${badge}` : this.baseLabel;
        this.setIcon(summary);
    }

    private static getLabel(uri: vscode.Uri, type: TwinCATItemType): string {
        if (type === TwinCATItemType.File) {
            const ext = path.extname(uri.fsPath);
            return path.basename(uri.fsPath, ext);
        }

        if (
            type === TwinCATItemType.Folder ||
            type === TwinCATItemType.PlcProjectFolder ||
            type === TwinCATItemType.StatusInfo ||
            type === TwinCATItemType.StatusWarning ||
            type === TwinCATItemType.SystemRoot ||
            type === TwinCATItemType.PlcRoot ||
            type === TwinCATItemType.IoRoot ||
            type === TwinCATItemType.ReferencesRoot ||
            type === TwinCATItemType.ReferenceItem
        ) {
            return path.basename(uri.fsPath);
        }

        if (uri.fragment) {
            const [, name] = uri.fragment.split(':');
            return name || uri.fragment;
        }

        return path.basename(uri.fsPath);
    }

    private getBaseIconSpec(): ThemeIconSpec {
        if (this.itemType === TwinCATItemType.File) {
            return getTwinCATFileKindIconSpec(this.targetUri.fsPath);
        }

        const iconMap: Record<TwinCATItemType, ThemeIconSpec> = {
            statusInfo: { id: 'search', colorId: TREE_ICON_COLOR.info },
            statusWarning: { id: 'warning', colorId: TREE_ICON_COLOR.warning },
            systemRoot: { id: 'server-environment', colorId: TREE_ICON_COLOR.system },
            plcRoot: { id: 'circuit-board', colorId: TREE_ICON_COLOR.plcRoot },
            ioRoot: { id: 'plug', colorId: TREE_ICON_COLOR.io },
            referencesRoot: { id: 'references', colorId: TREE_ICON_COLOR.reference },
            referenceItem: { id: 'library', colorId: TREE_ICON_COLOR.library },
            folder: { id: 'folder', colorId: TREE_ICON_COLOR.folder },
            plcProjectFolder: { id: 'circuit-board', colorId: TREE_ICON_COLOR.plcProject },
            pouFolder: { id: 'folder', colorId: TREE_ICON_COLOR.folderMembers },
            file: { id: 'file-code' },
            method: { id: 'symbol-method', colorId: TREE_ICON_COLOR.method },
            property: { id: 'symbol-property', colorId: TREE_ICON_COLOR.property },
            propertyGet: { id: 'arrow-circle-down', colorId: TREE_ICON_COLOR.propertyGet },
            propertySet: { id: 'arrow-circle-up', colorId: TREE_ICON_COLOR.propertySet },
            action: { id: 'symbol-event', colorId: TREE_ICON_COLOR.action },
            transition: { id: 'symbol-interface', colorId: TREE_ICON_COLOR.transition }
        };

        return iconMap[this.itemType];
    }

    private setIcon(summary?: DiagnosticBreadcrumb) {
        const problemColorId = getProblemColorId(summary);
        if (problemColorId) {
            this.iconPath = new vscode.ThemeIcon(
                summary && summary.errors > 0 ? 'error' : 'warning',
                new vscode.ThemeColor(problemColorId)
            );
            return;
        }

        if (this.itemType === TwinCATItemType.File) {
            this.iconPath = getTwinCATFileKindIcon(this.targetUri.fsPath, summary);
            return;
        }

        this.iconPath = toThemeIcon(this.getBaseIconSpec());
    }
}

// -----------------------------------------------------
// Provider
// -----------------------------------------------------

export class TwinCATFileExplorerProvider
    implements vscode.TreeDataProvider<TwinCATFileTreeItem>
{
    private _onDidChangeTreeData =
        new vscode.EventEmitter<TwinCATFileTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private parsedPOUCache = new Map<string, any>();
    private projectMetadataXmlCache = new Map<string, { mtimeMs: number; xml: any }>();
    private directoryEntriesCache = new Map<string, { mtimeMs: number; entries: fs.Dirent[] }>();
    private folderChildrenCache = new Map<string, TwinCATFileTreeItem[]>();
    private plcReferencesCache = new Map<string, TwinCATFileTreeItem[]>();
    private topLevelGroupsCache: { system: TwinCATFileTreeItem[]; plc: TwinCATFileTreeItem[]; io: TwinCATFileTreeItem[] } | undefined;
    private discoveryState: 'booting' | 'loading' | 'ready' | 'empty' = 'booting';
    private rootIdentifiers: { hasTwinCATFiles: boolean; tsprojPath?: string; slnPath?: string; plcprojPath?: string } | undefined;
    private tsprojStructure: { plcFolderPaths: Set<string>; hasSystem: boolean; ioFolderPaths: Set<string> } | undefined;
    private contentRoot?: string;
    private fileWatcher?: vscode.FileSystemWatcher;
    private refreshTimer: NodeJS.Timeout | undefined;
    private pendingStructuralRefresh = false;
    private hasActiveSolution = false;
    private discoveryStarted = false;
    private diagnosticSummaryCache = new Map<string, DiagnosticBreadcrumb>();
    private diagnosticFileSummaryCache: Map<string, DiagnosticBreadcrumb> | undefined;

    constructor(
        private workspaceRoot?: string,
        private readonly onDiscoveryStateChanged?: (state: { hasTwinCATFiles: boolean; isLoading: boolean; discoveryComplete: boolean }) => void
    ) {
    }

    setWorkspaceRoot(workspaceRoot?: string) {
        if (this.workspaceRoot === workspaceRoot) {
            return;
        }

        this.workspaceRoot = workspaceRoot;
        this.parsedPOUCache.clear();
        this.projectMetadataXmlCache.clear();
        this.directoryEntriesCache.clear();
        this.discoveryStarted = false;
        this.setDiscoveryState('booting');
        this.fileWatcher?.dispose();
        this.fileWatcher = undefined;
        this.refresh();
    }

    setHasActiveSolution(hasActiveSolution: boolean) {
        if (this.hasActiveSolution === hasActiveSolution) {
            return;
        }

        this.hasActiveSolution = hasActiveSolution;
        this.refresh();
    }

    handleDiagnosticsChanged() {
        this.clearDiagnosticSummaryCaches();
        this.notifyContentRefresh();
    }

    refresh() {
        this.folderChildrenCache.clear();
        this.plcReferencesCache.clear();
        this.topLevelGroupsCache = undefined;
        this._onDidChangeTreeData.fire(undefined);
    }

    private notifyContentRefresh() {
        this._onDidChangeTreeData.fire(undefined);
    }

    private clearDiagnosticSummaryCaches() {
        this.diagnosticSummaryCache.clear();
        this.diagnosticFileSummaryCache = undefined;
    }

    private scheduleRefresh(structural = true, delayMs = 150) {
        this.pendingStructuralRefresh = this.pendingStructuralRefresh || structural;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }

        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            const shouldRunStructuralRefresh = this.pendingStructuralRefresh;
            this.pendingStructuralRefresh = false;
            if (shouldRunStructuralRefresh) {
                this.refresh();
                return;
            }
            this.notifyContentRefresh();
        }, delayMs);
    }

    private ensureDiscoveryStarted() {
        if (this.discoveryStarted) {
            return;
        }
        this.discoveryStarted = true;
        this.setupWatcher();
        void this.beginDiscovery();
    }

    getTreeItem(element: TwinCATFileTreeItem) {
        this.applyDiagnosticState(element);
        return element;
    }

    async getChildren(element?: TwinCATFileTreeItem) {
        this.ensureDiscoveryStarted();

        if (!element) {
            const items: TwinCATFileTreeItem[] = [];

            if (this.discoveryState === 'booting') {
                const bootingItem = new TwinCATFileTreeItem(
                    vscode.Uri.file('Loading TcView'),
                    vscode.TreeItemCollapsibleState.None,
                    TwinCATItemType.StatusInfo,
                    undefined,
                    undefined,
                    'Loading TcView...'
                );
                bootingItem.tooltip = 'TcView is initializing.';
                return [bootingItem];
            }

            if (this.discoveryState === 'loading') {
                const loadingItem = new TwinCATFileTreeItem(
                    vscode.Uri.file('Looking for TwinCAT files'),
                    vscode.TreeItemCollapsibleState.None,
                    TwinCATItemType.StatusInfo,
                    undefined,
                    undefined,
                    'Looking for TwinCAT files'
                );
                loadingItem.tooltip = 'TcView is scanning the current workspace for TwinCAT solution and project identifiers.';
                return [loadingItem];
            }

            if (this.workspaceRoot && this.discoveryState === 'ready' && !this.hasActiveSolution) {
                const warningItem = new TwinCATFileTreeItem(
                    vscode.Uri.file('Not a project solution, view/edit files only'),
                    vscode.TreeItemCollapsibleState.None,
                    TwinCATItemType.StatusWarning,
                    undefined,
                    undefined,
                    'Not a project solution, view/edit files only'
                );
                warningItem.setDescriptionText('Build features are unavailable');
                warningItem.tooltip = 'TcView did not detect an open TwinCAT project solution in this workspace. View and edit features remain available.';
                items.push(warningItem);
            }

            if (!this.contentRoot || this.discoveryState === 'empty') {
                return items;
            }

            const [systemItems, plcItems, ioItems] = await Promise.all([
                this.getTopLevelGroupContents('system'),
                this.getTopLevelGroupContents('plc'),
                this.getTopLevelGroupContents('io')
            ]);

            const groupItems: TwinCATFileTreeItem[] = [];
            const isSolutionLikeRoot = !!(this.rootIdentifiers?.slnPath || this.rootIdentifiers?.tsprojPath);
            const isStandalonePlcRoot = !!(!this.rootIdentifiers?.slnPath && !this.rootIdentifiers?.tsprojPath && this.rootIdentifiers?.plcprojPath);

            if (isSolutionLikeRoot) {
                groupItems.push(new TwinCATFileTreeItem(
                    vscode.Uri.file(path.join(this.contentRoot, 'SYSTEM')),
                    vscode.TreeItemCollapsibleState.Expanded,
                    TwinCATItemType.SystemRoot,
                    undefined,
                    undefined,
                    'SYSTEM'
                ));
            }
            if (isSolutionLikeRoot || isStandalonePlcRoot || plcItems.length > 0) {
                groupItems.push(new TwinCATFileTreeItem(
                    vscode.Uri.file(path.join(this.contentRoot, 'PLC')),
                    vscode.TreeItemCollapsibleState.Expanded,
                    TwinCATItemType.PlcRoot,
                    undefined,
                    undefined,
                    'PLC'
                ));
            }
            if (isSolutionLikeRoot) {
                groupItems.push(new TwinCATFileTreeItem(
                    vscode.Uri.file(path.join(this.contentRoot, 'I-O')),
                    vscode.TreeItemCollapsibleState.Expanded,
                    TwinCATItemType.IoRoot,
                    undefined,
                    undefined,
                    'I/O'
                ));
            }

            return items.concat(groupItems);
        }

        if (element.itemType === TwinCATItemType.StatusInfo || element.itemType === TwinCATItemType.StatusWarning) {
            return [];
        }

        switch (element.itemType) {
            case TwinCATItemType.SystemRoot:
                return this.getTopLevelGroupContents('system');

            case TwinCATItemType.PlcRoot:
                return this.getTopLevelGroupContents('plc');

            case TwinCATItemType.IoRoot:
                return this.getTopLevelGroupContents('io');

            case TwinCATItemType.Folder:
                return this.getFolderContents(element.targetUri.fsPath);

            case TwinCATItemType.PlcProjectFolder:
                return this.getPlcProjectFolderContents(element.targetUri.fsPath);

            case TwinCATItemType.ReferencesRoot:
                return element.xmlContent || [];

            case TwinCATItemType.File:
                return this.isExpandablePOUFile(element.targetUri.fsPath)
                    ? this.getStructuredRootChildren(element.targetUri)
                    : [];

            case TwinCATItemType.POUFolder:
                return element.xmlContent || [];

            case TwinCATItemType.Property:
                return this.getPropertyChildren(element);

            default:
                return [];
        }
    }

    // -------------------------------------------------
    // Filesystem
    // -------------------------------------------------

    private isHiddenOrExcluded(name: string) {
        return name.startsWith('.') || name.startsWith('_');
    }

    private getMetadataCacheKey(filePath: string) {
        return path.normalize(filePath).toLowerCase();
    }

    private getDirectoryCacheKey(folderPath: string) {
        return path.normalize(folderPath).toLowerCase();
    }

    private async getDirectoryEntries(folderPath: string): Promise<fs.Dirent[] | undefined> {
        const key = this.getDirectoryCacheKey(folderPath);
        try {
            const stat = await fs.promises.stat(folderPath);
            const cached = this.directoryEntriesCache.get(key);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                return cached.entries;
            }

            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
            this.directoryEntriesCache.set(key, { mtimeMs: stat.mtimeMs, entries });
            return entries;
        } catch {
            this.directoryEntriesCache.delete(key);
            return undefined;
        }
    }

    private async getProjectMetadataXml(filePath: string): Promise<any | undefined> {
        const key = this.getMetadataCacheKey(filePath);
        try {
            const stat = await fs.promises.stat(filePath);
            const cached = this.projectMetadataXmlCache.get(key);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                return cached.xml;
            }

            const content = await fs.promises.readFile(filePath, 'utf8');
            const parser = new xml2js.Parser({
                explicitArray: true,
                mergeAttrs: true
            });
            const xml = await parser.parseStringPromise(content);
            this.projectMetadataXmlCache.set(key, { mtimeMs: stat.mtimeMs, xml });
            return xml;
        } catch {
            this.projectMetadataXmlCache.delete(key);
            return undefined;
        }
    }

    private invalidateMetadataCaches(filePath: string) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.plcproj') {
            this.plcReferencesCache.delete(this.getMetadataCacheKey(filePath));
        }

        if (ext === '.plcproj' || ext === '.tsproj' || ext === '.tspproj') {
            this.projectMetadataXmlCache.delete(this.getMetadataCacheKey(filePath));
            if (ext === '.tsproj' || ext === '.tspproj') {
                this.tsprojStructure = undefined;
            }
        }
    }

    private invalidateDirectoryCachesForPath(filePath: string) {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : this.contentRoot
                ? path.join(this.contentRoot, filePath)
                : filePath;
        const parent = path.dirname(absolutePath);
        this.directoryEntriesCache.delete(this.getDirectoryCacheKey(parent));
    }

    private setDiscoveryState(state: 'booting' | 'loading' | 'ready' | 'empty') {
        this.discoveryState = state;
        this.onDiscoveryStateChanged?.({
            hasTwinCATFiles: state === 'ready',
            isLoading: state === 'booting' || state === 'loading',
            discoveryComplete: state === 'ready' || state === 'empty'
        });
    }

    private async beginDiscovery() {
        this.folderChildrenCache.clear();
        this.plcReferencesCache.clear();
        this.topLevelGroupsCache = undefined;
        this.clearDiagnosticSummaryCaches();
        this.rootIdentifiers = undefined;
        this.tsprojStructure = undefined;
        this.contentRoot = undefined;

        if (!this.workspaceRoot) {
            this.setDiscoveryState('empty');
            this.refresh();
            return;
        }

        this.setDiscoveryState('loading');
        this.refresh();

        const resolvedRoot = await withPerfMetric('tree.discovery.resolveRoot', () => this.resolveTwinCATRoot(this.workspaceRoot!));
        if (!resolvedRoot) {
            this.setDiscoveryState('empty');
            this.refresh();
            return;
        }

        this.contentRoot = resolvedRoot.folderPath;
        this.rootIdentifiers = resolvedRoot.identifiers;

        if (resolvedRoot.identifiers.tsprojPath) {
            this.tsprojStructure = await withPerfMetric('tree.discovery.parseTsproj', () => this.parseTsprojStructure(resolvedRoot.identifiers.tsprojPath!));
        }

        this.setDiscoveryState('ready');
        this.refresh();
    }

    private async resolveTwinCATRoot(
        folderPath: string,
        depth = 2
    ): Promise<{ folderPath: string; identifiers: { hasTwinCATFiles: boolean; tsprojPath?: string; slnPath?: string; plcprojPath?: string } } | undefined> {
        const markerResolved = await this.resolveTwinCATRootFromWorkspaceMarkers(folderPath, depth);
        if (markerResolved) {
            return markerResolved;
        }

        const identifiers = await this.findTwinCATIdentifiers(folderPath);
        if (identifiers.hasTwinCATFiles) {
            return { folderPath, identifiers };
        }

        if (depth <= 0) {
            return undefined;
        }

        const entries = await this.getDirectoryEntries(folderPath);
        if (!entries) {
            return undefined;
        }

        const childDirs = entries
            .filter(entry => entry.isDirectory() && !this.isHiddenOrExcluded(entry.name))
            .map(entry => path.join(folderPath, entry.name))
            .sort((a, b) => a.localeCompare(b));

        for (const childDir of childDirs) {
            const resolved = await this.resolveTwinCATRoot(childDir, depth - 1);
            if (resolved) {
                return resolved;
            }
        }

        return undefined;
    }

    private async resolveTwinCATRootFromWorkspaceMarkers(
        folderPath: string,
        depth: number
    ): Promise<{ folderPath: string; identifiers: { hasTwinCATFiles: boolean; tsprojPath?: string; slnPath?: string; plcprojPath?: string } } | undefined> {
        const workspaceRoot = this.workspaceRoot;
        if (!workspaceRoot || path.normalize(folderPath) !== path.normalize(workspaceRoot)) {
            return undefined;
        }

        try {
            const markerUris = await vscode.workspace.findFiles('**/*.{sln,tsproj,tspproj,plcproj}', '**/{node_modules,.git}/**', 400);
            const rootLower = workspaceRoot.toLowerCase();
            const byFolder = new Map<string, { slnPath?: string; tsprojPath?: string; plcprojPath?: string }>();

            for (const uri of markerUris) {
                const markerPath = uri.fsPath;
                if (!markerPath.toLowerCase().startsWith(rootLower)) {
                    continue;
                }

                const relativeFolder = path.relative(workspaceRoot, path.dirname(markerPath));
                const segmentDepth = relativeFolder ? relativeFolder.split(path.sep).length : 0;
                if (segmentDepth > depth) {
                    continue;
                }

                const folderKey = path.normalize(path.dirname(markerPath));
                const entry = byFolder.get(folderKey) ?? {};
                const lowerExt = path.extname(markerPath).toLowerCase();
                if (lowerExt === '.sln') {
                    entry.slnPath = markerPath;
                } else if (lowerExt === '.tsproj' || lowerExt === '.tspproj') {
                    entry.tsprojPath = markerPath;
                } else if (lowerExt === '.plcproj') {
                    entry.plcprojPath = markerPath;
                }
                byFolder.set(folderKey, entry);
            }

            const candidates = [...byFolder.entries()]
                .map(([candidateFolder, markers]) => ({
                    folderPath: candidateFolder,
                    depth: path.relative(workspaceRoot, candidateFolder).split(path.sep).filter(Boolean).length,
                    identifiers: {
                        hasTwinCATFiles: !!((markers.slnPath && markers.tsprojPath) || markers.plcprojPath),
                        slnPath: markers.slnPath,
                        tsprojPath: markers.tsprojPath,
                        plcprojPath: markers.plcprojPath
                    }
                }))
                .filter(candidate => candidate.identifiers.hasTwinCATFiles)
                .sort((a, b) => {
                    const byDepth = a.depth - b.depth;
                    if (byDepth !== 0) {
                        return byDepth;
                    }
                    return a.folderPath.localeCompare(b.folderPath);
                });

            const best = candidates[0];
            return best
                ? { folderPath: best.folderPath, identifiers: best.identifiers }
                : undefined;
        } catch {
            return undefined;
        }
    }

    private async findTwinCATIdentifiers(folderPath: string): Promise<{ hasTwinCATFiles: boolean; tsprojPath?: string; slnPath?: string; plcprojPath?: string }> {
        const entries = await this.getDirectoryEntries(folderPath);
        if (!entries) {
            return { hasTwinCATFiles: false };
        }

        const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
        const slnPath = files.find(name => name.toLowerCase().endsWith('.sln'));
        // Treat .tspproj as equivalent to .tsproj for TwinCAT solution detection.
        const tsprojPath = files.find(name =>
            SOLUTION_PROJECT_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension))
        );
        const plcprojPath = files.find(name => name.toLowerCase().endsWith('.plcproj'));
        const isTwinCATSolution = !!(slnPath && tsprojPath);
        const isStandalonePlcProject = !!plcprojPath;
        return {
            hasTwinCATFiles: isTwinCATSolution || isStandalonePlcProject,
            slnPath: isTwinCATSolution && slnPath ? path.join(folderPath, slnPath) : undefined,
            tsprojPath: tsprojPath ? path.join(folderPath, tsprojPath) : undefined,
            plcprojPath: plcprojPath ? path.join(folderPath, plcprojPath) : undefined
        };
    }

    private async parseTsprojStructure(tsprojPath: string): Promise<{ plcFolderPaths: Set<string>; hasSystem: boolean; ioFolderPaths: Set<string> }> {
        try {
            const xml = await this.getProjectMetadataXml(tsprojPath);
            if (!xml) {
                return {
                    plcFolderPaths: new Set<string>(),
                    hasSystem: false,
                    ioFolderPaths: new Set<string>()
                };
            }
            const projectRoot = xml.TcSmProject?.Project?.[0];
            const plcProjects = toArray(projectRoot?.Plc?.[0]?.Project);
            const plcFolderPaths = new Set<string>();
            for (const plcProject of plcProjects) {
                const prjFilePath = plcProject?.PrjFilePath?.toString();
                if (!prjFilePath) continue;
                plcFolderPaths.add(path.normalize(path.join(path.dirname(tsprojPath), path.dirname(prjFilePath))));
            }

            const ioFolderPaths = new Set<string>();
            const deviceNodes = [
                ...toArray(projectRoot?.Io),
                ...toArray(projectRoot?.Device),
                ...toArray(projectRoot?.Devices)
            ];
            for (const deviceNode of deviceNodes) {
                const filePath = deviceNode?.FilePath?.toString?.();
                if (!filePath) continue;
                ioFolderPaths.add(path.normalize(path.join(path.dirname(tsprojPath), path.dirname(filePath))));
            }

            return {
                plcFolderPaths,
                hasSystem: !!projectRoot?.System,
                ioFolderPaths
            };
        } catch {
            return {
                plcFolderPaths: new Set<string>(),
                hasSystem: false,
                ioFolderPaths: new Set<string>()
            };
        }
    }

    private isIoLikeEntry(name: string) {
        const lower = name.toLowerCase();
        return lower === 'io' || lower === 'i_o' || lower === 'i-o';
    }

    private applyDiagnosticState(item: TwinCATFileTreeItem) {
        switch (item.itemType) {
            case TwinCATItemType.File:
            case TwinCATItemType.Folder:
            case TwinCATItemType.PlcProjectFolder:
            case TwinCATItemType.SystemRoot:
            case TwinCATItemType.PlcRoot:
            case TwinCATItemType.IoRoot:
                item.applyDiagnosticState(this.getDiagnosticBreadcrumb(item.itemType, item.targetUri.fsPath));
                return;
            default:
                item.applyDiagnosticState(undefined);
        }
    }

    private getDiagnosticBreadcrumb(itemType: TwinCATItemType, targetPath: string): DiagnosticBreadcrumb {
        const cacheKey = `${itemType}:${this.getMetadataCacheKey(targetPath)}`;
        const cached = this.diagnosticSummaryCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        let summary = EMPTY_DIAGNOSTIC_BREADCRUMB;
        switch (itemType) {
            case TwinCATItemType.File:
                summary = this.getDiagnosticBreadcrumbForFile(targetPath);
                break;
            case TwinCATItemType.Folder:
            case TwinCATItemType.PlcProjectFolder:
                summary = this.getDiagnosticBreadcrumbForFolder(targetPath);
                break;
            case TwinCATItemType.SystemRoot:
                summary = this.getDiagnosticBreadcrumbForGroup('system');
                break;
            case TwinCATItemType.PlcRoot:
                summary = this.getDiagnosticBreadcrumbForGroup('plc');
                break;
            case TwinCATItemType.IoRoot:
                summary = this.getDiagnosticBreadcrumbForGroup('io');
                break;
        }

        this.diagnosticSummaryCache.set(cacheKey, summary);
        return summary;
    }

    private getDiagnosticFileSummaryMap(): Map<string, DiagnosticBreadcrumb> {
        if (this.diagnosticFileSummaryCache) {
            return this.diagnosticFileSummaryCache;
        }

        const fileSummaryMap = new Map<string, DiagnosticBreadcrumb>();
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
            let targetPath: string | undefined;
            if (uri.scheme === 'file') {
                targetPath = uri.fsPath;
            } else if (uri.scheme === TwinCATFileSystemProvider.scheme) {
                targetPath = TwinCATFileSystemProvider.getOriginalPath(uri);
            }
            if (!targetPath) {
                continue;
            }

            const summary = summarizeDiagnostics(diagnostics);
            if (summary.errors === 0 && summary.warnings === 0) {
                continue;
            }

            const key = this.getMetadataCacheKey(targetPath);
            const existing = fileSummaryMap.get(key) || EMPTY_DIAGNOSTIC_BREADCRUMB;
            fileSummaryMap.set(key, combineDiagnosticBreadcrumb(existing, summary));
        }

        this.diagnosticFileSummaryCache = fileSummaryMap;
        return fileSummaryMap;
    }

    private getDiagnosticBreadcrumbForFile(filePath: string): DiagnosticBreadcrumb {
        return this.getDiagnosticFileSummaryMap().get(this.getMetadataCacheKey(filePath)) || EMPTY_DIAGNOSTIC_BREADCRUMB;
    }

    private getDiagnosticBreadcrumbForFolder(folderPath: string): DiagnosticBreadcrumb {
        const normalizedFolderPath = this.getMetadataCacheKey(folderPath);
        const folderPrefix = `${normalizedFolderPath}${path.sep}`;
        let summary = EMPTY_DIAGNOSTIC_BREADCRUMB;

        for (const [filePath, fileSummary] of this.getDiagnosticFileSummaryMap()) {
            if (filePath === normalizedFolderPath || filePath.startsWith(folderPrefix)) {
                summary = combineDiagnosticBreadcrumb(summary, fileSummary);
            }
        }

        return summary;
    }

    private getDiagnosticBreadcrumbForGroup(group: 'system' | 'plc' | 'io'): DiagnosticBreadcrumb {
        const groupItems = this.topLevelGroupsCache?.[group] || [];
        let summary = EMPTY_DIAGNOSTIC_BREADCRUMB;

        for (const item of groupItems) {
            summary = combineDiagnosticBreadcrumb(summary, this.getDiagnosticBreadcrumb(item.itemType, item.targetUri.fsPath));
        }

        return summary;
    }

    private async createTreeItemFromEntry(folderPath: string, entry: fs.Dirent, knownHasPlcProject?: boolean): Promise<TwinCATFileTreeItem | undefined> {
        if (this.isHiddenOrExcluded(entry.name)) {
            return undefined;
        }

        const fullPath = path.join(folderPath, entry.name);

        if (entry.isDirectory()) {
            const hasPlcProject = knownHasPlcProject ?? await this.directoryContainsPlcProj(fullPath);
            const item = new TwinCATFileTreeItem(
                vscode.Uri.file(fullPath),
                vscode.TreeItemCollapsibleState.Collapsed,
                hasPlcProject ? TwinCATItemType.PlcProjectFolder : TwinCATItemType.Folder
            );
            if (hasPlcProject) {
                item.setDescriptionText('PLC project');
            }
            return item;
        }

        if (entry.isFile() && this.isTwinCATFile(entry.name)) {
            const uri = vscode.Uri.file(fullPath);
            const detail = await this.getFileTreePresentation(uri);

            const item = new TwinCATFileTreeItem(
                uri,
                collapsibleState(detail.hasChildren),
                TwinCATItemType.File
            );
            item.setDescriptionText(detail.label ?? getTwinCATFileKindLabel(fullPath));
            return item;
        }

        return undefined;
    }

    private async buildTopLevelGroups() {
        return withPerfMetric('tree.refresh.topLevelGroups', async () => {
            if (!this.contentRoot) {
                return { system: [], plc: [], io: [] };
            }

            if (!this.tsprojStructure && this.rootIdentifiers?.tsprojPath) {
                this.tsprojStructure = await this.parseTsprojStructure(this.rootIdentifiers.tsprojPath);
            }

            const entries = await this.getDirectoryEntries(this.contentRoot);
            if (!entries) {
                return { system: [], plc: [], io: [] };
            }

            const systemEntries: TwinCATFileTreeItem[] = [];
            const plcEntries: TwinCATFileTreeItem[] = [];
            const ioEntries: TwinCATFileTreeItem[] = [];

            await Promise.all(entries.map(async entry => {
                if (this.isHiddenOrExcluded(entry.name)) {
                    return;
                }

                const fullPath = path.join(this.contentRoot!, entry.name);
                const normalizedFullPath = path.normalize(fullPath);
                const hasPlcProject = entry.isDirectory() && (
                    this.tsprojStructure?.plcFolderPaths.has(normalizedFullPath) ||
                    await this.directoryContainsPlcProj(fullPath)
                );
                const isIoEntry = this.tsprojStructure?.ioFolderPaths.has(normalizedFullPath) || this.isIoLikeEntry(entry.name);
                const item = await this.createTreeItemFromEntry(this.contentRoot!, entry, hasPlcProject);
                if (!item) {
                    return;
                }

                if (hasPlcProject || entry.name.toLowerCase().endsWith('.plcproj')) {
                    plcEntries.push(item);
                } else if (isIoEntry) {
                    ioEntries.push(item);
                } else {
                    systemEntries.push(item);
                }
            }));

            const isStandalonePlcRoot = !!(!this.rootIdentifiers?.slnPath && !this.rootIdentifiers?.tsprojPath && this.rootIdentifiers?.plcprojPath);
            if (isStandalonePlcRoot && plcEntries.length === 0) {
                const plcprojPath = this.rootIdentifiers?.plcprojPath!;
                const projectFolderItem = new TwinCATFileTreeItem(
                    vscode.Uri.file(this.contentRoot),
                    vscode.TreeItemCollapsibleState.Collapsed,
                    TwinCATItemType.PlcProjectFolder,
                    plcprojPath,
                    undefined,
                    path.basename(plcprojPath, '.plcproj')
                );
                plcEntries.push(projectFolderItem);
            }

            return {
                system: sortExplorerItems(systemEntries),
                plc: sortExplorerItems(plcEntries),
                io: sortExplorerItems(ioEntries)
            };
        });
    }

    private async getTopLevelGroupContents(group: 'system' | 'plc' | 'io') {
        if (!this.topLevelGroupsCache) {
            this.topLevelGroupsCache = await this.buildTopLevelGroups();
        }

        return this.topLevelGroupsCache[group];
    }

    private async getPlcProjectFolderContents(folderPath: string) {
        const plcProj = await this.getFirstPlcProjInDirectory(folderPath);
        const [referencesItems, folderItems] = await Promise.all([
            plcProj ? this.getPlcReferencesItems(plcProj) : Promise.resolve([]),
            this.getFolderContents(folderPath)
        ]);

        if (referencesItems.length === 0) {
            return folderItems;
        }

        const referencesRoot = new TwinCATFileTreeItem(
            vscode.Uri.file(path.join(folderPath, 'References')),
            vscode.TreeItemCollapsibleState.Collapsed,
            TwinCATItemType.ReferencesRoot,
            plcProj,
            referencesItems,
            'References'
        );
        referencesRoot.tooltip = `${path.basename(folderPath)} references`;
        referencesRoot.setDescriptionText(`${referencesItems.length}`);
        return [referencesRoot, ...folderItems];
    }

    private async getFolderContents(folderPath: string) {
        const cached = this.folderChildrenCache.get(folderPath);
        if (cached) {
            return cached;
        }

        return withPerfMetric('tree.refresh.folderContents', async () => {
            const entries = await this.getDirectoryEntries(folderPath);
            if (!entries) {
                return [];
            }

            const itemResults = await Promise.all(entries.map(entry => this.createTreeItemFromEntry(folderPath, entry)));

            const items = itemResults.filter((item): item is TwinCATFileTreeItem => !!item);

            const sorted = sortExplorerItems(items);
            this.folderChildrenCache.set(folderPath, sorted);
            return sorted;
        });
    }

    private async directoryContainsPlcProj(folderPath: string): Promise<boolean> {
        const entries = await this.getDirectoryEntries(folderPath);
        if (!entries) {
            return false;
        }
        return entries.some(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.plcproj'));
    }

    private async getFirstPlcProjInDirectory(folderPath: string): Promise<string | undefined> {
        const entries = await this.getDirectoryEntries(folderPath);
        if (!entries) {
            return undefined;
        }
        const plcProj = entries
            .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.plcproj'))
            .map(entry => path.join(folderPath, entry.name))
            .sort((a, b) => a.localeCompare(b))[0];
        return plcProj;
    }

    private async getPlcReferencesItems(plcprojPath: string): Promise<TwinCATFileTreeItem[]> {
        const cacheKey = this.getMetadataCacheKey(plcprojPath);
        const cached = this.plcReferencesCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const xml = await this.getProjectMetadataXml(plcprojPath);
            if (!xml) {
                return [];
            }
            const project = xml.Project;
            const itemGroups = toArray(project?.ItemGroup);
            const placeholderRefs = itemGroups.flatMap(group => toArray(group.PlaceholderReference));
            const items = placeholderRefs
                .map(ref => {
                    const include = Array.isArray(ref.Include) ? ref.Include[0] : ref.Include;
                    const defaultResolution = Array.isArray(ref.DefaultResolution) ? ref.DefaultResolution[0] : ref.DefaultResolution;
                    const namespaceValue = Array.isArray(ref.Namespace) ? ref.Namespace[0] : ref.Namespace;
                    const label = (include || namespaceValue || 'Library').toString();
                    const tooltip = defaultResolution
                        ? defaultResolution.toString()
                        : label;
                    const item = new TwinCATFileTreeItem(
                        vscode.Uri.file(path.join(path.dirname(plcprojPath), `${label}.library`)),
                        vscode.TreeItemCollapsibleState.None,
                        TwinCATItemType.ReferenceItem,
                        plcprojPath,
                        ref,
                        label
                    );
                    item.setDescriptionText(namespaceValue && namespaceValue !== label ? namespaceValue.toString() : undefined);
                    item.tooltip = tooltip;
                    return item;
                });

            try {
                await initializeProjectAnalyzer();
                const analyzer = getProjectAnalyzer();
                const implicitRefs = analyzer.getLibraryReferences()
                    .filter(ref => ref.metadataSource === 'system_global')
                    .map(ref => {
                        const item = new TwinCATFileTreeItem(
                            vscode.Uri.file(path.join(path.dirname(plcprojPath), `${ref.name}.library`)),
                            vscode.TreeItemCollapsibleState.None,
                            TwinCATItemType.ReferenceItem,
                            plcprojPath,
                            ref,
                            ref.name
                        );
                        item.setDescriptionText('system global');
                        item.tooltip = ref.summary
                            ? `${ref.name}\n${ref.summary}`
                            : `${ref.name} (system global)`;
                        return item;
                    });

                const deduped = new Map<string, TwinCATFileTreeItem>();
                for (const item of [...items, ...implicitRefs]) {
                    const key = (item.label?.toString() || '').toUpperCase();
                    if (!deduped.has(key)) {
                        deduped.set(key, item);
                    }
                }
                const sorted = [...deduped.values()]
                    .sort((a, b) => (a.label?.toString() || '').localeCompare(b.label?.toString() || ''));
                this.plcReferencesCache.set(cacheKey, sorted);
                return sorted;
            } catch {
                // Fall back to placeholder references only if analyzer init fails.
            }

            const sorted = items
                .sort((a, b) => (a.label?.toString() || '').localeCompare(b.label?.toString() || ''));
            this.plcReferencesCache.set(cacheKey, sorted);
            return sorted;
        } catch {
            return [];
        }
    }

    private isTwinCATFile(filePath: string) {
        return TREE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    }

    private isExpandablePOUFile(filePath: string) {
        return EXPANDABLE_POU_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    }

    private isInterfaceLikeFile(filePath: string) {
        const ext = path.extname(filePath).toLowerCase();
        return ext === '.tcitf' || ext === '.tcio';
    }

    private async getFileTreePresentation(uri: vscode.Uri): Promise<{ hasChildren: boolean; label?: string }> {
        const filePath = uri.fsPath;
        const ext = path.extname(filePath).toLowerCase();
        const defaultHasChildren = this.isExpandablePOUFile(filePath);
        const needsXmlTypeLabel = ext === '.tcpou' || ext === '.tcprg' || ext === '.tcapp' || ext === '.tccom' || ext === '.tcdut';
        if (!defaultHasChildren && !needsXmlTypeLabel) {
            return { hasChildren: false };
        }

        try {
            const xml = await this.getParsedPOU(uri);
            const label = this.getSpecificFileTypeLabel(filePath, xml);
            const hasChildren = defaultHasChildren ? this.hasStructuredMembers(xml) : false;
            return { hasChildren, label };
        } catch {
            return { hasChildren: defaultHasChildren };
        }
    }

    private getSpecificFileTypeLabel(filePath: string, xml: any): string | undefined {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.tcpou' || ext === '.tcprg' || ext === '.tcapp' || ext === '.tccom') {
            const root = xml.TcPOU?.[0] ?? xml.TcPlcObject?.POU?.[0] ?? xml.TcPlcObject?.TcPOU?.[0];
            const rawType = extractText(root?.Type);
            if (rawType) {
                return mapPouTypeLabel(rawType) ?? rawType.toUpperCase();
            }

            const declaration = extractText(root?.Declaration);
            const declarationType = this.getPouTypeFromDeclaration(declaration);
            return declarationType ? mapPouTypeLabel(declarationType) ?? declarationType.toUpperCase() : undefined;
        }

        if (ext === '.tcdut') {
            const root = xml.TcDUT?.[0] ?? xml.TcPlcObject?.DUT?.[0] ?? xml.TcPlcObject?.TcDUT?.[0];
            const rawType = extractText(root?.Type);
            if (rawType) {
                return rawType.toUpperCase();
            }

            const declaration = extractText(root?.Declaration);
            return this.getDutTypeFromDeclaration(declaration);
        }

        return undefined;
    }

    private getPouTypeFromDeclaration(declaration: string | undefined): string | undefined {
        if (!declaration) {
            return undefined;
        }

        const match = declaration.match(/^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\b/im);
        return match?.[1];
    }

    private getDutTypeFromDeclaration(declaration: string | undefined): string | undefined {
        if (!declaration) {
            return undefined;
        }

        const normalized = declaration.replace(/\r/g, '');
        const headerMatch = normalized.match(/^\s*TYPE\s+[A-Za-z_]\w*\s*:\s*/im);
        if (!headerMatch) {
            return undefined;
        }

        const afterHeader = normalized.slice(headerMatch.index! + headerMatch[0].length).trim();
        if (/^STRUCT\b/i.test(afterHeader)) {
            return 'STRUCT';
        }
        if (/^(?:\{[^\n]*\}\s*)*\(/.test(afterHeader)) {
            return 'ENUM';
        }

        const aliasMatch = afterHeader.match(/^([A-Za-z_]\w*)/);
        return aliasMatch?.[1]?.toUpperCase();
    }

    private hasStructuredMembers(xml: any): boolean {
        const root = this.extractStructuredRoot(xml);
        if (!root) {
            return false;
        }

        const hasNamedMembers = (collection: any[]) =>
            collection.some(entry => !!extractText(entry?.Name));

        return hasNamedMembers(toArray(root.Method))
            || hasNamedMembers(toArray(root.Property))
            || hasNamedMembers(toArray(root.Action))
            || hasNamedMembers(toArray(root.Transition));
    }

    // -------------------------------------------------
    // XML
    // -------------------------------------------------

    private async getParsedPOU(uri: vscode.Uri) {
        const cached = this.parsedPOUCache.get(uri.fsPath);
        if (cached) return cached;

        const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
        const parser = new xml2js.Parser({
            explicitArray: true,
            mergeAttrs: true
        });

        const xml = await parser.parseStringPromise(content);
        this.parsedPOUCache.set(uri.fsPath, xml);
        return xml;
    }

    private extractStructuredRoot(xml: any) {
        return (
            xml.TcPOU?.[0] ??
            xml.TcPlcObject?.POU?.[0] ??
            xml.TcITF?.[0] ??
            xml.TcItf?.[0] ??
            xml.TcIO?.[0] ??
            xml.TcPlcObject?.ITF?.[0] ??
            xml.TcPlcObject?.Itf?.[0] ??
            xml.TcPlcObject?.TcITF?.[0] ??
            xml.TcPlcObject?.TcItf?.[0] ??
            xml.TcPlcObject?.TcIO?.[0]
        );
    }

    private async getStructuredRootChildren(uri: vscode.Uri) {
        const xml = await this.getParsedPOU(uri);
        const root = xml ? this.extractStructuredRoot(xml) : undefined;
        if (!root) return [];

        return this.buildPOUStructure(uri, root);
    }

    // -------------------------------------------------
    // POU Structure Builder
    // -------------------------------------------------

    private buildPOUStructure(uri: vscode.Uri, pou: any) {
        const foldersXml = toArray(pou.Folder);
        const methods = toArray(pou.Method);
        const properties = toArray(pou.Property);
        const actions = toArray(pou.Action);
        const transitions = toArray(pou.Transition);

        const folderMap = new Map<string, TwinCATFileTreeItem[]>();

        const extractName = (v: any) => extractText(v);

        // Extract folder name from FolderPath attribute (removes trailing slash)
        const extractFolderName = (xmlObj: any): string | undefined => {
            if (!xmlObj) return undefined;
            if (xmlObj.FolderPath) {
                return xmlObj.FolderPath.toString().replace(/\\$/, '');
            }
            return undefined;
        };

        const addToFolder = (folderName: string, item: TwinCATFileTreeItem) => {
            if (!folderMap.has(folderName)) {
                folderMap.set(folderName, []);
            }
            folderMap.get(folderName)!.push(item);
        };

        const rootItems: TwinCATFileTreeItem[] = [];

        const createItem = (
            type: TwinCATItemType,
            xmlObj: any,
            name: string,
            hasChildren = false
        ) =>
            new TwinCATFileTreeItem(
                uri.with({ fragment: `${type}:${name}` }),
                collapsibleState(hasChildren),
                type,
                uri.fsPath,
                xmlObj,
                name
            );

        // -------------------------
        // Process Methods, Properties, Actions, Transitions
        // -------------------------
        const processItems = (
            collection: any[],
            type: TwinCATItemType,
            hasChildrenCheck?: (obj: any) => boolean
        ) => {
            for (const obj of collection) {
                const name = extractName(obj.Name);
                if (!name) continue;

                const hasChildren = hasChildrenCheck ? hasChildrenCheck(obj) : false;
                const item = createItem(type, obj, name, hasChildren);

                const folderName = extractFolderName(obj);
                if (folderName) {
                    addToFolder(folderName, item);
                } else {
                    rootItems.push(item);
                }
            }
        };

        processItems(methods, TwinCATItemType.Method);
        processItems(properties, TwinCATItemType.Property, p => !!(p.Get?.[0] || p.Set?.[0]));
        processItems(actions, TwinCATItemType.Action);
        processItems(transitions, TwinCATItemType.Transition);

        // -------------------------
        // Build Folder Nodes
        // -------------------------
        const folderItems: TwinCATFileTreeItem[] = [];

        for (const f of foldersXml) {
            const name = extractName(f.Name);
            if (!name) continue;

            const children = folderMap.get(name) || [];
            if (children.length === 0) {
                continue;
            }

            folderItems.push(
                new TwinCATFileTreeItem(
                    uri.with({ fragment: `Folder:${name}` }),
                    collapsibleState(children.length > 0),
                    TwinCATItemType.POUFolder,
                    uri.fsPath,
                    sortItems(children),
                    name
                )
            );
        }

        // -------------------------
        // RETURN - folders ALWAYS on top
        // -------------------------
        return [...sortItems(folderItems), ...sortItems(rootItems)];
    }

    // -------------------------------------------------
    // Property Get/Set
    // -------------------------------------------------

    private getPropertyChildren(element: TwinCATFileTreeItem) {
        const prop = element.xmlContent;
        if (!prop) return [];

        const uri = element.targetUri;
        const propertyName = element.label?.toString() || 'UnknownProperty';
        const isInterfaceProperty = this.isInterfaceLikeFile(uri.fsPath);
        const items: TwinCATFileTreeItem[] = [];

        if (prop.Get?.[0]) {
            items.push(
                new TwinCATFileTreeItem(
                    uri.with({ fragment: `PropertyGet:${propertyName}` }),
                    vscode.TreeItemCollapsibleState.None,
                    TwinCATItemType.PropertyGet,
                    element.parentPath,
                    prop.Get[0],
                    'Get',
                    !isInterfaceProperty
                )
            );
        }

        if (prop.Set?.[0]) {
            items.push(
                new TwinCATFileTreeItem(
                    uri.with({ fragment: `PropertySet:${propertyName}` }),
                    vscode.TreeItemCollapsibleState.None,
                    TwinCATItemType.PropertySet,
                    element.parentPath,
                    prop.Set[0],
                    'Set',
                    !isInterfaceProperty
                )
            );
        }

        return items;
    }

    // -------------------------------------------------
    // Watcher
    // -------------------------------------------------

    private setupWatcher() {
        if (!this.workspaceRoot) return;

        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            '**/*.{tcpou,tcprg,tcapp,tccom,tcgvl,tcdut,tcvar,tcgds,tcio,tcitf,TcPOU,TcPRG,TcAPP,TcCOM,TcGVL,TcDUT,TcVAR,TcGDS,TcIO,TcITF,plcproj,tsproj,tspproj,sln}'
        );

        this.fileWatcher.onDidChange(uri => {
            this.parsedPOUCache.delete(uri.fsPath);
            this.invalidateMetadataCaches(uri.fsPath);
            const ext = path.extname(uri.fsPath).toLowerCase();
            const requiresStructuralRefresh = ext === '.plcproj' || ext === '.tsproj' || ext === '.tspproj' || ext === '.sln';
            this.scheduleRefresh(requiresStructuralRefresh);
        });

        this.fileWatcher.onDidCreate(uri => {
            this.invalidateMetadataCaches(uri.fsPath);
            this.invalidateDirectoryCachesForPath(uri.fsPath);
            this.scheduleRefresh(true);
        });
        this.fileWatcher.onDidDelete(uri => {
            this.parsedPOUCache.delete(uri.fsPath);
            this.invalidateMetadataCaches(uri.fsPath);
            this.invalidateDirectoryCachesForPath(uri.fsPath);
            this.scheduleRefresh(true);
        });
    }

    dispose() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this.pendingStructuralRefresh = false;
        this.fileWatcher?.dispose();
        this.parsedPOUCache.clear();
        this.projectMetadataXmlCache.clear();
        this.directoryEntriesCache.clear();
        this.clearDiagnosticSummaryCaches();
        this._onDidChangeTreeData.dispose();
    }
}
