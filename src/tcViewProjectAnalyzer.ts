import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import { TwinCATXmlConverter } from './tcViewXmlConverter';
import { TwinCATLibraryRef } from './tcViewTypes';
import { withPerfMetric } from './tcViewTelemetry';
import { extractQualifiedOnlyUsageInfo, type QualifiedOnlyUsageInfo } from './twinCATQualifiedOnly';
import { parseTwinCATTypeDeclarations } from './twinCATTypeParser';

/**
 * Represents a symbol in the TwinCAT project (variable, type, FB, etc.)
 */
export interface TwinCATSymbol {
    name: string;
    type: string;
    kind: 'variable' | 'type' | 'functionBlock' | 'function' | 'program' | 'global';
    source: string; // File path where defined
    library?: string;
    line?: number;
    documentation?: string;
    provenance?: 'project' | 'tmc' | 'built_in' | 'user';
}

/**
 * Represents a data type (STRUCT, ENUM, etc.)
 */
export interface TwinCATDataType {
    name: string;
    kind: 'struct' | 'enum' | 'alias';
    members: Map<string, string>; // name -> type
    source: string;
    library?: string;
    documentation?: string;
    provenance?: 'project' | 'tmc' | 'built_in' | 'user';
}

interface ManagedLibraryMetadata {
    name: string;
    vendor: string;
    version: string;
    installPath: string;
    dependencies: string[];
}

interface LibraryCatalogSymbolEntry {
    name: string;
    kind: 'functionBlock' | 'function' | 'program' | 'variable';
    type?: string;
    documentation?: string;
    members?: Record<string, string>;
}

interface LibraryCatalogDataTypeEntry {
    name: string;
    kind: 'struct' | 'enum' | 'alias';
    documentation?: string;
    members?: Record<string, string>;
}

interface LibraryCatalogEntry {
    name: string;
    vendor?: string;
    version?: string;
    infoUrl?: string;
    dependencies?: string[];
    category?: string;
    suppliedWith?: string;
    summary?: string;
    virtualParent?: string;
    metadataSource: 'built_in' | 'user';
    symbols: LibraryCatalogSymbolEntry[];
    dataTypes: LibraryCatalogDataTypeEntry[];
}

interface LibraryCatalogFile {
    libraries?: Array<{
        name?: string;
        vendor?: string;
        version?: string;
        infoUrl?: string;
        dependencies?: string[];
        category?: string;
        suppliedWith?: string;
        summary?: string;
        virtualParent?: string;
        functionBlocks?: Array<{
            name?: string;
            documentation?: string;
            members?: Record<string, string>;
        }>;
        functions?: Array<{
            name?: string;
            returnType?: string;
            documentation?: string;
        }>;
        programs?: Array<{
            name?: string;
            documentation?: string;
            members?: Record<string, string>;
        }>;
        variables?: Array<{
            name?: string;
            type?: string;
            documentation?: string;
        }>;
        dataTypes?: Array<{
            name?: string;
            kind?: 'struct' | 'enum' | 'alias';
            documentation?: string;
            members?: Record<string, string>;
        }>;
    }>;
}

/**
 * TwinCAT Project Analyzer - Scans and analyzes TwinCAT project structure
 */
export class TwinCATProjectAnalyzer {
    private projectRoot: string | undefined;
    private symbols: Map<string, TwinCATSymbol> = new Map();
    private dataTypes: Map<string, TwinCATDataType> = new Map();
    private globalVars: Map<string, TwinCATSymbol> = new Map();
    private qualifiedOnlyGlobalMembers = new Map<string, Set<string>>();
    private qualifiedOnlyEnumMembers = new Map<string, Set<string>>();
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private libraryMetadataWatcher: vscode.FileSystemWatcher | undefined;
    private globalLibraryMetadataWatcher: vscode.FileSystemWatcher | undefined;
    private converter: TwinCATXmlConverter;
    private scanTimer: NodeJS.Timeout | undefined;
    private libraryRefreshTimer: NodeJS.Timeout | undefined;
    private libraryRefreshCycle:
        | {
            promise: Promise<void>;
            resolve: () => void;
            reject: (reason?: unknown) => void;
        }
        | undefined;
    private libraryRefreshExecuting = false;
    private libraryRefreshDueAt = 0;
    private lastLibraryRefreshCompletedAt = 0;
    private scanInProgress = false;
    private pendingRescan = false;
    private fileUpdateTimer: NodeJS.Timeout | undefined;
    private pendingChangedFiles = new Set<string>();
    private pendingDeletedFiles = new Set<string>();
    private fileFingerprints = new Map<string, string>();
    private fileContributions = new Map<string, {
        symbolKeys: Set<string>;
        dataTypeKeys: Set<string>;
        globalVarKeys: Set<string>;
        qualifiedGlobalEntries: Array<{ memberKey: string; ownerName: string }>;
        qualifiedEnumEntries: Array<{ memberKey: string; ownerName: string }>;
    }>();
    private libraryRefs: TwinCATLibraryRef[] = [];
    private libraryPlaceholderSymbolKeys = new Set<string>();
    private librarySymbols = new Map<string, TwinCATSymbol>();
    private libraryDataTypes = new Map<string, TwinCATDataType>();
    private libraryContextModes = new Map<string, TwinCATLibraryRef['mode']>();
    private implicitSystemLibraries = new Set<string>();
    private projectBuildNumber = 0;
    private projectMetadataTextCache = new Map<string, { mtimeMs: number; text: string }>();
    private tmcParseCache = new Map<string, { mtimeMs: number; symbols: TwinCATSymbol[]; dataTypes: TwinCATDataType[] }>();
    private managedLibraryIndex: Map<string, ManagedLibraryMetadata[]> | undefined;
    private managedLibraryIndexPromise: Promise<Map<string, ManagedLibraryMetadata[]>> | undefined;
    private readonly indexRefreshedEmitter = new vscode.EventEmitter<void>();
    private indexRevision = 0;
    private initialized = false;
    private initializePromise: Promise<void> | undefined;
    
    // Standard TwinCAT libraries
    private standardLibraries = new Set([
        'Tc2_Standard', 'Tc2_System', 'Tc2_Utilities', 'Tc2_Math',
        'Tc2_MC2', 'Tc3_Module', 'Tc3_JsonXml', 'Tc3_EventLogger',
        'Tc3_Drive', 'Tc3_PackML', 'Tc3_IoLink', 'Tc3_HVAC',
        'Tc3_BA', 'Tc3_PlcOpen', 'Tc3_PlcOpenMotion'
    ]);

    constructor() {
        this.converter = new TwinCATXmlConverter();
    }

    private getDefaultManagedLibraryRoots(): string[] {
        return [
            'C:\\ProgramData\\Beckhoff\\TwinCAT\\PlcEngineering\\Managed Libraries',
            'C:\\ProgramData\\Beckhoff\\TwinCAT\\3.1\\Components\\Plc\\Managed Libraries'
        ];
    }

    private isPerfLoggingEnabled(): boolean {
        return vscode.workspace.getConfiguration('twincat').get<boolean>('performanceLogging', false);
    }

    /**
     * Initialize the analyzer for a workspace
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }
        if (this.initializePromise) {
            return this.initializePromise;
        }

        this.initializePromise = (async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        // Find TwinCAT project root (look for .tsproj/.tspproj files)
        for (const folder of workspaceFolders) {
            const tsprojFiles = await this.findTsprojFiles(folder.uri.fsPath);
            if (tsprojFiles.length > 0) {
                this.projectRoot = path.dirname(tsprojFiles[0]);
                break;
            }
        }

        // If no .tsproj/.tspproj found, use first workspace folder
        if (!this.projectRoot) {
            this.projectRoot = workspaceFolders[0].uri.fsPath;
        }
        // Setup file watcher
        if (!this.fileWatcher) {
            this.setupFileWatcher();
        }

        // Initial scan
        await this.scanProject();
        this.initialized = true;
        })();

        try {
            await this.initializePromise;
        } finally {
            this.initializePromise = undefined;
        }
    }

    /**
     * Find all .tsproj/.tspproj files in a directory
     */
    private async findTsprojFiles(dir: string): Promise<string[]> {
        const files: string[] = [];
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const lowerName = entry.name.toLowerCase();
                // Some TwinCAT solutions store the system manager project as .tspproj.
                if (entry.isFile() && (lowerName.endsWith('.tsproj') || lowerName.endsWith('.tspproj'))) {
                    files.push(path.join(dir, entry.name));
                }
            }
        } catch (error) {
            console.error('Error finding .tsproj/.tspproj files:', error);
        }
        return files;
    }

    /**
     * Setup file watcher to detect changes
     */
    private setupFileWatcher(): void {
        // Watch TwinCAT PLC source plus project/library metadata outputs.
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            '**/*.{TcPOU,TcGVL,TcDUT,TcPRG,TcCOM,TcAPP,TcVAR,TcGDS,TcIO,TcITF,plcproj,tsproj,tspproj,tmc}'
        );
        this.libraryMetadataWatcher = vscode.workspace.createFileSystemWatcher('**/tcview.libraries.json');
        const globalMetadataPath = this.getGlobalLibraryMetadataPath();
        this.globalLibraryMetadataWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(globalMetadataPath), path.basename(globalMetadataPath))
        );

        this.fileWatcher.onDidCreate(uri => this.handleWatchedFileEvent(uri.fsPath, 'change'));
        this.fileWatcher.onDidChange(uri => this.handleWatchedFileEvent(uri.fsPath, 'change'));
        this.fileWatcher.onDidDelete(uri => this.handleWatchedFileEvent(uri.fsPath, 'delete'));
        this.libraryMetadataWatcher.onDidCreate(uri => this.handleWatchedFileEvent(uri.fsPath, 'change'));
        this.libraryMetadataWatcher.onDidChange(uri => this.handleWatchedFileEvent(uri.fsPath, 'change'));
        this.libraryMetadataWatcher.onDidDelete(uri => this.handleWatchedFileEvent(uri.fsPath, 'delete'));
        this.globalLibraryMetadataWatcher.onDidCreate(uri => this.handleWatchedFileEvent(uri.fsPath, 'change'));
        this.globalLibraryMetadataWatcher.onDidChange(uri => this.handleWatchedFileEvent(uri.fsPath, 'change'));
        this.globalLibraryMetadataWatcher.onDidDelete(uri => this.handleWatchedFileEvent(uri.fsPath, 'delete'));
    }

    private handleWatchedFileEvent(filePath: string, kind: 'change' | 'delete'): void {
        if (this.isPLCFile(filePath)) {
            this.scheduleFileUpdate(filePath, kind);
            return;
        }

        if (this.isLibraryMetadataFile(filePath)) {
            this.invalidateProjectMetadataTextCache(filePath);
            if (path.extname(filePath).toLowerCase() === '.tmc') {
                this.tmcParseCache.delete(filePath);
            }
            this.scheduleLibraryRefresh();
        }
    }

    private scheduleScan(delayMs = 300): void {
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
        }

        this.scanTimer = setTimeout(() => {
            this.scanTimer = undefined;
            void this.scanProject();
        }, delayMs);
    }

    private scheduleLibraryRefresh(delayMs = 250): void {
        void this.queueLibraryRefresh(delayMs);
    }

    private scheduleFileUpdate(filePath: string, kind: 'change' | 'delete', delayMs = 250): void {
        if (!this.isPLCFile(filePath)) {
            return;
        }

        if (kind === 'delete') {
            this.pendingDeletedFiles.add(filePath);
            this.pendingChangedFiles.delete(filePath);
        } else if (!this.pendingDeletedFiles.has(filePath)) {
            this.pendingChangedFiles.add(filePath);
        }

        if (this.fileUpdateTimer) {
            clearTimeout(this.fileUpdateTimer);
        }

        this.fileUpdateTimer = setTimeout(() => {
            this.fileUpdateTimer = undefined;
            void this.processPendingFileUpdates();
        }, delayMs);
    }

    private async processPendingFileUpdates(): Promise<void> {
        if (this.scanInProgress) {
            this.pendingRescan = true;
            return;
        }

        const deleted = [...this.pendingDeletedFiles];
        const changed = [...this.pendingChangedFiles];
        this.pendingDeletedFiles.clear();
        this.pendingChangedFiles.clear();

        if (deleted.length === 0 && changed.length === 0) {
            return;
        }

        const start = Date.now();
        let didMutateIndex = false;
        await withPerfMetric('reindex.incremental', async () => {
            for (const filePath of deleted) {
                didMutateIndex = this.removeFileContributions(filePath) || didMutateIndex;
            }

            const parseResults = await Promise.allSettled(changed.map(filePath => this.parseFile(filePath)));
            for (const result of parseResults) {
                if (result.status === 'fulfilled' && result.value) {
                    didMutateIndex = true;
                    break;
                }
            }

            if (didMutateIndex) {
                this.indexRevision++;
                this.indexRefreshedEmitter.fire();
            }
        });
        if (this.isPerfLoggingEnabled()) {
            console.log(`[TcView Perf] Incremental symbol update (${changed.length} changed, ${deleted.length} deleted, mutation=${didMutateIndex}): ${Date.now() - start} ms`);
        }
    }

    /**
     * Scan the entire project and build symbol tables
     */
    public async scanProject(): Promise<void> {
        if (!this.projectRoot) {
            return;
        }

        if (this.scanInProgress) {
            this.pendingRescan = true;
            return;
        }

        this.scanInProgress = true;
        const scanStart = Date.now();
        if (this.isPerfLoggingEnabled()) {
            console.log('[TcView Perf] Starting full project scan');
        }
        
        try {
            await withPerfMetric('reindex.full', async () => {
                // Clear existing data
                this.symbols.clear();
                this.dataTypes.clear();
                this.globalVars.clear();
                this.librarySymbols.clear();
                this.libraryDataTypes.clear();
                this.libraryContextModes.clear();
                this.fileContributions.clear();
                this.fileFingerprints.clear();

                // Find all PLC files
                const plcFiles = await this.findPLCFiles();

                // Parse files in parallel
                await Promise.allSettled(plcFiles.map(file => this.parseFile(file)));
                await this.refreshLibraryMetadata();
                this.indexRevision++;
                this.indexRefreshedEmitter.fire();
            });

            console.log(`Project scan complete. Found ${this.symbols.size} symbols, ${this.dataTypes.size} data types, ${this.globalVars.size} global variables.`);
            if (this.isPerfLoggingEnabled()) {
                console.log(`[TcView Perf] Full project scan duration: ${Date.now() - scanStart} ms`);
            }
        } finally {
            this.scanInProgress = false;
            if (this.pendingRescan) {
                this.pendingRescan = false;
                this.scheduleScan(50);
            }
        }
    }

    /**
     * Find all PLC files in the project
     */
    private async findPLCFiles(): Promise<string[]> {
        const files: string[] = [];
        const pattern = '**/*.{TcPOU,TcGVL,TcDUT,TcPRG,TcCOM,TcAPP,TcVAR,TcGDS,TcIO,TcITF,tcpou,tcgvl,tcdut,tcprg,tccom,tcapp,tcvar,tcgds,tcio,tcitf}';
        
        
        try {
            const foundFiles = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
            for (const file of foundFiles) {
                if (file.fsPath.toLowerCase().startsWith(this.projectRoot!.toLowerCase())) {
                    files.push(file.fsPath);
                }
            }
        } catch (error) {
            console.error('Error finding PLC files:', error);
        }

        return files;
    }

    /**
     * Parse a single PLC file and extract symbols
     */
    private async parseFile(filePath: string): Promise<boolean> {
        if (!this.isPLCFile(filePath)) {
            return false;
        }

        try {
            const fingerprint = await this.getFileFingerprint(filePath);
            const previousFingerprint = this.fileFingerprints.get(filePath);
            if (fingerprint && previousFingerprint === fingerprint && this.fileContributions.has(filePath)) {
                return false;
            }

            const ext = path.extname(filePath).toLowerCase();
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const contribution = {
                symbolKeys: new Set<string>(),
                dataTypeKeys: new Set<string>(),
                globalVarKeys: new Set<string>(),
                qualifiedGlobalEntries: [] as Array<{ memberKey: string; ownerName: string }>,
                qualifiedEnumEntries: [] as Array<{ memberKey: string; ownerName: string }>
            };

            this.removeFileContributions(filePath);

            switch (ext) {
                case '.tcgvl':
                    await this.parseGVLFile(filePath, content, contribution);
                    break;
                case '.tcdut':
                    await this.parseDUTFile(filePath, content, contribution);
                    break;
                case '.tcpou':
                case '.tcprg':
                case '.tcapp':
                case '.tccom':
                    await this.parsePOUFile(filePath, content, contribution);
                    break;
            }

            this.fileContributions.set(filePath, contribution);
            if (fingerprint) {
                this.fileFingerprints.set(filePath, fingerprint);
            }
            return true;
        } catch (error) {
            console.error(`Error parsing ${filePath}:`, error);
            return false;
        }
    }

    /**
     * Parse GVL (Global Variable List) file
     */
    private async parseGVLFile(filePath: string, content: string, contribution: {
        symbolKeys: Set<string>;
        dataTypeKeys: Set<string>;
        globalVarKeys: Set<string>;
        qualifiedGlobalEntries: Array<{ memberKey: string; ownerName: string }>;
        qualifiedEnumEntries: Array<{ memberKey: string; ownerName: string }>;
    }): Promise<void> {
        try {
            // Convert XML to ST to extract variable declarations
            const stContent = await this.converter.convertXmlToST(content);

            // Register the GVL container name so expressions like GVLName.Var are recognized
            const gvlNameMatch = stContent.match(/Global Variable List:\s*([A-Za-z_]\w*)/i);
            const gvlName = gvlNameMatch?.[1] || path.basename(filePath, path.extname(filePath));
            if (gvlName) {
                const key = gvlName.toUpperCase();
                this.symbols.set(key, {
                    name: gvlName,
                    type: 'GVL',
                    kind: 'global',
                    source: filePath
                });
                contribution.symbolKeys.add(key);
            }
            
            // Extract VAR_GLOBAL section
            const varGlobalMatch = stContent.match(/VAR_GLOBAL([\s\S]*?)END_VAR/i);
            if (varGlobalMatch) {
                const varSection = varGlobalMatch[1];
                this.extractVariables(varSection, filePath, 'global', contribution);
            }

            const qualifiedOnlyInfo = extractQualifiedOnlyUsageInfo(stContent, filePath);
            qualifiedOnlyInfo.globals.forEach((owners, memberKey) => {
                owners.forEach(ownerName => {
                    const existing = this.qualifiedOnlyGlobalMembers.get(memberKey) ?? new Set<string>();
                    existing.add(ownerName);
                    this.qualifiedOnlyGlobalMembers.set(memberKey, existing);
                    contribution.qualifiedGlobalEntries.push({ memberKey, ownerName });
                });
            });
        } catch (error) {
            console.error(`Error parsing GVL file ${filePath}:`, error);
        }
    }

    /**
     * Parse DUT (Data Type Unit) file for STRUCT/ENUM definitions
     */
    private async parseDUTFile(filePath: string, content: string, contribution: {
        symbolKeys: Set<string>;
        dataTypeKeys: Set<string>;
        globalVarKeys: Set<string>;
        qualifiedGlobalEntries: Array<{ memberKey: string; ownerName: string }>;
        qualifiedEnumEntries: Array<{ memberKey: string; ownerName: string }>;
    }): Promise<void> {
        try {
            const stContent = await this.converter.convertXmlToST(content);
            for (const declaration of parseTwinCATTypeDeclarations(stContent)) {
                const upperName = declaration.name.toUpperCase();
                const symbolType = declaration.kind === 'struct'
                    ? 'STRUCT'
                    : declaration.kind === 'enum'
                        ? 'ENUM'
                        : declaration.aliasTarget ?? 'ALIAS';

                this.dataTypes.set(upperName, {
                    name: declaration.name,
                    kind: declaration.kind,
                    members: declaration.members,
                    source: filePath
                });
                contribution.dataTypeKeys.add(upperName);

                this.symbols.set(upperName, {
                    name: declaration.name,
                    type: symbolType,
                    kind: 'type',
                    source: filePath
                });
                contribution.symbolKeys.add(upperName);
            }

            const qualifiedOnlyInfo = extractQualifiedOnlyUsageInfo(stContent, filePath);
            qualifiedOnlyInfo.enums.forEach((owners, memberKey) => {
                owners.forEach(ownerName => {
                    const existing = this.qualifiedOnlyEnumMembers.get(memberKey) ?? new Set<string>();
                    existing.add(ownerName);
                    this.qualifiedOnlyEnumMembers.set(memberKey, existing);
                    contribution.qualifiedEnumEntries.push({ memberKey, ownerName });
                });
            });
        } catch (error) {
            console.error(`Error parsing DUT file ${filePath}:`, error);
        }
    }

    /**
     * Parse POU (Program/Function/FB) file
     */
    private async parsePOUFile(filePath: string, content: string, contribution: {
        symbolKeys: Set<string>;
        dataTypeKeys: Set<string>;
        globalVarKeys: Set<string>;
        qualifiedGlobalEntries: Array<{ memberKey: string; ownerName: string }>;
        qualifiedEnumEntries: Array<{ memberKey: string; ownerName: string }>;
    }): Promise<void> {
        try {
            const stContent = await this.converter.convertXmlToST(content);
            
            // Extract declaration type and name
            const declMatch = stContent.match(/^\s*(PROGRAM|FUNCTION|FUNCTION_BLOCK)\s+(\w+)/im);
            if (declMatch) {
                const kind = declMatch[1].toUpperCase();
                const name = declMatch[2];
                
                let symbolKind: TwinCATSymbol['kind'] = 'program';
                if (kind === 'FUNCTION_BLOCK') symbolKind = 'functionBlock';
                if (kind === 'FUNCTION') symbolKind = 'function';

                this.symbols.set(name.toUpperCase(), {
                    name,
                    type: kind,
                    kind: symbolKind,
                    source: filePath
                });
                contribution.symbolKeys.add(name.toUpperCase());
            }

            // Extract local variables
            const varSections = stContent.match(/VAR[\s\S]*?END_VAR/gi) || [];
            for (const section of varSections) {
                this.extractVariables(section, filePath, 'variable', contribution);
            }

            // Also index POU members declared in XML (methods/properties/actions/transitions).
            this.indexPouMembersFromXmlText(filePath, content, contribution);
        } catch (error) {
            console.error(`Error parsing POU file ${filePath}:`, error);
        }
    }

    private async refreshLibraryMetadataOnly(): Promise<void> {
        if (!this.projectRoot) {
            return;
        }

        if (this.scanInProgress) {
            this.pendingRescan = true;
            return;
        }

        const start = Date.now();
        await withPerfMetric('reindex.libraryMetadata', async () => {
            await this.refreshLibraryMetadata();
            this.indexRevision++;
            this.indexRefreshedEmitter.fire();
        });
        this.lastLibraryRefreshCompletedAt = Date.now();
        if (this.isPerfLoggingEnabled()) {
            console.log(`[TcView Perf] Library metadata refresh: ${Date.now() - start} ms`);
        }
    }

    private queueLibraryRefresh(delayMs = 0): Promise<void> {
        if (!this.projectRoot) {
            return Promise.resolve();
        }

        const now = Date.now();
        if (
            !this.libraryRefreshExecuting &&
            !this.libraryRefreshTimer &&
            this.lastLibraryRefreshCompletedAt > 0 &&
            now - this.lastLibraryRefreshCompletedAt < delayMs
        ) {
            return Promise.resolve();
        }

        if (!this.libraryRefreshCycle) {
            let resolve!: () => void;
            let reject!: (reason?: unknown) => void;
            const promise = new Promise<void>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            this.libraryRefreshCycle = { promise, resolve, reject };
        }

        const requestedDueAt = now + delayMs;
        this.libraryRefreshDueAt = this.libraryRefreshDueAt === 0
            ? requestedDueAt
            : Math.min(this.libraryRefreshDueAt, requestedDueAt);

        if (!this.libraryRefreshExecuting) {
            this.armLibraryRefreshTimer();
        }

        return this.libraryRefreshCycle.promise;
    }

    private armLibraryRefreshTimer(): void {
        if (this.libraryRefreshExecuting || !this.libraryRefreshCycle || this.libraryRefreshDueAt === 0) {
            return;
        }

        if (this.libraryRefreshTimer) {
            clearTimeout(this.libraryRefreshTimer);
        }

        const delayMs = Math.max(0, this.libraryRefreshDueAt - Date.now());
        this.libraryRefreshTimer = setTimeout(() => {
            this.libraryRefreshTimer = undefined;
            void this.flushQueuedLibraryRefresh();
        }, delayMs);
    }

    private async flushQueuedLibraryRefresh(): Promise<void> {
        if (!this.libraryRefreshCycle) {
            return;
        }

        const activeCycle = this.libraryRefreshCycle;
        this.libraryRefreshExecuting = true;
        this.libraryRefreshDueAt = 0;

        try {
            await this.refreshLibraryMetadataOnly();
            activeCycle.resolve();
        } catch (error) {
            activeCycle.reject(error);
            throw error;
        } finally {
            this.libraryRefreshExecuting = false;
            if (this.libraryRefreshCycle === activeCycle) {
                this.libraryRefreshCycle = undefined;
            }
            if (this.libraryRefreshCycle) {
                this.armLibraryRefreshTimer();
            }
        }
    }

    private indexPouMembersFromXmlText(filePath: string, content: string, contribution: {
        symbolKeys: Set<string>;
        dataTypeKeys: Set<string>;
        globalVarKeys: Set<string>;
        qualifiedGlobalEntries: Array<{ memberKey: string; ownerName: string }>;
        qualifiedEnumEntries: Array<{ memberKey: string; ownerName: string }>;
    }): void {
        const registerMember = (name: string, type: string, kind: TwinCATSymbol['kind']) => {
            const clean = name.trim();
            if (!clean) return;
            const key = clean.toUpperCase();
            this.symbols.set(key, {
                name: clean,
                type,
                kind,
                source: filePath
            });
            contribution.symbolKeys.add(key);
        };

        const capture = (tag: string, type: string, kind: TwinCATSymbol['kind']) => {
            const attrRegex = new RegExp(`<${tag}\\b[^>]*\\bName\\s*=\\s*["']([^"']+)["'][^>]*>`, 'gi');
            const nodeRegex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<Name\\b[^>]*>([^<]+)<\\/Name>`, 'gi');
            let match: RegExpExecArray | null;

            while ((match = attrRegex.exec(content)) !== null) {
                registerMember(match[1], type, kind);
            }
            while ((match = nodeRegex.exec(content)) !== null) {
                registerMember(match[1], type, kind);
            }
        };

        try {
            capture('Method', 'METHOD', 'function');
            capture('Property', 'PROPERTY', 'variable');
            capture('Action', 'ACTION', 'function');
            capture('Transition', 'TRANSITION', 'function');
        } catch (error) {
            console.error(`Error indexing POU members from XML text ${filePath}:`, error);
        }
    }

    /**
     * Extract variable declarations from a VAR section
     */
    private extractVariables(varSection: string, source: string, kind: TwinCATSymbol['kind'], contribution: {
        symbolKeys: Set<string>;
        dataTypeKeys: Set<string>;
        globalVarKeys: Set<string>;
        qualifiedGlobalEntries: Array<{ memberKey: string; ownerName: string }>;
        qualifiedEnumEntries: Array<{ memberKey: string; ownerName: string }>;
    }): void {
        // Match variable declarations: name : type;
        const varRegex = /(\w+)\s*:\s*(\w+)(?:\s*\(.*?\))?\s*(?::=.*?)?;/g;
        let match;
        
        while ((match = varRegex.exec(varSection)) !== null) {
            const name = match[1];
            const type = match[2];
            
            const symbol: TwinCATSymbol = {
                name,
                type,
                kind,
                source
            };

            if (kind === 'global') {
                this.globalVars.set(name.toUpperCase(), symbol);
                contribution.globalVarKeys.add(name.toUpperCase());
            } else {
                this.symbols.set(name.toUpperCase(), symbol);
                contribution.symbolKeys.add(name.toUpperCase());
            }
        }
    }

    private removeFileContributions(filePath: string): boolean {
        const previous = this.fileContributions.get(filePath);
        if (!previous) return false;

        for (const key of previous.symbolKeys) {
            const symbol = this.symbols.get(key);
            if (symbol?.source === filePath) {
                this.symbols.delete(key);
            }
        }

        for (const key of previous.dataTypeKeys) {
            const dataType = this.dataTypes.get(key);
            if (dataType?.source === filePath) {
                this.dataTypes.delete(key);
            }
        }

        for (const key of previous.globalVarKeys) {
            const globalVar = this.globalVars.get(key);
            if (globalVar?.source === filePath) {
                this.globalVars.delete(key);
            }
        }

        for (const entry of previous.qualifiedGlobalEntries) {
            const owners = this.qualifiedOnlyGlobalMembers.get(entry.memberKey);
            if (!owners) {
                continue;
            }
            owners.delete(entry.ownerName);
            if (owners.size === 0) {
                this.qualifiedOnlyGlobalMembers.delete(entry.memberKey);
            }
        }

        for (const entry of previous.qualifiedEnumEntries) {
            const owners = this.qualifiedOnlyEnumMembers.get(entry.memberKey);
            if (!owners) {
                continue;
            }
            owners.delete(entry.ownerName);
            if (owners.size === 0) {
                this.qualifiedOnlyEnumMembers.delete(entry.memberKey);
            }
        }

        this.fileContributions.delete(filePath);
        this.fileFingerprints.delete(filePath);
        return true;
    }

    private async getFileFingerprint(filePath: string): Promise<string | undefined> {
        try {
            const stat = await fs.promises.stat(filePath);
            return `${stat.mtimeMs}:${stat.size}`;
        } catch {
            return undefined;
        }
    }

    private isPLCFile(filePath: string): boolean {
        return ['.tcpou', '.tcgvl', '.tcdut', '.tcprg', '.tccom', '.tcapp', '.tcvar', '.tcgds', '.tcio', '.tcitf']
            .includes(path.extname(filePath).toLowerCase());
    }

    private isLibraryMetadataFile(filePath: string): boolean {
        const lowerName = path.basename(filePath).toLowerCase();
        return ['.plcproj', '.tsproj', '.tspproj', '.tmc'].includes(path.extname(filePath).toLowerCase())
            || lowerName === 'tcview.libraries.json';
    }

    private getMetadataCacheKey(filePath: string): string {
        return path.normalize(filePath).toLowerCase();
    }

    private invalidateProjectMetadataTextCache(filePath: string): void {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.plcproj' || ext === '.tsproj' || ext === '.tspproj') {
            this.projectMetadataTextCache.delete(this.getMetadataCacheKey(filePath));
        }
    }

    private async readProjectMetadataText(filePath: string): Promise<string | undefined> {
        const key = this.getMetadataCacheKey(filePath);
        try {
            const stat = await fs.promises.stat(filePath);
            const cached = this.projectMetadataTextCache.get(key);
            if (cached && cached.mtimeMs === stat.mtimeMs) {
                return cached.text;
            }

            const text = await fs.promises.readFile(filePath, 'utf8');
            this.projectMetadataTextCache.set(key, { mtimeMs: stat.mtimeMs, text });
            return text;
        } catch {
            this.projectMetadataTextCache.delete(key);
            return undefined;
        }
    }

    private async refreshLibraryMetadata(): Promise<void> {
        for (const key of this.libraryPlaceholderSymbolKeys) {
            const existing = this.symbols.get(key);
            if (existing?.type.startsWith('LIBRARY ')) {
                this.symbols.delete(key);
            }
        }
        this.libraryPlaceholderSymbolKeys.clear();
        this.libraryRefs = [];
        this.librarySymbols.clear();
        this.libraryDataTypes.clear();
        this.libraryContextModes.clear();
        this.implicitSystemLibraries.clear();
        this.projectBuildNumber = 0;

        if (!this.projectRoot) {
            return;
        }

        const plcProjFiles = await this.findProjectFiles('**/*.plcproj');
        const tmcInventory = await this.collectAvailableTmcFiles();
        const managedLibraryIndex = await this.getManagedLibraryIndex();
        const libraryCatalog = await this.loadLibraryCatalogEntries();
        const refsByKey = new Map<string, TwinCATLibraryRef>();
        for (const plcProj of plcProjFiles) {
            this.projectBuildNumber = Math.max(this.projectBuildNumber, await this.readProgramBuildFromPlcProj(plcProj));
            const refs = await this.readLibraryRefsFromPlcProj(plcProj, tmcInventory.names, managedLibraryIndex, libraryCatalog);
            for (const ref of refs) {
                const key = `${ref.name.toUpperCase()}|${(ref.vendor ?? '').toUpperCase()}|${ref.version}`;
                if (!refsByKey.has(key)) {
                    refsByKey.set(key, ref);
                }
            }
        }

        this.applyImplicitSystemLibraries(refsByKey, libraryCatalog);

        this.libraryRefs = [...refsByKey.values()].sort((a, b) => {
            const byVendor = (a.vendor ?? '').localeCompare(b.vendor ?? '');
            if (byVendor !== 0) return byVendor;
            const byName = a.name.localeCompare(b.name);
            if (byName !== 0) return byName;
            return a.version.localeCompare(b.version);
        });

        for (const lib of this.libraryRefs) {
            this.libraryContextModes.set(lib.name.toUpperCase(), lib.mode);
            const key = lib.name.toUpperCase();
            if (this.symbols.has(key) || this.globalVars.has(key)) {
                continue;
            }

            this.symbols.set(key, {
                name: lib.name,
                type: `LIBRARY ${lib.version}`,
                kind: 'type',
                source: lib.path,
                library: lib.name,
                documentation: [lib.vendor ?? 'Unknown vendor', lib.category, lib.suppliedWith, lib.summary]
                    .filter(Boolean)
                    .join(' | ')
            });
            this.libraryPlaceholderSymbolKeys.add(key);
        }

        await this.loadLibrarySymbolsFromTmc(tmcInventory.files);
        this.loadLibrarySymbolsFromCatalog(libraryCatalog);

        const publicSymbolLibraries = new Set<string>();
        this.librarySymbols.forEach(symbol => {
            if (symbol.library) {
                publicSymbolLibraries.add(this.normalizeLookupName(symbol.library));
            }
        });
        this.libraryDataTypes.forEach(typeInfo => {
            if (typeInfo.library) {
                publicSymbolLibraries.add(this.normalizeLookupName(typeInfo.library));
            }
        });
        this.libraryRefs = this.libraryRefs.map(lib => {
            if (!publicSymbolLibraries.has(this.normalizeLookupName(lib.name))) {
                return lib;
            }
            return { ...lib, mode: 'public_symbols' };
        });
        this.libraryContextModes.clear();
        for (const lib of this.libraryRefs) {
            this.libraryContextModes.set(lib.name.toUpperCase(), lib.mode);
        }
    }

    private async findProjectFiles(pattern: string): Promise<string[]> {
        if (!this.projectRoot) {
            return [];
        }

        try {
            const foundFiles = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
            return foundFiles
                .map(file => file.fsPath)
                .filter(filePath => filePath.toLowerCase().startsWith(this.projectRoot!.toLowerCase()))
                .sort((a, b) => a.localeCompare(b));
        } catch {
            return [];
        }
    }

    private async readProgramBuildFromPlcProj(plcProjPath: string): Promise<number> {
        try {
            const text = await this.readProjectMetadataText(plcProjPath);
            if (!text) {
                return 0;
            }
            const versionText = text.match(/<ProgramVersion>\s*([^<]+)\s*<\/ProgramVersion>/i)?.[1]?.trim();
            if (!versionText) {
                return 0;
            }
            const parts = versionText.split('.');
            const buildPart = Number.parseInt(parts[2] ?? '', 10);
            return Number.isFinite(buildPart) ? buildPart : 0;
        } catch {
            return 0;
        }
    }

    private async collectAvailableTmcFiles(): Promise<{ names: Set<string>; files: string[] }> {
        const configuredRoots = vscode.workspace.getConfiguration('twincat').get<string[]>('backend.tmcRoots', []);
        const roots = [...new Set([
            this.projectRoot,
            ...configuredRoots
        ].filter((value): value is string => !!value && fs.existsSync(value)))];
        const tmcNames = new Set<string>();
        const tmcFiles = new Set<string>();

        for (const root of roots) {
            await this.collectTmcNamesFromRoot(root, tmcNames, tmcFiles);
        }

        return {
            names: tmcNames,
            files: [...tmcFiles].sort((a, b) => a.localeCompare(b))
        };
    }

    private async collectTmcNamesFromRoot(rootPath: string, target: Set<string>, files: Set<string>): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
        } catch {
            return;
        }

        await Promise.all(entries.map(async entry => {
            if (entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'node_modules') {
                return;
            }

            const fullPath = path.join(rootPath, entry.name);
            if (entry.isDirectory()) {
                await this.collectTmcNamesFromRoot(fullPath, target, files);
                return;
            }

            if (entry.isFile() && entry.name.toLowerCase().endsWith('.tmc')) {
                target.add(this.normalizeLookupName(path.basename(entry.name, '.tmc')));
                files.add(fullPath);
            }
        }));
    }

    private async getManagedLibraryIndex(): Promise<Map<string, ManagedLibraryMetadata[]>> {
        if (this.managedLibraryIndex) {
            return this.managedLibraryIndex;
        }
        if (this.managedLibraryIndexPromise) {
            return this.managedLibraryIndexPromise;
        }

        this.managedLibraryIndexPromise = this.buildManagedLibraryIndex();
        try {
            this.managedLibraryIndex = await this.managedLibraryIndexPromise;
            return this.managedLibraryIndex;
        } finally {
            this.managedLibraryIndexPromise = undefined;
        }
    }

    private async buildManagedLibraryIndex(): Promise<Map<string, ManagedLibraryMetadata[]>> {
        const configuredRoots = vscode.workspace.getConfiguration('twincat').get<string[]>('library.managedRoots', []);
        const roots = [...new Set([
            ...this.getDefaultManagedLibraryRoots(),
            ...configuredRoots
        ].filter(root => !!root && fs.existsSync(root)))];

        const index = new Map<string, ManagedLibraryMetadata[]>();
        for (const root of roots) {
            let vendors: fs.Dirent[];
            try {
                vendors = await fs.promises.readdir(root, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const vendorEntry of vendors) {
                if (!vendorEntry.isDirectory() || vendorEntry.name.startsWith('.') || vendorEntry.name.startsWith('_')) {
                    continue;
                }
                const vendorPath = path.join(root, vendorEntry.name);
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
                        continue;
                    }

                    for (const versionEntry of versions) {
                        if (!versionEntry.isDirectory()) {
                            continue;
                        }
                        const versionPath = path.join(libraryPath, versionEntry.name);
                        const metadata: ManagedLibraryMetadata = {
                            name: libraryEntry.name,
                            vendor: vendorEntry.name,
                            version: versionEntry.name,
                            installPath: versionPath,
                            dependencies: await this.readManagedLibraryDependencies(versionPath)
                        };
                        const key = this.normalizeLookupName(metadata.name);
                        const existing = index.get(key) ?? [];
                        existing.push(metadata);
                        index.set(key, existing);
                    }
                }
            }
        }

        index.forEach(entries => entries.sort((a, b) => this.compareLibraryVersions(b.version, a.version)));
        return index;
    }

    private async readManagedLibraryDependencies(versionPath: string): Promise<string[]> {
        const dependenciesPath = path.join(versionPath, 'dependencies');
        try {
            const text = await fs.promises.readFile(dependenciesPath, 'utf8');
            return text
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => line.replace(/^#/, '').trim())
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    private compareLibraryVersions(a: string, b: string): number {
        const aParts = a.split('.').map(part => Number.parseInt(part, 10));
        const bParts = b.split('.').map(part => Number.parseInt(part, 10));
        const maxLength = Math.max(aParts.length, bParts.length);
        for (let i = 0; i < maxLength; i++) {
            const aValue = Number.isFinite(aParts[i]) ? aParts[i] : 0;
            const bValue = Number.isFinite(bParts[i]) ? bParts[i] : 0;
            if (aValue !== bValue) {
                return aValue - bValue;
            }
        }
        return a.localeCompare(b);
    }

    private resolveManagedLibraryMetadata(
        managedLibraryIndex: Map<string, ManagedLibraryMetadata[]>,
        name: string,
        vendor?: string
    ): ManagedLibraryMetadata | undefined {
        const candidates = managedLibraryIndex.get(this.normalizeLookupName(name)) ?? [];
        if (candidates.length === 0) {
            return undefined;
        }
        if (vendor) {
            const vendorMatch = candidates.find(candidate => candidate.vendor.localeCompare(vendor, undefined, { sensitivity: 'accent' }) === 0);
            if (vendorMatch) {
                return vendorMatch;
            }
        }
        return candidates[0];
    }

    private getBuiltInLibraryCatalogPath(): string {
        return path.resolve(__dirname, '..', 'resources', 'library-metadata.json');
    }

    private getGlobalLibraryMetadataPath(): string {
        const appDataRoot = process.env.APPDATA
            || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : undefined)
            || process.cwd();
        return path.join(appDataRoot, 'TcView', 'tcview.libraries.json');
    }

    private getWorkspaceLibraryMetadataPaths(): string[] {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        return workspaceFolders.flatMap(folder => [
            path.join(folder.uri.fsPath, 'tcview.libraries.json'),
            path.join(folder.uri.fsPath, '.vscode', 'tcview.libraries.json')
        ]);
    }

    private getConfiguredLibraryMetadataPaths(): string[] {
        const configuredPaths = vscode.workspace.getConfiguration('twincat').get<string[]>('library.metadataFiles', []);
        return configuredPaths.map(candidate => {
            if (path.isAbsolute(candidate)) {
                return candidate;
            }
            const basePath = this.projectRoot
                ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
                ?? process.cwd();
            return path.resolve(basePath, candidate);
        });
    }

    private async loadLibraryCatalogEntries(): Promise<Map<string, LibraryCatalogEntry[]>> {
        const catalog = new Map<string, LibraryCatalogEntry[]>();
        const sources: Array<{ source: 'built_in' | 'user'; filePath: string }> = [
            { source: 'built_in', filePath: this.getBuiltInLibraryCatalogPath() },
            { source: 'user', filePath: this.getGlobalLibraryMetadataPath() },
            ...[...this.getWorkspaceLibraryMetadataPaths(), ...this.getConfiguredLibraryMetadataPaths()]
                .map(filePath => ({ source: 'user' as const, filePath }))
        ];

        const seenPaths = new Set<string>();
        for (const source of sources) {
            const normalizedPath = path.normalize(source.filePath).toLowerCase();
            if (seenPaths.has(normalizedPath) || !fs.existsSync(source.filePath)) {
                continue;
            }
            seenPaths.add(normalizedPath);

            try {
                const raw = JSON.parse(await fs.promises.readFile(source.filePath, 'utf8')) as LibraryCatalogFile;
                for (const entry of this.parseLibraryCatalogFile(raw, source.source)) {
                    const key = this.normalizeLookupName(entry.name);
                    const existing = catalog.get(key) ?? [];
                    existing.push(entry);
                    catalog.set(key, existing);
                }
            } catch (error) {
                console.warn(`Failed to load TcView library metadata file ${source.filePath}: ${String(error)}`);
            }
        }

        return catalog;
    }

    private parseLibraryCatalogFile(raw: LibraryCatalogFile, metadataSource: 'built_in' | 'user'): LibraryCatalogEntry[] {
        const results: LibraryCatalogEntry[] = [];
        for (const entry of raw.libraries ?? []) {
            const name = entry.name?.trim();
            if (!name) {
                continue;
            }

            const functionBlocks = (entry.functionBlocks ?? [])
                .filter(item => item.name?.trim())
                .map(item => ({
                    name: item.name!.trim(),
                    kind: 'functionBlock' as const,
                    type: item.name!.trim(),
                    documentation: item.documentation,
                    members: item.members
                }));
            const functions = (entry.functions ?? [])
                .filter(item => item.name?.trim())
                .map(item => ({
                    name: item.name!.trim(),
                    kind: 'function' as const,
                    type: item.returnType?.trim() || item.name!.trim(),
                    documentation: item.documentation
                }));
            const programs = (entry.programs ?? [])
                .filter(item => item.name?.trim())
                .map(item => ({
                    name: item.name!.trim(),
                    kind: 'program' as const,
                    type: item.name!.trim(),
                    documentation: item.documentation,
                    members: item.members
                }));
            const variables = (entry.variables ?? [])
                .filter(item => item.name?.trim())
                .map(item => ({
                    name: item.name!.trim(),
                    kind: 'variable' as const,
                    type: item.type?.trim() || 'ANY',
                    documentation: item.documentation
                }));
            const dataTypes = (entry.dataTypes ?? [])
                .filter(item => item.name?.trim())
                .map(item => ({
                    name: item.name!.trim(),
                    kind: item.kind ?? 'alias',
                    documentation: item.documentation,
                    members: item.members
                }));

            results.push({
                name,
                vendor: entry.vendor?.trim(),
                version: entry.version?.trim(),
                infoUrl: entry.infoUrl?.trim(),
                dependencies: (entry.dependencies ?? []).map(dep => dep.trim()).filter(Boolean),
                category: entry.category?.trim(),
                suppliedWith: entry.suppliedWith?.trim(),
                summary: entry.summary?.trim(),
                virtualParent: entry.virtualParent?.trim(),
                metadataSource,
                symbols: [...functionBlocks, ...functions, ...programs, ...variables],
                dataTypes
            });
        }
        return results;
    }

    private resolveCatalogLibraryMetadata(
        catalog: Map<string, LibraryCatalogEntry[]>,
        name: string,
        vendor?: string
    ): LibraryCatalogEntry | undefined {
        const candidates = catalog.get(this.normalizeLookupName(name)) ?? [];
        if (candidates.length === 0) {
            return undefined;
        }

        const ordered = [...candidates].sort((a, b) => {
            const sourcePriority = (source: LibraryCatalogEntry['metadataSource']) => source === 'user' ? 2 : 1;
            return sourcePriority(b.metadataSource) - sourcePriority(a.metadataSource);
        });

        if (vendor) {
            const vendorMatch = ordered.find(candidate =>
                candidate.vendor?.localeCompare(vendor, undefined, { sensitivity: 'accent' }) === 0
            );
            if (vendorMatch) {
                return vendorMatch;
            }
        }

        return ordered[0];
    }

    private applyImplicitSystemLibraries(
        refsByKey: Map<string, TwinCATLibraryRef>,
        catalog: Map<string, LibraryCatalogEntry[]>
    ): void {
        const allCatalogEntries = [...catalog.values()].flat();
        const tc3GlobalTypesEntry = this.resolveCatalogLibraryMetadata(catalog, 'Tc3_GlobalTypes');
        const systemGlobalEntries = allCatalogEntries.filter(entry =>
            entry.name.localeCompare('Tc3_GlobalTypes', undefined, { sensitivity: 'accent' }) === 0 ||
            entry.virtualParent?.localeCompare('Tc3_GlobalTypes', undefined, { sensitivity: 'accent' }) === 0
        );

        if (tc3GlobalTypesEntry) {
            const systemRef = this.createImplicitSystemLibraryRef('Tc3_GlobalTypes', tc3GlobalTypesEntry);
            refsByKey.set(`${systemRef.name.toUpperCase()}|${(systemRef.vendor ?? '').toUpperCase()}|${systemRef.version}`, systemRef);
            this.implicitSystemLibraries.add(this.normalizeLookupName(systemRef.name));
        }

        if (systemGlobalEntries.length === 0) {
            return;
        }

        const supportsVirtualLibraries = this.projectBuildNumber >= 4026;
        for (const entry of systemGlobalEntries) {
            if (entry.name.localeCompare('Tc3_GlobalTypes', undefined, { sensitivity: 'accent' }) === 0) {
                continue;
            }

            this.implicitSystemLibraries.add(this.normalizeLookupName(entry.name));
            if (!supportsVirtualLibraries) {
                continue;
            }

            const systemRef = this.createImplicitSystemLibraryRef(entry.name, entry);
            refsByKey.set(`${systemRef.name.toUpperCase()}|${(systemRef.vendor ?? '').toUpperCase()}|${systemRef.version}`, systemRef);
        }
    }

    private createImplicitSystemLibraryRef(name: string, catalogEntry: LibraryCatalogEntry): TwinCATLibraryRef {
        return {
            name,
            version: catalogEntry.version ?? (this.projectBuildNumber > 0 ? `3.1.${this.projectBuildNumber}` : 'system'),
            vendor: catalogEntry.vendor ?? 'Beckhoff Automation GmbH',
            path: this.projectRoot ?? '',
            mode: 'public_symbols',
            metadataSource: 'system_global',
            infoUrl: catalogEntry.infoUrl,
            category: catalogEntry.category ?? 'System',
            suppliedWith: catalogEntry.suppliedWith ?? 'TwinCAT 3',
            summary: catalogEntry.summary ?? 'TwinCAT system-provided global type library.'
        };
    }

    private loadLibrarySymbolsFromCatalog(catalog: Map<string, LibraryCatalogEntry[]>): void {
        const applicableLibraryRefs = [
            ...this.libraryRefs,
            ...[...this.implicitSystemLibraries]
                .filter(libraryKey => !this.libraryRefs.some(ref => this.normalizeLookupName(ref.name) === libraryKey))
                .map(libraryKey => {
                    const matchingEntry = [...catalog.values()].flat().find(entry => this.normalizeLookupName(entry.name) === libraryKey);
                    return matchingEntry ? this.createImplicitSystemLibraryRef(matchingEntry.name, matchingEntry) : undefined;
                })
                .filter((ref): ref is TwinCATLibraryRef => !!ref)
        ];

        for (const libraryRef of applicableLibraryRefs) {
            const catalogEntry = this.resolveCatalogLibraryMetadata(catalog, libraryRef.name, libraryRef.vendor);
            if (!catalogEntry) {
                continue;
            }

            for (const symbolEntry of catalogEntry.symbols) {
                const key = symbolEntry.name.toUpperCase();
                if (this.symbols.has(key) || this.globalVars.has(key) || this.librarySymbols.has(key)) {
                    continue;
                }
                this.librarySymbols.set(key, {
                    name: symbolEntry.name,
                    type: symbolEntry.type ?? symbolEntry.name,
                    kind: symbolEntry.kind,
                    source: catalogEntry.infoUrl ?? libraryRef.path,
                    library: libraryRef.name,
                    documentation: symbolEntry.documentation,
                    provenance: catalogEntry.metadataSource
                });
            }

            for (const dataTypeEntry of catalogEntry.dataTypes) {
                const key = dataTypeEntry.name.toUpperCase();
                if (this.dataTypes.has(key) || this.libraryDataTypes.has(key)) {
                    continue;
                }
                this.libraryDataTypes.set(key, {
                    name: dataTypeEntry.name,
                    kind: dataTypeEntry.kind,
                    members: new Map(Object.entries(dataTypeEntry.members ?? {})),
                    source: catalogEntry.infoUrl ?? libraryRef.path,
                    library: libraryRef.name,
                    documentation: dataTypeEntry.documentation,
                    provenance: catalogEntry.metadataSource
                });
                if (!this.symbols.has(key) && !this.globalVars.has(key) && !this.librarySymbols.has(key)) {
                    this.librarySymbols.set(key, {
                        name: dataTypeEntry.name,
                        type: dataTypeEntry.kind.toUpperCase(),
                        kind: 'type',
                        source: catalogEntry.infoUrl ?? libraryRef.path,
                        library: libraryRef.name,
                        documentation: dataTypeEntry.documentation,
                        provenance: catalogEntry.metadataSource
                    });
                }
            }

            for (const symbolEntry of catalogEntry.symbols) {
                if (symbolEntry.kind !== 'functionBlock' && symbolEntry.kind !== 'program') {
                    continue;
                }
                const key = symbolEntry.name.toUpperCase();
                if (this.libraryDataTypes.has(key) || !symbolEntry.members || Object.keys(symbolEntry.members).length === 0) {
                    continue;
                }
                this.libraryDataTypes.set(key, {
                    name: symbolEntry.name,
                    kind: 'struct',
                    members: new Map(Object.entries(symbolEntry.members)),
                    source: catalogEntry.infoUrl ?? libraryRef.path,
                    library: libraryRef.name,
                    documentation: symbolEntry.documentation,
                    provenance: catalogEntry.metadataSource
                });
            }
        }
    }

    private async readLibraryRefsFromPlcProj(
        plcProjPath: string,
        tmcNames: Set<string>,
        managedLibraryIndex: Map<string, ManagedLibraryMetadata[]>,
        catalog: Map<string, LibraryCatalogEntry[]>
    ): Promise<TwinCATLibraryRef[]> {
        try {
            const text = await this.readProjectMetadataText(plcProjPath);
            if (!text) {
                return [];
            }
            const refs: TwinCATLibraryRef[] = [];
            const blockRegex = /<PlaceholderReference\b[^>]*\bInclude\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/PlaceholderReference>/gi;
            let match: RegExpExecArray | null;

            while ((match = blockRegex.exec(text)) !== null) {
                const name = match[1].trim();
                const inner = match[2];
                const defaultResolution = this.decodeXmlText(inner.match(/<DefaultResolution\b[^>]*>([\s\S]*?)<\/DefaultResolution>/i)?.[1]);
                const vendorMatch = defaultResolution?.match(/\(([^)]+)\)\s*$/);
                const vendor = vendorMatch?.[1]?.trim();
                const managedMetadata = this.resolveManagedLibraryMetadata(managedLibraryIndex, name, vendor);
                const catalogMetadata = this.resolveCatalogLibraryMetadata(catalog, name, vendor ?? managedMetadata?.vendor);
                const mode: TwinCATLibraryRef['mode'] = tmcNames.has(this.normalizeLookupName(name))
                    ? 'public_symbols'
                    : 'metadata_only';

                refs.push({
                    name,
                    version: managedMetadata?.version ?? catalogMetadata?.version ?? 'unknown',
                    vendor: vendor ?? managedMetadata?.vendor ?? catalogMetadata?.vendor,
                    path: plcProjPath,
                    mode,
                    installPath: managedMetadata?.installPath,
                    dependencies: managedMetadata?.dependencies?.length
                        ? managedMetadata.dependencies
                        : catalogMetadata?.dependencies,
                    metadataSource: managedMetadata
                        ? 'managed_libraries'
                        : catalogMetadata?.metadataSource ?? 'plcproj',
                    infoUrl: catalogMetadata?.infoUrl,
                    category: catalogMetadata?.category,
                    suppliedWith: catalogMetadata?.suppliedWith,
                    summary: catalogMetadata?.summary
                });
            }

            return refs;
        } catch {
            return [];
        }
    }

    private decodeXmlText(value: string | undefined): string | undefined {
        if (!value) {
            return undefined;
        }
        return value
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
    }

    private normalizeLookupName(value: string): string {
        return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    }

    private async loadLibrarySymbolsFromTmc(tmcFiles: string[]): Promise<void> {
        for (const tmcPath of tmcFiles) {
            try {
                const parsed = await this.parseTmcFile(tmcPath);
                parsed.symbols.forEach(symbol => {
                    const upperName = symbol.name.toUpperCase();
                    if (!this.symbols.has(upperName) && !this.globalVars.has(upperName)) {
                        this.librarySymbols.set(upperName, symbol);
                    }
                });
                parsed.dataTypes.forEach(typeInfo => {
                    const upperName = typeInfo.name.toUpperCase();
                    if (!this.dataTypes.has(upperName)) {
                        this.libraryDataTypes.set(upperName, typeInfo);
                    }
                });
            } catch (error) {
                console.warn(`Failed to parse TMC ${tmcPath}: ${String(error)}`);
            }
        }
    }

    private async parseTmcFile(tmcPath: string): Promise<{ symbols: TwinCATSymbol[]; dataTypes: TwinCATDataType[] }> {
        const stat = await fs.promises.stat(tmcPath);
        const cached = this.tmcParseCache.get(tmcPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return {
                symbols: cached.symbols.map(symbol => ({ ...symbol })),
                dataTypes: cached.dataTypes.map(typeInfo => ({
                    ...typeInfo,
                    members: new Map(typeInfo.members)
                }))
            };
        }

        const xml = await fs.promises.readFile(tmcPath, 'utf8');
        const stem = path.basename(tmcPath, '.tmc');
        const matchedLib = this.findBestLibraryForTmc(stem);
        const fallbackLibraryName = matchedLib?.name ?? stem;
        const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
        const xmlObj = await parser.parseStringPromise(xml);
        const moduleClass = xmlObj?.TcModuleClass;
        const seen = new Set<string>();
        const symbols: TwinCATSymbol[] = [];
        const dataTypes: TwinCATDataType[] = [];
        const dataTypeNodes = this.toArray<any>(moduleClass?.DataTypes?.DataType);
        const symbolNodes = this.toArray<any>(moduleClass?.Modules?.Module)
            .flatMap((moduleNode: any) => this.toArray<any>(moduleNode?.DataAreas?.DataArea))
            .flatMap((areaNode: any) => this.toArray<any>(areaNode?.Symbol));

        for (const dataTypeNode of dataTypeNodes) {
            const name = this.readTmcName(dataTypeNode?.Name);
            if (!name) {
                continue;
            }
            const libraryName = this.inferLibraryNameForDataType(dataTypeNode, fallbackLibraryName);

            const kind = this.inferSymbolKindFromTmcDataType(dataTypeNode, name);
            const key = `${name.toUpperCase()}|${kind}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);

            const members = this.extractTmcMembersFromNode(dataTypeNode);
            symbols.push({
                name,
                type: this.resolveTmcSymbolType(dataTypeNode, kind, name),
                kind,
                source: tmcPath,
                library: libraryName,
                documentation: this.readTmcComment(dataTypeNode) ?? `Resolved from TMC: ${tmcPath}`,
                provenance: 'tmc'
            });

            if (kind === 'type' || kind === 'functionBlock' || kind === 'program') {
                dataTypes.push({
                    name,
                    kind: this.inferTmcDataTypeKind(dataTypeNode, members),
                    members,
                    source: tmcPath,
                    library: libraryName,
                    documentation: this.readTmcComment(dataTypeNode),
                    provenance: 'tmc'
                });
            }
        }

        for (const symbolNode of symbolNodes) {
            const fullName = this.readTmcName(symbolNode?.Name);
            if (!fullName) {
                continue;
            }
            const libraryName = this.inferLibraryNameForSymbol(symbolNode, fallbackLibraryName);
            const name = fullName.split('.').pop() ?? fullName;
            const key = `${name.toUpperCase()}|variable`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);

            symbols.push({
                name,
                type: this.readTmcTypeReference(symbolNode?.BaseType) ?? this.readTmcTypeReference(symbolNode?.Type) ?? 'ANY',
                kind: 'variable',
                source: tmcPath,
                library: libraryName,
                documentation: this.readTmcComment(symbolNode) ?? `Resolved from TMC: ${tmcPath}`,
                provenance: 'tmc'
            });
        }

        this.tmcParseCache.set(tmcPath, {
            mtimeMs: stat.mtimeMs,
            symbols: symbols.map(symbol => ({ ...symbol })),
            dataTypes: dataTypes.map(typeInfo => ({ ...typeInfo, members: new Map(typeInfo.members) }))
        });

        return { symbols, dataTypes };
    }

    private toArray<T>(value: T | T[] | undefined): T[] {
        if (value === undefined || value === null) {
            return [];
        }
        return Array.isArray(value) ? value : [value];
    }

    private readTmcName(value: any): string | undefined {
        if (!value) {
            return undefined;
        }
        if (typeof value === 'string') {
            return value.trim() || undefined;
        }
        if (typeof value._ === 'string') {
            return value._.trim() || undefined;
        }
        return undefined;
    }

    private readTmcPropertyMap(node: any): Map<string, string> {
        const properties = new Map<string, string>();
        this.toArray<any>(node?.Properties?.Property).forEach(propertyNode => {
            const name = this.readTmcName(propertyNode?.Name);
            const value = this.readTmcName(propertyNode?.Value) ?? '';
            if (name) {
                properties.set(name, value);
            }
        });
        return properties;
    }

    private readTmcNamespace(value: any): string | undefined {
        if (!value || typeof value !== 'object') {
            return undefined;
        }
        const namespace = value.Namespace;
        return typeof namespace === 'string' && namespace.trim().length > 0
            ? namespace.trim()
            : undefined;
    }

    private readTmcComment(node: any): string | undefined {
        const comment = this.readTmcName(node?.Comment);
        return comment && comment.length > 0 ? comment : undefined;
    }

    private inferLibraryNameForDataType(node: any, fallbackLibraryName: string): string {
        return this.readTmcNamespace(node?.Name)
            ?? this.readTmcNamespace(node?.BaseType)
            ?? this.readTmcNamespace(node?.Type)
            ?? fallbackLibraryName;
    }

    private inferLibraryNameForSymbol(node: any, fallbackLibraryName: string): string {
        return this.readTmcNamespace(node?.BaseType)
            ?? this.readTmcNamespace(node?.Type)
            ?? this.readTmcNamespace(node?.Name)
            ?? fallbackLibraryName;
    }

    private inferSymbolKindFromTmcDataType(node: any, name: string): TwinCATSymbol['kind'] {
        const properties = this.readTmcPropertyMap(node);
        const pouType = (properties.get('PouType') || '').trim().toUpperCase();
        if (pouType === 'FUNCTIONBLOCK' || /^FB_/i.test(name)) {
            return 'functionBlock';
        }
        if (pouType === 'FUNCTION' || /^F_/i.test(name)) {
            return 'function';
        }
        if (pouType === 'PROGRAM' || /^PRG_/i.test(name)) {
            return 'program';
        }
        return 'type';
    }

    private inferTmcDataTypeKind(node: any, members: Map<string, string>): TwinCATDataType['kind'] {
        if (this.toArray<any>(node?.EnumInfo).length > 0) {
            return 'enum';
        }
        return members.size > 0 ? 'struct' : 'alias';
    }

    private resolveTmcSymbolType(node: any, kind: TwinCATSymbol['kind'], name: string): string {
        const explicitType =
            this.readTmcTypeReference(node?.BaseType) ??
            this.readTmcTypeReference(node?.Type) ??
            this.readTmcTypeReference(node?.ReturnType);
        if (explicitType) {
            return explicitType;
        }
        if (kind === 'type' || kind === 'functionBlock' || kind === 'function' || kind === 'program') {
            return name;
        }
        return `${kind.toUpperCase()} ${name}`;
    }

    private extractTmcMembersFromNode(node: any): Map<string, string> {
        const members = new Map<string, string>();
        this.toArray<any>(node?.SubItem).forEach(subItem => {
            const name = this.readTmcName(subItem?.Name);
            const type = this.readTmcTypeReference(subItem?.Type) ?? this.readTmcTypeReference(subItem?.BaseType);
            if (name && type) {
                members.set(name, type);
            }
        });
        this.toArray<any>(node?.Method).forEach(methodNode => {
            const name = this.readTmcName(methodNode?.Name);
            const type = this.readTmcTypeReference(methodNode?.ReturnType) ?? 'METHOD';
            if (name) {
                members.set(name, type);
            }
        });
        this.toArray<any>(node?.Property).forEach(propertyNode => {
            const name = this.readTmcName(propertyNode?.Name);
            const type = this.readTmcTypeReference(propertyNode?.Type) ?? 'PROPERTY';
            if (name) {
                members.set(name, type);
            }
        });
        this.toArray<any>(node?.EnumInfo).forEach(enumNode => {
            const name = this.readTmcName(enumNode?.Text);
            if (name) {
                members.set(name, 'ENUM_MEMBER');
            }
        });
        return members;
    }

    private readTmcTypeReference(value: any): string | undefined {
        const typeName = this.readTmcName(value);
        if (!typeName) {
            return undefined;
        }
        return this.normalizeLookupType(typeName);
    }

    private normalizeLookupType(value: string): string {
        const trimmed = value.trim();
        const segments = trimmed.split(/[.:]/).filter(Boolean);
        return segments[segments.length - 1] || trimmed;
    }

    private findBestLibraryForTmc(tmcStem: string): TwinCATLibraryRef | undefined {
        const exact = this.libraryRefs.find(lib => lib.name.localeCompare(tmcStem, undefined, { sensitivity: 'accent' }) === 0);
        if (exact) {
            return exact;
        }

        const normalizedStem = this.normalizeLookupName(tmcStem);
        return this.libraryRefs.find(lib => {
            const normalizedName = this.normalizeLookupName(lib.name);
            return normalizedStem.includes(normalizedName) || normalizedName.includes(normalizedStem);
        });
    }

    /**
     * Check if a variable name is known (declared or global)
     */
    public isKnownVariable(name: string): boolean {
        const upperName = name.toUpperCase();
        return this.symbols.has(upperName) || 
               this.globalVars.has(upperName) ||
               this.dataTypes.has(upperName) ||
               this.librarySymbols.has(upperName) ||
               this.libraryDataTypes.has(upperName);
    }

    /**
     * Get symbol information for a name
     */
    public getSymbol(name: string): TwinCATSymbol | undefined {
        const upperName = name.toUpperCase();
        return this.symbols.get(upperName) || this.globalVars.get(upperName) || this.librarySymbols.get(upperName);
    }

    /**
     * Get data type information
     */
    public getDataType(name: string): TwinCATDataType | undefined {
        return this.dataTypes.get(name.toUpperCase()) || this.libraryDataTypes.get(name.toUpperCase());
    }

    public getQualifiedOnlyOwners(name: string): { globals: string[]; enums: string[] } {
        const key = name.toUpperCase();
        return {
            globals: [...(this.qualifiedOnlyGlobalMembers.get(key) ?? [])].sort((a, b) => a.localeCompare(b)),
            enums: [...(this.qualifiedOnlyEnumMembers.get(key) ?? [])].sort((a, b) => a.localeCompare(b))
        };
    }

    public getQualifiedOnlyUsageInfo(): QualifiedOnlyUsageInfo {
        const cloneMap = (source: Map<string, Set<string>>): Map<string, Set<string>> => {
            const result = new Map<string, Set<string>>();
            source.forEach((owners, memberName) => {
                result.set(memberName, new Set(owners));
            });
            return result;
        };

        return {
            globals: cloneMap(this.qualifiedOnlyGlobalMembers),
            enums: cloneMap(this.qualifiedOnlyEnumMembers)
        };
    }

    /**
     * Get all global variables
     */
    public getGlobalVariables(): Map<string, TwinCATSymbol> {
        return new Map(this.globalVars);
    }

    /**
     * Get all data types
     */
    public getDataTypes(): Map<string, TwinCATDataType> {
        return new Map([...this.dataTypes, ...this.libraryDataTypes]);
    }

    public forEachDataType(visitor: (typeInfo: TwinCATDataType, key: string) => void): void {
        this.dataTypes.forEach((typeInfo, key) => visitor(typeInfo, key));
        this.libraryDataTypes.forEach((typeInfo, key) => {
            if (!this.dataTypes.has(key)) {
                visitor(typeInfo, key);
            }
        });
    }

    /**
     * Get all symbols
     */
    public getAllSymbols(): Map<string, TwinCATSymbol> {
        return new Map([...this.symbols, ...this.globalVars, ...this.librarySymbols]);
    }

    public forEachAllSymbols(visitor: (symbol: TwinCATSymbol, key: string) => void): void {
        this.symbols.forEach((symbol, key) => visitor(symbol, key));
        this.globalVars.forEach((symbol, key) => {
            if (!this.symbols.has(key)) {
                visitor(symbol, key);
            }
        });
        this.librarySymbols.forEach((symbol, key) => {
            if (!this.symbols.has(key) && !this.globalVars.has(key)) {
                visitor(symbol, key);
            }
        });
    }

    public getLibraryReferences(): TwinCATLibraryRef[] {
        return [...this.libraryRefs];
    }

    public getLibraryApi(libraryName: string, aliases: string[] = []): {
        reference?: TwinCATLibraryRef;
        symbols: TwinCATSymbol[];
        dataTypes: TwinCATDataType[];
    } {
        const candidateNames = [...new Set([libraryName, ...aliases].map(value => value?.trim()).filter((value): value is string => !!value))];
        const normalizedCandidates = new Set(candidateNames.map(value => this.normalizeLookupName(value)));
        const reference =
            this.libraryRefs.find(lib =>
                candidateNames.some(candidate => lib.name.localeCompare(candidate, undefined, { sensitivity: 'accent' }) === 0)
            )
            ?? this.libraryRefs.find(lib => normalizedCandidates.has(this.normalizeLookupName(lib.name)));

        if (reference) {
            normalizedCandidates.add(this.normalizeLookupName(reference.name));
        }

        const symbols = [...this.librarySymbols.values()]
            .filter(symbol => symbol.library && normalizedCandidates.has(this.normalizeLookupName(symbol.library)))
            .sort((a, b) => {
                const byKind = a.kind.localeCompare(b.kind);
                if (byKind !== 0) return byKind;
                return a.name.localeCompare(b.name);
            });
        const dataTypes = [...this.libraryDataTypes.values()]
            .filter(typeInfo => typeInfo.library && normalizedCandidates.has(this.normalizeLookupName(typeInfo.library)))
            .sort((a, b) => {
                const byKind = a.kind.localeCompare(b.kind);
                if (byKind !== 0) return byKind;
                return a.name.localeCompare(b.name);
            });

        return {
            reference,
            symbols,
            dataTypes
        };
    }

    public getIndexRevision(): number {
        return this.indexRevision;
    }

    public getLibraryContextModes(): Map<string, TwinCATLibraryRef['mode']> {
        return new Map(this.libraryContextModes);
    }

    public async refreshExternalLibraryMetadata(): Promise<void> {
        this.managedLibraryIndex = undefined;
        this.managedLibraryIndexPromise = undefined;

        if (!this.initialized || !this.projectRoot) {
            return;
        }

        await this.queueLibraryRefresh();
    }

    public getTypeResolutionStatus(typeName: string): 'known' | 'metadata_only' | 'unknown' {
        const upperType = typeName.toUpperCase();
        if (this.isValidType(upperType) || this.dataTypes.has(upperType)) {
            return 'known';
        }

        if (this.libraryContextModes.has(upperType)) {
            return this.libraryContextModes.get(upperType) === 'metadata_only' ? 'metadata_only' : 'known';
        }

        if (this.librarySymbols.has(upperType) || this.libraryDataTypes.has(upperType)) {
            return 'known';
        }

        const fallbackType = this.resolveTypeFallbackName(typeName);
        if (fallbackType && fallbackType.toUpperCase() !== upperType) {
            const fallbackUpper = fallbackType.toUpperCase();
            if (this.isValidType(fallbackUpper) || this.dataTypes.has(fallbackUpper) || this.libraryDataTypes.has(fallbackUpper) || this.librarySymbols.has(fallbackUpper)) {
                return 'known';
            }
        }

        return 'unknown';
    }

    /**
     * Check if a type is valid (built-in or user-defined)
     */
    public isValidType(typeName: string): boolean {
        const upperType = typeName.toUpperCase();
        
        // Check built-in types
        const builtInTypes = [
            'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
            'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
            'REAL', 'LREAL', 'TIME', 'DATE', 'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT',
            'STRING', 'WSTRING', 'ARRAY'
        ];
        
        if (builtInTypes.includes(upperType)) {
            return true;
        }
        
        // Check user-defined types
        if (this.dataTypes.has(upperType)) {
            return true;
        }

        if (this.libraryDataTypes.has(upperType)) {
            return true;
        }
        
        // Check if it's a known FB type
        const symbol = this.symbols.get(upperType);
        if (symbol && (symbol.kind === 'functionBlock' || symbol.kind === 'type')) {
            return true;
        }

        const librarySymbol = this.librarySymbols.get(upperType);
        if (librarySymbol && (librarySymbol.kind === 'functionBlock' || librarySymbol.kind === 'type' || librarySymbol.kind === 'program')) {
            return true;
        }

        const fallbackType = this.resolveTypeFallbackName(typeName);
        if (fallbackType && fallbackType.toUpperCase() !== upperType) {
            return this.isValidType(fallbackType);
        }
        
        return false;
    }

    private resolveTypeFallbackName(typeName: string): string | undefined {
        if (!typeName) {
            return undefined;
        }

        const trimmed = typeName.trim();
        if (!trimmed.includes('.')) {
            return undefined;
        }

        return trimmed.split('.').pop()?.trim();
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
            this.scanTimer = undefined;
        }
        if (this.libraryRefreshTimer) {
            clearTimeout(this.libraryRefreshTimer);
            this.libraryRefreshTimer = undefined;
        }
        this.libraryRefreshCycle = undefined;
        this.libraryRefreshExecuting = false;
        this.libraryRefreshDueAt = 0;
        if (this.fileUpdateTimer) {
            clearTimeout(this.fileUpdateTimer);
            this.fileUpdateTimer = undefined;
        }
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
        if (this.libraryMetadataWatcher) {
            this.libraryMetadataWatcher.dispose();
        }
        if (this.globalLibraryMetadataWatcher) {
            this.globalLibraryMetadataWatcher.dispose();
        }
        this.initialized = false;
        this.initializePromise = undefined;
        this.libraryPlaceholderSymbolKeys.clear();
        this.tmcParseCache.clear();
        this.projectMetadataTextCache.clear();
        this.managedLibraryIndex = undefined;
        this.managedLibraryIndexPromise = undefined;
        this.indexRefreshedEmitter.dispose();
    }

    public onDidRefreshIndex(listener: () => void): vscode.Disposable {
        return this.indexRefreshedEmitter.event(listener);
    }
}

// Singleton instance
let analyzer: TwinCATProjectAnalyzer | undefined;
const analyzerCreatedEmitter = new vscode.EventEmitter<TwinCATProjectAnalyzer>();

export function getProjectAnalyzer(): TwinCATProjectAnalyzer {
    if (!analyzer) {
        analyzer = new TwinCATProjectAnalyzer();
        analyzerCreatedEmitter.fire(analyzer);
    }
    return analyzer;
}

export function onProjectAnalyzerCreated(listener: (analyzer: TwinCATProjectAnalyzer) => void): vscode.Disposable {
    return analyzerCreatedEmitter.event(listener);
}

export function initializeProjectAnalyzer(): Promise<void> {
    const analyzer = getProjectAnalyzer();
    return analyzer.initialize();
}

export async function refreshProjectAnalyzerLibraryMetadata(): Promise<void> {
    if (!analyzer) {
        return;
    }

    await analyzer.refreshExternalLibraryMetadata();
}

export function disposeProjectAnalyzer(): void {
    if (!analyzer) {
        return;
    }
    analyzer.dispose();
    analyzer = undefined;
}
