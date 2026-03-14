import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { TwinCATFileExplorerProvider, TwinCATFileTreeItem, TwinCATItemType } from './tcViewFileExplorerProvider';
import { withPerfMetric } from './tcViewTelemetry';

const execFileAsync = promisify(execFile);
const SCM_POLL_INTERVAL_MS = 2500;

const getNonce = () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i += 1) {
        value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return value;
};

type WebviewNode = {
    id: string;
    label: string;
    description?: string;
    tooltip?: string;
    itemType: TwinCATItemType;
    collapsible: boolean;
    openable: boolean;
    severity: 'error' | 'warning' | 'none';
    iconClass: string;
    iconColorClass: string;
    errorCount: number;
    warningCount: number;
    scmBadge?: string;
    scmTooltip?: string;
    isCut?: boolean;
    children?: WebviewNode[];
    fileKind?: string;
};

type ScmEntry = {
    badge: string;
    tooltip: string;
    sort: number;
};

type WebviewMessage =
    | { type: 'ready' }
    | { type: 'focus' }
    | { type: 'blur' }
    | { type: 'select'; id: string }
    | { type: 'context'; id: string }
    | { type: 'toggle'; id: string; expanded: boolean }
    | { type: 'open'; id: string }
    | { type: 'refresh' }
    | { type: 'action'; id: string; action: string; value?: string };

export class TwinCATWebviewExplorerProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'twincat.files';

    private view?: vscode.WebviewView;
    private webviewReady = false;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly itemById = new Map<string, TwinCATFileTreeItem>();
    private readonly scmByPath = new Map<string, ScmEntry>();
    private scmChangeDisposable?: vscode.Disposable;
    private gitApi: any;
    private scmPollTimer?: NodeJS.Timeout;
    private refreshTimer?: NodeJS.Timeout;
    private pendingForcedRootsRefresh = false;
    private readonly expandedNodeIds = new Set<string>();
    private lastVisibleStructureKey = '';
    private lastVisibleStateKey = '';
    private currentContextItemId = '';
    private cutNodeId = '';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly fileExplorerProvider: TwinCATFileExplorerProvider,
        private readonly openTreeItem: (item: TwinCATFileTreeItem) => Promise<void>,
        private readonly runTreeAction: (action: string, item: TwinCATFileTreeItem, value?: string) => Promise<void>
    ) {
        this.disposables.push(this.fileExplorerProvider.onDidChangeTreeData(() => {
            this.pendingForcedRootsRefresh = true;
            this.scheduleRefresh(140);
        }));
        void this.attachGitApi();
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        this.webviewReady = false;
        void vscode.commands.executeCommand('setContext', 'tcview.webExplorerFocus', false);
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
            ]
        };
        webviewView.webview.html = this.renderHtml(webviewView.webview);
        this.disposables.push(webviewView.webview.onDidReceiveMessage(message => {
            void this.handleMessage(message as WebviewMessage);
        }));
        this.disposables.push(webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                return;
            }
            this.lastVisibleStructureKey = '';
            this.lastVisibleStateKey = '';
            this.scheduleRefresh(20);
        }));
        this.disposables.push(webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
                this.webviewReady = false;
                void vscode.commands.executeCommand('setContext', 'tcview.webExplorerFocus', false);
            }
        }));
    }

    async refresh() {
        if (!this.view || !this.webviewReady) {
            return;
        }

        if (this.pendingForcedRootsRefresh) {
            this.lastVisibleStructureKey = '';
            this.lastVisibleStateKey = '';
            this.pendingForcedRootsRefresh = false;
        }

        await withPerfMetric('tree.webview.refresh', async () => {
            if (this.gitApi?.repositories) {
                await withPerfMetric('tree.webview.refresh.scm', () => this.rebuildScmIndex(this.gitApi.repositories));
            }

            const roots = await withPerfMetric('tree.webview.refresh.roots', () => this.fileExplorerProvider.getChildren());
            const payload = await withPerfMetric('tree.webview.refresh.serialize', () => this.serializeVisibleItems(roots));
            const structureKey = this.createStructureKey(payload);
            const stateKey = this.createStateKey(payload);
            if (structureKey === this.lastVisibleStructureKey && stateKey === this.lastVisibleStateKey) {
                return;
            }
            if (structureKey !== this.lastVisibleStructureKey) {
                this.lastVisibleStructureKey = structureKey;
                this.lastVisibleStateKey = stateKey;
                await withPerfMetric('tree.webview.refresh.postMessage.roots', () => this.view!.webview.postMessage({ type: 'roots', nodes: payload }));
                return;
            }

            this.lastVisibleStateKey = stateKey;
            await withPerfMetric('tree.webview.refresh.postMessage.state', () => this.view!.webview.postMessage({ type: 'state', nodes: payload }));
        });
    }

    dispose() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        if (this.scmPollTimer) {
            clearInterval(this.scmPollTimer);
            this.scmPollTimer = undefined;
        }
        this.scmChangeDisposable?.dispose();
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
    }

    getCurrentContextItem(): TwinCATFileTreeItem | undefined {
        return this.itemById.get(this.currentContextItemId);
    }

    getItemById(id: string): TwinCATFileTreeItem | undefined {
        return this.itemById.get(id);
    }

    getCurrentContextItemId(): string {
        return this.currentContextItemId;
    }

    setCutNodeId(nodeId?: string) {
        this.cutNodeId = nodeId ?? '';
        this.scheduleRefresh(40);
    }

    ensureExpanded(item?: TwinCATFileTreeItem) {
        if (!item) {
            return;
        }
        const id = this.getItemId(item);
        if (this.expandedNodeIds.has(id)) {
            return;
        }
        this.expandedNodeIds.add(id);
    }

    startInlineRenameCurrentSelection() {
        void this.view?.webview.postMessage({ type: 'beginRename', id: this.currentContextItemId });
    }

    startInlineCreateFolderCurrentSelection() {
        void this.beginInlineCreate('beginCreateFolder');
    }

    startInlineCreateFileCurrentSelection(templateId: string, extension: string) {
        void this.beginInlineCreate('beginCreateFile', { templateId, extension });
    }

    startInlineCreateMemberCurrentSelection(kind: 'method' | 'property' | 'action' | 'transition') {
        void this.beginInlineCreate('beginCreateMember', { kind });
    }

    private async beginInlineCreate(type: 'beginCreateFolder' | 'beginCreateFile' | 'beginCreateMember', extra?: Record<string, unknown>) {
        if (!this.view || !this.currentContextItemId) {
            return;
        }

        const item = this.itemById.get(this.currentContextItemId);
        if (item?.collapsibleState !== vscode.TreeItemCollapsibleState.None && !this.expandedNodeIds.has(this.currentContextItemId)) {
            this.expandedNodeIds.add(this.currentContextItemId);
            await this.refresh();
        }

        await this.view.webview.postMessage({
            type,
            id: this.currentContextItemId,
            ...(extra ?? {})
        });
    }

    private async handleMessage(message: WebviewMessage) {
        switch (message.type) {
            case 'ready':
                this.webviewReady = true;
                this.lastVisibleStructureKey = '';
                this.lastVisibleStateKey = '';
                this.itemById.clear();
                await this.refresh();
                return;
            case 'refresh':
                await this.refresh();
                return;
            case 'select':
            case 'context':
                this.currentContextItemId = message.id;
                return;
            case 'focus':
                await vscode.commands.executeCommand('setContext', 'tcview.webExplorerFocus', true);
                return;
            case 'blur':
                await vscode.commands.executeCommand('setContext', 'tcview.webExplorerFocus', false);
                return;
            case 'toggle': {
                if (message.expanded) {
                    this.expandedNodeIds.add(message.id);
                } else {
                    this.expandedNodeIds.delete(message.id);
                }
                await this.refresh();
                return;
            }
            case 'open': {
                const item = this.itemById.get(message.id);
                if (!item) {
                    return;
                }
                await this.openTreeItem(item);
                return;
            }
            case 'action': {
                if (message.action === 'openSolution') {
                    await vscode.commands.executeCommand('tcview.openSolution');
                    return;
                }
                const item = this.itemById.get(message.id);
                if (!item) {
                    return;
                }
                await this.runTreeAction(message.action, item, message.value);
                return;
            }
        }
    }

    private async serializeVisibleItems(items: TwinCATFileTreeItem[]): Promise<WebviewNode[]> {
        return Promise.all(items.map(async item => {
            const treeItem = this.fileExplorerProvider.getTreeItem(item);
            const id = this.getItemId(item);
            const diagnostics = this.fileExplorerProvider.getDiagnosticSummaryForItem(item) ?? this.getDiagnosticCounts(treeItem);
            const scm = await this.getScmEntry(item);
            this.itemById.set(id, item);
            const shouldIncludeChildren =
                this.expandedNodeIds.has(id)
                || item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded;
            if (item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded) {
                this.expandedNodeIds.add(id);
            }
            const children = shouldIncludeChildren
                ? await this.fileExplorerProvider.getChildren(item)
                : [];
            const fileKind = this.getFileKind(item, treeItem);
            return {
                id,
                label: this.stripDiagnosticBadge(this.toLabel(treeItem.label)),
                description: typeof treeItem.description === 'string' ? treeItem.description : undefined,
                tooltip: this.toTooltip(treeItem.tooltip),
                itemType: item.itemType,
                collapsible: item.collapsibleState !== vscode.TreeItemCollapsibleState.None,
                openable: !!item.command,
                severity: diagnostics.errors > 0 ? 'error' : diagnostics.warnings > 0 ? 'warning' : 'none',
                iconClass: this.getIconClass(item.itemType, fileKind),
                iconColorClass: this.getIconColorClass(item.itemType, fileKind),
                errorCount: diagnostics.errors,
                warningCount: diagnostics.warnings,
                scmBadge: scm?.badge,
                scmTooltip: scm?.tooltip,
                isCut: this.cutNodeId === id,
                children: children.length > 0 ? await this.serializeVisibleItems(children) : undefined,
                fileKind
            };
        }));
    }

    private getFileKind(item: TwinCATFileTreeItem, treeItem: vscode.TreeItem): string | undefined {
        if (item.itemType !== TwinCATItemType.File) {
            if (
                item.itemType === TwinCATItemType.POUFolder ||
                item.itemType === TwinCATItemType.Method ||
                item.itemType === TwinCATItemType.Property ||
                item.itemType === TwinCATItemType.PropertyGet ||
                item.itemType === TwinCATItemType.PropertySet ||
                item.itemType === TwinCATItemType.Action ||
                item.itemType === TwinCATItemType.Transition
            ) {
                const ext = path.extname(item.parentPath ?? '').toLowerCase();
                return this.getFileKindFromExtension(ext, undefined);
            }
            return undefined;
        }

        const ext = path.extname(item.targetUri.fsPath).toLowerCase();
        const description = typeof treeItem.description === 'string' ? treeItem.description : undefined;
        return this.getFileKindFromExtension(ext, description);
    }

    private getFileKindFromExtension(ext: string, description?: string): string | undefined {
        switch (ext) {
            case '.tcprg':
                return 'program';
            case '.tcitf':
            case '.tcio':
                return 'interface';
            case '.tcgvl':
                return 'gvl';
            case '.tcdut':
                return 'dut';
            case '.tcpou':
            case '.tcapp':
            case '.tccom':
                if (description === 'FUN') {
                    return 'function';
                }
                if (description === 'FB') {
                    return 'functionBlock';
                }
                if (description === 'PRG') {
                    return 'program';
                }
                return 'functionBlock';
            default:
                return undefined;
        }
    }

    private createStructureKey(nodes: WebviewNode[]) {
        const encode = (entries: WebviewNode[]): unknown[] => entries.map(node => ({
            id: node.id,
            label: node.label,
            description: node.description,
            tooltip: node.tooltip,
            itemType: node.itemType,
            collapsible: node.collapsible,
            openable: node.openable,
            iconClass: node.iconClass,
            iconColorClass: node.iconColorClass,
            children: node.children ? encode(node.children) : []
        }));
        return JSON.stringify(encode(nodes));
    }

    private createStateKey(nodes: WebviewNode[]) {
        const encode = (entries: WebviewNode[]): unknown[] => entries.map(node => ({
            id: node.id,
            label: node.label,
            description: node.description,
            tooltip: node.tooltip,
            severity: node.severity,
            errorCount: node.errorCount,
            warningCount: node.warningCount,
            scmBadge: node.scmBadge,
            scmTooltip: node.scmTooltip,
            isCut: node.isCut,
            children: node.children ? encode(node.children) : []
        }));
        return JSON.stringify(encode(nodes));
    }

    private async attachGitApi() {
        const extension = vscode.extensions.getExtension<any>('vscode.git');
        if (!extension) {
            return;
        }

        const exports = extension.isActive ? extension.exports : await extension.activate();
        const git = exports?.getAPI?.(1);
        if (!git?.repositories) {
            return;
        }
        this.gitApi = git;

        const refreshScm = async () => {
            await this.rebuildScmIndex(git.repositories);
            this.scheduleRefresh();
        };

        const repoDisposables = git.repositories.map((repository: any) =>
            repository.state?.onDidChange?.(() => { void refreshScm(); })
        ).filter(Boolean) as vscode.Disposable[];

        const gitApiDisposables: vscode.Disposable[] = [];
        if (typeof git.onDidOpenRepository === 'function') {
            gitApiDisposables.push(git.onDidOpenRepository(() => { void refreshScm(); }));
        }
        if (typeof git.onDidCloseRepository === 'function') {
            gitApiDisposables.push(git.onDidCloseRepository(() => { void refreshScm(); }));
        }

        this.scmChangeDisposable = vscode.Disposable.from(...repoDisposables, ...gitApiDisposables);
        this.disposables.push(this.scmChangeDisposable);
        if (!this.scmPollTimer) {
            this.scmPollTimer = setInterval(() => {
                if (!this.view?.visible) {
                    return;
                }
                void refreshScm();
            }, SCM_POLL_INTERVAL_MS);
        }
        await refreshScm();
    }

    private scheduleRefresh(delayMs = 80) {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, delayMs);
    }

    private async rebuildScmIndex(repositories: readonly any[]) {
        this.scmByPath.clear();
        for (const repository of repositories) {
            const rootPath = this.normalizePath(repository.rootUri?.fsPath);
            if (!rootPath) {
                continue;
            }

            const statuses = await this.readGitStatuses(repository.rootUri.fsPath);
            for (const status of statuses) {
                const filePath = this.normalizePath(status.path);
                const badge = status.badge;
                const tooltip = status.tooltip;
                const sort = this.getScmPriority(badge);
                this.upsertScm(filePath, badge, tooltip, sort);

                let current = filePath;
                while (current.startsWith(rootPath)) {
                    const separatorIndex = Math.max(current.lastIndexOf('\\'), current.lastIndexOf('/'));
                    if (separatorIndex <= 0) {
                        break;
                    }
                    current = this.normalizePath(current.substring(0, separatorIndex));
                    if (!current || current.length < rootPath.length) {
                        break;
                    }
                    this.upsertScm(current, badge, tooltip, sort);
                    if (current === rootPath) {
                        break;
                    }
                }
            }
        }
    }

    private async readGitStatuses(repositoryRoot: string): Promise<Array<{ path: string; badge: string; tooltip: string }>> {
        try {
            const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'status', '--porcelain=v1', '--untracked-files=all'], {
                windowsHide: true,
                maxBuffer: 1024 * 1024
            });

            return stdout
                .split(/\r?\n/)
                .map(line => line.trimEnd())
                .filter(line => line.length >= 4)
                .map(line => {
                    const xy = line.slice(0, 2);
                    const rawPath = line.slice(3).replace(/^"+|"+$/g, '');
                    const pathPart = (rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() || rawPath : rawPath)
                        .replace(/\/$/, '');
                    const badge = this.getScmLetterFromPorcelain(xy);
                    return {
                        path: path.resolve(repositoryRoot, ...pathPart.split('/')),
                        badge,
                        tooltip: this.getScmTooltipFromPorcelain(xy)
                    };
                });
        } catch {
            return [];
        }
    }

    private upsertScm(pathKey: string, badge: string, tooltip: string, sort: number) {
        const existing = this.scmByPath.get(pathKey);
        if (!existing || sort < existing.sort) {
            this.scmByPath.set(pathKey, { badge, tooltip, sort });
        }
    }

    private normalizePath(filePath: string | undefined): string {
        return (filePath || '').replace(/\//g, '\\').toLowerCase();
    }

    private getScmPriority(badge: string): number {
        switch (badge) {
            case '!': return 0;
            case 'M': return 1;
            case 'D': return 2;
            case 'A': return 3;
            case 'R': return 4;
            case 'U': return 5;
            default: return 9;
        }
    }

    private getScmLetterFromPorcelain(xy: string): string {
        if (xy === '??') {
            return 'U';
        }
        if (xy.includes('U')) {
            return '!';
        }
        if (xy.includes('D')) {
            return 'D';
        }
        if (xy.includes('R')) {
            return 'R';
        }
        if (xy.includes('A')) {
            return 'A';
        }
        return 'M';
    }

    private getScmTooltipFromPorcelain(xy: string): string {
        if (xy === '??') {
            return 'Source control: Untracked';
        }
        if (xy.includes('U')) {
            return 'Source control: Conflict';
        }
        if (xy.includes('D')) {
            return 'Source control: Deleted';
        }
        if (xy.includes('R')) {
            return 'Source control: Renamed';
        }
        if (xy.includes('A')) {
            return 'Source control: Added';
        }
        return 'Source control: Modified';
    }

    private async getScmEntry(item: TwinCATFileTreeItem): Promise<ScmEntry | undefined> {
        const exact = this.scmByPath.get(this.normalizePath(item.targetUri.fsPath));

        if (item.itemType === TwinCATItemType.Folder || item.itemType === TwinCATItemType.PlcProjectFolder) {
            return this.getStrongestScmEntry([
                exact,
                this.getScmEntryForPrefix(item.targetUri.fsPath)
            ]);
        }

        if (
            item.itemType === TwinCATItemType.PlcRoot ||
            item.itemType === TwinCATItemType.SystemRoot ||
            item.itemType === TwinCATItemType.IoRoot
        ) {
            const children = await this.fileExplorerProvider.getChildren(item);
            return this.getStrongestScmEntry(
                [
                    exact,
                    ...(await Promise.all(children.map((child: TwinCATFileTreeItem) => this.getScmEntry(child))))
                ]
            );
        }

        return exact;
    }

    private getScmEntryForPrefix(prefixPath: string): ScmEntry | undefined {
        const normalizedPrefix = this.normalizePath(prefixPath);
        const folderPrefix = `${normalizedPrefix}\\`;
        const matches: ScmEntry[] = [];
        for (const [pathKey, entry] of this.scmByPath.entries()) {
            if (pathKey === normalizedPrefix || pathKey.startsWith(folderPrefix)) {
                matches.push(entry);
            }
        }
        return this.getStrongestScmEntry(matches);
    }

    private getStrongestScmEntry(entries: Array<ScmEntry | undefined>): ScmEntry | undefined {
        const filtered = entries.filter((entry): entry is ScmEntry => !!entry);
        if (!filtered.length) {
            return undefined;
        }
        return filtered.reduce((best, current) => current.sort < best.sort ? current : best);
    }

    private stripDiagnosticBadge(label: string): string {
        return label.replace(/\s+\[(?:x|!)\d+\](?:\s+\[(?:x|!)\d+\])*$/i, '');
    }

    private getDiagnosticCounts(item: vscode.TreeItem): { errors: number; warnings: number } {
        const tooltip = this.toTooltip(item.tooltip) || '';
        const errorsMatch = tooltip.match(/(\d+)\s+error(?:s)?/i);
        const warningsMatch = tooltip.match(/(\d+)\s+warning(?:s)?/i);
        return {
            errors: errorsMatch ? Number(errorsMatch[1]) : 0,
            warnings: warningsMatch ? Number(warningsMatch[1]) : 0
        };
    }

    private getIconClass(itemType: TwinCATItemType, fileKind?: string): string {
        if (itemType === TwinCATItemType.File) {
            switch (fileKind) {
                case 'functionBlock':
                    return 'codicon-symbol-class';
                case 'program':
                    return 'codicon-symbol-method';
                case 'interface':
                    return 'codicon-type-hierarchy-super';
                case 'gvl':
                    return 'codicon-symbol-variable';
                case 'dut':
                    return 'codicon-symbol-struct';
                case 'function':
                    return 'codicon-symbol-function';
                default:
                    return 'codicon-file-code';
            }
        }
        const iconMap: Record<TwinCATItemType, string> = {
            [TwinCATItemType.StatusInfo]: 'codicon-info',
            [TwinCATItemType.StatusWarning]: 'codicon-warning',
            [TwinCATItemType.SystemRoot]: 'codicon-server-environment',
            [TwinCATItemType.PlcRoot]: 'codicon-circuit-board',
            [TwinCATItemType.IoRoot]: 'codicon-plug',
            [TwinCATItemType.ReferencesRoot]: 'codicon-references',
            [TwinCATItemType.ReferenceItem]: 'codicon-library',
            [TwinCATItemType.Folder]: 'codicon-folder',
            [TwinCATItemType.PlcProjectFolder]: 'codicon-circuit-board',
            [TwinCATItemType.File]: 'codicon-file-code',
            [TwinCATItemType.POUFolder]: 'codicon-folder',
            [TwinCATItemType.Method]: 'codicon-symbol-method',
            [TwinCATItemType.Property]: 'codicon-symbol-property',
            [TwinCATItemType.PropertyGet]: 'codicon-arrow-circle-down',
            [TwinCATItemType.PropertySet]: 'codicon-arrow-circle-up',
            [TwinCATItemType.Action]: 'codicon-symbol-event',
            [TwinCATItemType.Transition]: 'codicon-symbol-interface'
        };
        return iconMap[itemType];
    }

    private getIconColorClass(itemType: TwinCATItemType, fileKind?: string): string {
        if (itemType === TwinCATItemType.File) {
            switch (fileKind) {
                case 'functionBlock':
                    return 'color-file-pou';
                case 'program':
                    return 'color-file-program';
                case 'interface':
                    return 'color-file-interface';
                case 'gvl':
                    return 'color-file-gvl';
                case 'dut':
                    return 'color-file-dut';
                case 'function':
                    return 'color-file-function';
                default:
                    return 'color-file';
            }
        }
        const colorMap: Record<TwinCATItemType, string> = {
            [TwinCATItemType.StatusInfo]: 'color-info',
            [TwinCATItemType.StatusWarning]: 'color-warning',
            [TwinCATItemType.SystemRoot]: 'color-system',
            [TwinCATItemType.PlcRoot]: 'color-plc',
            [TwinCATItemType.IoRoot]: 'color-io',
            [TwinCATItemType.ReferencesRoot]: 'color-reference',
            [TwinCATItemType.ReferenceItem]: 'color-reference',
            [TwinCATItemType.Folder]: 'color-folder',
            [TwinCATItemType.PlcProjectFolder]: 'color-plc',
            [TwinCATItemType.File]: 'color-file',
            [TwinCATItemType.POUFolder]: 'color-folder',
            [TwinCATItemType.Method]: 'color-method',
            [TwinCATItemType.Property]: 'color-property',
            [TwinCATItemType.PropertyGet]: 'color-property-get',
            [TwinCATItemType.PropertySet]: 'color-property-set',
            [TwinCATItemType.Action]: 'color-action',
            [TwinCATItemType.Transition]: 'color-transition'
        };
        return colorMap[itemType];
    }

    private toLabel(label: string | vscode.TreeItemLabel | undefined): string {
        if (!label) {
            return '';
        }
        return typeof label === 'string' ? label : label.label;
    }

    private toTooltip(tooltip: string | vscode.MarkdownString | undefined): string | undefined {
        if (!tooltip) {
            return undefined;
        }
        return typeof tooltip === 'string' ? tooltip : tooltip.value;
    }

    private getItemId(item: TwinCATFileTreeItem): string {
        const uri = item.targetUri.toString();
        return `${item.itemType}::${item.parentPath || ''}::${uri}`;
    }

    private renderHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const codiconCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${codiconCss}">
    <style>
${this.renderStyles()}
    </style>
</head>
<body>
${this.renderMarkup()}
    <script nonce="${nonce}">
${this.renderScript()}
    </script>
</body>
</html>`;
    }

    private renderStyles(): string {
        return `
        :root {
            color-scheme: light dark;
            --bg: var(--vscode-sideBar-background);
            --fg: var(--vscode-foreground);
            --muted: var(--vscode-descriptionForeground);
            --list-fg: var(--vscode-list-foreground, var(--fg));
            --list-hover-fg: var(--vscode-list-hoverForeground, var(--list-fg));
            --list-active-fg: var(--vscode-list-activeSelectionForeground, var(--list-fg));
            --list-inactive-fg: var(--vscode-list-inactiveSelectionForeground, var(--list-fg));
            --border: color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
            --hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, transparent);
            --focus: var(--vscode-focusBorder);
            --chip-bg: color-mix(in srgb, var(--vscode-button-secondaryBackground) 70%, transparent);
            --chip-fg: var(--vscode-button-secondaryForeground);
            --warn: var(--vscode-list-warningForeground);
            --err: var(--vscode-list-errorForeground);
            --header: var(--vscode-sideBarSectionHeader-background);
            --header-border: var(--vscode-sideBarSectionHeader-border);
            --indent-step: 8px;
            --tree-left-gutter: 6px;
            --guide: var(--vscode-tree-indentGuidesStroke);
            --color-system: var(--vscode-charts-purple);
            --color-plc: var(--vscode-charts-blue);
            --color-io: var(--vscode-charts-green);
            --color-folder: var(--vscode-charts-orange);
            --color-file: var(--vscode-terminal-ansiBrightBlue);
            --color-file-pou: var(--vscode-terminal-ansiBrightBlue);
            --color-file-program: var(--vscode-charts-green);
            --color-file-interface: var(--vscode-terminal-ansiBrightMagenta);
            --color-file-gvl: var(--vscode-charts-green);
            --color-file-dut: var(--vscode-charts-purple);
            --color-file-function: var(--vscode-terminal-ansiBlue);
            --color-reference: var(--vscode-terminal-ansiCyan);
            --color-method: var(--vscode-charts-purple);
            --color-property: var(--vscode-charts-red);
            --color-property-get: var(--vscode-charts-green);
            --color-property-set: var(--vscode-charts-blue);
            --color-action: var(--vscode-charts-green);
            --color-transition: var(--vscode-terminal-ansiYellow);
            --color-info: var(--vscode-charts-blue);
            --caret-size: 22px;
            --caret-center: calc(var(--caret-size) / 2);
            --row-height: 10px;
            --scrollbar-lane: 10px;
        }
        html, body {
            height: 100%;
            width: 100%;
        }
        body {
            margin: 0;
            padding: 0;
            background: var(--bg);
            color: var(--fg);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size, 13px);
            font-weight: var(--vscode-font-weight, 400);
            line-height: 1.4;
            overflow: hidden;
        }
        .shell {
            width: 100%;
            height: 100%;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            padding-left: 2px;
            padding-right: 0px;
        }
        .tree-viewport {
            flex: 1;
            width: 100%;
            min-height: 0;
            overflow-x: auto;
            overflow-y: auto;
            margin: 0;

            padding-right: 0;

             /* overlay style behavior */
            scrollbar-width: thin;
            scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
            outline: none;
            box-sizing: border-box;
        }
        .tree-viewport:hover {
            scrollbar-color: color-mix(in srgb, var(--muted) 46%, transparent) transparent;
        }
        .tree-viewport::-webkit-scrollbar {
            width: var(--scrollbar-lane);
            height: var(--scrollbar-lane);
            background: transparent;
        }
        .tree-viewport::-webkit-scrollbar-button {
            display: none !important;
            width: 0 !important;
            height: 0 !important;
        }
        .tree-viewport::-webkit-scrollbar-corner {
            background: transparent;
        }
        .tree-viewport::-webkit-scrollbar-track {
            background: transparent;
        }
        .tree-viewport::-webkit-scrollbar-thumb {
            background-color: var(--vscode-scrollbarSlider-background);
            border-radius: 0;
            border: none;
        }

        .tree-viewport::-webkit-scrollbar-thumb:hover {
            background-color: var(--vscode-scrollbarSlider-hoverBackground);
        }

        .tree-viewport::-webkit-scrollbar-thumb:active {
            background-color: var(--vscode-scrollbarSlider-activeBackground);
        }
        .tree {
            display: flex;
            flex-direction: column;
            gap: 2px;
            width: 100%;
            min-width: 0;
            min-height: 100%;
            margin: 0;
            padding-right: 0;
            box-sizing: border-box;
        }
        .node {
            display: flex;
            flex-direction: column;
            width: 100%;
            min-width: 0;
            box-sizing: border-box;
        }
        .row {
            contain: layout paint;
            display: grid;
            grid-template-columns: var(--caret-size, 10px) minmax(0, 1fr) auto;
            gap: 4px;
            align-items: center;
            min-height: var(--row-height);
            padding-top: 2px;
            padding-bottom: 2px;
            padding-left: calc(var(--tree-left-gutter) + (var(--depth, 0) * var(--indent-step)));
            border-radius: 0px;
            cursor: default;
            border: 1px solid transparent;
            background: transparent;
            min-width: 100%;
            width: 100%;
            box-sizing: border-box;
            font: inherit;
            color: var(--list-fg);
            text-align: left;
            appearance: none;
            -webkit-appearance: none;
            position: relative;
            isolation: isolate;
        }
        .node.expanded > .row {
            position: sticky;
            top: calc(var(--depth, 0) * var(--row-height));
            z-index: calc(200 - var(--depth, 0));
            background: var(--bg);
        }
        .row.openable { cursor: pointer; }
        .row::before {
            content: '';
            position: absolute;
            inset: 0;

            /* extend highlight edge to edge */
            left: calc(-1 * (var(--tree-left-gutter) + (var(--depth, 0) * var(--indent-step))));

            right: calc(-1 * var(--scrollbar-lane));

            border-radius: 0px;
            background: transparent;
            z-index: -1;
            pointer-events: none;
        }
        .row:hover {
            color: var(--list-hover-fg);
        }
        .row:hover::before { background: var(--hover); }
        .row:hover ~ .children::before {
            background: color-mix(in srgb, var(--bg) 40%, var(--guide) 60%);
        }
        .row:focus-visible { outline: none; border-color: var(--focus); }
        .row.selected {
            color: var(--list-inactive-fg);
        }
        .tree-viewport:focus-within .row.selected {
            color: var(--list-active-fg);
        }
        .row.selected::before {
            background: var(--vscode-list-activeSelectionBackground);
        }
        .row.selected .text,
        .row.selected .description,
        .row.selected .diagnostics,
        .row.selected .diag-badge,
        .row.selected .scm-badge {
            color: inherit;
        }
        .row.cut {
            color: color-mix(in srgb, var(--fg) 42%, var(--muted) 58%);
        }
        .row.cut .description {
            color: color-mix(in srgb, var(--muted) 82%, transparent);
        }
        .row.cut .icon {
            opacity: 0.46;
            filter: saturate(0.75);
        }
        .row.warning .text,
        .row.warning .description { color: var(--warn); }
        .row.error .text,
        .row.error .description { color: var(--err); }
        .caret {
            width: var(--caret-size);
            height: var(--caret-size);
            flex: 0 0 var(--caret-size);
            user-select: none;
            position: relative;
        }
        .caret.collapsible { cursor: pointer; }
        .caret.collapsible::before {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 0;
            height: 0;
            border-top: 3px solid transparent;
            border-bottom: 3px solid transparent;
            border-left: 4px solid var(--muted);
            transition: transform 90ms ease;
            transform-origin: 2px 3px;
        }
        .node.expanded > .row .caret.collapsible::before {
            transform: rotate(90deg);
        }
        .main {
            min-width: 0;
            width: 100%;
            display: flex;
            align-items: center;
            gap: 4px;
            overflow: hidden;
        }
        .icon {
            width: 16px;
            min-width: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex: 0 0 auto;
            color: var(--muted);
        }
        .icon.color-system { color: var(--color-system); }
        .icon.color-plc { color: var(--color-plc); }
        .icon.color-io { color: var(--color-io); }
        .icon.color-folder { color: var(--color-folder); }
        .icon.color-file { color: var(--color-file); }
        .icon.color-file-pou { color: var(--color-file-pou); }
        .icon.color-file-program { color: var(--color-file-program); }
        .icon.color-file-interface { color: var(--color-file-interface); }
        .icon.color-file-gvl { color: var(--color-file-gvl); }
        .icon.color-file-dut { color: var(--color-file-dut); }
        .icon.color-file-function { color: var(--color-file-function); }
        .icon.color-reference { color: var(--color-reference); }
        .icon.color-method { color: var(--color-method); }
        .icon.color-property { color: var(--color-property); }
        .icon.color-property-get { color: var(--color-property-get); }
        .icon.color-property-set { color: var(--color-property-set); }
        .icon.color-action { color: var(--color-action); }
        .icon.color-transition { color: var(--color-transition); }
        .icon.color-warning { color: var(--warn); }
        .icon.color-info { color: var(--color-info); }
        .label {
            min-width: 0;
            flex: 1 1 auto;
            display: flex;
            align-items: baseline;
            gap: 6px;
            white-space: nowrap;
            overflow: hidden;
        }
        .text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .description {
            color: var(--muted);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .row:hover .description,
        .row.selected .description {
            color: inherit;
        }
        .row.drop-target::before {
            background: color-mix(in srgb, var(--vscode-list-dropBackground) 72%, transparent);
        }
        .inline-name {
            width: 100%;
            min-width: 0;
            padding: 0 4px;
            border: 1px solid var(--focus);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font: inherit;
            line-height: 1.4;
            box-sizing: border-box;
        }
        .diagnostics {
            display: inline-flex;
            flex: 0 0 auto;
            align-items: center;
            justify-content: flex-end;
            gap: 4px;
            min-width: 0;
            padding-right: 2px;
            margin-right: 0;
        }
        .diag-badge {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            min-height: 16px;
            padding: 0 5px;
            border-radius: 999px;
            font-size: 11px;
            line-height: 1;
            font-weight: 500;
            background: color-mix(in srgb, var(--muted) 14%, transparent);
            color: var(--muted);
            white-space: nowrap;
        }
        .diag-badge.error {
            background: color-mix(in srgb, var(--err) 18%, transparent);
            color: var(--err);
        }
        .diag-badge.warning {
            background: color-mix(in srgb, var(--warn) 20%, transparent);
            color: var(--warn);
        }
        .diag-badge .codicon {
            font-size: 11px;
        }
        .scm-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 14px;
            height: 14px;
            padding: 0 4px;
            border-radius: 999px;
            font-size: 10px;
            line-height: 1;
            font-weight: 600;
            background: color-mix(in srgb, var(--muted) 8%, transparent);
            color: color-mix(in srgb, var(--fg) 84%, var(--muted) 16%);
        }
        .scm-badge.m { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
        .scm-badge.a { color: var(--vscode-gitDecoration-addedResourceForeground); }
        .scm-badge.d { color: var(--vscode-gitDecoration-deletedResourceForeground); }
        .scm-badge.r { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
        .scm-badge.u { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
        .scm-badge.\! { color: var(--vscode-gitDecoration-conflictingResourceForeground, var(--vscode-list-errorForeground)); }
        .children {
            display: none;
            margin-left: 0;
            border-left: none;
            padding-left: 0;
            position: relative;
        }
        .node.expanded > .children { display: flex; flex-direction: column; gap: 2px; }
        .children::before {
            content: '';
            position: absolute;
            top: 0;
            bottom: 0;
            left: calc(
                var(--tree-left-gutter) +
                var(--caret-center) +
                ((var(--child-depth, 1) - 1) * var(--indent-step))
            );
            width: 1px;
            background: color-mix(in srgb, var(--bg) 58%, var(--guide) 42%);
            transform: scaleX(0.6);
            transform-origin: center;
            opacity: 0;
            transition: opacity 180ms ease;
            pointer-events: none;
        }
        .tree-viewport:hover .node.expanded > .children::before { opacity: 1; }
        .empty {
            padding: 10px 6px;
            color: var(--muted);
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
        }
        .empty-action {
            border: 1px solid var(--vscode-button-border, transparent);
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font: inherit;
            padding: 4px 10px;
            cursor: pointer;
        }
        .empty-action:hover {
            background: var(--vscode-button-hoverBackground);
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation: none !important;
                transition: none !important;
                scroll-behavior: auto !important;
            }
        }
`;
    }

    private renderMarkup(): string {
        return `    <div class="shell">
        <div class="tree-viewport" id="tree-viewport" tabindex="0" role="tree" aria-label="TcView Explorer Preview">
            <div class="tree" id="tree">
                <div class="empty">Loading TcView explorer...</div>
            </div>
        </div>
    </div>`;
    }

    private renderScript(): string {
        return `
        const vscode = acquireVsCodeApi();
        const treeViewport = document.getElementById('tree-viewport');
        const tree = document.getElementById('tree');
        const expanded = new Set();
        const nodeIndex = new Map();
        let selectedId = '';
        let draftEditor = null;
        let dragSourceId = '';

        const renderNodes = (container, nodes, depth = 0) => {
            container.textContent = '';
            if (!nodes.length) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                const message = document.createElement('div');
                message.textContent = 'No TwinCAT content loaded.';
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'empty-action';
                button.textContent = 'Open TwinCAT Solution';
                button.addEventListener('click', () => {
                    vscode.postMessage({ type: 'action', id: '', action: 'openSolution' });
                });
                empty.appendChild(message);
                empty.appendChild(button);
                container.appendChild(empty);
                return;
            }

            for (const node of nodes) {
                nodeIndex.set(node.id, node);
                container.appendChild(renderNode(node, depth));
            }
        };

        const renderDiagnostics = (container, node) => {
            container.textContent = '';
            if (node.errorCount > 0) {
                const errorBadge = document.createElement('div');
                errorBadge.className = 'diag-badge error';
                errorBadge.innerHTML = '<span class=\"codicon codicon-error\"></span><span>' + node.errorCount + '</span>';
                container.appendChild(errorBadge);
            }
            if (node.warningCount > 0) {
                const warningBadge = document.createElement('div');
                warningBadge.className = 'diag-badge warning';
                warningBadge.innerHTML = '<span class=\"codicon codicon-warning\"></span><span>' + node.warningCount + '</span>';
                container.appendChild(warningBadge);
            }
            if (node.scmBadge) {
                const scmBadge = document.createElement('div');
                scmBadge.className = 'scm-badge ' + node.scmBadge.toLowerCase();
                scmBadge.textContent = node.scmBadge;
                if (node.scmTooltip) {
                    scmBadge.title = node.scmTooltip;
                }
                container.appendChild(scmBadge);
            }
        };

        const applyNodeState = (node) => {
            nodeIndex.set(node.id, node);
            const row = tree.querySelector('.row[data-id="' + CSS.escape(node.id) + '"]');
            if (!row) {
                return;
            }

            row.title = node.tooltip || node.label;
            row.classList.remove('error', 'warning', 'none', 'cut');
            if (node.severity && node.severity !== 'none') {
                row.classList.add(node.severity);
            }
            row.classList.toggle('cut', !!node.isCut);

            const text = row.querySelector(':scope > .main .text');
            if (text) {
                text.textContent = node.label;
            }

            const label = row.querySelector(':scope > .main .label');
            if (label) {
                let description = label.querySelector(':scope > .description');
                if (node.description) {
                    if (!description) {
                        description = document.createElement('div');
                        description.className = 'description';
                        label.appendChild(description);
                    }
                    description.textContent = node.description;
                } else if (description) {
                    description.remove();
                }
            }

            const diagnostics = row.querySelector(':scope > .diagnostics');
            if (diagnostics) {
                renderDiagnostics(diagnostics, node);
            }

            if (Array.isArray(node.children)) {
                for (const child of node.children) {
                    applyNodeState(child);
                }
            }
        };

        const renderNode = (node, depth) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'node';
            wrapper.dataset.id = node.id;
            wrapper.dataset.depth = String(depth);
            const isExpanded = expanded.has(node.id) || (!!node.children && node.children.length > 0);
            if (isExpanded) {
                expanded.add(node.id);
                wrapper.classList.add('expanded');
            }

            const row = document.createElement(node.openable ? 'button' : 'div');
            row.className = ['row', node.openable ? 'openable' : '', node.severity].filter(Boolean).join(' ');
            if (node.isCut) {
                row.classList.add('cut');
            }
            row.style.setProperty('--depth', String(depth));
            row.title = node.tooltip || node.label;
            row.dataset.id = node.id;
            row.dataset.collapsible = String(node.collapsible);
            row.dataset.openable = String(node.openable);
            row.dataset.itemType = node.itemType;
            const vscodeContext = JSON.stringify({
                webviewSection: 'tcview.node',
                preventDefaultContextMenuItems: true,
                tcviewItemType: node.itemType,
                tcviewFileKind: node.fileKind
            });
            row.setAttribute('data-vscode-context', vscodeContext);
            row.tabIndex = -1;
            row.id = 'treeitem-' + node.id;
            row.setAttribute('role', 'treeitem');
            row.setAttribute('aria-level', String(depth + 1));
            row.setAttribute('aria-selected', String(selectedId === node.id));
            if (node.collapsible) {
                row.setAttribute('aria-expanded', String(isExpanded));
            }
            if (selectedId === node.id) {
                row.classList.add('selected');
            }
            if (node.openable) {
                row.type = 'button';
            }
            const isDraggable = ['folder', 'file', 'pouFolder', 'method', 'property', 'action', 'transition'].includes(node.itemType);
            if (isDraggable) {
                row.draggable = true;
                row.addEventListener('dragstart', (event) => {
                    dragSourceId = node.id;
                    setSelected(node.id, true);
                    event.dataTransfer?.setData('text/plain', node.id);
                    if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = 'copyMove';
                    }
                });
                row.addEventListener('dragend', () => {
                    dragSourceId = '';
                    row.classList.remove('drop-target');
                });
            }
            row.addEventListener('click', (event) => {
                if (event.target instanceof HTMLElement && event.target.closest('.caret')) {
                    return;
                }
                setSelected(node.id, true);
            });
            row.addEventListener('dragover', (event) => {
                if (!dragSourceId || dragSourceId === node.id) {
                    return;
                }
                event.preventDefault();
                row.classList.add('drop-target');
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? 'copy' : 'move';
                }
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('drop-target');
            });
            row.addEventListener('drop', (event) => {
                if (!dragSourceId || dragSourceId === node.id) {
                    return;
                }
                event.preventDefault();
                row.classList.remove('drop-target');
                const mode = event.ctrlKey || event.metaKey ? 'copy' : 'move';
                setSelected(node.id, true);
                vscode.postMessage({
                    type: 'action',
                    id: node.id,
                    action: 'dropTwinCatItem',
                    value: JSON.stringify({ sourceId: dragSourceId, mode })
                });
                dragSourceId = '';
            });
            if (node.openable) {
                row.addEventListener('dblclick', (event) => {
                    if (event.target instanceof HTMLElement && event.target.closest('.caret')) {
                        return;
                    }
                    setSelected(node.id, true);
                    vscode.postMessage({ type: 'open', id: node.id });
                });
            }
            const caret = document.createElement('div');
            caret.className = ['caret', node.collapsible ? 'collapsible' : ''].filter(Boolean).join(' ');
            caret.setAttribute('aria-hidden', 'true');
            if (node.collapsible) {
                caret.addEventListener('click', (event) => {
                    event.stopPropagation();
                    if (expanded.has(node.id)) {
                        expanded.delete(node.id);
                        wrapper.classList.remove('expanded');
                        row.setAttribute('aria-expanded', 'false');
                        vscode.postMessage({ type: 'toggle', id: node.id, expanded: false });
                    } else {
                        expanded.add(node.id);
                        wrapper.classList.add('expanded');
                        row.setAttribute('aria-expanded', 'true');
                        vscode.postMessage({ type: 'toggle', id: node.id, expanded: true });
                    }
                });
            }

            const main = document.createElement('div');
            main.className = 'main';
            const glyph = document.createElement('div');
            glyph.className = ['icon', 'codicon', node.iconClass, node.iconColorClass].filter(Boolean).join(' ');
            glyph.setAttribute('aria-hidden', 'true');
            const label = document.createElement('div');
            label.className = 'label';
            const text = document.createElement('div');
            text.className = 'text';
            text.textContent = node.label;
            label.appendChild(text);
            if (node.description) {
                const description = document.createElement('div');
                description.className = 'description';
                description.textContent = node.description;
                label.appendChild(description);
            }
            main.appendChild(glyph);
            main.appendChild(label);

            const diagnostics = document.createElement('div');
            diagnostics.className = 'diagnostics';
            renderDiagnostics(diagnostics, node);

            row.appendChild(caret);
            row.appendChild(main);
            row.appendChild(diagnostics);

            const children = document.createElement('div');
            children.className = 'children';
            children.setAttribute('role', 'group');
            children.style.setProperty('--child-depth', String(depth + 1));
            wrapper.appendChild(row);
            wrapper.appendChild(children);
            if (node.children?.length) {
                renderNodes(children, node.children, depth + 1);
            }
            return wrapper;
        };

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.type === 'roots') {
                const previousScrollTop = treeViewport.scrollTop;
                nodeIndex.clear();
                renderNodes(tree, message.nodes || [], 0);
                ensureSelectedVisible();
                treeViewport.scrollTop = previousScrollTop;
                return;
            }
            if (message.type === 'state') {
                for (const node of message.nodes || []) {
                    applyNodeState(node);
                }
                ensureSelectedVisible();
                return;
            }
            if (message.type === 'beginRename') {
                const node = nodeIndex.get(message.id || selectedId);
                if (node) {
                    startRenameInline(node);
                }
                return;
            }
            if (message.type === 'beginCreateFolder') {
                const node = nodeIndex.get(message.id || selectedId);
                if (node) {
                    startCreateFolderInline(node);
                }
                return;
            }
            if (message.type === 'beginCreateFile') {
                const node = nodeIndex.get(message.id || selectedId);
                if (node) {
                    startCreateFileInline(node, message.templateId, message.extension);
                }
                return;
            }
            if (message.type === 'beginCreateMember') {
                const node = nodeIndex.get(message.id || selectedId);
                if (node) {
                    startCreateMemberInline(node, message.kind);
                }
            }
        });

        const getVisibleRows = () => Array.from(tree.querySelectorAll('.row'));

        const clearDraftEditor = () => {
            if (!draftEditor) {
                return;
            }
            if (draftEditor.mode === 'rename') {
                const label = draftEditor.row.querySelector('.label');
                if (label && draftEditor.originalLabel) {
                    label.replaceWith(draftEditor.originalLabel);
                }
            } else if (draftEditor.mode === 'createFolder' || draftEditor.mode === 'createFile' || draftEditor.mode === 'createMember') {
                draftEditor.wrapper.remove();
            }
            draftEditor = null;
        };

        const commitDraftEditor = () => {
            if (!draftEditor) {
                return;
            }
            const value = draftEditor.input.value.trim();
            if (!value) {
                clearDraftEditor();
                return;
            }
            const action = draftEditor.mode === 'rename'
                ? 'renameTwinCatItem'
                : draftEditor.mode === 'createFolder'
                    ? 'createTwinCatFolder'
                    : draftEditor.mode === 'createFile'
                        ? 'createTwinCatFileTemplate'
                        : draftEditor.memberKind === 'method'
                            ? 'createTwinCatMethod'
                            : draftEditor.memberKind === 'property'
                                ? 'createTwinCatProperty'
                                : draftEditor.memberKind === 'action'
                                    ? 'createTwinCatAction'
                                    : 'createTwinCatTransition';
            const id = draftEditor.node.id;
            const actionValue = draftEditor.mode === 'createFile'
                ? JSON.stringify({ templateId: draftEditor.templateId, name: value })
                : draftEditor.mode === 'rename' && draftEditor.fileExtension
                    ? value + draftEditor.fileExtension
                : value;
            clearDraftEditor();
            vscode.postMessage({ type: 'action', id, action, value: actionValue });
        };

        const createInlineInput = (value) => {
            const input = document.createElement('input');
            input.className = 'inline-name';
            input.type = 'text';
            input.value = value;
            const stopTreeInteraction = (event) => {
                event.stopPropagation();
            };
            input.addEventListener('mousedown', stopTreeInteraction);
            input.addEventListener('mouseup', stopTreeInteraction);
            input.addEventListener('click', stopTreeInteraction);
            input.addEventListener('dblclick', stopTreeInteraction);
            input.addEventListener('pointerdown', stopTreeInteraction);
            input.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commitDraftEditor();
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    clearDraftEditor();
                }
            });
            input.addEventListener('blur', (event) => {
                if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest('.inline-name')) {
                    return;
                }
                commitDraftEditor();
            });
            queueMicrotask(() => {
                input.focus();
                input.select();
            });
            return input;
        };

        const startRenameInline = (node) => {
            clearDraftEditor();
            const row = tree.querySelector('.row[data-id="' + CSS.escape(node.id) + '"]');
            if (!row) {
                return;
            }
            const label = row.querySelector('.label');
            if (!label) {
                return;
            }
            const originalLabel = label.cloneNode(true);
            const replacement = document.createElement('div');
            replacement.className = 'label';
            const fullName = node.itemType === 'file' && node.tooltip
                ? ((node.tooltip.split(/[/\\\\]/).pop()) || node.label)
                : node.label;
            const fileExtension = node.itemType === 'file'
                ? (fullName.match(/(\.[^.]+)$/)?.[1] || '')
                : '';
            const visibleName = fileExtension ? fullName.slice(0, -fileExtension.length) : fullName;
            const input = createInlineInput(visibleName);
            replacement.appendChild(input);
            label.replaceWith(replacement);
            draftEditor = { mode: 'rename', node, row, input, originalLabel, fileExtension };
        };

        const startCreateFolderInline = (node) => {
            clearDraftEditor();
            const parent = tree.querySelector('.node[data-id="' + CSS.escape(node.id) + '"]');
            if (!parent) {
                return;
            }
            const children = parent.querySelector(':scope > .children');
            if (!children) {
                return;
            }
            expanded.add(node.id);
            parent.classList.add('expanded');
            parent.querySelector(':scope > .row')?.setAttribute('aria-expanded', 'true');

            const depth = Number(parent.dataset.depth || '0') + 1;
            const wrapper = document.createElement('div');
            wrapper.className = 'node';
            wrapper.dataset.depth = String(depth);
            const row = document.createElement('div');
            row.className = 'row';
            row.style.setProperty('--depth', String(depth));
            const caret = document.createElement('div');
            caret.className = 'caret';
            const main = document.createElement('div');
            main.className = 'main';
            const glyph = document.createElement('div');
            glyph.className = 'icon codicon codicon-folder color-folder';
            const label = document.createElement('div');
            label.className = 'label';
            const input = createInlineInput('New Folder');
            label.appendChild(input);
            main.appendChild(glyph);
            main.appendChild(label);
            const diagnostics = document.createElement('div');
            diagnostics.className = 'diagnostics';
            row.appendChild(caret);
            row.appendChild(main);
            row.appendChild(diagnostics);
            wrapper.appendChild(row);
            children.prepend(wrapper);
            draftEditor = { mode: 'createFolder', node, input, wrapper };
        };

        const startCreateFileInline = (node, templateId, extension) => {
            clearDraftEditor();
            const parent = tree.querySelector('.node[data-id="' + CSS.escape(node.id) + '"]');
            if (!parent) {
                return;
            }
            const children = parent.querySelector(':scope > .children');
            if (!children) {
                return;
            }
            expanded.add(node.id);
            parent.classList.add('expanded');
            parent.querySelector(':scope > .row')?.setAttribute('aria-expanded', 'true');

            const depth = Number(parent.dataset.depth || '0') + 1;
            const wrapper = document.createElement('div');
            wrapper.className = 'node';
            wrapper.dataset.depth = String(depth);
            const row = document.createElement('div');
            row.className = 'row';
            row.style.setProperty('--depth', String(depth));
            const caret = document.createElement('div');
            caret.className = 'caret';
            const main = document.createElement('div');
            main.className = 'main';
            const glyph = document.createElement('div');
            glyph.className = 'icon codicon codicon-file-code color-file';
            const label = document.createElement('div');
            label.className = 'label';
            const input = createInlineInput('NewItem');
            label.appendChild(input);
            main.appendChild(glyph);
            main.appendChild(label);
            const diagnostics = document.createElement('div');
            diagnostics.className = 'diagnostics';
            row.appendChild(caret);
            row.appendChild(main);
            row.appendChild(diagnostics);
            wrapper.appendChild(row);
            children.prepend(wrapper);
            draftEditor = { mode: 'createFile', node, input, wrapper, templateId };
        };

        const startCreateMemberInline = (node, kind) => {
            clearDraftEditor();
            const parent = tree.querySelector('.node[data-id="' + CSS.escape(node.id) + '"]');
            if (!parent) {
                return;
            }
            const children = parent.querySelector(':scope > .children');
            if (!children) {
                return;
            }
            expanded.add(node.id);
            parent.classList.add('expanded');
            parent.querySelector(':scope > .row')?.setAttribute('aria-expanded', 'true');

            const depth = Number(parent.dataset.depth || '0') + 1;
            const wrapper = document.createElement('div');
            wrapper.className = 'node';
            wrapper.dataset.depth = String(depth);
            const row = document.createElement('div');
            row.className = 'row';
            row.style.setProperty('--depth', String(depth));
            const caret = document.createElement('div');
            caret.className = 'caret';
            const main = document.createElement('div');
            main.className = 'main';
            const glyph = document.createElement('div');
            const memberConfig = kind === 'method'
                ? { icon: 'codicon-symbol-method', color: 'color-method', name: 'NewMethod' }
                : kind === 'property'
                    ? { icon: 'codicon-symbol-property', color: 'color-property', name: 'NewProperty' }
                    : kind === 'action'
                        ? { icon: 'codicon-symbol-event', color: 'color-action', name: 'NewAction' }
                        : { icon: 'codicon-symbol-interface', color: 'color-transition', name: 'NewTransition' };
            glyph.className = ['icon', 'codicon', memberConfig.icon, memberConfig.color].join(' ');
            const label = document.createElement('div');
            label.className = 'label';
            const input = createInlineInput(memberConfig.name);
            label.appendChild(input);
            main.appendChild(glyph);
            main.appendChild(label);
            const diagnostics = document.createElement('div');
            diagnostics.className = 'diagnostics';
            row.appendChild(caret);
            row.appendChild(main);
            row.appendChild(diagnostics);
            wrapper.appendChild(row);
            children.prepend(wrapper);
            draftEditor = { mode: 'createMember', memberKind: kind, node, input, wrapper };
        };

        const setSelected = (id, focusTree = false) => {
            selectedId = id;
            for (const row of getVisibleRows()) {
                row.classList.toggle('selected', row.dataset.id === id);
                row.setAttribute('aria-selected', String(row.dataset.id === id));
            }
            treeViewport.setAttribute('aria-activedescendant', selectedId ? ('treeitem-' + selectedId) : '');
            if (selectedId) {
                vscode.postMessage({ type: 'select', id: selectedId });
            }
            if (focusTree) {
                treeViewport.focus();
            }
        };

        const ensureSelectedVisible = () => {
            const rows = getVisibleRows();
            if (!rows.length) {
                selectedId = '';
                return;
            }
            if (!selectedId || !rows.some(row => row.dataset.id === selectedId)) {
                selectedId = rows[0].dataset.id || '';
            }
            setSelected(selectedId);
        };

        const findParentId = (id) => {
            const node = tree.querySelector('.node[data-id="' + CSS.escape(id) + '"]');
            const parentNode = node?.parentElement?.closest('.node[data-id]');
            return parentNode?.dataset.id || '';
        };

        const handleTreeKeyDown = (event) => {
            if (event.key === 'Escape') {
                clearDraftEditor();
                return;
            }
            if (draftEditor) {
                return;
            }
            const rows = getVisibleRows();
            if (!rows.length) {
                return;
            }

            let index = rows.findIndex(row => row.dataset.id === selectedId);
            if (index < 0) {
                index = 0;
                selectedId = rows[0].dataset.id || '';
            }
            const current = rows[index];
            const currentId = current.dataset.id || '';
            const currentNodeData = nodeIndex.get(currentId);
            const currentNode = tree.querySelector('.node[data-id="' + CSS.escape(currentId) + '"]');
            const isExpanded = currentNode?.classList.contains('expanded');
            const isCollapsible = current.dataset.collapsible === 'true';
            const isCommandModifier = event.ctrlKey || event.metaKey;

            if (event.key === 'ArrowDown' && index < rows.length - 1) {
                event.preventDefault();
                setSelected(rows[index + 1].dataset.id || '');
                rows[index + 1].scrollIntoView({ block: 'nearest' });
                return;
            }
            if (event.key === 'ArrowUp' && index > 0) {
                event.preventDefault();
                setSelected(rows[index - 1].dataset.id || '');
                rows[index - 1].scrollIntoView({ block: 'nearest' });
                return;
            }
            if (event.key === 'ArrowRight') {
                event.preventDefault();
                if (isCollapsible && !isExpanded) {
                    expanded.add(currentId);
                    currentNode?.classList.add('expanded');
                    current.setAttribute('aria-expanded', 'true');
                    vscode.postMessage({ type: 'toggle', id: currentId, expanded: true });
                    return;
                }
                if (isCollapsible && isExpanded) {
                    const child = currentNode?.querySelector(':scope > .children .row');
                    if (child?.dataset.id) {
                        setSelected(child.dataset.id);
                        child.scrollIntoView({ block: 'nearest' });
                    }
                    return;
                }
                if (current.dataset.openable === 'true') {
                    vscode.postMessage({ type: 'open', id: currentId });
                }
                return;
            }
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                if (isCollapsible && isExpanded) {
                    expanded.delete(currentId);
                    currentNode?.classList.remove('expanded');
                    current.setAttribute('aria-expanded', 'false');
                    vscode.postMessage({ type: 'toggle', id: currentId, expanded: false });
                    return;
                }
                const parentId = findParentId(currentId);
                if (parentId) {
                    setSelected(parentId);
                    const parentRow = tree.querySelector('.row[data-id="' + CSS.escape(parentId) + '"]');
                    parentRow?.scrollIntoView({ block: 'nearest' });
                }
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                if (current.dataset.openable === 'true') {
                    vscode.postMessage({ type: 'open', id: currentId });
                } else if (isCollapsible) {
                    const nextExpanded = !isExpanded;
                    if (nextExpanded) {
                        expanded.add(currentId);
                        currentNode?.classList.add('expanded');
                        current.setAttribute('aria-expanded', 'true');
                    } else {
                        expanded.delete(currentId);
                        currentNode?.classList.remove('expanded');
                        current.setAttribute('aria-expanded', 'false');
                    }
                    vscode.postMessage({ type: 'toggle', id: currentId, expanded: nextExpanded });
                }
                return;
            }
        };

        treeViewport.addEventListener('keydown', handleTreeKeyDown);

        treeViewport.addEventListener('click', (event) => {
            if (event.target instanceof HTMLElement && event.target.closest('.inline-name')) {
                return;
            }
            const row = event.target instanceof HTMLElement ? event.target.closest('.row') : null;
            if (row?.dataset.id) {
                setSelected(row.dataset.id, true);
            }
        });

        treeViewport.addEventListener('pointerdown', (event) => {
            if (!(event.target instanceof HTMLElement) || event.target.closest('.inline-name')) {
                return;
            }
            const row = event.target.closest('.row');
            if (!row?.dataset.id) {
                return;
            }
            setSelected(row.dataset.id, false);
            if (event.button !== 0) {
                treeViewport.focus();
            }
            vscode.postMessage({ type: 'context', id: row.dataset.id });
        }, true);

        treeViewport.addEventListener('focus', () => {
            vscode.postMessage({ type: 'focus' });
        });

        window.addEventListener('contextmenu', (event) => {
            if (!(event.target instanceof HTMLElement)) {
                return;
            }

            const row = event.target.closest('.row');
            if (!row || !tree.contains(row)) {
                return;
            }

            const node = nodeIndex.get(row.dataset.id || '');
            if (!node) {
                return;
            }
            setSelected(node.id, true);
            vscode.postMessage({ type: 'context', id: node.id });
        }, true);
        treeViewport.addEventListener('blur', (event) => {
            vscode.postMessage({ type: 'blur' });
            if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest('.inline-name')) {
                return;
            }
            clearDraftEditor();
        });

        treeViewport.addEventListener('wheel', (event) => {
            const isWheelLike = event.deltaMode !== 0 || Math.abs(event.deltaY) >= 50 || Math.abs(event.deltaX) >= 50;
            if (!isWheelLike || event.ctrlKey) {
                return;
            }
            event.preventDefault();
            treeViewport.scrollTop += event.deltaY * 0.82;
            treeViewport.scrollLeft += event.deltaX * 0.82;
        }, { passive: false });

        vscode.postMessage({ type: 'ready' });
`;
    }
}
