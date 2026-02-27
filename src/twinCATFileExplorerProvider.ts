import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as xml2js from 'xml2js';

export enum TwinCATItemType {
    Folder = 'folder',
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
        }
    }

    private static getLabel(uri: vscode.Uri, type: TwinCATItemType): string {
        if (type === TwinCATItemType.File || type === TwinCATItemType.Folder) {
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
            folder: vscode.ThemeIcon.Folder,
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
    private fileWatcher?: vscode.FileSystemWatcher;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor(private workspaceRoot?: string) {
        this.setupWatcher();
    }

    refresh() {
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

    getTreeItem(element: TwinCATFileTreeItem) {
        return element;
    }

    async getChildren(element?: TwinCATFileTreeItem) {
        if (!this.workspaceRoot) return [];

        if (!element) return this.getFolderContents(this.workspaceRoot);

        switch (element.itemType) {
            case TwinCATItemType.Folder:
                return this.getFolderContents(element.resourceUri.fsPath);

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

    private async getFolderContents(folderPath: string) {
        const entries = await fs.promises.readdir(folderPath, {
            withFileTypes: true
        });

        const itemResults = await Promise.all(entries.map(async entry => {
            const fullPath = path.join(folderPath, entry.name);

            if (entry.isDirectory()) {
                return new TwinCATFileTreeItem(
                    vscode.Uri.file(fullPath),
                    vscode.TreeItemCollapsibleState.Collapsed,
                    TwinCATItemType.Folder
                );
            }

            if (entry.isFile() && this.isTwinCATFile(entry.name)) {
                const uri = vscode.Uri.file(fullPath);
                const hasChildren = this.isExpandablePOUFile(fullPath)
                    ? await this.pouFileHasChildren(uri)
                    : false;

                return new TwinCATFileTreeItem(
                    uri,
                    collapsibleState(hasChildren),
                    TwinCATItemType.File
                );
            }

            return undefined;
        }));

        const items = itemResults.filter((item): item is TwinCATFileTreeItem => !!item);

        return sortItems(items);
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

    private async pouFileHasChildren(uri: vscode.Uri) {
        try {
            const xml = await this.getParsedPOU(uri);
            const pou = xml ? this.extractPOU(xml) : undefined;
            if (!pou) return false;

            return (
                toArray(pou.Method).length > 0 ||
                toArray(pou.Action).length > 0 ||
                toArray(pou.Transition).length > 0 ||
                toArray(pou.Folder).length > 0 ||
                toArray(pou.Property).some(p => p.Get || p.Set)
            );
        } catch {
            return false;
        }
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
            '**/*.{tcpou,tcprg,tcapp,tccom,tcgvl,tcdut,tcvar,tcgds,tcio,tcitf,TcPOU,TcPRG,TcAPP,TcCOM,TcGVL,TcDUT,TcVAR,TcGDS,TcIO,TcITF}'
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

