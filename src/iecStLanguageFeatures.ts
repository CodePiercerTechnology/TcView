import * as vscode from 'vscode';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { getProjectAnalyzer, initializeProjectAnalyzer, onProjectAnalyzerCreated } from './tcViewProjectAnalyzer';
import { buildAstAnalysis } from './iecStAst';
import { TwinCATFileSystemProvider } from './tcViewFileSystemProvider';
import { isTcviewLintRuleSuppressed, parseTcviewLintPragmas } from './tcviewLintPragmas';
import {
    iecBuiltinFunctions,
    iecBuiltinNamespaces,
    iecBuiltinTypes,
    isConversionFunctionName,
    isKnownIecBuiltinFunction,
    isKnownIecBuiltinNamespace,
    isKnownIecBuiltinType
} from './iecStBuiltins';
import { iecStKeywords, iecStKeywordSet } from './iecStKeywords';

type IECPrimitiveType =
    | 'BOOL'
    | 'INT'
    | 'DINT'
    | 'UDINT'
    | 'REAL'
    | 'LREAL'
    | 'TIME'
    | 'STRING'
    | 'WSTRING'
    | 'UNKNOWN';

interface IECStandardDefinition {
    kind: 'functionBlock' | 'function' | 'type' | 'constant';
    summary: string;
    members?: Array<{ name: string; type: string; description: string }>;
    parameters?: Array<{ name: string; type: string; direction: 'IN' | 'OUT' | 'IN_OUT'; description: string }>;
    example?: string;
}

export function isKnownIecBuiltinIdentifier(value: string): boolean {
    const upper = value.toUpperCase();
    return iecStKeywordSet.has(upper) ||
        stdSymbolSet.has(upper) ||
        isKnownIecBuiltinType(upper) ||
        isKnownIecBuiltinFunction(upper) ||
        isKnownIecBuiltinNamespace(upper);
}
// IEC ST Snippets
const iecStSnippets: { [key: string]: vscode.SnippetString } = {
    'IF Statement': new vscode.SnippetString([
        'IF ${1:condition} THEN',
        '\t${2:// statements}',
        'END_IF;'
    ].join('\n')),
    
    'IF-ELSE Statement': new vscode.SnippetString([
        'IF ${1:condition} THEN',
        '\t${2:// statements}',
        'ELSE',
        '\t${3:// statements}',
        'END_IF;'
    ].join('\n')),
    
    'IF-ELSIF-ELSE Statement': new vscode.SnippetString([
        'IF ${1:condition1} THEN',
        '\t${2:// statements}',
        'ELSIF ${3:condition2} THEN',
        '\t${4:// statements}',
        'ELSE',
        '\t${5:// statements}',
        'END_IF;'
    ].join('\n')),
    
    'CASE Statement': new vscode.SnippetString([
        'CASE ${1:selector} OF',
        '\t${2:1}: ${3:// statements}',
        '\t${4:2}: ${5:// statements}',
        '\tELSE',
        '\t\t${6:// statements}',
        'END_CASE;'
    ].join('\n')),
    
    'FOR Loop': new vscode.SnippetString([
        'FOR ${1:i} := ${2:1} TO ${3:10} BY ${4:1} DO',
        '\t${5:// statements}',
        'END_FOR;'
    ].join('\n')),
    
    'WHILE Loop': new vscode.SnippetString([
        'WHILE ${1:condition} DO',
        '\t${2:// statements}',
        'END_WHILE;'
    ].join('\n')),
    
    'REPEAT Loop': new vscode.SnippetString([
        'REPEAT',
        '\t${1:// statements}',
        'UNTIL ${2:condition}',
        'END_REPEAT;'
    ].join('\n')),
    
    'FUNCTION_BLOCK': new vscode.SnippetString([
        'FUNCTION_BLOCK ${1:FB_Name}',
        'VAR_INPUT',
        '\t${2:input1} : ${3:BOOL};',
        'END_VAR',
        'VAR_OUTPUT',
        '\t${4:output1} : ${5:BOOL};',
        'END_VAR',
        'VAR',
        '\t${6:localVar} : ${7:INT};',
        'END_VAR',
        '',
        '${8:// Implementation}',
        '',
        'END_FUNCTION_BLOCK'
    ].join('\n')),
    
    'FUNCTION': new vscode.SnippetString([
        'FUNCTION ${1:FuncName} : ${2:REAL}',
        'VAR_INPUT',
        '\t${3:input1} : ${4:REAL};',
        'END_VAR',
        'VAR',
        '\t${5:localVar} : ${6:REAL};',
        'END_VAR',
        '',
        '${7:// Implementation}',
        '${1:FuncName} := ${8:result};',
        '',
        'END_FUNCTION'
    ].join('\n')),
    
    'PROGRAM': new vscode.SnippetString([
        'PROGRAM ${1:PRG_Name}',
        'VAR',
        '\t${2:var1} : ${3:BOOL};',
        'END_VAR',
        '',
        '${4:// Implementation}',
        '',
        'END_PROGRAM'
    ].join('\n')),
    
    'VAR Block': new vscode.SnippetString([
        'VAR',
        '\t${1:variable} : ${2:INT};',
        'END_VAR'
    ].join('\n')),
    
    'VAR_INPUT Block': new vscode.SnippetString([
        'VAR_INPUT',
        '\t${1:input} : ${2:BOOL};',
        'END_VAR'
    ].join('\n')),
    
    'VAR_OUTPUT Block': new vscode.SnippetString([
        'VAR_OUTPUT',
        '\t${1:output} : ${2:BOOL};',
        'END_VAR'
    ].join('\n')),
    
    'R_TRIG': new vscode.SnippetString([
        '${1:r_trig_inst}: R_TRIG;',
        '${1:r_trig_inst}(CLK := ${2:trigger}, Q => ${3:result});'
    ].join('\n')),
    
    'F_TRIG': new vscode.SnippetString([
        '${1:f_trig_inst}: F_TRIG;',
        '${1:f_trig_inst}(CLK := ${2:trigger}, Q => ${3:result});'
    ].join('\n')),
    
    'TON Timer': new vscode.SnippetString([
        '${1:ton_inst}: TON;',
        '${1:ton_inst}(IN := ${2:input}, PT := ${3:T#5s}, Q => ${4:output}, ET => ${5:elapsed});'
    ].join('\n')),
    
    'TOF Timer': new vscode.SnippetString([
        '${1:tof_inst}: TOF;',
        '${1:tof_inst}(IN := ${2:input}, PT := ${3:T#5s}, Q => ${4:output}, ET => ${5:elapsed});'
    ].join('\n')),
    
    'TP Timer': new vscode.SnippetString([
        '${1:tp_inst}: TP;',
        '${1:tp_inst}(IN := ${2:input}, PT := ${3:T#5s}, Q => ${4:output}, ET => ${5:elapsed});'
    ].join('\n')),
    
    'RS Flip-Flop': new vscode.SnippetString([
        '${1:rs_inst}: RS;',
        '${1:rs_inst}(SET := ${2:set}, RESET1 := ${3:reset}, Q1 => ${4:output});'
    ].join('\n')),
    
    'SR Flip-Flop': new vscode.SnippetString([
        '${1:sr_inst}: SR;',
        '${1:sr_inst}(SET1 := ${2:set}, RESET := ${3:reset}, Q1 => ${4:output});'
    ].join('\n'))
};

const standardIecDefinitions: Record<string, IECStandardDefinition> = {
    TON: {
        kind: 'functionBlock',
        summary: 'On-delay timer.',
        members: [
            { name: 'IN', type: 'BOOL', description: 'Input signal.' },
            { name: 'PT', type: 'TIME', description: 'Preset time.' },
            { name: 'Q', type: 'BOOL', description: 'Output signal after PT elapsed.' },
            { name: 'ET', type: 'TIME', description: 'Elapsed time.' }
        ],
        example: 'tmrStart(IN := bStart, PT := T#2s, Q => bDone, ET => tElapsed);'
    },
    TOF: {
        kind: 'functionBlock',
        summary: 'Off-delay timer.',
        members: [
            { name: 'IN', type: 'BOOL', description: 'Input signal.' },
            { name: 'PT', type: 'TIME', description: 'Preset time.' },
            { name: 'Q', type: 'BOOL', description: 'Output signal delayed on falling edge.' },
            { name: 'ET', type: 'TIME', description: 'Elapsed time.' }
        ],
        example: 'tmrStop(IN := bRun, PT := T#2s, Q => bStopped, ET => tElapsed);'
    },
    TP: {
        kind: 'functionBlock',
        summary: 'Pulse timer.',
        members: [
            { name: 'IN', type: 'BOOL', description: 'Rising edge trigger.' },
            { name: 'PT', type: 'TIME', description: 'Pulse duration.' },
            { name: 'Q', type: 'BOOL', description: 'Pulse output.' },
            { name: 'ET', type: 'TIME', description: 'Elapsed time.' }
        ],
        example: 'tpPulse(IN := bTrigger, PT := T#100ms, Q => bPulse, ET => tPulse);'
    },
    CTU: {
        kind: 'functionBlock',
        summary: 'Count-up counter.',
        members: [
            { name: 'CU', type: 'BOOL', description: 'Count-up trigger.' },
            { name: 'R', type: 'BOOL', description: 'Reset.' },
            { name: 'PV', type: 'INT', description: 'Preset value.' },
            { name: 'Q', type: 'BOOL', description: 'Reached preset.' },
            { name: 'CV', type: 'INT', description: 'Current value.' }
        ]
    },
    CTD: {
        kind: 'functionBlock',
        summary: 'Count-down counter.',
        members: [
            { name: 'CD', type: 'BOOL', description: 'Count-down trigger.' },
            { name: 'LD', type: 'BOOL', description: 'Load preset.' },
            { name: 'PV', type: 'INT', description: 'Preset value.' },
            { name: 'Q', type: 'BOOL', description: 'Reached zero.' },
            { name: 'CV', type: 'INT', description: 'Current value.' }
        ]
    },
    CTUD: {
        kind: 'functionBlock',
        summary: 'Up/down counter.',
        members: [
            { name: 'CU', type: 'BOOL', description: 'Count-up trigger.' },
            { name: 'CD', type: 'BOOL', description: 'Count-down trigger.' },
            { name: 'R', type: 'BOOL', description: 'Reset.' },
            { name: 'LD', type: 'BOOL', description: 'Load preset.' },
            { name: 'PV', type: 'INT', description: 'Preset value.' },
            { name: 'QU', type: 'BOOL', description: 'Upper limit reached.' },
            { name: 'QD', type: 'BOOL', description: 'Lower limit reached.' },
            { name: 'CV', type: 'INT', description: 'Current value.' }
        ]
    },
    R_TRIG: {
        kind: 'functionBlock',
        summary: 'Rising-edge detector.',
        members: [
            { name: 'CLK', type: 'BOOL', description: 'Input signal.' },
            { name: 'Q', type: 'BOOL', description: 'One-cycle pulse on rising edge.' }
        ]
    },
    F_TRIG: {
        kind: 'functionBlock',
        summary: 'Falling-edge detector.',
        members: [
            { name: 'CLK', type: 'BOOL', description: 'Input signal.' },
            { name: 'Q', type: 'BOOL', description: 'One-cycle pulse on falling edge.' }
        ]
    },
    RS: {
        kind: 'functionBlock',
        summary: 'Reset-dominant bistable.',
        members: [
            { name: 'SET', type: 'BOOL', description: 'Set input.' },
            { name: 'RESET1', type: 'BOOL', description: 'Reset input.' },
            { name: 'Q1', type: 'BOOL', description: 'Output state.' }
        ]
    },
    SR: {
        kind: 'functionBlock',
        summary: 'Set-dominant bistable.',
        members: [
            { name: 'SET1', type: 'BOOL', description: 'Set input.' },
            { name: 'RESET', type: 'BOOL', description: 'Reset input.' },
            { name: 'Q1', type: 'BOOL', description: 'Output state.' }
        ]
    },
    ANY: {
        kind: 'type',
        summary: 'TwinCAT generic value carrier used for runtime type inspection and conversion.',
        members: [
            { name: 'TypeClass', type: '__SYSTEM.TYPE_CLASS', description: 'Runtime type classification for the contained value.' },
            { name: 'pValue', type: 'PVOID', description: 'Pointer to the contained runtime value.' }
        ]
    },
    HRESULT: {
        kind: 'type',
        summary: 'TwinCAT/TcCOM result code type used by system and module APIs.'
    },
    S_OK: {
        kind: 'constant',
        summary: 'HRESULT success code.'
    },
    S_FALSE: {
        kind: 'constant',
        summary: 'HRESULT success code indicating false or partial success.'
    },
    E_FAIL: {
        kind: 'constant',
        summary: 'HRESULT failure code for an unspecified error.'
    },
    E_NOTIMPL: {
        kind: 'constant',
        summary: 'HRESULT failure code indicating the operation is not implemented.'
    },
    E_POINTER: {
        kind: 'constant',
        summary: 'HRESULT failure code indicating an invalid pointer.'
    },
    E_INVALIDARG: {
        kind: 'constant',
        summary: 'HRESULT failure code indicating an invalid argument.'
    },
    E_OUTOFMEMORY: {
        kind: 'constant',
        summary: 'HRESULT failure code indicating insufficient memory.'
    }
};

// Block pairs for validation (only internal ST blocks, not XML wrapper blocks)
// Multiple VAR types all close with END_VAR
const blockPairs: { [key: string]: string } = {
    'IF': 'END_IF',
    'FOR': 'END_FOR',
    'WHILE': 'END_WHILE',
    'REPEAT': 'UNTIL',
    'CASE': 'END_CASE',
    'VAR': 'END_VAR',
    'VAR_INPUT': 'END_VAR',
    'VAR_OUTPUT': 'END_VAR',
    'VAR_IN_OUT': 'END_VAR',
    'VAR_TEMP': 'END_VAR',
    'VAR_GLOBAL': 'END_VAR',
    'VAR_INST': 'END_VAR',
    'VAR_STAT': 'END_VAR'
    // Note: PROGRAM, FUNCTION, FUNCTION_BLOCK are in XML wrapper, not ST code
};

// All blocks that close with END_VAR
const varBlocks = ['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_GLOBAL', 'VAR_INST', 'VAR_STAT'];
const unusedDeclarationScopes = new Set(['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_INST', 'VAR_STAT']);



// Keywords that don't need semicolons after them
const noSemicolonKeywords = [
    'THEN', 'ELSE', 'ELSIF', 'END_IF', 'OF', 'DO', 'END_FOR', 'END_WHILE', 
    'UNTIL', 'END_REPEAT', 'END_CASE', 'END_VAR', 'END_STRUCT', 'END_ENUM',
    'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_GLOBAL', 'VAR_INST', 'VAR_STAT',
    'CONSTANT', 'RETAIN', 'PERSISTENT', 'AT', 'RETURN', 'EXIT', 'CONTINUE'
];

// Patterns that indicate a line doesn't need a semicolon
// These must be very specific to avoid false positives
const noSemicolonPatterns = [
    // Function/FB/Program declarations at start of line (e.g., "FUNCTION foo : INT")
    /^\s*(FUNCTION|FUNCTION_BLOCK|PROGRAM)\s+\w+(\s*:\s*\w+)?\s*$/i,
    // Case labels: number or identifier followed by colon (e.g., "1:", "ALARM_IDLE:", "stateIdle:")
    // Must be at start of line (after whitespace), not contain assignment operator
    /^\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*|\d+)\s*:\s*(\/\/.*)?$/i,
    // CASE labels with lists/ranges (e.g., "1,2,3:", "10..20:", "StateA, StateB:")
    /^\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*|\d+)(\s*\.\.\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*|\d+))?(\s*,\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*|\d+)(\s*\.\.\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*|\d+))?)*\s*:\s*(\/\/.*)?$/i,
    // ELSE in CASE statement (standalone, no following code on same line)
    /^\s*ELSE\s*$/i,
    // Empty lines
    /^\s*$/,
    // Type declarations at line start
    /^\s*(TYPE|END_TYPE|STRUCT|END_STRUCT|UNION|END_UNION)\s*$/i,
    // TYPE declarations like "TYPE MyType :"
    /^\s*TYPE\s+[a-zA-Z_]\w*\s*:\s*$/i,
    // VAR blocks with inline modifiers, e.g. "VAR_GLOBAL CONSTANT INTERNAL"
    /^\s*(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_GLOBAL|VAR_INST|VAR_STAT)(\s+(CONSTANT|INTERNAL|PUBLIC|PRIVATE|PROTECTED|FINAL|ABSTRACT|RETAIN|PERSISTENT))*\s*$/i,
    // Method/property declarations at line start
    /^\s*(METHOD|END_METHOD|PROPERTY|END_PROPERTY)\b/i,
    // Action/transition declarations at line start
    /^\s*(ACTION|END_ACTION|TRANSITION|END_TRANSITION|STEP|END_STEP)\b/i,
    // Configuration/resource declarations at line start
    /^\s*(CONFIGURATION|END_CONFIGURATION|RESOURCE|END_RESOURCE|TASK|END_TASK)\b/i,
    // Interface declarations/accessors at line start
    /^\s*(INTERFACE|END_INTERFACE|GET|SET)\b/i,
    // Modifier-only declaration lines such as "CONSTANT INTERNAL"
    /^\s*(CONSTANT|INTERNAL|PUBLIC|PRIVATE|PROTECTED|FINAL|ABSTRACT|RETAIN|PERSISTENT)(\s+(CONSTANT|INTERNAL|PUBLIC|PRIVATE|PROTECTED|FINAL|ABSTRACT|RETAIN|PERSISTENT))*\s*$/i,
    // Import/using statements at line start
    /^\s*(IMPORT|USING|FROM)\b/i,
    // Pragma/directive lines (curly braces)
    /^\s*\{.*\}\s*$/
];

const globalListFileExtensions = new Set(['.tcgvl', '.tcgcl']);
const globalListModifierOnlyLinePattern = /^\s*(CONSTANT|INTERNAL|PUBLIC|PRIVATE|PROTECTED|FINAL|ABSTRACT|RETAIN|PERSISTENT)(\s+(CONSTANT|INTERNAL|PUBLIC|PRIVATE|PROTECTED|FINAL|ABSTRACT|RETAIN|PERSISTENT))*\s*$/i;

const PROJECT_SCAN_PATTERN = '**/*.{st,TcPOU,TcPRG,TcAPP,TcCOM,TcGVL,TcDUT,TcVAR,TcIO,TcITF,tcpou,tcprg,tcapp,tccom,tcgvl,tcdut,tcvar,tcio,tcitf}';
const stringTokenRegex = /'([^']|'')*'|"([^"]|"")*"/g;
const numberTokenRegex = /\b(16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+|\d+(\.\d+)?([eE][+-]?\d+)?)\b/g;
const identifierTokenRegex = /\b[a-zA-Z_]\w*\b/g;
const stdSymbolSet = new Set(Object.keys(standardIecDefinitions).map(name => name.toUpperCase()));







export function registerLanguageFeatures(context: vscode.ExtensionContext): void {
    const localSymbolCache = new Map<string, { version: number; symbols: Map<string, { name: string; type: string }> }>();
    const relatedValidationTimers = new Map<string, NodeJS.Timeout>();
    const documentValidationTimers = new Map<string, NodeJS.Timeout>();
    const featureStats = new Map<string, { calls: number; totalMs: number }>();
    const workspaceSearchTextCache = new Map<string, { mtime: number; text: string }>();
    const staticCompletionItems: vscode.CompletionItem[] = [];
    const projectCompletionCache = {
        revision: -1,
        items: [] as vscode.CompletionItem[]
    };
    let applyingAutoKeywordCase = false;
    let analyzerReadyPromise: Promise<void> | undefined;

    const ensureProjectAnalyzerReady = async () => {
        if (!analyzerReadyPromise) {
            analyzerReadyPromise = initializeProjectAnalyzer()
                .catch(() => undefined)
                .then(() => undefined);
        }
        await analyzerReadyPromise;
    };

    const getLocalSymbols = (document: vscode.TextDocument) => {
        const key = document.uri.toString();
        const cached = localSymbolCache.get(key);
        if (cached && cached.version === document.version) {
            return cached.symbols;
        }

        const symbols = extractDeclaredSymbolsWithTypes(document.getText());
        localSymbolCache.set(key, { version: document.version, symbols });
        return symbols;
    };

    const getSourcePathForDocument = (document: vscode.TextDocument): string | undefined => {
        if (document.uri.scheme === 'twincat') {
            const query = document.uri.query || '';
            return query ? decodeURIComponent(query) : undefined;
        }
        if (document.uri.scheme === 'file') {
            return document.uri.fsPath;
        }
        return undefined;
    };

    const trackFeature = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
        const start = Date.now();
        try {
            return await fn();
        } finally {
            const elapsed = Date.now() - start;
            const current = featureStats.get(name) || { calls: 0, totalMs: 0 };
            current.calls += 1;
            current.totalMs += elapsed;
            featureStats.set(name, current);
        }
    };

    const scheduleRelatedValidation = (sourcePath: string) => {
        const key = sourcePath.toLowerCase();
        const existing = relatedValidationTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            relatedValidationTimers.delete(key);
            void validateRelatedDocuments(key);
        }, 120);
        relatedValidationTimers.set(key, timer);
    };

    const validateRelatedDocuments = async (sourcePathLower: string) => {
        const docs = vscode.workspace.textDocuments.filter(doc => {
            if (doc.languageId !== 'iec-st') return false;
            const source = getSourcePathForDocument(doc);
            return !!source && source.toLowerCase() === sourcePathLower;
        });
        await Promise.all(docs.map(doc => validateDocument(doc)));
    };

    const createCompletionItem = (
        label: string,
        kind: vscode.CompletionItemKind,
        detail?: string,
        documentation?: string
    ) => {
        const item = new vscode.CompletionItem(label, kind);
        if (detail) item.detail = detail;
        if (documentation) item.documentation = new vscode.MarkdownString(documentation);
        return item;
    };

    const addCompletionUnique = (target: vscode.CompletionItem[], seen: Set<string>, item: vscode.CompletionItem) => {
        const key = `${item.kind ?? ''}:${item.label.toString().toUpperCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        target.push(item);
    };

    const getMemberCompletionContext = (linePrefix: string) => {
        const match = linePrefix.match(/([a-zA-Z_]\w*)\.\s*([a-zA-Z_]\w*)?$/);
        if (!match) return undefined;
        return { base: match[1], partial: match[2] ?? '' };
    };

    const scheduleDocumentValidation = (document: vscode.TextDocument, delayMs = 180) => {
        if (document.languageId !== 'iec-st') {
            return;
        }
        const key = document.uri.toString();
        const existing = documentValidationTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            documentValidationTimers.delete(key);
            void validateDocument(document);
        }, delayMs);
        documentValidationTimers.set(key, timer);
    };

    const kindMap: Record<string, vscode.CompletionItemKind> = {
        variable: vscode.CompletionItemKind.Variable,
        global: vscode.CompletionItemKind.Variable,
        type: vscode.CompletionItemKind.Struct,
        functionBlock: vscode.CompletionItemKind.Class,
        function: vscode.CompletionItemKind.Function,
        program: vscode.CompletionItemKind.Module
    };

    const buildStaticCompletionItems = () => {
        if (staticCompletionItems.length > 0) {
            return;
        }
        const seen = new Set<string>();
        iecStKeywords.forEach(keyword => {
            addCompletionUnique(
                staticCompletionItems,
                seen,
                createCompletionItem(
                    keyword,
                    vscode.CompletionItemKind.Keyword,
                    'IEC keyword',
                    `IEC 61131-3 keyword: **${keyword}**`
                )
            );
        });
        Object.entries(iecStSnippets).forEach(([name, snippet]) => {
            const item = createCompletionItem(name, vscode.CompletionItemKind.Snippet, 'IEC ST Snippet', `Snippet: ${name}`);
            item.insertText = snippet;
            addCompletionUnique(staticCompletionItems, seen, item);
        });
        Object.entries(standardIecDefinitions).forEach(([name, def]) => {
            const kind = def.kind === 'functionBlock'
                ? vscode.CompletionItemKind.Class
                : def.kind === 'type'
                    ? vscode.CompletionItemKind.Struct
                    : def.kind === 'constant'
                        ? vscode.CompletionItemKind.Constant
                        : vscode.CompletionItemKind.Function;
            addCompletionUnique(
                staticCompletionItems,
                seen,
                createCompletionItem(
                    name,
                    kind,
                    `IEC ${def.kind}`,
                    `${def.summary}`
                )
            );
        });
        iecBuiltinFunctions.forEach(name => {
            addCompletionUnique(
                staticCompletionItems,
                seen,
                createCompletionItem(
                    name,
                    vscode.CompletionItemKind.Function,
                    'IEC builtin',
                    `IEC builtin function: **${name}**`
                )
            );
        });
        iecBuiltinNamespaces.forEach(name => {
            addCompletionUnique(
                staticCompletionItems,
                seen,
                createCompletionItem(
                    name,
                    vscode.CompletionItemKind.Module,
                    'TwinCAT builtin namespace',
                    `TwinCAT builtin namespace: **${name}**`
                )
            );
        });
    };

    const getProjectCompletionItems = async () => {
        await ensureProjectAnalyzerReady();
        const analyzer = getProjectAnalyzer();
        const revision = analyzer.getIndexRevision();
        if (projectCompletionCache.revision === revision) {
            return projectCompletionCache.items;
        }

        const items: vscode.CompletionItem[] = [];
        analyzer.forEachAllSymbols(symbol => {
            items.push(
                createCompletionItem(
                    symbol.name,
                    kindMap[symbol.kind] ?? vscode.CompletionItemKind.Text,
                    `${symbol.kind}: ${symbol.type}`,
                    `Defined in: \`${symbol.source}\``
                )
            );
        });
        projectCompletionCache.revision = revision;
        projectCompletionCache.items = items;
        return items;
    };

    const buildPositionAt = (text: string) => {
        const lineOffsets: number[] = [0];
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 10) {
                lineOffsets.push(i + 1);
            }
        }
        return (offset: number) => {
            const clamped = Math.max(0, Math.min(offset, text.length));
            let low = 0;
            let high = lineOffsets.length - 1;
            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                if (lineOffsets[mid] > clamped) {
                    high = mid - 1;
                } else {
                    low = mid + 1;
                }
            }
            const line = Math.max(0, high);
            return new vscode.Position(line, clamped - lineOffsets[line]);
        };
    };

    const getWorkspaceSearchDocs = async () => {
        const files = await vscode.workspace.findFiles(PROJECT_SCAN_PATTERN, '**/node_modules/**');
        const openDocsByUri = new Map(vscode.workspace.textDocuments.map(doc => [doc.uri.toString(), doc]));
        const docs = await Promise.all(files.map(async uri => {
            try {
                const openDoc = openDocsByUri.get(uri.toString());
                if (openDoc) {
                    const openText = openDoc.getText();
                    workspaceSearchTextCache.set(uri.toString(), { mtime: Date.now(), text: openText });
                    return {
                        uri,
                        text: openText,
                        positionAt: (offset: number) => openDoc.positionAt(offset)
                    };
                }

                const stat = await vscode.workspace.fs.stat(uri);
                const cacheKey = uri.toString();
                const cached = workspaceSearchTextCache.get(cacheKey);
                const text = cached && cached.mtime === stat.mtime
                    ? cached.text
                    : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
                workspaceSearchTextCache.set(cacheKey, { mtime: stat.mtime, text });
                return {
                    uri,
                    text,
                    positionAt: buildPositionAt(text)
                };
            } catch {
                return undefined;
            }
        }));
        return docs.filter((doc): doc is { uri: vscode.Uri; text: string; positionAt: (offset: number) => vscode.Position } => !!doc);
    };

    // Register completion provider
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        'iec-st',
        {
            provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
                return trackFeature('completion', async () => {
                    const completions: vscode.CompletionItem[] = [];
                    const seen = new Set<string>();
                    await ensureProjectAnalyzerReady();
                    const analyzer = getProjectAnalyzer();
                    const localSymbols = getLocalSymbols(document);
                    const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
                    const memberContext = getMemberCompletionContext(linePrefix);

                    if (memberContext) {
                        const baseSymbol = localSymbols.get(memberContext.base.toUpperCase()) ?? analyzer.getSymbol(memberContext.base);
                        const baseTypeName = normalizeTypeName(baseSymbol?.type ?? '');
                        const typeInfo = analyzer.getDataType(baseTypeName);
                        if (typeInfo) {
                            typeInfo.members.forEach((memberType, memberName) => {
                                addCompletionUnique(
                                    completions,
                                    seen,
                                    createCompletionItem(
                                        memberName,
                                        vscode.CompletionItemKind.Field,
                                        `Member: ${memberType}`,
                                        `\`${memberName}\` : \`${memberType}\``
                                    )
                                );
                            });
                        }

                        getKnownFbMembers(baseTypeName).forEach(member => {
                            addCompletionUnique(
                                completions,
                                seen,
                                createCompletionItem(
                                    member,
                                    vscode.CompletionItemKind.Field,
                                    `Member of ${baseTypeName || 'FB'}`
                                )
                            );
                        });

                        return completions;
                    }
                
                    buildStaticCompletionItems();
                    staticCompletionItems.forEach(item => addCompletionUnique(completions, seen, item));

                // Add local symbols
                localSymbols.forEach(symbol => {
                    addCompletionUnique(
                        completions,
                        seen,
                        createCompletionItem(
                            symbol.name,
                            vscode.CompletionItemKind.Variable,
                            `Local: ${symbol.type}`,
                            `Local declaration\n\n\`${symbol.name}\` : \`${symbol.type}\``
                        )
                    );
                });

                    (await getProjectCompletionItems()).forEach(item => addCompletionUnique(completions, seen, item));
                
                    return completions;
                });
            }
        },
        '.', ':', '('
    );
    
    // Register hover provider
    const hoverProvider = vscode.languages.registerHoverProvider('iec-st', {
        provideHover(document: vscode.TextDocument, position: vscode.Position) {
            return trackFeature('hover', async () => {
                const wordRange = document.getWordRangeAtPosition(position);
                if (!wordRange) return;
                
                const word = document.getText(wordRange).toUpperCase();
                await ensureProjectAnalyzerReady();
                const analyzer = getProjectAnalyzer();
                const localSymbols = getLocalSymbols(document);

                const local = localSymbols.get(word);
                if (local) {
                    return new vscode.Hover(
                        new vscode.MarkdownString(`**${local.name}**\n\nLocal variable: \`${local.type}\``),
                        wordRange
                    );
                }

                const projectSymbol = analyzer.getSymbol(word);
                if (projectSymbol) {
                    return new vscode.Hover(
                        new vscode.MarkdownString(`**${projectSymbol.name}**\n\n${projectSymbol.kind}: \`${projectSymbol.type}\`\n\nDefined in: \`${projectSymbol.source}\``),
                        wordRange
                    );
                }

                const projectType = analyzer.getDataType(word);
                if (projectType) {
                    const members = [...projectType.members.entries()]
                        .slice(0, 15)
                        .map(([name, type]) => `- \`${name}\` : \`${type}\``)
                        .join('\n');
                    const memberSection = members ? `\n\nMembers:\n${members}` : '';
                    return new vscode.Hover(
                        new vscode.MarkdownString(`**${projectType.name}**\n\n${projectType.kind} type${memberSection}`),
                        wordRange
                    );
                }

                const standardDef = standardIecDefinitions[word];
                if (standardDef) {
                    const members = standardDef.members?.map(m => `- \`${m.name}\` : \`${m.type}\` - ${m.description}`).join('\n') ?? '';
                    const params = standardDef.parameters?.map(p => `- \`${p.direction} ${p.name}\` : \`${p.type}\` - ${p.description}`).join('\n') ?? '';
                    const example = standardDef.example ? `\n\nExample:\n\`\`\`iec-st\n${standardDef.example}\n\`\`\`` : '';
                    return new vscode.Hover(
                        new vscode.MarkdownString(
                            `**${word}** (${standardDef.kind})\n\n${standardDef.summary}` +
                            (params ? `\n\nParameters:\n${params}` : '') +
                            (members ? `\n\nMembers:\n${members}` : '') +
                            example
                        ),
                        wordRange
                    );
                }
                
                if (iecStKeywords.includes(word)) {
                    return new vscode.Hover(
                        new vscode.MarkdownString(`**${word}** - IEC 61131-3 Keyword`)
                    );
                }
                
                return undefined;
            });
        }
    });
    
    // Register document symbol provider (for outline view)
    const symbolProvider = vscode.languages.registerDocumentSymbolProvider('iec-st', {
        provideDocumentSymbols(document: vscode.TextDocument) {
            const symbols: vscode.DocumentSymbol[] = [];
            const text = document.getText();
            const lines = text.split('\n');
            
            lines.forEach((line, index) => {
                // Match program/function block/function declarations
                const match = line.match(/^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)/i);
                if (match) {
                    const kind = match[1].toUpperCase() === 'PROGRAM' 
                        ? vscode.SymbolKind.Module 
                        : match[1].toUpperCase() === 'FUNCTION_BLOCK'
                            ? vscode.SymbolKind.Class
                            : vscode.SymbolKind.Function;
                    
                    const symbol = new vscode.DocumentSymbol(
                        match[2],
                        match[1],
                        kind,
                        new vscode.Range(index, 0, index, line.length),
                        new vscode.Range(index, line.indexOf(match[2]), index, line.indexOf(match[2]) + match[2].length)
                    );
                    symbols.push(symbol);
                }
            });
            
            return symbols;
        }
    });

    const foldingProvider = vscode.languages.registerFoldingRangeProvider('iec-st', {
        provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
            const lines = document.getText().split('\n');
            const ranges: vscode.FoldingRange[] = [];

            const foldPairs: Record<string, string> = {
                ...blockPairs,
                METHOD: 'END_METHOD',
                PROPERTY: 'END_PROPERTY',
                ACTION: 'END_ACTION',
                TRANSITION: 'END_TRANSITION',
                TYPE: 'END_TYPE',
                STRUCT: 'END_STRUCT',
                UNION: 'END_UNION',
                INTERFACE: 'END_INTERFACE'
            };

            const closeToOpen = new Map<string, string[]>();
            for (const [open, close] of Object.entries(foldPairs)) {
                const closers = closeToOpen.get(close) ?? [];
                closers.push(open);
                closeToOpen.set(close, closers);
            }

            const stack: Array<{ token: string; start: number }> = [];
            const getToken = (line: string) => line.replace(/\/\/.*$/, '').trim().match(/^([A-Z_]+)/i)?.[1]?.toUpperCase();

            for (let i = 0; i < lines.length; i++) {
                const token = getToken(lines[i]);
                if (!token) continue;

                const closes = closeToOpen.get(token);
                if (closes && closes.length > 0) {
                    for (let idx = stack.length - 1; idx >= 0; idx--) {
                        if (closes.includes(stack[idx].token)) {
                            const open = stack[idx];
                            stack.splice(idx, 1);
                            if (i > open.start) {
                                ranges.push(new vscode.FoldingRange(open.start, i, vscode.FoldingRangeKind.Region));
                            }
                            break;
                        }
                    }
                    continue;
                }

                if (foldPairs[token]) {
                    stack.push({ token, start: i });
                }
            }

            let declarationStart = -1;
            let declarationEnd = -1;
            let inVarDepth = 0;
            const headerRegex = /^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|METHOD|PROPERTY|ACTION|TRANSITION)\b/i;
            const varStartRegex = /^\s*VAR(?:_(INPUT|OUTPUT|IN_OUT|TEMP|GLOBAL|INST|STAT))?\b/i;
            const keepInDeclarationRegex = /^\s*(\/\/.*|\(\*.*\*\)|\{.*\}|)\s*$/;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (declarationStart < 0) {
                    if (headerRegex.test(line)) {
                        declarationStart = i;
                        declarationEnd = i;
                    }
                    continue;
                }

                if (varStartRegex.test(line)) {
                    inVarDepth++;
                    declarationEnd = i;
                    continue;
                }
                if (inVarDepth > 0) {
                    declarationEnd = i;
                    if (/^\s*END_VAR\b/i.test(line)) {
                        inVarDepth = Math.max(0, inVarDepth - 1);
                    }
                    continue;
                }
                if (keepInDeclarationRegex.test(line)) {
                    declarationEnd = i;
                    continue;
                }
                break;
            }

            if (declarationStart >= 0 && declarationEnd > declarationStart) {
                ranges.push(new vscode.FoldingRange(declarationStart, declarationEnd, vscode.FoldingRangeKind.Region));
            }

            return ranges;
        }
    });

    const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider('iec-st', {
        provideDocumentFormattingEdits(document: vscode.TextDocument) {
            const formatted = formatIECStructuredText(
                document.getText(),
                vscode.workspace.getConfiguration('twincat').get<'upper' | 'lower' | 'preserve'>('keywordCasing', 'upper')
            );
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            return [vscode.TextEdit.replace(fullRange, formatted)];
        }
    });

    const rangeFormattingProvider = vscode.languages.registerDocumentRangeFormattingEditProvider('iec-st', {
        provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range) {
            const selected = document.getText(range);
            const formatted = formatIECStructuredText(
                selected,
                vscode.workspace.getConfiguration('twincat').get<'upper' | 'lower' | 'preserve'>('keywordCasing', 'upper')
            );
            return [vscode.TextEdit.replace(range, formatted)];
        }
    });

    const definitionProvider = vscode.languages.registerDefinitionProvider('iec-st', {
        async provideDefinition(document, position) {
            return trackFeature('definition', async () => {
                const wordRange = document.getWordRangeAtPosition(position);
                if (!wordRange) return undefined;
                const symbolName = document.getText(wordRange);
                await ensureProjectAnalyzerReady();
                const analyzer = getProjectAnalyzer();

                const localDef = findDeclarationInDocument(document, symbolName);
                if (localDef) {
                    return new vscode.Location(document.uri, localDef);
                }

                const projectSymbol = analyzer.getSymbol(symbolName);
                if (projectSymbol?.source) {
                    const targetUri = vscode.Uri.file(projectSymbol.source);
                    const targetDoc = await vscode.workspace.openTextDocument(targetUri);
                    const targetRange = findDeclarationInDocument(targetDoc, symbolName);
                    if (targetRange) {
                        return new vscode.Location(targetUri, targetRange);
                    }
                }

                return undefined;
            });
        }
    });

    const referenceProvider = vscode.languages.registerReferenceProvider('iec-st', {
        async provideReferences(document, position, _context) {
            return trackFeature('references', async () => {
                const wordRange = document.getWordRangeAtPosition(position);
                if (!wordRange) return [];
                const symbolName = document.getText(wordRange);
                const includeCommentsStrings = vscode.workspace.getConfiguration('twincat').get<boolean>('renameIncludeCommentsStrings', false);
                const locations: vscode.Location[] = [];
                const docs = await getWorkspaceSearchDocs();

                for (const doc of docs) {
                    const occurrences = findIdentifierOccurrences(doc.text, symbolName, includeCommentsStrings);
                    for (const index of occurrences) {
                        const start = doc.positionAt(index);
                        const end = doc.positionAt(index + symbolName.length);
                        locations.push(new vscode.Location(doc.uri, new vscode.Range(start, end)));
                    }
                }

                return locations;
            });
        }
    });

    const renameProvider = vscode.languages.registerRenameProvider('iec-st', {
        prepareRename(document, position) {
            const range = document.getWordRangeAtPosition(position);
            if (!range) return undefined;
            const oldName = document.getText(range);
            if (!/^[a-zA-Z_]\w*$/.test(oldName)) {
                throw new Error('Invalid IEC identifier.');
            }
            return range;
        },
        async provideRenameEdits(document, position, newName) {
            if (!/^[a-zA-Z_]\w*$/.test(newName)) {
                throw new Error('New name is not a valid IEC identifier.');
            }

            return trackFeature('rename', async () => {
                const wordRange = document.getWordRangeAtPosition(position);
                if (!wordRange) return undefined;
                const oldName = document.getText(wordRange);
                const includeCommentsStrings = vscode.workspace.getConfiguration('twincat').get<boolean>('renameIncludeCommentsStrings', false);
                const edit = new vscode.WorkspaceEdit();
                const docs = await getWorkspaceSearchDocs();

                for (const doc of docs) {
                    const occurrences = findIdentifierOccurrences(doc.text, oldName, includeCommentsStrings);
                    for (const index of occurrences) {
                        const start = doc.positionAt(index);
                        const end = doc.positionAt(index + oldName.length);
                        edit.replace(doc.uri, new vscode.Range(start, end), newName);
                    }
                }
                return edit;
            });
        }
    });

    const signatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
        'iec-st',
        {
            provideSignatureHelp(document, position) {
                return trackFeature('signatureHelp', async () => {
                    const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
                    const call = extractCallContext(linePrefix);
                    if (!call) return undefined;

                    const nameUpper = call.name.toUpperCase();
                    const standard = standardIecDefinitions[nameUpper];
                    if (!standard) return undefined;

                    const params = (standard.parameters && standard.parameters.length > 0)
                        ? standard.parameters
                        : standard.members?.map(m => ({ name: m.name, type: m.type, direction: 'IN' as const, description: m.description })) ?? [];

                    if (params.length === 0) return undefined;

                    const signature = new vscode.SignatureInformation(
                        `${call.name}(${params.map(p => `${p.name} := ${p.type}`).join(', ')})`,
                        new vscode.MarkdownString(standard.summary)
                    );
                    signature.parameters = params.map(p =>
                        new vscode.ParameterInformation(
                            `${p.name}: ${p.type}`,
                            new vscode.MarkdownString(`${p.direction} - ${p.description}`)
                        )
                    );

                    const help = new vscode.SignatureHelp();
                    help.signatures = [signature];
                    help.activeSignature = 0;
                    help.activeParameter = Math.min(call.argIndex, Math.max(0, signature.parameters.length - 1));
                    return help;
                });
            }
        },
        '(',
        ','
    );

    const semanticTokensLegend = new vscode.SemanticTokensLegend(
        ['keyword', 'type', 'function', 'variable', 'property', 'number', 'string', 'comment'],
        []
    );

    const semanticTokensProvider = vscode.languages.registerDocumentSemanticTokensProvider(
        'iec-st',
        {
            provideDocumentSemanticTokens(document) {
                return trackFeature('semanticTokens', async () => {
                    const builder = new vscode.SemanticTokensBuilder(semanticTokensLegend);
                    const lines = document.getText().split('\n');
                    const stringRegex = new RegExp(stringTokenRegex.source, 'g');
                    const numberRegex = new RegExp(numberTokenRegex.source, 'g');
                    const idRegex = new RegExp(identifierTokenRegex.source, 'g');
                    const pushCodeTokens = (lineIndex: number, segment: string, segmentOffset: number) => {
                        if (!segment) {
                            return;
                        }

                        stringRegex.lastIndex = 0;
                        let sm;
                        while ((sm = stringRegex.exec(segment)) !== null) {
                            builder.push(lineIndex, segmentOffset + sm.index, sm[0].length, 6, 0);
                        }

                        numberRegex.lastIndex = 0;
                        let nm;
                        while ((nm = numberRegex.exec(segment)) !== null) {
                            builder.push(lineIndex, segmentOffset + nm.index, nm[0].length, 5, 0);
                        }

                        idRegex.lastIndex = 0;
                        let im;
                        while ((im = idRegex.exec(segment)) !== null) {
                            const token = im[0];
                            const upper = token.toUpperCase();
                            if (iecStKeywordSet.has(upper)) {
                                builder.push(lineIndex, segmentOffset + im.index, token.length, 0, 0);
                                continue;
                            }
                            if (/^(BOOL|BYTE|WORD|DWORD|LWORD|SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL|TIME|DATE|TIME_OF_DAY|TOD|DATE_AND_TIME|DT|STRING|WSTRING|ARRAY|STRUCT|ENUM|TYPE)$/i.test(token)) {
                                builder.push(lineIndex, segmentOffset + im.index, token.length, 1, 0);
                                continue;
                            }
                            if (stdSymbolSet.has(upper)) {
                                builder.push(lineIndex, segmentOffset + im.index, token.length, 2, 0);
                                continue;
                            }
                            builder.push(lineIndex, segmentOffset + im.index, token.length, 3, 0);
                        }
                    };
                    let activeBlockCommentEnd: '*)' | '*/' | undefined;

                    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                        const raw = lines[lineIndex].replace(/\r/g, '');
                        if (!raw) continue;

                        let cursor = 0;
                        while (cursor < raw.length) {
                            if (activeBlockCommentEnd) {
                                const blockEndIdx = raw.indexOf(activeBlockCommentEnd, cursor);
                                if (blockEndIdx >= 0) {
                                    builder.push(lineIndex, cursor, (blockEndIdx + activeBlockCommentEnd.length) - cursor, 7, 0);
                                    cursor = blockEndIdx + activeBlockCommentEnd.length;
                                    activeBlockCommentEnd = undefined;
                                    continue;
                                }
                                builder.push(lineIndex, cursor, raw.length - cursor, 7, 0);
                                cursor = raw.length;
                                continue;
                            }

                            const lineCommentIdx = raw.indexOf('//', cursor);
                            const parenCommentIdx = raw.indexOf('(*', cursor);
                            const slashCommentIdx = raw.indexOf('/*', cursor);
                            const nextBlockStartCandidates = [parenCommentIdx, slashCommentIdx].filter(idx => idx >= 0);
                            const nextBlockStart = nextBlockStartCandidates.length > 0
                                ? Math.min(...nextBlockStartCandidates)
                                : -1;
                            const nextCommentStartCandidates = [lineCommentIdx, nextBlockStart].filter(idx => idx >= 0);
                            const nextCommentStart = nextCommentStartCandidates.length > 0
                                ? Math.min(...nextCommentStartCandidates)
                                : -1;

                            if (nextCommentStart < 0) {
                                pushCodeTokens(lineIndex, raw.substring(cursor), cursor);
                                break;
                            }

                            if (nextCommentStart > cursor) {
                                pushCodeTokens(lineIndex, raw.substring(cursor, nextCommentStart), cursor);
                            }

                            if (lineCommentIdx === nextCommentStart) {
                                builder.push(lineIndex, nextCommentStart, raw.length - nextCommentStart, 7, 0);
                                break;
                            }

                            const commentEndToken = parenCommentIdx === nextCommentStart ? '*)' : '*/';
                            const blockEndIdx = raw.indexOf(commentEndToken, nextCommentStart + 2);
                            if (blockEndIdx >= 0) {
                                builder.push(lineIndex, nextCommentStart, (blockEndIdx + commentEndToken.length) - nextCommentStart, 7, 0);
                                cursor = blockEndIdx + commentEndToken.length;
                                continue;
                            }

                            builder.push(lineIndex, nextCommentStart, raw.length - nextCommentStart, 7, 0);
                            activeBlockCommentEnd = commentEndToken;
                            break;
                        }
                    }
                    return builder.build();
                });
            }
        },
        semanticTokensLegend
    );
    
    // Register diagnostics (error checking)
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('iec-st');
    
    const validateDocument = async (document: vscode.TextDocument) => {
        if (document.languageId !== 'iec-st') return;
        
        const diagnostics: vscode.Diagnostic[] = [];
        await ensureProjectAnalyzerReady();
        const severityUndefined = getConfiguredSeverity('twincat.diagnostics.undefinedVariables', vscode.DiagnosticSeverity.Error);
        const severityUnused = getConfiguredSeverity('twincat.diagnostics.unusedVariables', vscode.DiagnosticSeverity.Warning);
        const severityDuplicate = getConfiguredSeverity('twincat.diagnostics.duplicateDeclarations', vscode.DiagnosticSeverity.Error);
        const severityTypeMismatch = getConfiguredSeverity('twincat.diagnostics.typeMismatch', vscode.DiagnosticSeverity.Error);
        const text = document.getText();
        const lines = text.split('\n');
        const tcviewLintPragmas = parseTcviewLintPragmas(text);
        const originalPath = document.uri.scheme === 'twincat'
            ? TwinCATFileSystemProvider.getOriginalPath(document.uri)
            : document.uri.scheme === 'file'
                ? document.uri.fsPath
                : undefined;
        const sourceExtension = originalPath ? path.extname(originalPath).toLowerCase() : '';
        const isGlobalListDocument =
            globalListFileExtensions.has(sourceExtension) ||
            (/^\s*VAR_GLOBAL\b/im.test(text) && !/^\s*(FUNCTION|FUNCTION_BLOCK|PROGRAM|METHOD|PROPERTY|ACTION|TRANSITION)\b/im.test(text));

        // AST-based diagnostics path
        {
        const ast = buildAstAnalysis(text);

        ast.missingSemicolons.forEach(item => {
            const lineText = lines[item.line] ?? '';
            if (isGlobalListDocument && globalListModifierOnlyLinePattern.test(lineText)) {
                return;
            }
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(item.line, item.startCol, item.line, item.endCol),
                item.message,
                vscode.DiagnosticSeverity.Error
            ));
        });
        ast.blockErrors.forEach(item => {
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(item.line, item.startCol, item.line, item.endCol),
                item.message,
                vscode.DiagnosticSeverity.Error
            ));
        });
        ast.stringErrors.forEach(item => {
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(item.line, item.startCol, item.line, item.endCol),
                item.message,
                vscode.DiagnosticSeverity.Error
            ));
        });
        ast.parenthesisErrors.forEach(item => {
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(item.line, item.startCol, item.line, item.endCol),
                item.message,
                vscode.DiagnosticSeverity.Error
            ));
        });
        ast.duplicates.forEach(dup => {
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(dup.line, dup.startCol, dup.line, dup.endCol),
                `Duplicate declaration '${dup.name}' in the same scope.`,
                severityDuplicate
            ));
        });

        const allDeclared = new Set(ast.declarations.map(d => d.upper));
        const astSymbolTypes = new Map(ast.declarations.map(d => [d.upper, normalizeTypeName(d.type)] as [string, string]));
        const astLocalsForUnusedCheck = ast.declarations
            .filter(d => unusedDeclarationScopes.has(d.scopeKind))
            .map(d => ({ name: d.name, upper: d.upper, line: d.line, startCol: d.startCol, endCol: d.endCol }));

        const systemVars = getSystemVariables();
        const allKnownVars = new Set([...allDeclared, ...systemVars, ...iecStKeywords]);
        const programNames = extractProgramFunctionNames(text);
        programNames.forEach(name => allKnownVars.add(name.toUpperCase()));
        const callableNames = extractCallableNames(text);
        callableNames.forEach(name => allKnownVars.add(name.toUpperCase()));

        const astProjectAnalyzer = getProjectAnalyzer();
        const astProjectSymbols = new Map<string, ReturnType<typeof astProjectAnalyzer.getSymbol>>();
        astProjectAnalyzer.forEachAllSymbols((symbol, name) => {
            astProjectSymbols.set(name, symbol);
            allKnownVars.add(name);
        });
        const astProjectTypes = new Map<string, ReturnType<typeof astProjectAnalyzer.getDataType>>();
        astProjectAnalyzer.forEachDataType((_type, name) => {
            astProjectTypes.set(name, _type);
            allKnownVars.add(name);
        });
        Object.keys(standardIecDefinitions).forEach(name => allKnownVars.add(name.toUpperCase()));
        const astProjectSymbolTypes = new Map<string, string>();
        astProjectSymbols.forEach(symbol => {
            if (!symbol) return;
            astProjectSymbolTypes.set(symbol.name.toUpperCase(), normalizeTypeName(symbol.type));
        });

        const getDeclarationTypeStatus = (typeName: string): 'known' | 'metadata_only' | 'unknown' => {
            if (!typeName) return 'known';
            if (isKnownIecBuiltinType(typeName) || standardIecDefinitions[typeName.toUpperCase()]) return 'known';
            const analyzerStatus = astProjectAnalyzer.getTypeResolutionStatus(typeName);
            if (analyzerStatus !== 'unknown') return analyzerStatus;
            const key = typeName.toUpperCase();
            if (astProjectTypes.has(key)) return 'known';
            const sym = astProjectSymbols.get(key);
            if (!sym) return 'unknown';
            return sym.kind === 'type' || sym.kind === 'functionBlock' || sym.kind === 'program'
                ? 'known'
                : 'unknown';
        };

        ast.declarations.forEach(decl => {
            const typeInfo = parseDeclarationTypeInfo(decl.type);
            if (!typeInfo.baseType) {
                return;
            }

            const typeStatus = getDeclarationTypeStatus(typeInfo.baseType);
            if (typeStatus === 'unknown') {
                const typeRange = findDeclarationTypeRange(lines[decl.line] ?? '', decl.line);
                diagnostics.push(new vscode.Diagnostic(
                    typeRange,
                    `Unknown or unresolved type '${typeInfo.baseType}' for declaration '${decl.name}'.`,
                    severityUndefined
                ));
                return;
            }
            if (typeStatus === 'metadata_only') {
                const typeRange = findDeclarationTypeRange(lines[decl.line] ?? '', decl.line);
                diagnostics.push(new vscode.Diagnostic(
                    typeRange,
                    `Type '${typeInfo.baseType}' is referenced from metadata-only library context and is not fully verified.`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }

            if (typeInfo.hasInitializer && !typeInfo.initializer) {
                const typeRange = findDeclarationTypeRange(lines[decl.line] ?? '', decl.line);
                diagnostics.push(new vscode.Diagnostic(
                    typeRange,
                    `Missing initializer expression for declaration '${decl.name}'.`,
                    vscode.DiagnosticSeverity.Error
                ));
                return;
            }

            if (typeInfo.initializer) {
                const exprType = inferExpressionPrimitiveType(typeInfo.initializer);
                if (exprType !== 'UNKNOWN' && !isTypeCompatible(typeInfo.baseType, exprType)) {
                    const typeRange = findDeclarationTypeRange(lines[decl.line] ?? '', decl.line);
                    diagnostics.push(new vscode.Diagnostic(
                        typeRange,
                        `Type mismatch in declaration '${decl.name}': cannot assign ${exprType} to ${typeInfo.baseType}.`,
                        severityTypeMismatch
                    ));
                }
            }
        });

        extractCallableReturnTypes(lines).forEach(callable => {
            const typeStatus = getDeclarationTypeStatus(callable.typeName);
            if (typeStatus === 'known') {
                return;
            }

            const typeRange = findCallableReturnTypeRange(lines[callable.line] ?? '', callable.line);
            if (typeStatus === 'metadata_only') {
                diagnostics.push(new vscode.Diagnostic(
                    typeRange,
                    `Return type '${callable.typeName}' for ${callable.kind} '${callable.name}' is referenced from metadata-only library context and is not fully verified.`,
                    vscode.DiagnosticSeverity.Warning
                ));
                return;
            }

            diagnostics.push(new vscode.Diagnostic(
                typeRange,
                `Unknown or unresolved return type '${callable.typeName}' for ${callable.kind} '${callable.name}'.`,
                severityUndefined
            ));
        });

        // Add inferred type names to reduce false undefined-variable errors
        // for enum/type-qualified literals (e.g. E_Type.Member).
        astSymbolTypes.forEach(typeName => {
            const normalized = normalizeTypeName(typeName);
            if (/^[A-Z_]\w*$/.test(normalized)) {
                allKnownVars.add(normalized.toUpperCase());
            }
        });
        astProjectSymbolTypes.forEach(typeName => {
            const normalized = normalizeTypeName(typeName);
            if (/^[A-Z_]\w*$/.test(normalized)) {
                allKnownVars.add(normalized.toUpperCase());
            }
        });

        const astUsedIdentifiers = new Set<string>();
        ast.usages.forEach(u => {
            if (isKnownIecBuiltinIdentifier(u.upper)) return;
            if (allKnownVars.has(u.upper)) {
                astUsedIdentifiers.add(u.upper);
                return;
            }
            const suggestion = findClosestMatch(u.name, [...allKnownVars]);
            const suggestionText = suggestion ? ` Did you mean '${suggestion}'?` : '';
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(u.line, u.startCol, u.line, u.endCol),
                `'${u.name}' is undeclared in local scope and project symbols.${suggestionText}`,
                severityUndefined
            ));
        });

        ast.assignments.forEach(a => {
            const targetType = astSymbolTypes.get(a.targetUpper) || astProjectSymbolTypes.get(a.targetUpper);
            if (!targetType) return;
            const exprType = inferExpressionPrimitiveType(a.expr);
            if (exprType === 'UNKNOWN') return;
            if (!isTypeCompatible(targetType, exprType)) {
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(a.line, a.startCol, a.line, a.startCol + a.target.length),
                    `Type mismatch: cannot assign ${exprType} to ${targetType}.`,
                    severityTypeMismatch
                ));
            }
        });

        const isLikelyPartialPouMainView =
            document.uri.scheme === 'twincat' &&
            /^\s*(FUNCTION_BLOCK|FUNCTION|PROGRAM)\b/im.test(text) &&
            !/^\s*(METHOD|PROPERTY|ACTION|TRANSITION)\b/im.test(text);
        const wholePouUsageSet = isLikelyPartialPouMainView
            ? await getWholePouUsageSet(document)
            : undefined;

        if (!isGlobalListDocument) {
            astLocalsForUnusedCheck.forEach(local => {
                if (isTcviewLintRuleSuppressed(tcviewLintPragmas, local.line, 'unused-instance')) {
                    return;
                }
                const usedInBody = astUsedIdentifiers.has(local.upper) || isIdentifierUsedInBody(text, local.name);
                const usedInWholePou = wholePouUsageSet ? wholePouUsageSet.has(local.upper) : false;
                if (!(usedInBody || usedInWholePou)) {
                    diagnostics.push(new vscode.Diagnostic(
                        new vscode.Range(local.line, local.startCol, local.line, local.endCol),
                        `Declaration '${local.name}' is declared but never used.`,
                        severityUnused
                    ));
                }
            });
        }

        diagnosticCollection.set(document.uri, diagnostics);
        return;
        }
    };

    
    // Validate on open and change
    const autoKeywordCaseListener = vscode.workspace.onDidChangeTextDocument(async e => {
        if (applyingAutoKeywordCase) return;
        const document = e.document;
        if (document.languageId !== 'iec-st') return;

        const keywordCasing = vscode.workspace.getConfiguration('twincat').get<'upper' | 'lower' | 'preserve'>('keywordCasing', 'upper');
        if (keywordCasing !== 'upper') return;
        if (e.contentChanges.length === 0) return;

        const touchedLines = new Set<number>();
        for (const change of e.contentChanges) {
            // Ignore pure deletions.
            if (change.text.length === 0) continue;
            const insertedLineBreaks = (change.text.match(/\n/g) || []).length;
            const endLine = Math.max(change.range.end.line, change.range.start.line + insertedLineBreaks);
            for (let line = change.range.start.line; line <= endLine; line++) {
                if (line >= 0 && line < document.lineCount) {
                    touchedLines.add(line);
                }
            }
        }

        if (touchedLines.size === 0) return;

        const fullText = document.getText();
        const edit = new vscode.WorkspaceEdit();
        let editCount = 0;

        for (const line of [...touchedLines].sort((a, b) => a - b)) {
            const lineRange = document.lineAt(line).range;
            const original = document.getText(lineRange);
            const transformed = uppercaseKeywordsInLine(fullText, document.offsetAt(lineRange.start), original);
            if (transformed !== original) {
                edit.replace(document.uri, lineRange, transformed);
                editCount++;
            }
        }

        if (editCount === 0) return;

        applyingAutoKeywordCase = true;
        try {
            await vscode.workspace.applyEdit(edit);
        } finally {
            applyingAutoKeywordCase = false;
        }
    });

    const invalidateSearchCacheForDocument = (doc: vscode.TextDocument) => {
        if (doc.uri.scheme !== 'file') {
            return;
        }
        workspaceSearchTextCache.delete(doc.uri.toString());
    };

    const invalidateWholePouUsageCacheForDocument = (doc: vscode.TextDocument) => {
        const sourcePath = getSourcePathForDocument(doc);
        if (!sourcePath) {
            return;
        }
        const prefix = `${sourcePath.toLowerCase()}|`;
        for (const key of [...wholePouUsageCache.keys()]) {
            if (key.startsWith(prefix)) {
                wholePouUsageCache.delete(key);
            }
        }
    };

    const openListener = vscode.workspace.onDidOpenTextDocument(doc => {
        scheduleDocumentValidation(doc, 40);
    });
    const changeListener = vscode.workspace.onDidChangeTextDocument(e => {
        scheduleDocumentValidation(e.document);
        invalidateSearchCacheForDocument(e.document);
        invalidateWholePouUsageCacheForDocument(e.document);
        const source = getSourcePathForDocument(e.document);
        if (source) scheduleRelatedValidation(source);
    });
    const saveListener = vscode.workspace.onDidSaveTextDocument(doc => {
        scheduleDocumentValidation(doc, 40);
        invalidateSearchCacheForDocument(doc);
        invalidateWholePouUsageCacheForDocument(doc);
        const source = getSourcePathForDocument(doc);
        if (source) scheduleRelatedValidation(source);
    });
    const closeListener = vscode.workspace.onDidCloseTextDocument(doc => {
        diagnosticCollection.delete(doc.uri);
        const key = doc.uri.toString();
        const timer = documentValidationTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            documentValidationTimers.delete(key);
        }
    });
    const closeCacheListener = vscode.workspace.onDidCloseTextDocument(doc => {
        localSymbolCache.delete(doc.uri.toString());
        workspaceSearchTextCache.delete(doc.uri.toString());
    });
    const handleAnalyzerRefresh = () => {
        const docs = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'iec-st');
        for (const doc of docs) {
            scheduleDocumentValidation(doc, 80);
            const source = getSourcePathForDocument(doc);
            if (source) scheduleRelatedValidation(source);
        }
    };
    let activeAnalyzerRefreshDisposable: vscode.Disposable | undefined;
    const analyzerRefreshListener = onProjectAnalyzerCreated(analyzer => {
        activeAnalyzerRefreshDisposable?.dispose();
        activeAnalyzerRefreshDisposable = analyzer.onDidRefreshIndex(handleAnalyzerRefresh);
    });

    // Quick fixes for common diagnostics
    const codeActionProvider = vscode.languages.registerCodeActionsProvider(
        'iec-st',
        {
            provideCodeActions(document, _range, context) {
                const actions: vscode.CodeAction[] = [];

                for (const diagnostic of context.diagnostics) {
                    const message = diagnostic.message;
                    const line = document.lineAt(diagnostic.range.start.line);

                    // Missing semicolon
                    if (message === 'Missing semicolon at end of statement') {
                        const action = new vscode.CodeAction('Insert missing semicolon', vscode.CodeActionKind.QuickFix);
                        action.diagnostics = [diagnostic];
                        action.isPreferred = true;
                        action.edit = new vscode.WorkspaceEdit();
                        const insertPos = findLineEndInsertPosition(line.text);
                        action.edit.insert(document.uri, new vscode.Position(line.lineNumber, insertPos), ';');
                        actions.push(action);
                        continue;
                    }

                    // Unclosed single/double string
                    if (message === 'Unclosed single-quoted string literal.' || message === 'Unclosed double-quoted string literal.') {
                        const action = new vscode.CodeAction(
                            message.includes('single') ? 'Append closing single quote' : 'Append closing double quote',
                            vscode.CodeActionKind.QuickFix
                        );
                        action.diagnostics = [diagnostic];
                        action.isPreferred = true;
                        action.edit = new vscode.WorkspaceEdit();
                        const quote = message.includes('single') ? '\'' : '"';
                        const insertPos = findLineEndInsertPosition(line.text);
                        action.edit.insert(document.uri, new vscode.Position(line.lineNumber, insertPos), quote);
                        actions.push(action);
                        continue;
                    }

                    // Unmatched parentheses
                    if (message.startsWith('Unmatched parentheses: missing')) {
                        const missingMatch = message.match(/missing\s+(\d+)\s+closing/);
                        const missing = missingMatch ? Number(missingMatch[1]) : 1;
                        const action = new vscode.CodeAction(
                            missing === 1 ? 'Insert missing closing parenthesis' : `Insert ${missing} missing closing parentheses`,
                            vscode.CodeActionKind.QuickFix
                        );
                        action.diagnostics = [diagnostic];
                        action.isPreferred = true;
                        action.edit = new vscode.WorkspaceEdit();
                        const insertPos = findLineEndInsertPosition(line.text);
                        action.edit.insert(document.uri, new vscode.Position(line.lineNumber, insertPos), ')'.repeat(missing));
                        actions.push(action);
                        continue;
                    }

                    if (message.startsWith('Unmatched parentheses on this line:')) {
                        const counts = message.match(/(\d+)\s+opening,\s+(\d+)\s+closing/);
                        const openings = counts ? Number(counts[1]) : 1;
                        const closings = counts ? Number(counts[2]) : 0;
                        if (openings > closings) {
                            const missing = openings - closings;
                            const action = new vscode.CodeAction(
                                missing === 1 ? 'Insert missing closing parenthesis' : `Insert ${missing} missing closing parentheses`,
                                vscode.CodeActionKind.QuickFix
                            );
                            action.diagnostics = [diagnostic];
                            action.isPreferred = true;
                            action.edit = new vscode.WorkspaceEdit();
                            const insertPos = findLineEndInsertPosition(line.text);
                            action.edit.insert(document.uri, new vscode.Position(line.lineNumber, insertPos), ')'.repeat(missing));
                            actions.push(action);
                        }
                        continue;
                    }

                    // Duplicate declaration
                    if (message.startsWith('Duplicate declaration ')) {
                        const action = new vscode.CodeAction('Remove duplicate declaration line', vscode.CodeActionKind.QuickFix);
                        action.diagnostics = [diagnostic];
                        action.edit = new vscode.WorkspaceEdit();
                        action.edit.delete(document.uri, fullLineDeletionRange(document, diagnostic.range.start.line));
                        actions.push(action);
                        continue;
                    }

                    // Missing closing block quick fix
                    if (message.startsWith('Missing ') && message.includes(' for ')) {
                        const missingMatch = message.match(/^Missing\s+([A-Z_]+)\s+for\s+([A-Z_]+)/i);
                        if (missingMatch) {
                            const closeToken = missingMatch[1].toUpperCase();
                            const action = new vscode.CodeAction(`Insert ${closeToken}`, vscode.CodeActionKind.QuickFix);
                            action.diagnostics = [diagnostic];
                            action.edit = new vscode.WorkspaceEdit();
                            const insertLine = Math.min(document.lineCount - 1, diagnostic.range.start.line + 1);
                            action.edit.insert(document.uri, new vscode.Position(insertLine, 0), `${closeToken}\n`);
                            actions.push(action);
                            continue;
                        }
                    }

                    // Unused declaration
                    if (message.startsWith('Declaration ') && message.includes('declared but never used')) {
                        const action = new vscode.CodeAction('Remove unused variable declaration line', vscode.CodeActionKind.QuickFix);
                        action.diagnostics = [diagnostic];
                        action.edit = new vscode.WorkspaceEdit();
                        action.edit.delete(document.uri, fullLineDeletionRange(document, diagnostic.range.start.line));
                        actions.push(action);
                        continue;
                    }

                    // Undefined symbol quick fix
                    if (message.includes('is undeclared in local scope and project symbols')) {
                        const symbolMatch = message.match(/^'([^']+)'/);
                        const symbolName = symbolMatch?.[1];
                        if (symbolName && /^[A-Za-z_]\w*$/.test(symbolName)) {
                            const action = new vscode.CodeAction(`Declare '${symbolName}' in VAR`, vscode.CodeActionKind.QuickFix);
                            action.diagnostics = [diagnostic];
                            action.edit = new vscode.WorkspaceEdit();
                            applyCreateVariableDeclarationEdit(
                                document,
                                action.edit,
                                symbolName,
                                vscode.workspace.getConfiguration('twincat').get<string>('createMissingVariableDefaultSection', 'VAR')
                            );
                            actions.push(action);
                            continue;
                        }
                    }
                }

                return actions;
            }
        },
        {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        }
    );
    
    // Validate all open documents
    vscode.workspace.textDocuments.forEach(doc => scheduleDocumentValidation(doc, 40));

    const validateSyntaxCommand = vscode.commands.registerCommand('tcview.validateSyntax', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'iec-st') {
            vscode.window.showInformationMessage('Open an IEC ST document to validate.');
            return;
        }
        await validateDocument(editor.document);
        const issues = diagnosticCollection.get(editor.document.uri)?.length ?? 0;
        vscode.window.showInformationMessage(`Validation complete: ${issues} issue(s).`);
    });

        const indexStatsCommand = vscode.commands.registerCommand('tcview.showIndexStats', async () => {
        await ensureProjectAnalyzerReady();
        const analyzer = getProjectAnalyzer();
        let symbols = 0;
        analyzer.forEachAllSymbols(() => {
            symbols++;
        });
        const globals = analyzer.getGlobalVariables().size;
        let types = 0;
        analyzer.forEachDataType(() => {
            types++;
        });
        vscode.window.showInformationMessage(`Index stats: ${symbols} symbols, ${globals} globals, ${types} data types.`);
    });

    const statusCommand = vscode.commands.registerCommand('tcview.checkLspStatus', () => {
        const parts = [...featureStats.entries()]
            .map(([name, s]) => `${name}: ${s.calls} calls, ${Math.round(s.totalMs / Math.max(1, s.calls))} ms avg`)
            .join(' | ');
        const suffix = parts ? ` Stats -> ${parts}` : '';
        vscode.window.showInformationMessage(`TcView language features are active (completion, hover, diagnostics, formatting, navigation, code actions).${suffix}`);
    });

    const cacheCleanupDisposable = new vscode.Disposable(() => {
        documentValidationTimers.forEach(timer => clearTimeout(timer));
        documentValidationTimers.clear();
        relatedValidationTimers.forEach(timer => clearTimeout(timer));
        relatedValidationTimers.clear();
        workspaceSearchTextCache.clear();
        projectCompletionCache.revision = -1;
        projectCompletionCache.items = [];
        wholePouUsageCache.clear();
    });
    
    context.subscriptions.push(
        completionProvider,
        hoverProvider,
        symbolProvider,
        foldingProvider,
        formattingProvider,
        rangeFormattingProvider,
        definitionProvider,
        referenceProvider,
        renameProvider,
        signatureHelpProvider,
        semanticTokensProvider,
        diagnosticCollection,
        codeActionProvider,
        autoKeywordCaseListener,
        openListener,
        changeListener,
        saveListener,
        closeListener,
        closeCacheListener,
        analyzerRefreshListener,
        { dispose: () => activeAnalyzerRefreshDisposable?.dispose() },
        validateSyntaxCommand,
        indexStatsCommand,
        statusCommand,
        cacheCleanupDisposable
    );
}

// Extract declared variables from VAR sections
function extractDeclaredVariables(text: string): string[] {
    const declaredVars: string[] = [];
    const varSectionRegex = /\b(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_GLOBAL|VAR_INST|VAR_STAT)\b[\s\S]*?\bEND_VAR\b/gi;
    
    let sectionMatch;
    while ((sectionMatch = varSectionRegex.exec(text)) !== null) {
        const section = sectionMatch[0];
        // Match variable declarations: "name : type" or "name : type := value"
        const varDeclRegex = /^\s*([a-zA-Z_]\w*)\s*:/gm;
        let declMatch;
        while ((declMatch = varDeclRegex.exec(section)) !== null) {
            declaredVars.push(declMatch[1].toUpperCase());
        }
    }
    
    return declaredVars;
}

function extractDeclaredSymbolsWithTypes(text: string): Map<string, { name: string; type: string }> {
    const symbols = new Map<string, { name: string; type: string }>();
    const varSectionRegex = /\b(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_GLOBAL|VAR_INST|VAR_STAT)\b[\s\S]*?\bEND_VAR\b/gi;

    let sectionMatch;
    while ((sectionMatch = varSectionRegex.exec(text)) !== null) {
        const section = sectionMatch[0];
        const varDeclRegex = /^\s*([a-zA-Z_]\w*)\s*:\s*([^;]+);/gm;
        let declMatch;

        while ((declMatch = varDeclRegex.exec(section)) !== null) {
            const name = declMatch[1];
            const rawType = declMatch[2];
            const type = normalizeTypeName(rawType);
            symbols.set(name.toUpperCase(), { name, type: type || rawType.trim() });
        }
    }

    return symbols;
}

function normalizeTypeName(rawType: string): string {
    if (!rawType) return '';
    let cleaned = rawType.toUpperCase();
    cleaned = cleaned.split(':=')[0].trim();
    cleaned = cleaned.replace(/\([^)]*\)/g, '').trim();
    cleaned = cleaned.replace(/\b(CONSTANT|RETAIN|PERSISTENT|AT)\b/g, '').trim();
    const qualifiedMatch = cleaned.match(/[A-Z_]\w*(?:\.[A-Z_]\w*)+/);
    if (qualifiedMatch) {
        const parts = qualifiedMatch[0].split('.');
        return parts[parts.length - 1];
    }
    const tokenMatch = cleaned.match(/[A-Z_]\w*/);
    return tokenMatch ? tokenMatch[0] : cleaned;
}

function parseDeclarationTypeInfo(rawType: string): { baseType: string; initializer?: string; hasInitializer: boolean } {
    const typeAndInit = rawType.split(':=');
    const declaredType = (typeAndInit[0] || '').trim();
    const initializer = typeAndInit.length > 1 ? typeAndInit.slice(1).join(':=').trim() : undefined;

    const baseType = extractBaseTypeName(declaredType);
    return { baseType, initializer, hasInitializer: typeAndInit.length > 1 };
}

function extractBaseTypeName(typeExpr: string): string {
    if (!typeExpr) return '';

    let working = typeExpr.trim();
    working = working.replace(/\b(CONSTANT|RETAIN|PERSISTENT)\b/gi, '').trim();
    working = working.replace(/\bAT\s+%[A-Za-z0-9_.]+\b/gi, '').trim();

    const arrayMatch = working.match(/\bARRAY\b[\s\S]*\bOF\s+(.+)$/i);
    if (arrayMatch) {
        return extractBaseTypeName(arrayMatch[1]);
    }

    const refMatch = working.match(/\b(?:REFERENCE|POINTER)\s+TO\s+(.+)$/i);
    if (refMatch) {
        return extractBaseTypeName(refMatch[1]);
    }

    if (/^\s*STRING\s*\(/i.test(working)) return 'STRING';
    if (/^\s*WSTRING\s*\(/i.test(working)) return 'WSTRING';

    const normalized = normalizeTypeName(working);
    return normalized;
}

function findDeclarationTypeRange(lineText: string, lineNumber: number): vscode.Range {
    const line = lineText.replace(/\r/g, '');
    const colon = line.indexOf(':');
    if (colon < 0) {
        const end = Math.max(1, line.length);
        return new vscode.Range(lineNumber, 0, lineNumber, end);
    }

    const afterColon = line.substring(colon + 1);
    const semicolonRel = afterColon.indexOf(';');
    const typeStart = colon + 1 + (afterColon.match(/^\s*/)?.[0].length ?? 0);
    const typeEnd = semicolonRel >= 0 ? colon + 1 + semicolonRel : line.length;
    const start = Math.max(0, Math.min(typeStart, line.length));
    const end = Math.max(start + 1, Math.min(typeEnd, line.length));
    return new vscode.Range(lineNumber, start, lineNumber, end);
}

function findCallableReturnTypeRange(lineText: string, lineNumber: number): vscode.Range {
    const line = lineText.replace(/\r/g, '');
    const colon = line.indexOf(':');
    if (colon < 0) {
        const end = Math.max(1, line.length);
        return new vscode.Range(lineNumber, 0, lineNumber, end);
    }

    let start = colon + 1;
    while (start < line.length && /\s/.test(line[start])) {
        start += 1;
    }

    let end = start;
    while (end < line.length && /[A-Za-z0-9_.]/.test(line[end])) {
        end += 1;
    }

    const safeStart = Math.max(0, Math.min(start, line.length));
    const safeEnd = Math.max(safeStart + 1, Math.min(end, line.length));
    return new vscode.Range(lineNumber, safeStart, lineNumber, safeEnd);
}

function extractCallableReturnTypes(lines: string[]): Array<{ kind: string; name: string; typeName: string; line: number }> {
    const results: Array<{ kind: string; name: string; typeName: string; line: number }> = [];
    const callableHeaderPattern = /^\s*(FUNCTION|METHOD|PROPERTY)\b(?:\s+(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|FINAL|ABSTRACT))*\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)/i;

    lines.forEach((lineText, line) => {
        const match = lineText.match(callableHeaderPattern);
        if (!match) {
            return;
        }

        results.push({
            kind: match[1].toUpperCase(),
            name: match[2],
            typeName: match[3],
            line
        });
    });

    return results;
}

function getKnownFbMembers(typeName: string): string[] {
    const fbMembers: Record<string, string[]> = {
        TON: ['IN', 'PT', 'Q', 'ET'],
        TOF: ['IN', 'PT', 'Q', 'ET'],
        TP: ['IN', 'PT', 'Q', 'ET'],
        R_TRIG: ['CLK', 'Q'],
        F_TRIG: ['CLK', 'Q'],
        RS: ['SET', 'RESET1', 'Q1'],
        SR: ['SET1', 'RESET', 'Q1'],
        CTU: ['CU', 'R', 'PV', 'Q', 'CV'],
        CTD: ['CD', 'LD', 'PV', 'Q', 'CV'],
        CTUD: ['CU', 'CD', 'R', 'LD', 'PV', 'QU', 'QD', 'CV']
    };
    const standardMembers = standardIecDefinitions[typeName]?.members?.map(m => m.name) ?? [];
    return [...new Set([...(fbMembers[typeName] ?? []), ...standardMembers])];
}

// Get common system/standard library variables
function getSystemVariables(): string[] {
    return [
        // Timer/FB instance members (TON, TOF, TP, TONR, etc.)
        'Q', 'IN', 'PT', 'ET', 'OUT', 'CV', 'PV', 'R', 'S', 'R1', 'S1',
        // R_TRIG / F_TRIG
        'CLK', 
        // RS / SR flip-flops
        'SET', 'RESET', 'SET1', 'RESET1', 'Q1',
        // Counters (CTU, CTD, CTUD)
        'CU', 'CD', 'LD', 'QU', 'QD',
        // TOF specific
        'TOF',
        // Common FB outputs
        'DONE', 'BUSY', 'ERROR', 'STATUS', 'ERR', 'ID',
        // Motion control (MC_Power, MC_MoveAbsolute, etc.)
        'AXIS', 'ENABLE', 'START', 'VELOCITY', 'ACCELERATION', 'DECELERATION', 'JERK',
        'POSITION', 'DIRECTION', 'EXECUTE', 'COMMANDABORTED', 'INVERT', 'REGULATOR',
        // Array properties
        'LOWER_BOUND', 'UPPER_BOUND',
        // String properties
        'LENGTH',
        // Common global/system variables (TwinCAT specific)
        'PLC_TICKS', 'PLC_CYCLE_COUNT', 'PLC_TASK',
        // Standard functions treated as variables
        'TRUE', 'FALSE',
        // Common TwinCAT system
        'ADS', 'AMSPORT', 'TASKINDEX',
        // Standard FB types (when used as instances)
        'TON', 'TOF', 'TP', 'R_TRIG', 'F_TRIG', 'RS', 'SR', 'CTU', 'CTD', 'CTUD',
        'SEMA', 'F_EDGE', 'R_EDGE'
    ];
}


// Extract program and function names from declarations
function extractProgramFunctionNames(text: string): string[] {
    const names: string[] = [];
    
    // Match PROGRAM Name, FUNCTION Name : Type, FUNCTION_BLOCK Name
    const declRegex = /^\s*(PROGRAM|FUNCTION|FUNCTION_BLOCK)\s+([a-zA-Z_]\w*)/gm;
    let match;
    while ((match = declRegex.exec(text)) !== null) {
        names.push(match[2]);
    }
    
    return names;
}

function extractCallableNames(text: string): string[] {
    const names: string[] = [];
    const lines = text.split('\n');
    const modifiers = new Set(['PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL', 'FINAL', 'ABSTRACT', 'OVERRIDE', 'STATIC']);

    for (const rawLine of lines) {
        const line = rawLine.replace(/\/\/.*/, '').trim();
        if (!line) continue;

        const keywordMatch = line.match(/^(METHOD|PROPERTY|ACTION|TRANSITION)\b/i);
        if (!keywordMatch) continue;

        const afterKeyword = line.substring(keywordMatch[0].length).trim();
        if (!afterKeyword) continue;
        const tokens = afterKeyword.split(/\s+/).filter(Boolean);

        let name: string | undefined;
        for (const token of tokens) {
            const clean = token.replace(/[:(].*$/, '');
            if (!clean) continue;
            if (modifiers.has(clean.toUpperCase())) continue;
            if (/^[A-Za-z_]\w*$/.test(clean)) {
                name = clean;
                break;
            }
        }

        if (name) {
            names.push(name);
        }
    }
    return names;
}

function isLikelyContinuationLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.endsWith(',')) return true;

    const opens = (trimmed.match(/[([{}]/g) || []).length;
    const closes = (trimmed.match(/[)\]}]/g) || []).length;
    if (opens > closes) return true;

    if (/^\s*(AND|OR|XOR|\+|-|\*|\/)\b/i.test(trimmed)) return true;
    if (/:=\s*$/.test(trimmed)) return true;
    if (/[+\-*/,(]$/.test(trimmed)) return true;
    if (/\b(AND|OR|XOR|MOD|DIV)\s*$/i.test(trimmed)) return true;

    return false;
}

function isCaseLabelLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes(':=')) return false;
    if (!trimmed.includes(':')) return false;
    // Allow common CASE label forms:
    // 1:, 16#10:, StateA:, 1,2,3:, 1..10:, StateA,StateB:
    return /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+|16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+)(\s*\.\.\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+|16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+))?(\s*,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+|16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+)(\s*\.\.\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+|16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+))?)*\s*:\s*(\/\/.*)?$/i.test(trimmed);
}

function isLikelyContinuationToNextLine(currentLine: string, nextLine: string): boolean {
    const current = currentLine.trim();
    const next = nextLine.trim();
    if (!next) return false;

    // If next line starts with an operator or delimiter, current line is likely a continued expression.
    if (/^(\)|\]|\+|-|\*|\/|AND\b|OR\b|XOR\b|MOD\b|DIV\b|,)/i.test(next)) return true;
    // Current line ending with assignment/operator/comma/opening delimiter indicates continuation.
    if (/:=\s*$/.test(current)) return true;
    if (/[+\-*/,(]$/.test(current)) return true;

    return false;
}

function findNextRelevantLine(lines: string[], startIndex: number): { text: string; index: number } | undefined {
    for (let i = startIndex; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('//')) continue;
        return { text: lines[i], index: i };
    }
    return undefined;
}

function extractIdentifiersWithContext(line: string): Array<{
    name: string;
    start: number;
    end: number;
    prevNonWs: string;
    nextNonWs: string;
    after: string;
}> {
    const results: Array<{
        name: string;
        start: number;
        end: number;
        prevNonWs: string;
        nextNonWs: string;
        after: string;
    }> = [];

    const regex = /\b[a-zA-Z_]\w*\b/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const before = line.slice(0, start);
        const after = line.slice(end);

        const prevNonWsMatch = before.match(/\S(?=\s*$)/);
        const prevNonWs = prevNonWsMatch ? prevNonWsMatch[0] : '';
        const nextNonWsMatch = after.match(/\S/);
        const nextNonWs = nextNonWsMatch ? nextNonWsMatch[0] : '';

        results.push({
            name: match[0],
            start,
            end,
            prevNonWs,
            nextNonWs,
            after
        });
    }

    return results;
}

function extractVariableDeclarations(text: string): {
    allDeclared: Set<string>;
    symbolTypes: Map<string, string>;
    duplicates: Array<{ name: string; line: number; startCol: number; endCol: number }>;
    localsForUnusedCheck: Array<{ name: string; upper: string; line: number; startCol: number; endCol: number }>;
} {
    const allDeclared = new Set<string>();
    const symbolTypes = new Map<string, string>();
    const duplicates: Array<{ name: string; line: number; startCol: number; endCol: number }> = [];
    const localsForUnusedCheck: Array<{ name: string; upper: string; line: number; startCol: number; endCol: number }> = [];

    const lines = text.split('\n');
    let currentScope: string | undefined;
    let scopeDeclarations = new Map<string, { line: number; startCol: number; endCol: number }>();

    lines.forEach((line, lineIndex) => {
        const cleanLine = line.replace(/\r/g, '');
        const upper = cleanLine.trim().toUpperCase();
        if (!upper) return;

        const scopeMatch = upper.match(/^(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_GLOBAL|VAR_INST|VAR_STAT)\b/);
        if (scopeMatch) {
            currentScope = `${scopeMatch[1]}@${lineIndex}`;
            scopeDeclarations = new Map<string, { line: number; startCol: number; endCol: number }>();
            return;
        }

        if (/^END_VAR\b/.test(upper)) {
            currentScope = undefined;
            scopeDeclarations = new Map<string, { line: number; startCol: number; endCol: number }>();
            return;
        }

        if (!currentScope) return;

        const varMatch = cleanLine.match(/^\s*([a-zA-Z_]\w*)\s*:\s*([^;]+);/);
        if (!varMatch) return;

        const name = varMatch[1];
        const upperName = name.toUpperCase();
        const startCol = cleanLine.indexOf(name);
        const endCol = startCol + name.length;

        allDeclared.add(upperName);
        symbolTypes.set(upperName, normalizeTypeName(varMatch[2]));

        if (scopeDeclarations.has(upperName)) {
            duplicates.push({ name, line: lineIndex, startCol, endCol });
        } else {
            scopeDeclarations.set(upperName, { line: lineIndex, startCol, endCol });
        }

        const activeScope = currentScope;
        if (activeScope && [...unusedDeclarationScopes].some(scope => activeScope.startsWith(`${scope}@`))) {
            localsForUnusedCheck.push({ name, upper: upperName, line: lineIndex, startCol, endCol });
        }
    });

    return { allDeclared, symbolTypes, duplicates, localsForUnusedCheck };
}

function findClosestMatch(target: string, candidates: string[]): string | undefined {
    const upperTarget = target.toUpperCase();
    let best: { value: string; score: number } | undefined;

    for (const candidate of candidates) {
        const upperCandidate = candidate.toUpperCase();
        const score = levenshteinDistance(upperTarget, upperCandidate);
        if (score > 2) continue;
        if (!best || score < best.score) {
            best = { value: candidate, score };
        }
    }

    return best?.value;
}

function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));

    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }

    return matrix[a.length][b.length];
}

function stripCommentsKeepingState(line: string, inBlockComment: boolean): { code: string; inBlockComment: boolean } {
    let code = '';
    let i = 0;
    while (i < line.length) {
        if (inBlockComment) {
            const end = line.indexOf('*)', i);
            if (end === -1) return { code, inBlockComment: true };
            i = end + 2;
            inBlockComment = false;
            continue;
        }

        if (line.startsWith('//', i)) {
            break;
        }

        if (line.startsWith('(*', i)) {
            inBlockComment = true;
            i += 2;
            continue;
        }

        code += line[i];
        i++;
    }

    return { code, inBlockComment };
}

function detectUnclosedString(line: string): 'single' | 'double' | undefined {
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = i + 1 < line.length ? line[i + 1] : '';

        if (!inDouble && ch === '\'') {
            if (inSingle && next === '\'') {
                i++;
                continue;
            }
            inSingle = !inSingle;
            continue;
        }

        if (!inSingle && ch === '"') {
            if (inDouble && next === '"') {
                i++;
                continue;
            }
            inDouble = !inDouble;
            continue;
        }
    }

    if (inSingle) return 'single';
    if (inDouble) return 'double';
    return undefined;
}

function removeQuotedStrings(line: string): string {
    let out = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = i + 1 < line.length ? line[i + 1] : '';

        if (!inDouble && ch === '\'') {
            if (inSingle && next === '\'') {
                i++;
                continue;
            }
            inSingle = !inSingle;
            continue;
        }

        if (!inSingle && ch === '"') {
            if (inDouble && next === '"') {
                i++;
                continue;
            }
            inDouble = !inDouble;
            continue;
        }

        if (!inSingle && !inDouble) {
            out += ch;
        }
    }

    return out;
}

function findLineEndInsertPosition(lineText: string): number {
    // Insert before inline comment if present, otherwise at end of non-whitespace text.
    const commentIndex = lineText.indexOf('//');
    const codePart = commentIndex >= 0 ? lineText.substring(0, commentIndex) : lineText;
    let pos = codePart.length;
    while (pos > 0 && /\s/.test(codePart[pos - 1])) pos--;
    return pos;
}

function fullLineDeletionRange(document: vscode.TextDocument, lineNumber: number): vscode.Range {
    const line = document.lineAt(lineNumber);
    if (lineNumber < document.lineCount - 1) {
        const nextLineStart = document.lineAt(lineNumber + 1).range.start;
        return new vscode.Range(line.range.start, nextLineStart);
    }
    return new vscode.Range(line.range.start, line.range.end);
}

function findDeclarationInDocument(document: vscode.TextDocument, name: string): vscode.Range | undefined {
    const text = document.getText();
    const patterns = [
        new RegExp(`^\\s*${escapeRegExp(name)}\\s*:\\s*[^;]+;`, 'gim'),
        new RegExp(`^\\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|INTERFACE|METHOD|PROPERTY|ACTION|TRANSITION)\\s+(?:\\w+\\s+)*${escapeRegExp(name)}\\b`, 'gim')
    ];

    for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match && typeof match.index === 'number') {
            const start = document.positionAt(match.index);
            const end = document.positionAt(match.index + match[0].length);
            return new vscode.Range(start, end);
        }
    }

    return undefined;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatIECStructuredText(input: string, keywordCasing: 'upper' | 'lower' | 'preserve'): string {
    const lines = input.replace(/\r/g, '').split('\n');
    let indent = 0;
    const out: string[] = [];

    for (const originalLine of lines) {
        const trimmed = originalLine.trim();
        if (!trimmed) {
            out.push('');
            continue;
        }

        const upper = trimmed.toUpperCase();
        const isClosing = /^(END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_VAR|END_STRUCT|END_INTERFACE|END_METHOD|END_PROPERTY|END_ACTION|END_TRANSITION|ELSE|ELSIF)\b/.test(upper);
        if (isClosing) {
            indent = Math.max(0, indent - 1);
        }

        let formatted = trimmed;
        if (keywordCasing !== 'preserve') {
            formatted = applyKeywordCasing(formatted, keywordCasing);
        }

        out.push(`${'    '.repeat(indent)}${formatted}`);

        const isOpening = /^(IF\b.*THEN|FOR\b.*DO|WHILE\b.*DO|REPEAT\b|CASE\b.*OF|VAR(_\w+)?\b|STRUCT\b|INTERFACE\b|METHOD\b|PROPERTY\b|ACTION\b|TRANSITION\b)/i.test(upper);
        if (isOpening && !isClosing) {
            indent += 1;
        }
        if (/^ELSE\b|^ELSIF\b/i.test(upper)) {
            indent += 1;
        }
    }

    return out.join('\n');
}

function applyKeywordCasing(line: string, keywordCasing: 'upper' | 'lower'): string {
    return line.replace(/\b[a-zA-Z_]\w*\b/g, token => {
        const upper = token.toUpperCase();
        if (iecStKeywordSet.has(upper)) {
            return keywordCasing === 'upper' ? upper : upper.toLowerCase();
        }
        return token;
    });
}

function uppercaseKeywordsInLine(fullText: string, lineStartOffset: number, lineText: string): string {
    const state = getLexerStateAtOffset(fullText, lineStartOffset);
    let inLineComment = false;
    let inBlockComment = state.inBlockComment;
    let inSingle = state.inSingle;
    let inDouble = state.inDouble;
    let out = '';
    let i = 0;

    while (i < lineText.length) {
        const ch = lineText[i];
        const next = i + 1 < lineText.length ? lineText[i + 1] : '';

        if (inLineComment) {
            out += lineText.substring(i);
            break;
        }

        if (inBlockComment) {
            out += ch;
            if (ch === '*' && next === ')') {
                out += next;
                i += 2;
                inBlockComment = false;
                continue;
            }
            i++;
            continue;
        }

        if (inSingle) {
            out += ch;
            if (ch === '\'') {
                if (next === '\'') {
                    out += next;
                    i += 2;
                    continue;
                }
                inSingle = false;
            }
            i++;
            continue;
        }

        if (inDouble) {
            out += ch;
            if (ch === '"') {
                if (next === '"') {
                    out += next;
                    i += 2;
                    continue;
                }
                inDouble = false;
            }
            i++;
            continue;
        }

        if (ch === '/' && next === '/') {
            out += lineText.substring(i);
            inLineComment = true;
            break;
        }

        if (ch === '(' && next === '*') {
            out += ch + next;
            inBlockComment = true;
            i += 2;
            continue;
        }

        if (ch === '\'') {
            out += ch;
            inSingle = true;
            i++;
            continue;
        }

        if (ch === '"') {
            out += ch;
            inDouble = true;
            i++;
            continue;
        }

        if (/[A-Za-z_]/.test(ch)) {
            let end = i + 1;
            while (end < lineText.length && /\w/.test(lineText[end])) end++;
            const token = lineText.substring(i, end);
            const upper = token.toUpperCase();
            out += iecStKeywordSet.has(upper) ? upper : token;
            i = end;
            continue;
        }

        out += ch;
        i++;
    }

    return out;
}

function getLexerStateAtOffset(text: string, offset: number): { inBlockComment: boolean; inSingle: boolean; inDouble: boolean } {
    let inLineComment = false;
    let inBlockComment = false;
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < offset && i < text.length; i++) {
        const ch = text[i];
        const next = i + 1 < text.length ? text[i + 1] : '';

        if (inLineComment) {
            if (ch === '\n') inLineComment = false;
            continue;
        }

        if (inBlockComment) {
            if (ch === '*' && next === ')') {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (inSingle) {
            if (ch === '\'') {
                if (next === '\'') {
                    i++;
                    continue;
                }
                inSingle = false;
            }
            continue;
        }

        if (inDouble) {
            if (ch === '"') {
                if (next === '"') {
                    i++;
                    continue;
                }
                inDouble = false;
            }
            continue;
        }

        if (ch === '/' && next === '/') {
            inLineComment = true;
            i++;
            continue;
        }

        if (ch === '(' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
        }

        if (ch === '\'') {
            inSingle = true;
            continue;
        }

        if (ch === '"') {
            inDouble = true;
        }
    }

    return { inBlockComment, inSingle, inDouble };
}

function inferExpressionPrimitiveType(expr: string): IECPrimitiveType {
    const value = expr.trim();
    if (!value) return 'UNKNOWN';

    if (/^(TRUE|FALSE)$/i.test(value)) return 'BOOL';
    if (/^'.*'$/.test(value)) return 'STRING';
    if (/^".*"$/.test(value)) return 'WSTRING';
    if (/^(T|TIME)#/i.test(value)) return 'TIME';
    if (/^[+-]?\d+$/.test(value)) return 'INT';
    if (/^[+-]?\d+\.\d+([eE][+-]?\d+)?$/.test(value)) return 'REAL';
    if (/^(16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+)$/.test(value)) return 'DINT';

    return 'UNKNOWN';
}

function isTypeCompatible(targetType: string, exprType: IECPrimitiveType): boolean {
    const normalizedTarget = normalizeTypeName(targetType);
    if (!normalizedTarget || exprType === 'UNKNOWN') return true;

    if (normalizedTarget === exprType) return true;

    const integerTypes = new Set(['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT']);
    const realTypes = new Set(['REAL', 'LREAL']);

    if (integerTypes.has(normalizedTarget) && (exprType === 'INT' || exprType === 'DINT' || exprType === 'UDINT')) return true;
    if (realTypes.has(normalizedTarget) && (exprType === 'REAL' || exprType === 'INT' || exprType === 'DINT')) return true;
    if (normalizedTarget === 'BOOL' && exprType === 'BOOL') return true;
    if (normalizedTarget === 'TIME' && exprType === 'TIME') return true;
    if (normalizedTarget === 'STRING' && exprType === 'STRING') return true;
    if (normalizedTarget === 'WSTRING' && exprType === 'WSTRING') return true;

    return false;
}

function isIdentifierUsedInBody(text: string, identifier: string): boolean {
    // Remove declaration-heavy blocks to focus on executable body usage.
    let body = text.replace(/\r/g, '');
    body = body.replace(/\b(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_GLOBAL|VAR_INST|VAR_STAT)\b[\s\S]*?\bEND_VAR\b/gi, '\n');
    body = body.replace(/\bTYPE\b[\s\S]*?\bEND_TYPE\b/gi, '\n');

    // Remove comments.
    body = body.replace(/\/\/.*$/gm, '');
    body = body.replace(/\(\*[\s\S]*?\*\)/g, '');

    // Remove quoted strings.
    body = body.replace(/'([^']|'')*'/g, '');
    body = body.replace(/"([^"]|"")*"/g, '');

    const re = new RegExp(`\\b${escapeRegExp(identifier)}\\b`, 'i');
    return re.test(body);
}

const wholePouUsageCache = new Map<string, Set<string>>();

async function getWholePouUsageSet(document: vscode.TextDocument): Promise<Set<string> | undefined> {
    if (document.uri.scheme !== 'twincat') return undefined;
    const originalPath = decodeURIComponent(document.uri.query || '');
    if (!/\.(tcpou|tcprg|tcapp|tccom)$/i.test(originalPath)) return undefined;

    try {
        const sourceUri = vscode.Uri.file(originalPath);
        const sourceStat = await vscode.workspace.fs.stat(sourceUri);
        const sourceFingerprint = `${sourceStat.mtime}:${sourceStat.size}`;
        const cacheKey = `${originalPath.toLowerCase()}|${document.version}|${sourceFingerprint}`;
        const cached = wholePouUsageCache.get(cacheKey);
        if (cached) {
            return new Set(cached);
        }

        const stalePrefix = `${originalPath.toLowerCase()}|`;
        for (const key of [...wholePouUsageCache.keys()]) {
            if (key.startsWith(stalePrefix) && key !== cacheKey) {
                wholePouUsageCache.delete(key);
            }
        }

        const xmlBytes = await vscode.workspace.fs.readFile(sourceUri);
        const xmlText = Buffer.from(xmlBytes).toString('utf8');
        const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
        const xmlObj = await parser.parseStringPromise(xmlText);
        const pou = xmlObj.TcPOU ?? xmlObj.TcPlcObject?.POU;
        if (!pou) return undefined;

        const chunks: string[] = [];
        const pushText = (value: any) => {
            if (typeof value === 'string') {
                chunks.push(value);
                return;
            }
            if (value && typeof value._ === 'string') {
                chunks.push(value._);
            }
        };

        pushText(pou.Declaration);
        pushText(pou.Implementation?.ST);

        const toArray = <T>(value: T | T[] | undefined): T[] =>
            Array.isArray(value) ? value : value ? [value] : [];

        const methods = toArray<any>(pou.Method);
        methods.forEach(m => {
            pushText(m.Declaration);
            pushText(m.Implementation?.ST);
        });

        const actions = toArray<any>(pou.Action);
        actions.forEach(a => {
            pushText(a.Declaration);
            pushText(a.Implementation?.ST);
        });

        const transitions = toArray<any>(pou.Transition);
        transitions.forEach(t => {
            pushText(t.Declaration);
            pushText(t.Implementation?.ST);
        });

        const properties = toArray<any>(pou.Property);
        properties.forEach(p => {
            pushText(p.Declaration);
            const getObj = p.Get;
            const setObj = p.Set;
            if (getObj) {
                pushText(getObj.Declaration);
                pushText(getObj.Implementation?.ST);
            }
            if (setObj) {
                pushText(setObj.Declaration);
                pushText(setObj.Implementation?.ST);
            }
        });

        // Merge currently open unsaved fragment/main docs for the same source file
        const sourcePath = originalPath.toLowerCase();
        for (const openDoc of vscode.workspace.textDocuments) {
            if (openDoc.languageId !== 'iec-st') continue;
            if (openDoc.uri.scheme !== 'twincat') continue;
            const query = decodeURIComponent(openDoc.uri.query || '').toLowerCase();
            if (query !== sourcePath) continue;
            chunks.push(openDoc.getText());
        }

        let combined = chunks.join('\n');
        combined = combined.replace(/\r/g, '');
        combined = combined.replace(/\b(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_GLOBAL|VAR_INST|VAR_STAT)\b[\s\S]*?\bEND_VAR\b/gi, '\n');
        combined = combined.replace(/\bTYPE\b[\s\S]*?\bEND_TYPE\b/gi, '\n');
        combined = combined.replace(/\/\/.*$/gm, '');
        combined = combined.replace(/\(\*[\s\S]*?\*\)/g, '');
        combined = combined.replace(/'([^']|'')*'/g, '');
        combined = combined.replace(/"([^"]|"")*"/g, '');

        const usage = new Set<string>();
        const regex = /\b[a-zA-Z_]\w*\b/g;
        let match;
        while ((match = regex.exec(combined)) !== null) {
            usage.add(match[0].toUpperCase());
        }
        wholePouUsageCache.set(cacheKey, usage);
        return usage;
    } catch {
        return undefined;
    }
}

function getConfiguredSeverity(settingKey: string, fallback: vscode.DiagnosticSeverity): vscode.DiagnosticSeverity {
    const config = vscode.workspace.getConfiguration('twincat');
    const profile = (config.get<string>('diagnostics.profile', 'balanced') || 'balanced').toLowerCase();
    const diagKey = settingKey.replace(/^twincat\.diagnostics\./, '').replace(/^twincat\./, '');

    // Profile overrides for faster team-wide tuning.
    if (profile === 'strict') {
        const strictMap: Record<string, vscode.DiagnosticSeverity> = {
            undefinedVariables: vscode.DiagnosticSeverity.Error,
            duplicateDeclarations: vscode.DiagnosticSeverity.Error,
            typeMismatch: vscode.DiagnosticSeverity.Error,
            unusedVariables: vscode.DiagnosticSeverity.Warning
        };
        return strictMap[diagKey] ?? fallback;
    }
    if (profile === 'relaxed') {
        const relaxedMap: Record<string, vscode.DiagnosticSeverity> = {
            undefinedVariables: vscode.DiagnosticSeverity.Warning,
            duplicateDeclarations: vscode.DiagnosticSeverity.Warning,
            typeMismatch: vscode.DiagnosticSeverity.Information,
            unusedVariables: vscode.DiagnosticSeverity.Hint
        };
        return relaxedMap[diagKey] ?? fallback;
    }

    const value = config.get<string>(settingKey.replace(/^twincat\./, ''), '');
    const normalized = (value || '').toLowerCase();
    if (normalized === 'error') return vscode.DiagnosticSeverity.Error;
    if (normalized === 'warning') return vscode.DiagnosticSeverity.Warning;
    if (normalized === 'information' || normalized === 'info') return vscode.DiagnosticSeverity.Information;
    if (normalized === 'hint') return vscode.DiagnosticSeverity.Hint;
    return fallback;
}

function extractCallContext(linePrefix: string): { name: string; argIndex: number } | undefined {
    const openParenIdx = linePrefix.lastIndexOf('(');
    if (openParenIdx < 1) return undefined;
    const before = linePrefix.substring(0, openParenIdx).trimEnd();
    const fnMatch = before.match(/([A-Za-z_]\w*)$/);
    if (!fnMatch) return undefined;

    const argsText = linePrefix.substring(openParenIdx + 1);
    let depth = 0;
    let commas = 0;
    for (const ch of argsText) {
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) commas++;
    }

    return { name: fnMatch[1], argIndex: commas };
}

function findIdentifierOccurrences(text: string, identifier: string, includeCommentsStrings: boolean): number[] {
    const results: number[] = [];
    const idUpper = identifier.toUpperCase();

    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = i + 1 < text.length ? text[i + 1] : '';

        if (ch === '\n') {
            inLineComment = false;
        }

        if (!includeCommentsStrings) {
            if (!inSingle && !inDouble && !inBlockComment && ch === '/' && next === '/') {
                inLineComment = true;
                i++;
                continue;
            }
            if (!inSingle && !inDouble && !inLineComment && ch === '(' && next === '*') {
                inBlockComment = true;
                i++;
                continue;
            }
            if (inBlockComment && ch === '*' && next === ')') {
                inBlockComment = false;
                i++;
                continue;
            }
            if (inLineComment || inBlockComment) continue;

            if (!inDouble && ch === '\'') {
                if (inSingle && next === '\'') {
                    i++;
                    continue;
                }
                inSingle = !inSingle;
                continue;
            }
            if (!inSingle && ch === '"') {
                if (inDouble && next === '"') {
                    i++;
                    continue;
                }
                inDouble = !inDouble;
                continue;
            }
            if (inSingle || inDouble) continue;
        }

        if (!/[A-Za-z_]/.test(ch)) continue;
        let end = i + 1;
        while (end < text.length && /\w/.test(text[end])) end++;
        const token = text.substring(i, end);
        const prev = i > 0 ? text[i - 1] : '';
        const after = end < text.length ? text[end] : '';
        const isWordBoundaryBefore = !prev || !/\w/.test(prev);
        const isWordBoundaryAfter = !after || !/\w/.test(after);
        if (isWordBoundaryBefore && isWordBoundaryAfter && token.toUpperCase() === idUpper) {
            results.push(i);
        }
        i = end - 1;
    }

    return results;
}

function applyCreateVariableDeclarationEdit(
    document: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    name: string,
    preferredSection: string
): void {
    const sectionRegex = new RegExp(`^\\s*${escapeRegExp(preferredSection)}\\b`, 'i');
    let sectionStart: number | undefined;
    let endVarLine: number | undefined;

    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i).text;
        if (sectionStart === undefined && sectionRegex.test(line)) {
            sectionStart = i;
            continue;
        }
        if (sectionStart !== undefined && /^\s*END_VAR\b/i.test(line)) {
            endVarLine = i;
            break;
        }
    }

    if (endVarLine !== undefined) {
        edit.insert(document.uri, new vscode.Position(endVarLine, 0), `    ${name} : BOOL;\n`);
        return;
    }

    // Fallback: create VAR block after first declaration header
    let insertLine = 0;
    for (let i = 0; i < document.lineCount; i++) {
        if (/^\s*(FUNCTION_BLOCK|FUNCTION|PROGRAM|INTERFACE)\b/i.test(document.lineAt(i).text)) {
            insertLine = i + 1;
            break;
        }
    }
    const block = `\nVAR\n    ${name} : BOOL;\nEND_VAR\n`;
    edit.insert(document.uri, new vscode.Position(insertLine, 0), block);
}
