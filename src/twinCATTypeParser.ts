export interface ParsedTwinCATTypeDeclaration {
    name: string;
    kind: 'struct' | 'enum' | 'alias';
    members: Map<string, string>;
    aliasTarget?: string;
}

function parseStructMembers(structBody: string): Map<string, string> {
    const members = new Map<string, string>();
    const memberRegex = /([A-Za-z_]\w*)\s*:\s*([^;]+);/g;
    let match: RegExpExecArray | null;
    while ((match = memberRegex.exec(structBody)) !== null) {
        members.set(match[1], match[2].trim());
    }
    return members;
}

function parseEnumMembers(enumBody: string): Map<string, string> {
    const members = new Map<string, string>();
    for (const rawSegment of enumBody.split(',')) {
        const segment = rawSegment
            .replace(/\/\/.*$/gm, '')
            .replace(/\(\*[\s\S]*?\*\)/g, '')
            .trim();
        if (!segment) {
            continue;
        }
        const memberName = segment.split(':=')[0].trim();
        if (memberName) {
            members.set(memberName, 'INT');
        }
    }
    return members;
}

export function parseTwinCATTypeDeclarations(stText: string): ParsedTwinCATTypeDeclaration[] {
    const declarations: ParsedTwinCATTypeDeclaration[] = [];
    const typeBlockRegex = /TYPE\s+([A-Za-z_]\w*)\s*:\s*([\s\S]*?)END_TYPE/gi;
    let match: RegExpExecArray | null;

    while ((match = typeBlockRegex.exec(stText)) !== null) {
        const typeName = match[1];
        const body = (match[2] ?? '').trim();
        const structMatch = body.match(/STRUCT\s*([\s\S]*?)END_STRUCT/i);
        if (structMatch) {
            declarations.push({
                name: typeName,
                kind: 'struct',
                members: parseStructMembers(structMatch[1] ?? '')
            });
            continue;
        }

        const enumMatch = body.match(/\(([\s\S]*?)\)\s*;?\s*$/);
        if (enumMatch) {
            declarations.push({
                name: typeName,
                kind: 'enum',
                members: parseEnumMembers(enumMatch[1] ?? '')
            });
            continue;
        }

        const aliasMatch = body.match(/(?:\{[\s\S]*?\}\s*)*([A-Za-z_]\w*(?:\s*\([^)]*\))?)\s*;?\s*$/);
        declarations.push({
            name: typeName,
            kind: 'alias',
            members: new Map<string, string>(),
            aliasTarget: aliasMatch?.[1]?.trim()
        });
    }

    return declarations;
}
