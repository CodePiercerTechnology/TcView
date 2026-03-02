export type TwinCATLibraryMode = 'metadata_only' | 'public_symbols' | 'full_source';

export interface TwinCATLibraryRef {
    name: string;
    version: string;
    vendor?: string;
    path: string;
    mode: TwinCATLibraryMode;
    installPath?: string;
    dependencies?: string[];
    metadataSource?: 'plcproj' | 'managed_libraries' | 'tmc' | 'built_in' | 'user';
    infoUrl?: string;
}
