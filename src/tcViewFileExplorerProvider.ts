import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as xml2js from 'xml2js';

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
    '.tccom'
]);

const toArray = <T>(value: T | T[] | undefined): T[] =>
    Array.isArray(value) ? value : value ? [value] : [];

const sortItems = (items: TwinCATFileTreeItem[]) =>
    items.sort((a, b) =>
        (a.label?.toString() || '').localeCompare(b.label?.toString() || '')
    );

const collapsibleState = (hasChildren: boolean) =>
    hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

// -----------------------------------------------------
// Tree Item
// -----------------------------------------------------

export class TwinCATFileTreeItem extends vscode.TreeItem {
    constructor(
        public readonly resourceUri: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: TwinCATItemType,
        public readonly parentPath?: string,
        public readonly xmlContent?: any,
        customLabel?: string
    ) {
        super(customLabel ?? TwinCATFileTreeItem.getLabel(resourceUri, itemType));

        this.tooltip = resourceUri.fsPath;
        this.contextValue = itemType;
        this.setIcon();

        if (OPENABLE_TYPES.has(itemType)) {
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

    private static getLabel(uri: vscode.Uri, type: TwinCATItemType): string {
        if (
            type === TwinCATItemType.File ||
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

    private setIcon() {
        const iconMap: Record<TwinCATItemType, string | vscode.ThemeIcon> = {
            statusInfo: new vscode.ThemeIcon('search'),
            statusWarning: new vscode.ThemeIcon('warning'),
            systemRoot: new vscode.ThemeIcon('server-environment'),
            plcRoot: new vscode.ThemeIcon('symbol-module'),
            ioRoot: new vscode.ThemeIcon('plug'),
            referencesRoot: new vscode.ThemeIcon('references'),
            referenceItem: new vscode.ThemeIcon('library'),
            folder: vscode.ThemeIcon.Folder,
            plcProjectFolder: vscode.ThemeIcon.Folder,
            pouFolder: vscode.ThemeIcon.Folder,
            file: 'symbol-class',
            method: 'symbol-method',
            property: 'symbol-property',
            propertyGet: 'arrow-circle-down',
            propertySet: 'arrow-circle-up',
            action: 'symbol-event',
            transition: 'symbol-interface'
        };

        const icon = iconMap[this.itemType];
        this.iconPath =
            icon instanceof vscode.ThemeIcon
                ? icon
                : new vscode.ThemeIcon(icon);
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
    private folderChildrenCache = new Map<string, TwinCATFileTreeItem[]>();
    private plcReferencesCache = new Map<string, TwinCATFileTreeItem[]>();
    private topLevelGroupsCache: { system: TwinCATFileTreeItem[]; plc: TwinCATFileTreeItem[]; io: TwinCATFileTreeItem[] } | undefined;
    private discoveryState: 'booting' | 'loading' | 'ready' | 'empty' = 'booting';
    private rootIdentifiers: { hasTwinCATFiles: boolean; tsprojPath?: string; slnPath?: string; plcprojPath?: string } | undefined;
    private tsprojStructure: { plcFolderPaths: Set<string>; hasSystem: boolean; ioFolderPaths: Set<string> } | undefined;
    private contentRoot?: string;
    private fileWatcher?: vscode.FileSystemWatcher;
    private refreshTimer: NodeJS.Timeout | undefined;
    private hasActiveSolution = false;
    private discoveryStarted = false;

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

    refresh() {
        this.folderChildrenCache.clear();
        this.plcReferencesCache.clear();
        this.topLevelGroupsCache = undefined;
        this._onDidChangeTreeData.fire(undefined);
    }

    private scheduleRefresh(delayMs = 150) {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }

        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.refresh();
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
                warningItem.description = 'Build features are unavailable';
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
                return this.getFolderContents(element.resourceUri.fsPath);

            case TwinCATItemType.PlcProjectFolder:
                return this.getPlcProjectFolderContents(element.resourceUri.fsPath);

            case TwinCATItemType.ReferencesRoot:
                return element.xmlContent || [];

            case TwinCATItemType.File:
                return this.isExpandablePOUFile(element.resourceUri.fsPath)
                    ? this.getPOURootChildren(element.resourceUri)
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

        const resolvedRoot = await this.resolveTwinCATRoot(this.workspaceRoot);
        if (!resolvedRoot) {
            this.setDiscoveryState('empty');
            this.refresh();
            return;
        }

        this.contentRoot = resolvedRoot.folderPath;
        this.rootIdentifiers = resolvedRoot.identifiers;

        if (resolvedRoot.identifiers.tsprojPath) {
            this.tsprojStructure = await this.parseTsprojStructure(resolvedRoot.identifiers.tsprojPath);
        }

        this.setDiscoveryState('ready');
        this.refresh();
    }

    private async resolveTwinCATRoot(
        folderPath: string,
        depth = 2
    ): Promise<{ folderPath: string; identifiers: { hasTwinCATFiles: boolean; tsprojPath?: string; slnPath?: string; plcprojPath?: string } } | undefined> {
        const identifiers = await this.findTwinCATIdentifiers(folderPath);
        if (identifiers.hasTwinCATFiles) {
            return { folderPath, identifiers };
        }

        if (depth <= 0) {
            return undefined;
        }

        try {
            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
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
        } catch {
            return undefined;
        }

        return undefined;
    }

    private async findTwinCATIdentifiers(folderPath: string): Promise<{ hasTwinCATFiles: boolean; tsprojPath?: string; slnPath?: string; plcprojPath?: string }> {
        try {
            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
            const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
            const slnPath = files.find(name => name.toLowerCase().endsWith('.sln'));
            const tsprojPath = files.find(name => name.toLowerCase().endsWith('.tsproj'));
            const plcprojPath = files.find(name => name.toLowerCase().endsWith('.plcproj'));
            const isTwinCATSolution = !!(slnPath && tsprojPath);
            const isStandalonePlcProject = !!plcprojPath;
            return {
                hasTwinCATFiles: isTwinCATSolution || isStandalonePlcProject,
                slnPath: isTwinCATSolution && slnPath ? path.join(folderPath, slnPath) : undefined,
                tsprojPath: tsprojPath ? path.join(folderPath, tsprojPath) : undefined,
                plcprojPath: plcprojPath ? path.join(folderPath, plcprojPath) : undefined
            };
        } catch {
            return { hasTwinCATFiles: false };
        }
    }

    private async parseTsprojStructure(tsprojPath: string): Promise<{ plcFolderPaths: Set<string>; hasSystem: boolean; ioFolderPaths: Set<string> }> {
        try {
            const content = await fs.promises.readFile(tsprojPath, 'utf8');
            const parser = new xml2js.Parser({
                explicitArray: true,
                mergeAttrs: true
            });
            const xml = await parser.parseStringPromise(content);
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
        return lower === 'io' || lower === 'i_o' || lower === 'i-o' || lower.endsWith('.tcio');
    }

    private async createTreeItemFromEntry(folderPath: string, entry: fs.Dirent): Promise<TwinCATFileTreeItem | undefined> {
        if (this.isHiddenOrExcluded(entry.name)) {
            return undefined;
        }

        const fullPath = path.join(folderPath, entry.name);

        if (entry.isDirectory()) {
            const hasPlcProject = await this.directoryContainsPlcProj(fullPath);
            return new TwinCATFileTreeItem(
                vscode.Uri.file(fullPath),
                vscode.TreeItemCollapsibleState.Collapsed,
                hasPlcProject ? TwinCATItemType.PlcProjectFolder : TwinCATItemType.Folder
            );
        }

        if (entry.isFile() && this.isTwinCATFile(entry.name)) {
            const uri = vscode.Uri.file(fullPath);
            const hasChildren = this.isExpandablePOUFile(fullPath);

            return new TwinCATFileTreeItem(
                uri,
                collapsibleState(hasChildren),
                TwinCATItemType.File
            );
        }

        return undefined;
    }

    private async buildTopLevelGroups() {
        if (!this.contentRoot) {
            return { system: [], plc: [], io: [] };
        }

        const entries = await fs.promises.readdir(this.contentRoot, {
            withFileTypes: true
        });

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
            const item = await this.createTreeItemFromEntry(this.contentRoot!, entry);
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

        return {
            system: sortItems(systemEntries),
            plc: sortItems(plcEntries),
            io: sortItems(ioEntries)
        };
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
            folderPath,
            referencesItems,
            'References'
        );
        referencesRoot.tooltip = `${path.basename(folderPath)} references`;
        return [referencesRoot, ...folderItems];
    }

    private async getFolderContents(folderPath: string) {
        const cached = this.folderChildrenCache.get(folderPath);
        if (cached) {
            return cached;
        }

        const entries = await fs.promises.readdir(folderPath, {
            withFileTypes: true
        });

        const itemResults = await Promise.all(entries.map(entry => this.createTreeItemFromEntry(folderPath, entry)));

        const items = itemResults.filter((item): item is TwinCATFileTreeItem => !!item);

        const sorted = sortItems(items);
        this.folderChildrenCache.set(folderPath, sorted);
        return sorted;
    }

    private async directoryContainsPlcProj(folderPath: string): Promise<boolean> {
        try {
            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
            return entries.some(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.plcproj'));
        } catch {
            return false;
        }
    }

    private async getFirstPlcProjInDirectory(folderPath: string): Promise<string | undefined> {
        try {
            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
            const plcProj = entries
                .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.plcproj'))
                .map(entry => path.join(folderPath, entry.name))
                .sort((a, b) => a.localeCompare(b))[0];
            return plcProj;
        } catch {
            return undefined;
        }
    }

    private async getPlcReferencesItems(plcprojPath: string): Promise<TwinCATFileTreeItem[]> {
        const cached = this.plcReferencesCache.get(plcprojPath);
        if (cached) {
            return cached;
        }

        try {
            const content = await fs.promises.readFile(plcprojPath, 'utf8');
            const parser = new xml2js.Parser({
                explicitArray: true,
                mergeAttrs: true
            });
            const xml = await parser.parseStringPromise(content);
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
                    item.description = namespaceValue && namespaceValue !== label ? namespaceValue.toString() : undefined;
                    item.tooltip = tooltip;
                    return item;
                })
                .sort((a, b) => (a.label?.toString() || '').localeCompare(b.label?.toString() || ''));

            this.plcReferencesCache.set(plcprojPath, items);
            return items;
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

    private extractPOU(xml: any) {
        return xml.TcPOU?.[0] ?? xml.TcPlcObject?.POU?.[0];
    }

    private async getPOURootChildren(uri: vscode.Uri) {
        const xml = await this.getParsedPOU(uri);
        const pou = xml ? this.extractPOU(xml) : undefined;
        if (!pou) return [];

        return this.buildPOUStructure(uri, pou);
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

        const extractName = (v: any) => (Array.isArray(v) ? v[0]?.toString() : v?.toString());

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
        processItems(properties, TwinCATItemType.Property, p => !!(p.Get || p.Set));
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

            folderItems.push(
                new TwinCATFileTreeItem(
                    uri.with({ fragment: `Folder:${name}` }),
                    // Make folders expandable even if no children
                    vscode.TreeItemCollapsibleState.Collapsed,
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

        const uri = element.resourceUri;
        const propertyName = element.label?.toString() || 'UnknownProperty';
        const items: TwinCATFileTreeItem[] = [];

        if (prop.Get?.[0]) {
            items.push(
                new TwinCATFileTreeItem(
                    uri.with({ fragment: `PropertyGet:${propertyName}` }),
                    vscode.TreeItemCollapsibleState.None,
                    TwinCATItemType.PropertyGet,
                    element.parentPath,
                    prop.Get[0],
                    'Get'
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
                    'Set'
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
            '**/*.{tcpou,tcprg,tcapp,tccom,tcgvl,tcdut,tcvar,tcgds,tcio,tcitf,TcPOU,TcPRG,TcAPP,TcCOM,TcGVL,TcDUT,TcVAR,TcGDS,TcIO,TcITF,plcproj,tsproj,sln}'
        );

        this.fileWatcher.onDidChange(uri => {
            this.parsedPOUCache.delete(uri.fsPath);
            this.scheduleRefresh();
        });

        this.fileWatcher.onDidCreate(() => this.scheduleRefresh());
        this.fileWatcher.onDidDelete(() => this.scheduleRefresh());
    }

    dispose() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this.fileWatcher?.dispose();
        this.parsedPOUCache.clear();
    }
}

