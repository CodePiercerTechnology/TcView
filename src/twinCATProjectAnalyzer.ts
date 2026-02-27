import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import { TwinCATXmlConverter } from './twinCATXmlConverter';

/**
 * Represents a symbol in the TwinCAT project (variable, type, FB, etc.)
 */
export interface TwinCATSymbol {
    name: string;
    type: string;
    kind: 'variable' | 'type' | 'functionBlock' | 'function' | 'program' | 'global';
    source: string; // File path where defined
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
        this.setupFileWatcher();

        // Initial scan
        await this.scanProject();
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
        // Watch all TwinCAT PLC files
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            '**/*.{TcPOU,TcGVL,TcDUT,TcPRG,TcCOM,TcAPP,TcVAR,TcGDS,TcIO,TcITF}'
        );

        this.fileWatcher.onDidCreate(uri => this.scheduleFileUpdate(uri.fsPath, 'change'));
        this.fileWatcher.onDidChange(uri => this.scheduleFileUpdate(uri.fsPath, 'change'));
        this.fileWatcher.onDidDelete(uri => this.scheduleFileUpdate(uri.fsPath, 'delete'));
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
            this.fileContributions.clear();
            this.fileFingerprints.clear();

            // Find all PLC files
            const plcFiles = await this.findPLCFiles(this.projectRoot);

            // Parse files in parallel
            await Promise.allSettled(plcFiles.map(file => this.parseFile(file)));

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
    private async findPLCFiles(dir: string): Promise<string[]> {
        const files: string[] = [];
        const pattern = '**/*.{TcPOU,TcGVL,TcDUT,TcPRG,TcCOM,TcAPP,TcVAR,TcGDS,TcIO,TcITF,tcpou,tcgvl,tcdut,tcprg,tccom,tcapp,tcvar,tcgds,tcio,tcitf}';
        
        
        try {
            const foundFiles = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
            for (const file of foundFiles) {
                if (file.fsPath.startsWith(this.projectRoot!)) {
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
                const enumValues = enumMatch[2].split(',').map(v => v.trim());

                const members = new Map<string, string>();
                enumValues.forEach((val, idx) => {
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

            // Also index POU members declared in XML (methods/properties/actions/transitions),
            // supporting both Name attributes and <Name> child nodes, including nested folders.
            await this.indexPouMembersFromXml(filePath, content, contribution);
        } catch (error) {
            console.error(`Error parsing POU file ${filePath}:`, error);
        }
    }

    private async indexPouMembersFromXml(filePath: string, content: string, contribution: { symbolKeys: Set<string>; dataTypeKeys: Set<string>; globalVarKeys: Set<string> }): Promise<void> {
        try {
            const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
            const xmlObj = await parser.parseStringPromise(content);
            const pou = xmlObj.TcPOU ?? xmlObj.TcPlcObject?.POU;
            if (!pou) return;

            const toArray = <T>(value: T | T[] | undefined): T[] =>
                Array.isArray(value) ? value : value ? [value] : [];
            const getNodeName = (node: any): string | undefined => {
                if (!node) return undefined;
                if (typeof node.Name === 'string') return node.Name;
                if (node.Name && typeof node.Name._ === 'string') return node.Name._;
                return undefined;
            };
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

            const walkPouNode = (node: any) => {
                if (!node) return;

                for (const method of toArray(node.Method)) {
                    const name = getNodeName(method);
                    if (name) registerMember(name, 'METHOD', 'function');
                }
                for (const property of toArray(node.Property)) {
                    const name = getNodeName(property);
                    if (name) registerMember(name, 'PROPERTY', 'variable');
                }
                for (const action of toArray(node.Action)) {
                    const name = getNodeName(action);
                    if (name) registerMember(name, 'ACTION', 'function');
                }
                for (const transition of toArray(node.Transition)) {
                    const name = getNodeName(transition);
                    if (name) registerMember(name, 'TRANSITION', 'function');
                }

                for (const folder of toArray(node.Folder)) {
                    walkPouNode(folder);
                }
            };

            walkPouNode(pou);
        } catch (error) {
            console.error(`Error indexing POU members from XML ${filePath}:`, error);
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

    /**
     * Check if a variable name is known (declared or global)
     */
    public isKnownVariable(name: string): boolean {
        const upperName = name.toUpperCase();
        return this.symbols.has(upperName) || 
               this.globalVars.has(upperName) ||
               this.dataTypes.has(upperName);
    }

    /**
     * Get symbol information for a name
     */
    public getSymbol(name: string): TwinCATSymbol | undefined {
        const upperName = name.toUpperCase();
        return this.symbols.get(upperName) || this.globalVars.get(upperName);
    }

    /**
     * Get data type information
     */
    public getDataType(name: string): TwinCATDataType | undefined {
        return this.dataTypes.get(name.toUpperCase());
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
        return new Map(this.dataTypes);
    }

    /**
     * Get all symbols
     */
    public getAllSymbols(): Map<string, TwinCATSymbol> {
        return new Map([...this.symbols, ...this.globalVars]);
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
        
        // Check if it's a known FB type
        const symbol = this.symbols.get(upperType);
        if (symbol && (symbol.kind === 'functionBlock' || symbol.kind === 'type')) {
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
        if (this.fileUpdateTimer) {
            clearTimeout(this.fileUpdateTimer);
            this.fileUpdateTimer = undefined;
        }
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
    }
}

// Singleton instance
let analyzer: TwinCATProjectAnalyzer | undefined;

export function getProjectAnalyzer(): TwinCATProjectAnalyzer {
    if (!analyzer) {
        analyzer = new TwinCATProjectAnalyzer();
    }
    return analyzer;
}

export function initializeProjectAnalyzer(): Promise<void> {
    const analyzer = getProjectAnalyzer();
    return analyzer.initialize();
}

