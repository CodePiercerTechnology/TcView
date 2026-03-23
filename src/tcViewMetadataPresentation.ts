import type { TwinCATMetadataSource } from './tcViewTypes';

export type TwinCATProvenance = 'project' | TwinCATMetadataSource;

export interface TwinCATMetadataPresentationInfo {
    source?: string;
    library?: string;
    provenance?: TwinCATProvenance;
    documentation?: string;
}

export function formatTwinCATProvenanceLabel(provenance?: TwinCATProvenance): string | undefined {
    switch (provenance) {
        case 'project':
            return 'Project source';
        case 'system_global':
            return 'System global';
        case 'built_in':
            return 'Built-in catalog';
        case 'managed_libraries':
            return 'Managed Libraries';
        case 'plcproj':
            return 'PLC project';
        case 'tmc':
            return 'TMC';
        case 'user':
            return 'User metadata';
        default:
            return provenance;
    }
}

export function buildTwinCATMetadataSummarySegments(info: TwinCATMetadataPresentationInfo): string[] {
    const segments: string[] = [];
    if (info.library) {
        segments.push(info.library);
    }
    const provenanceLabel = formatTwinCATProvenanceLabel(info.provenance);
    if (provenanceLabel) {
        segments.push(provenanceLabel);
    }
    return segments;
}

export function buildTwinCATMetadataMarkdown(info: TwinCATMetadataPresentationInfo): string | undefined {
    const sections: string[] = [];
    const documentation = info.documentation?.trim();
    if (documentation) {
        sections.push(documentation);
    }
    if (info.library) {
        sections.push(`Library: \`${info.library}\``);
    }
    const provenanceLabel = formatTwinCATProvenanceLabel(info.provenance);
    if (provenanceLabel) {
        sections.push(`Origin: ${provenanceLabel}`);
    }
    if (info.source) {
        sections.push(`Defined in: \`${info.source}\``);
    }
    return sections.length > 0 ? sections.join('\n\n') : undefined;
}
