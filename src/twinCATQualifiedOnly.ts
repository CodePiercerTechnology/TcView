import * as path from 'path';

export type QualifiedOnlyUsageInfo = {
    globals: Map<string, Set<string>>;
    enums: Map<string, Set<string>>;
};

function addOwner(map: Map<string, Set<string>>, memberName: string, ownerName: string) {
    const key = memberName.trim().toUpperCase();
    const owner = ownerName.trim();
    if (!key || !owner) {
        return;
    }
    const existing = map.get(key) ?? new Set<string>();
    existing.add(owner);
    map.set(key, existing);
}

function parseVariableNames(varSection: string): string[] {
    const names: string[] = [];
    const varRegex = /(\w+)\s*:\s*(\w+)(?:\s*\(.*?\))?\s*(?::=.*?)?;/g;
    let match: RegExpExecArray | null;
    while ((match = varRegex.exec(varSection)) !== null) {
        names.push(match[1]);
    }
    return names;
}

function parseEnumMemberNames(enumBody: string): string[] {
    return enumBody
        .split(',')
        .map(segment => segment
            .replace(/\/\/.*$/gm, '')
            .replace(/\(\*[\s\S]*?\*\)/g, '')
            .trim())
        .filter(Boolean)
        .map(segment => segment.split(':=')[0].trim())
        .filter(Boolean);
}

export function extractQualifiedOnlyUsageInfo(stText: string, fallbackSourceName?: string): QualifiedOnlyUsageInfo {
    const globals = new Map<string, Set<string>>();
    const enums = new Map<string, Set<string>>();
    const qualifiedOnlyPattern = /\{attribute\s+'qualified_only'\s*\}/i;
    const analyzableText = stText
        .replace(/\/\/.*$/gm, '')
        .replace(/\(\*[\s\S]*?\*\)/g, '');

    const gvlName = stText.match(/Global Variable List:\s*([A-Za-z_]\w*)/i)?.[1]
        ?? (fallbackSourceName ? path.basename(fallbackSourceName, path.extname(fallbackSourceName)) : undefined);
    const gvlSectionMatch = analyzableText.match(/([\s\S]*?)VAR_GLOBAL(?:\s+(?:CONSTANT|INTERNAL|PUBLIC|PRIVATE|PROTECTED|FINAL|ABSTRACT|RETAIN|PERSISTENT))*\s*([\s\S]*?)END_VAR/i);
    if (gvlName && gvlSectionMatch && qualifiedOnlyPattern.test(gvlSectionMatch[1])) {
        for (const variableName of parseVariableNames(gvlSectionMatch[2])) {
            addOwner(globals, variableName, gvlName);
        }
    }

    const enumRegex = /((?:\s*\{attribute\s+'[^']+'\s*(?::=\s*'[^']*')?\}\s*\r?\n?)*)TYPE\s+([A-Za-z_]\w*)\s*:\s*([\s\S]*?)\(([\s\S]*?)\)\s*;?(?:\s*END_TYPE)?/gi;
    let enumMatch: RegExpExecArray | null;
    while ((enumMatch = enumRegex.exec(analyzableText)) !== null) {
        const leadingAttributes = enumMatch[1] ?? '';
        const typeName = enumMatch[2];
        const prefix = enumMatch[3] ?? '';
        const body = enumMatch[4] ?? '';
        if (!qualifiedOnlyPattern.test(`${leadingAttributes}\n${prefix}`)) {
            continue;
        }
        for (const memberName of parseEnumMemberNames(body)) {
            addOwner(enums, memberName, typeName);
        }
    }

    return { globals, enums };
}

export function mergeQualifiedOnlyUsageInfo(target: QualifiedOnlyUsageInfo, source: QualifiedOnlyUsageInfo): QualifiedOnlyUsageInfo {
    source.globals.forEach((owners, memberName) => {
        owners.forEach(owner => addOwner(target.globals, memberName, owner));
    });
    source.enums.forEach((owners, memberName) => {
        owners.forEach(owner => addOwner(target.enums, memberName, owner));
    });
    return target;
}
