export type TwinCATLibraryMode = 'metadata_only' | 'public_symbols' | 'full_source';

export interface TwinCATLibraryRef {
    name: string;
    version: string;
    vendor?: string;
    path: string;
    mode: TwinCATLibraryMode;
}

export interface TwinCATBackendSymbol {
    id: string;
    name: string;
    kind: 'function_block' | 'function' | 'type' | 'variable';
    signature?: string;
    documentation?: string;
    origin: 'ai' | 'tmc' | 'source' | 'library_public' | 'library_meta';
    library?: string;
    version?: string;
    confidence: 'high' | 'medium' | 'low';
}

export interface TwinCATScanResult {
    libraries: TwinCATLibraryRef[];
    symbols: TwinCATBackendSymbol[];
    librarySymbols: TwinCATBackendSymbol[];
    diagnostics: string[];
}
