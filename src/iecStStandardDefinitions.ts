import * as fs from 'fs';
import * as path from 'path';

export interface IECStandardDefinition {
    label?: string;
    kind: 'functionBlock' | 'function' | 'type' | 'constant';
    summary: string;
    members?: Array<{ name: string; type: string; description: string }>;
    parameters?: Array<{ name: string; type: string; direction: 'IN' | 'OUT' | 'IN_OUT'; description: string }>;
    example?: string;
}

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

function augmentStandardDefinitionsFromBundledLibraryMetadata(): void {
    const assignDefinition = (name: string, definition: IECStandardDefinition) => {
        const key = name.toUpperCase();
        if (!name || standardIecDefinitions[key]) {
            return;
        }
        standardIecDefinitions[key] = {
            ...definition,
            label: definition.label ?? name
        };
    };

    try {
        const metadataPath = path.resolve(__dirname, '..', 'resources', 'library-metadata.json');
        const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
            libraries?: Array<{
                functionBlocks?: Array<{ name?: string; documentation?: string; members?: Record<string, string> }>;
                functions?: Array<{ name?: string; documentation?: string; returnType?: string }>;
                variables?: Array<{ name?: string; documentation?: string; type?: string }>;
                dataTypes?: Array<{ name?: string; documentation?: string; members?: Record<string, string> }>;
            }>;
        };

        for (const library of raw.libraries ?? []) {
            for (const item of library.functionBlocks ?? []) {
                const name = item.name?.trim();
                assignDefinition(name ?? '', {
                    kind: 'functionBlock',
                    summary: item.documentation ?? `Bundled library function block: ${name}`,
                    members: Object.entries(item.members ?? {}).map(([memberName, type]) => ({
                        name: memberName,
                        type,
                        description: ''
                    }))
                });
            }

            for (const item of library.functions ?? []) {
                const name = item.name?.trim();
                assignDefinition(name ?? '', {
                    kind: 'function',
                    summary: item.returnType
                        ? `${item.documentation ?? 'Bundled library function.'} Returns ${item.returnType}.`
                        : item.documentation ?? `Bundled library function: ${name}`
                });
            }

            for (const item of library.dataTypes ?? []) {
                const name = item.name?.trim();
                assignDefinition(name ?? '', {
                    kind: 'type',
                    summary: item.documentation ?? `Bundled library data type: ${name}`,
                    members: Object.entries(item.members ?? {}).map(([memberName, type]) => ({
                        name: memberName,
                        type,
                        description: ''
                    }))
                });
            }

            for (const item of library.variables ?? []) {
                const name = item.name?.trim();
                assignDefinition(name ?? '', {
                    kind: 'constant',
                    summary: item.type
                        ? `${item.documentation ?? 'Bundled library global.'} Type: ${item.type}.`
                        : item.documentation ?? `Bundled library global: ${name}`
                });
            }
        }
    } catch {
        // Fall back to the handwritten core definitions if the bundled catalog cannot be read.
    }
}

augmentStandardDefinitionsFromBundledLibraryMetadata();

const stdSymbolSet = new Set(Object.keys(standardIecDefinitions).map(name => name.toUpperCase()));

export function isKnownStandardIecIdentifier(value: string): boolean {
    return stdSymbolSet.has(value.toUpperCase());
}

export function getKnownStandardDefinition(name: string): IECStandardDefinition | undefined {
    const definition = standardIecDefinitions[name.toUpperCase()];
    if (!definition) {
        return undefined;
    }
    return {
        ...definition,
        members: definition.members?.map(member => ({ ...member })),
        parameters: definition.parameters?.map(parameter => ({ ...parameter }))
    };
}

export function getKnownFbMembers(typeName: string): string[] {

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
    const standardMembers = standardIecDefinitions[typeName.toUpperCase()]?.members?.map(m => m.name) ?? [];
    return [...new Set([...(fbMembers[typeName] ?? []), ...standardMembers])];

}

export { standardIecDefinitions };
