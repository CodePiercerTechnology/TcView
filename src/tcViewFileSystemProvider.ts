import * as vscode from 'vscode';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { TwinCATXmlConverter } from './tcViewXmlConverter';
import { logError } from './tcViewTelemetry';
import { applyFragmentSTToXml, extractFragmentSTFromXml } from './tcViewFragmentCodec';

export class TwinCATFileSystemProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;
    
    private converter = new TwinCATXmlConverter();
    
    // Store mapping of virtual URIs to original XML file paths and their content
    private fileMap = new Map<string, { originalPath: string; content: Uint8Array; sourceMtimeMs: number }>();

    // Scheme for our virtual file system
    public static readonly scheme = 'twincat';

    // Create a virtual URI from an original file path
    static createVirtualUri(originalPath: string, fragment?: string): vscode.Uri {
        const fileName = path.basename(originalPath, path.extname(originalPath)) + '.st';
        const uri = vscode.Uri.parse(`${this.scheme}:/${fileName}?${encodeURIComponent(originalPath)}`);
        return fragment ? uri.with({ fragment }) : uri;
    }

    // Pre-populate the file cache before opening
    async preloadFile(originalPath: string, fragment?: string): Promise<vscode.Uri> {
        const virtualUri = TwinCATFileSystemProvider.createVirtualUri(originalPath, fragment);
        const sourceMtimeMs = await this.getSourceMtimeMs(originalPath);
        
        // Check if already cached
        const cached = this.fileMap.get(virtualUri.toString());
        if (cached && cached.sourceMtimeMs === sourceMtimeMs) {
            return virtualUri;
        }

        // Read and convert from original XML file
        const originalUri = vscode.Uri.file(originalPath);
        const xmlContent = await vscode.workspace.fs.readFile(originalUri);
        const xmlString = Buffer.from(xmlContent).toString('utf8');
        const stCode = fragment
            ? await this.convertXmlToFragmentST(xmlString, fragment)
            : await this.converter.convertXmlToST(xmlString);
        const content = Buffer.from(stCode, 'utf8');
        
        this.fileMap.set(virtualUri.toString(), {
            originalPath: originalPath,
            content: content,
            sourceMtimeMs
        });

        return virtualUri;
    }


    // Get original path from virtual URI
    static getOriginalPath(uri: vscode.Uri): string {
        return decodeURIComponent(uri.query);
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const data = this.fileMap.get(uri.toString());
        if (data) {
            return {
                type: vscode.FileType.File,
                ctime: Date.now(),
                mtime: Date.now(),
                size: data.content.length
            };
        }

        // Restored tabs may call stat before cache is rebuilt.
        const originalPath = TwinCATFileSystemProvider.getOriginalPath(uri);
        if (!originalPath) {
            throw vscode.FileSystemError.FileNotFound();
        }

        try {
            const sourceStat = await vscode.workspace.fs.stat(vscode.Uri.file(originalPath));
            return {
                type: vscode.FileType.File,
                ctime: sourceStat.ctime,
                mtime: sourceStat.mtime,
                size: Math.max(1, sourceStat.size)
            };
        } catch {
            throw vscode.FileSystemError.FileNotFound();
        }
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        return [];
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const uriString = uri.toString();
        
        const originalPath = TwinCATFileSystemProvider.getOriginalPath(uri);
        if (!originalPath) {
            return Buffer.from('// TwinCAT source path is missing from URI.\n', 'utf8');
        }

        try {
            const sourceMtimeMs = await this.getSourceMtimeMs(originalPath);
            const data = this.fileMap.get(uriString);
            if (data && data.sourceMtimeMs === sourceMtimeMs) {
                return data.content;
            }

            // Read and convert from original XML file
            const originalUri = vscode.Uri.file(originalPath);
            const xmlContent = await vscode.workspace.fs.readFile(originalUri);
            const xmlString = Buffer.from(xmlContent).toString('utf8');
            const stCode = uri.fragment
                ? await this.convertXmlToFragmentST(xmlString, uri.fragment)
                : await this.converter.convertXmlToST(xmlString);
            const content = Buffer.from(stCode, 'utf8');
            
            this.fileMap.set(uriString, {
                originalPath: originalPath,
                content: content,
                sourceMtimeMs
            });
            
            return content;
        } catch (error) {
            return Buffer.from(`// TwinCAT source file is unavailable: ${originalPath}\n`, 'utf8');
        }
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
        const uriString = uri.toString();
        const existing = this.fileMap.get(uriString);
        
        if (!existing && !options.create) {
            throw vscode.FileSystemError.FileNotFound();
        }
        
        if (existing) {
            // Update cached content
            existing.content = content;
            existing.sourceMtimeMs = Date.now();
        } else {
            // This shouldn't happen for our use case
            throw vscode.FileSystemError.FileNotFound();
        }

        // Notify that file changed
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    async saveToOriginal(uri: vscode.Uri): Promise<void> {
        const data = this.fileMap.get(uri.toString());
        if (!data) {
            throw new Error('File not found in cache');
        }

        const stCode = Buffer.from(data.content).toString('utf8');
        const originalUri = vscode.Uri.file(data.originalPath);
        
        // Read original XML to preserve structure
        const originalContent = await vscode.workspace.fs.readFile(originalUri);
        const originalXml = Buffer.from(originalContent).toString('utf8');

        let newXml: string;
        if (uri.fragment) {
            newXml = await this.applyFragmentSave(originalXml, uri.fragment, stCode);
        } else {
            // Convert ST back to XML
            newXml = await this.converter.convertSTToXml(stCode, originalXml);
        }
        
        // Atomic write with rollback backup to avoid partial/corrupt saves.
        await this.writeAtomicWithRollback(originalUri, Buffer.from(newXml, 'utf8'));

        // Refresh cache source timestamp after successful source write.
        data.sourceMtimeMs = await this.getSourceMtimeMs(data.originalPath);
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    delete(uri: vscode.Uri, options: { recursive: boolean }): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    createDirectory(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    private async convertXmlToFragmentST(xmlString: string, fragment: string): Promise<string> {
        return extractFragmentSTFromXml(xmlString, fragment);
    }

    private normalizeFragmentType(fragmentType: string): 'method' | 'property' | 'action' | 'transition' {
        if (fragmentType === 'propertyget' || fragmentType === 'propertyset' || fragmentType === 'property') {
            return 'property';
        }
        if (fragmentType === 'action') return 'action';
        if (fragmentType === 'transition') return 'transition';
        return 'method';
    }

    private findFragmentRecursively(node: any, type: 'method' | 'property' | 'action' | 'transition', name: string): any {
        if (!node) return undefined;

        const key = this.getElementKey(type);
        const candidates = this.toArray(node[key]);
        for (const candidate of candidates) {
            if ((candidate?.Name || '').toString() === name) {
                return candidate;
            }
        }

        for (const folder of this.toArray(node.Folder)) {
            const found = this.findFragmentRecursively(folder, type, name);
            if (found) return found;
        }

        return undefined;
    }

    private buildFragmentST(type: string, name: string, element: any): string {
        switch (type) {
            case 'method':
                return this.buildMethodLikeFragment('METHOD', name, element);
            case 'action':
                return this.buildMethodLikeFragment('ACTION', name, element);
            case 'transition':
                return this.buildMethodLikeFragment('TRANSITION', name, element);
            case 'propertyget':
                return this.buildSinglePropertyAccessorFragment(name, element, 'GET');
            case 'propertyset':
                return this.buildSinglePropertyAccessorFragment(name, element, 'SET');
            case 'property':
                return this.buildPropertyFragment(name, element);
            default:
                return this.buildMethodLikeFragment('METHOD', name, element);
        }
    }

    private buildMethodLikeFragment(kind: 'METHOD' | 'ACTION' | 'TRANSITION', name: string, element: any): string {
        const declaration = this.getTextContent(element?.Declaration).trim();
        const implementation = this.getImplementationText(element).trim();

        // Preserve full declaration (including pragmas/comments/VAR sections) when present.
        const header = declaration || [kind, name].join(' ');

        const parts: string[] = [header];
        if (implementation) {
            parts.push(implementation);
        }
        return parts.join('\n\n').trim() + '\n';
    }

    private buildPropertyFragment(name: string, element: any): string {
        const declaration = this.getTextContent(element?.Declaration).trim();
        const header = declaration && /\bPROPERTY\b/i.test(declaration)
            ? declaration
            : `PROPERTY ${name}`;

        const parts: string[] = [header];
        const getSection = this.buildPropertyAccessor('GET', element?.Get);
        const setSection = this.buildPropertyAccessor('SET', element?.Set);

        if (getSection) parts.push(getSection);
        if (setSection) parts.push(setSection);

        if (getSection || setSection) {
            parts.push('END_PROPERTY');
        }

        return parts.join('\n\n').trim() + '\n';
    }

    private buildSinglePropertyAccessorFragment(name: string, element: any, kind: 'GET' | 'SET'): string {
        const declaration = this.getTextContent(element?.Declaration).trim();
        const header = declaration && /\bPROPERTY\b/i.test(declaration)
            ? declaration
            : `PROPERTY ${name}`;

        const accessor = kind === 'GET' ? element?.Get : element?.Set;
        const accessorSection = this.buildPropertyAccessor(kind, accessor);
        if (!accessorSection) {
            return `${header}\n\n// ${kind} accessor not found.\n`;
        }

        return [header, accessorSection, 'END_PROPERTY'].join('\n\n').trim() + '\n';
    }

    private buildPropertyAccessor(kind: 'GET' | 'SET', accessor: any): string {
        if (!accessor) return '';

        const declaration = this.getTextContent(accessor?.Declaration).trim();
        const implementation = this.getImplementationText(accessor).trim();
        const header = declaration && new RegExp(`\\b${kind}\\b`, 'i').test(declaration)
            ? declaration
            : kind;

        const parts: string[] = [header];
        if (implementation) {
            parts.push(implementation);
        }
        return parts.join('\n\n').trim();
    }

    private getElementKey(type: 'method' | 'property' | 'action' | 'transition') {
        switch (type) {
            case 'method':
                return 'Method';
            case 'property':
                return 'Property';
            case 'action':
                return 'Action';
            case 'transition':
                return 'Transition';
        }
    }

    private getImplementationText(element: any): string {
        const implementation = element?.Implementation;
        if (!implementation) return '';
        if (typeof implementation === 'string') return implementation;
        return this.getTextContent(implementation.ST);
    }

    private getTextContent(value: any): string {
        if (typeof value === 'string') return value;
        if (value?.ST) return this.getTextContent(value.ST);
        if (value && typeof value._ === 'string') return value._;
        return '';
    }

    private toArray<T>(value: T | T[] | undefined): T[] {
        if (Array.isArray(value)) return value;
        return value ? [value] : [];
    }

    private async getSourceMtimeMs(originalPath: string): Promise<number> {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(originalPath));
        return stat.mtime;
    }

    private async writeAtomicWithRollback(targetUri: vscode.Uri, content: Uint8Array): Promise<void> {
        const dir = path.dirname(targetUri.fsPath);
        const base = path.basename(targetUri.fsPath);
        const backupUri = vscode.Uri.file(path.join(dir, `${base}.twincat.bak`));
        const tempUri = vscode.Uri.file(path.join(dir, `${base}.twincat.tmp.${Date.now()}`));

        let backupCreated = false;
        try {
            await vscode.workspace.fs.writeFile(tempUri, content);

            // Preserve last known good state before replacing.
            await vscode.workspace.fs.copy(targetUri, backupUri, { overwrite: true });
            backupCreated = true;

            // Move temp into place.
            await vscode.workspace.fs.rename(tempUri, targetUri, { overwrite: true });

            if (backupCreated) {
                try {
                    await vscode.workspace.fs.delete(backupUri, { recursive: false, useTrash: false });
                } catch {
                    // Backup cleanup is best-effort.
                }
            }
        } catch (error) {
            logError(`Atomic write failed for ${targetUri.fsPath}: ${String(error)}`);

            // Rollback original from backup if replacement failed.
            if (backupCreated) {
                try {
                    await vscode.workspace.fs.copy(backupUri, targetUri, { overwrite: true });
                } catch (restoreError) {
                    logError(`Rollback failed for ${targetUri.fsPath}: ${String(restoreError)}`);
                }
            }

            try {
                await vscode.workspace.fs.delete(tempUri, { recursive: false, useTrash: false });
            } catch {
                // Temp cleanup is best-effort.
            }

            throw error;
        } finally {
            if (backupCreated) {
                try {
                    await vscode.workspace.fs.delete(backupUri, { recursive: false, useTrash: false });
                } catch {
                    // Backup cleanup is best-effort.
                }
            }
        }
    }

    private async applyFragmentSave(originalXml: string, fragment: string, stCode: string): Promise<string> {
        return applyFragmentSTToXml(originalXml, fragment, stCode);
    }

    private applyStToFragmentElement(fragmentType: string, element: any, stCode: string): void {
        switch (fragmentType) {
            case 'method':
                this.applyMethodLikeSt('METHOD', element, stCode);
                break;
            case 'action':
                this.applyMethodLikeSt('ACTION', element, stCode);
                break;
            case 'transition':
                this.applyMethodLikeSt('TRANSITION', element, stCode);
                break;
            case 'property':
                this.applyPropertySt(element, stCode);
                break;
            case 'propertyget':
                this.applySinglePropertyAccessorSt('GET', element, stCode);
                break;
            case 'propertyset':
                this.applySinglePropertyAccessorSt('SET', element, stCode);
                break;
            default:
                this.applyMethodLikeSt('METHOD', element, stCode);
                break;
        }
    }

    private applyMethodLikeSt(kind: 'METHOD' | 'ACTION' | 'TRANSITION', element: any, stCode: string): void {
        const lines = stCode.replace(/\r/g, '').split('\n');
        while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

        let firstNonEmpty = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim()) {
                firstNonEmpty = i;
                break;
            }
        }

        if (firstNonEmpty < 0) return;

        const headerLine = lines[firstNonEmpty].trim();
        const defaultName = (element?.Name || '').toString().trim();
        const fallbackHeader = `${kind}${defaultName ? ` ${defaultName}` : ''}`;
        const declaration = new RegExp(`^${kind}\\b`, 'i').test(headerLine) ? headerLine : fallbackHeader;
        this.setTextField(element, 'Declaration', declaration);

        const body = lines.slice(firstNonEmpty + 1).join('\n').trim();
        this.setImplementationText(element, body);
    }

    private applyPropertySt(element: any, stCode: string): void {
        const lines = stCode.replace(/\r/g, '').split('\n');
        let index = 0;
        while (index < lines.length && !lines[index].trim()) index++;

        if (index < lines.length && /^PROPERTY\b/i.test(lines[index].trim())) {
            this.setTextField(element, 'Declaration', lines[index].trim());
            index++;
        }

        this.applyPropertySectionsFromLines(element, lines.slice(index));
    }

    private applySinglePropertyAccessorSt(kind: 'GET' | 'SET', element: any, stCode: string): void {
        const lines = stCode.replace(/\r/g, '').split('\n');
        let index = 0;
        while (index < lines.length && !lines[index].trim()) index++;

        if (index < lines.length && /^PROPERTY\b/i.test(lines[index].trim())) {
            this.setTextField(element, 'Declaration', lines[index].trim());
            index++;
        }

        this.applyPropertySectionsFromLines(element, lines.slice(index), kind);
    }

    private applyPropertySectionsFromLines(element: any, lines: string[], onlyKind?: 'GET' | 'SET'): void {
        const findIndex = (rx: RegExp, from: number) => {
            for (let i = from; i < lines.length; i++) {
                if (rx.test(lines[i].trim())) return i;
            }
            return -1;
        };
        const getIndex = findIndex(/^GET\b/i, 0);
        const setIndex = findIndex(/^SET\b/i, 0);
        const endIndex = findIndex(/^END_PROPERTY\b/i, 0);
        const endBound = endIndex >= 0 ? endIndex : lines.length;

        const applyAccessor = (kind: 'GET' | 'SET', start: number, stop: number) => {
            const accessor = kind === 'GET'
                ? (element.Get = element.Get || {})
                : (element.Set = element.Set || {});
            const declLine = lines[start]?.trim() || kind;
            this.setTextField(accessor, 'Declaration', new RegExp(`^${kind}\\b`, 'i').test(declLine) ? declLine : kind);
            const impl = lines.slice(start + 1, stop).join('\n').trim();
            this.setImplementationText(accessor, impl);
        };

        if ((!onlyKind || onlyKind === 'GET') && getIndex >= 0) {
            const stop = [setIndex, endBound].filter(v => v >= 0 && v > getIndex).sort((a, b) => a - b)[0] ?? endBound;
            applyAccessor('GET', getIndex, stop);
        }
        if ((!onlyKind || onlyKind === 'SET') && setIndex >= 0) {
            const stop = [endBound].filter(v => v >= 0 && v > setIndex)[0] ?? lines.length;
            applyAccessor('SET', setIndex, stop);
        }
    }

    private setImplementationText(target: any, text: string): void {
        target.Implementation = target.Implementation || {};
        const existing = target.Implementation.ST;
        if (typeof existing === 'string') {
            target.Implementation.ST = text;
            return;
        }
        if (existing && typeof existing === 'object' && '_' in existing) {
            existing._ = text;
            return;
        }
        target.Implementation.ST = text;
    }

    private setTextField(target: any, key: string, text: string): void {
        const existing = target?.[key];
        if (typeof existing === 'string') {
            target[key] = text;
            return;
        }
        if (existing && typeof existing === 'object' && '_' in existing) {
            existing._ = text;
            return;
        }
        target[key] = text;
    }
}
