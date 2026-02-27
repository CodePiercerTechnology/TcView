import * as vscode from 'vscode';
import * as xml2js from 'xml2js';
import { TwinCATXmlConverter } from './twinCATXmlConverter';

interface CachedDocument {
    stContent: string;
    sourceLastModified: number;
}

export class TwinCATDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {

    public static readonly scheme = 'twincat';
    private readonly converter = new TwinCATXmlConverter();

    private readonly contentCache = new Map<string, CachedDocument>();
    private readonly pendingConversions = new Map<string, Promise<string>>();
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.setupAutoInvalidation();
    }

    // -------------------------------------------------
    // Public API
    // -------------------------------------------------

    public setContent(uri: vscode.Uri, content: string): void {
        const cacheKey = this.getCacheKey(uri);
        this.contentCache.set(cacheKey, {
            stContent: content,
            sourceLastModified: Date.now()
        });
    }

    public clearCache(uri: vscode.Uri): void {
        this.contentCache.delete(this.getCacheKey(uri));
    }

    public clearAllCache(): void {
        this.contentCache.clear();
    }

    public update(uri: vscode.Uri): void {
        this._onDidChange.fire(uri);
    }

    // -------------------------------------------------
    // VS Code Hook
    // -------------------------------------------------

    public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const cacheKey = this.getCacheKey(uri);
        const filePath = this.getFilePathFromUri(uri);
        const fileUri = vscode.Uri.file(filePath);

        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const xmlContent = document.getText();

            // Default: show full POU
            let xmlForST = xmlContent;

            // Extract fragment type and name if requested
            const fragment = uri.fragment; // e.g., "Method:FB_Init"
            if (fragment) {
                const [type, name] = fragment.split(':');
                const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
                const xmlObj = await parser.parseStringPromise(xmlContent);

                const pou = xmlObj.TcPOU ?? xmlObj.TcPlcObject?.POU;
                if (pou) {
                    const element = this.findFragmentRecursively(pou, type, name);
                    if (element) {
                        xmlForST = element?.Implementation?.ST ?? '';
                    } else {
                        xmlForST = `// Fragment not found: ${type}:${name}`;
                    }
                }
            }

            const stCode = await this.converter.convertXmlToST(xmlForST);

            // Cache the result
            this.contentCache.set(cacheKey, {
                stContent: stCode,
                sourceLastModified: Date.now()
            });

            return stCode;

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `// TcView ST View Error\n// ${message}`;
        }
    }

    // -------------------------------------------------
    // Recursive Fragment Search
    // -------------------------------------------------

    private findFragmentRecursively(node: any, type: string, name: string): any {
        if (!node) return null;

        // Normalize candidates of the requested type
        const candidates = node[type] ? (Array.isArray(node[type]) ? node[type] : [node[type]]) : [];

        for (const el of candidates) {
            const elName = el?.Name?._ ?? el?.Name; // handle <Name>FB_Init</Name> or Name attribute
            if (elName === name) {
                return el;
            }
        }

        // Recurse into folders if present
        const folders = node.Folder ? (Array.isArray(node.Folder) ? node.Folder : [node.Folder]) : [];
        for (const folder of folders) {
            const found = this.findFragmentRecursively(folder, type, name);
            if (found) return found;
        }

        // Also recurse into other container types (e.g., Methods, Actions, Properties, Transitions)
        const childTypes = ['Method', 'Action', 'Property', 'Transition'];
        for (const childType of childTypes) {
            if (childType === type) continue; // skip already checked
            const children = node[childType] ? (Array.isArray(node[childType]) ? node[childType] : [node[childType]]) : [];
            for (const child of children) {
                const found = this.findFragmentRecursively(child, type, name);
                if (found) return found;
            }
        }

        return null;
    }

    // -------------------------------------------------
    // Auto Cache Invalidation
    // -------------------------------------------------

    private setupAutoInvalidation(): void {
        const saveDisposable = vscode.workspace.onDidSaveTextDocument(doc => {
            if (this.isTwinCATSourceFile(doc.uri)) {
                this.invalidateBySourcePath(doc.uri.fsPath);
            }
        });
        this.disposables.push(saveDisposable);
    }

    private invalidateBySourcePath(sourcePath: string): void {
        for (const [key] of this.contentCache.entries()) {
            if (key.includes(encodeURIComponent(sourcePath))) {
                this.contentCache.delete(key);
            }
        }
    }

    private isTwinCATSourceFile(uri: vscode.Uri): boolean {
        return /\.(tcpou|tcprg|tcapp|tccom)$/i.test(uri.fsPath);
    }

    // -------------------------------------------------
    // Helpers
    // -------------------------------------------------

    private getCacheKey(uri: vscode.Uri): string {
        return uri.toString(true);
    }

    private getFilePathFromUri(uri: vscode.Uri): string {
        if (!uri.query || uri.query.trim().length === 0) {
            throw new Error('Invalid TwinCAT URI: missing file path.');
        }
        return decodeURIComponent(uri.query);
    }

    // -------------------------------------------------
    // Cleanup
    // -------------------------------------------------

    public dispose(): void {
        this._onDidChange.dispose();
        this.contentCache.clear();
        this.pendingConversions.clear();
        for (const d of this.disposables) d.dispose();
    }
}
