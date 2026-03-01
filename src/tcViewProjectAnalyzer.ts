import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import { TwinCATXmlConverter } from './tcViewXmlConverter';
import { TwinCATLibraryRef } from './tcViewTypes';

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
}

/**
 * TwinCAT Project Analyzer - Scans and analyzes TwinCAT project structure
 */
export class TwinCATProjectAnalyzer {
    private projectRoot: string | undefined;
    private symbols: Map<string, TwinCATSymbol> = new Map();
    private dataTypes: Map<string, TwinCATDataType> = new Map();
    private globalVars: Map<string, TwinCATSymbol> = new Map();
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private converter: TwinCATXmlConverter;
    private scanTimer: NodeJS.Timeout | undefined;
    private libraryRefreshTimer: NodeJS.Timeout | undefined;
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
    }>();
    private libraryRefs: TwinCATLibraryRef[] = [];
    private libraryPlaceholderSymbolKeys = new Set<string>();
    private librarySymbols = new Map<string, TwinCATSymbol>();
    private libraryDataTypes = new Map<string, TwinCATDataType>();
    private libraryContextModes = new Map<string, TwinCATLibraryRef['mode']>();
    private tmcParseCache = new Map<string, { mtimeMs: number; symbols: TwinCATSymbol[]; dataTypes: TwinCATDataType[] }>();
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

        // Find TwinCAT project root (look for .tsproj files)
        for (const folder of workspaceFolders) {
            const tsprojFiles = await this.findTsprojFiles(folder.uri.fsPath);
            if (tsprojFiles.length > 0) {
                this.projectRoot = path.dirname(tsprojFiles[0]);
                break;
            }
        }

        // If no .tsproj found, use first workspace folder
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
     * Find all .tsproj files in a directory
     */
    private async findTsprojFiles(dir: string): Promise<string[]> {
        const files: string[] = [];
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.tsproj')) {
                    files.push(path.join(dir, entry.name));
                }
            }
        } catch (error) {
            console.error('Error finding .tsproj files:', error);
        }
        return files;
    }

    /**
     * Setup file watcher to detect changes
     */
    private setupFileWatcher(): void {
        // Watch TwinCAT PLC source plus project/library metadata outputs.
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            '**/*.{TcPOU,TcGVL,TcDUT,TcPRG,TcCOM,TcAPP,TcVAR,TcGDS,TcIO,TcITF,plcproj,tsproj,tmc}'
        );

        this.fileWatcher.onDidCreate(uri => this.handleWatchedFileEvent(uri.fsPath, 'change'));
        this.fileWatcher.onDidChange(uri => this.handleWatchedFileEvent(uri.fsPath, 'change'));
        this.fileWatcher.onDidDelete(uri => this.handleWatchedFileEvent(uri.fsPath, 'delete'));
    }

    private handleWatchedFileEvent(filePath: string, kind: 'change' | 'delete'): void {
        if (this.isPLCFile(filePath)) {
            this.scheduleFileUpdate(filePath, kind);
            return;
        }

        if (this.isLibraryMetadataFile(filePath)) {
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
        if (this.libraryRefreshTimer) {
            clearTimeout(this.libraryRefreshTimer);
        }

        this.libraryRefreshTimer = setTimeout(() => {
            this.libraryRefreshTimer = undefined;
            void this.refreshLibraryMetadataOnly();
        }, delayMs);
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
        for (const filePath of deleted) {
            this.removeFileContributions(filePath);
        }

        await Promise.allSettled(changed.map(filePath => this.parseFile(filePath)));
        this.indexRevision++;
        this.indexRefreshedEmitter.fire();
        if (this.isPerfLoggingEnabled()) {
            console.log(`[TcView Perf] Incremental symbol update (${changed.length} changed, ${deleted.length} deleted): ${Date.now() - start} ms`);
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
    private async parseFile(filePath: string): Promise<void> {
        if (!this.isPLCFile(filePath)) {
            return;
        }

        try {
            const fingerprint = await this.getFileFingerprint(filePath);
            const previousFingerprint = this.fileFingerprints.get(filePath);
            if (fingerprint && previousFingerprint === fingerprint && this.fileContributions.has(filePath)) {
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const contribution = {
                symbolKeys: new Set<string>(),
                dataTypeKeys: new Set<string>(),
                globalVarKeys: new Set<string>()
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
        } catch (error) {
            console.error(`Error parsing ${filePath}:`, error);
        }
    }

    /**
     * Parse GVL (Global Variable List) file
     */
    private async parseGVLFile(filePath: string, content: string, contribution: { symbolKeys: Set<string>; dataTypeKeys: Set<string>; globalVarKeys: Set<string> }): Promise<void> {
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
        } catch (error) {
            console.error(`Error parsing GVL file ${filePath}:`, error);
        }
    }

    /**
     * Parse DUT (Data Type Unit) file for STRUCT/ENUM definitions
     */
    private async parseDUTFile(filePath: string, content: string, contribution: { symbolKeys: Set<string>; dataTypeKeys: Set<string>; globalVarKeys: Set<string> }): Promise<void> {
        try {
            const stContent = await this.converter.convertXmlToST(content);
            
            // Extract STRUCT definition
            const structMatch = stContent.match(/TYPE\s+(\w+)\s*:\s*STRUCT\s*([\s\S]*?)\s*END_STRUCT\s*;/i);
            if (structMatch) {
                const typeName = structMatch[1];
                const structBody = structMatch[2];
                
                const members = new Map<string, string>();
                const memberRegex = /(\w+)\s*:\s*(\w+);/g;
                let match;
                while ((match = memberRegex.exec(structBody)) !== null) {
                    members.set(match[1], match[2]);
                }

                this.dataTypes.set(typeName.toUpperCase(), {
                    name: typeName,
                    kind: 'struct',
                    members,
                    source: filePath
                });
                contribution.dataTypeKeys.add(typeName.toUpperCase());

                // Also add as a symbol
                this.symbols.set(typeName.toUpperCase(), {
                    name: typeName,
                    type: 'STRUCT',
                    kind: 'type',
                    source: filePath
                });
                contribution.symbolKeys.add(typeName.toUpperCase());
            }

            // Extract ENUM definition
            const enumMatch = stContent.match(/TYPE\s+(\w+)\s*:\s*\(([\s\S]*?)\)\s*;/i);
            if (enumMatch) {
                const typeName = enumMatch[1];
                const enumValues = enumMatch[2].split(',').map((v: string) => v.trim());

                const members = new Map<string, string>();
                enumValues.forEach((val: string, idx: number) => {
                    members.set(val, 'INT');
                });

                this.dataTypes.set(typeName.toUpperCase(), {
                    name: typeName,
                    kind: 'enum',
                    members,
                    source: filePath
                });
                contribution.dataTypeKeys.add(typeName.toUpperCase());

                this.symbols.set(typeName.toUpperCase(), {
                    name: typeName,
                    type: 'ENUM',
                    kind: 'type',
                    source: filePath
                });
                contribution.symbolKeys.add(typeName.toUpperCase());
            }
        } catch (error) {
            console.error(`Error parsing DUT file ${filePath}:`, error);
        }
    }

    /**
     * Parse POU (Program/Function/FB) file
     */
    private async parsePOUFile(filePath: string, content: string, contribution: { symbolKeys: Set<string>; dataTypeKeys: Set<string>; globalVarKeys: Set<string> }): Promise<void> {
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
        await this.refreshLibraryMetadata();
        this.indexRevision++;
        this.indexRefreshedEmitter.fire();
        if (this.isPerfLoggingEnabled()) {
            console.log(`[TcView Perf] Library metadata refresh: ${Date.now() - start} ms`);
        }
    }

    private indexPouMembersFromXmlText(filePath: string, content: string, contribution: { symbolKeys: Set<string>; dataTypeKeys: Set<string>; globalVarKeys: Set<string> }): void {
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
    private extractVariables(varSection: string, source: string, kind: TwinCATSymbol['kind'], contribution: { symbolKeys: Set<string>; dataTypeKeys: Set<string>; globalVarKeys: Set<string> }): void {
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

    private removeFileContributions(filePath: string): void {
        const previous = this.fileContributions.get(filePath);
        if (!previous) return;

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

        this.fileContributions.delete(filePath);
        this.fileFingerprints.delete(filePath);
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
        return ['.plcproj', '.tsproj', '.tmc'].includes(path.extname(filePath).toLowerCase());
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

        if (!this.projectRoot) {
            return;
        }

        const plcProjFiles = await this.findProjectFiles('**/*.plcproj');
        const tmcInventory = await this.collectAvailableTmcFiles();
        const refsByKey = new Map<string, TwinCATLibraryRef>();
        for (const plcProj of plcProjFiles) {
            const refs = await this.readLibraryRefsFromPlcProj(plcProj, tmcInventory.names);
            for (const ref of refs) {
                const key = `${ref.name.toUpperCase()}|${(ref.vendor ?? '').toUpperCase()}|${ref.version}`;
                if (!refsByKey.has(key)) {
                    refsByKey.set(key, ref);
                }
            }
        }

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
                documentation: `${lib.vendor ?? 'Unknown vendor'} (${lib.mode})`
            });
            this.libraryPlaceholderSymbolKeys.add(key);
        }

        await this.loadLibrarySymbolsFromTmc(tmcInventory.files);

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

    private async readLibraryRefsFromPlcProj(plcProjPath: string, tmcNames: Set<string>): Promise<TwinCATLibraryRef[]> {
        try {
            const text = await fs.promises.readFile(plcProjPath, 'utf8');
            const refs: TwinCATLibraryRef[] = [];
            const blockRegex = /<PlaceholderReference\b[^>]*\bInclude\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/PlaceholderReference>/gi;
            let match: RegExpExecArray | null;

            while ((match = blockRegex.exec(text)) !== null) {
                const name = match[1].trim();
                const inner = match[2];
                const defaultResolution = this.decodeXmlText(inner.match(/<DefaultResolution\b[^>]*>([\s\S]*?)<\/DefaultResolution>/i)?.[1]);
                const vendorMatch = defaultResolution?.match(/\(([^)]+)\)\s*$/);
                const vendor = vendorMatch?.[1]?.trim();
                const mode: TwinCATLibraryRef['mode'] = tmcNames.has(this.normalizeLookupName(name))
                    ? 'public_symbols'
                    : 'metadata_only';

                refs.push({
                    name,
                    version: 'unknown',
                    vendor,
                    path: plcProjPath,
                    mode
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
            });

            if (kind === 'type' || kind === 'functionBlock' || kind === 'program') {
                dataTypes.push({
                    name,
                    kind: this.inferTmcDataTypeKind(dataTypeNode, members),
                    members,
                    source: tmcPath,
                    library: libraryName,
                    documentation: this.readTmcComment(dataTypeNode)
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
                documentation: this.readTmcComment(symbolNode) ?? `Resolved from TMC: ${tmcPath}`
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

    public getLibraryApi(libraryName: string): {
        reference?: TwinCATLibraryRef;
        symbols: TwinCATSymbol[];
        dataTypes: TwinCATDataType[];
    } {
        const reference = this.libraryRefs.find(lib => lib.name.localeCompare(libraryName, undefined, { sensitivity: 'accent' }) === 0);
        const normalizedLibrary = this.normalizeLookupName(libraryName);
        const symbols = [...this.librarySymbols.values()]
            .filter(symbol => symbol.library && this.normalizeLookupName(symbol.library) === normalizedLibrary)
            .sort((a, b) => {
                const byKind = a.kind.localeCompare(b.kind);
                if (byKind !== 0) return byKind;
                return a.name.localeCompare(b.name);
            });
        const dataTypes = [...this.libraryDataTypes.values()]
            .filter(typeInfo => typeInfo.library && this.normalizeLookupName(typeInfo.library) === normalizedLibrary)
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
        
        return false;
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
        if (this.fileUpdateTimer) {
            clearTimeout(this.fileUpdateTimer);
            this.fileUpdateTimer = undefined;
        }
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
        this.initialized = false;
        this.initializePromise = undefined;
        this.libraryPlaceholderSymbolKeys.clear();
        this.tmcParseCache.clear();
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

export function disposeProjectAnalyzer(): void {
    if (!analyzer) {
        return;
    }
    analyzer.dispose();
    analyzer = undefined;
}

