export type TwinCATLibraryMode = 'metadata_only' | 'public_symbols' | 'full_source';

export interface TwinCATLibraryRef {
    name: string;
    version: string;
    vendor?: string;
    path: string;
    mode: TwinCATLibraryMode;
}
