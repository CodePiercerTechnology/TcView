import * as xml2js from 'xml2js';

type FragmentCategory = 'method' | 'property' | 'action' | 'transition';
type StructuredRoot = { node: any; kind: 'pou' | 'interface' };

const VAR_BLOCK_START_RX = /^VAR(?:_(?:INPUT|OUTPUT|IN_OUT|TEMP|GLOBAL|INST|STAT|CONSTANT|RETAIN|EXTERNAL|ACCESS|CONFIG))?\b/i;
const COMMENT_OR_BLANK_RX = /^(\/\/|\/\*|\(\*|\{.*\}\s*$)?\s*$/;

function toArray<T>(value: T | T[] | undefined): T[] {
    return Array.isArray(value) ? value : value ? [value] : [];
}

function firstNode<T>(value: T | T[] | undefined): T | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function getTextContent(value: any): string {
    if (Array.isArray(value)) return value.map(item => getTextContent(item)).filter(Boolean).join('\n');
    if (typeof value === 'string') return value;
    if (value?.ST) return getTextContent(value.ST);
    if (value && typeof value._ === 'string') return value._;
    return '';
}

function setTextField(target: any, key: string, text: string): void {
    const existing = target?.[key];
    if (typeof existing === 'string') {
        target[key] = text;
        return;
    }
    if (existing && typeof existing === 'object' && '_' in existing) {
        existing._ = text;
        return;
    }
    target[key] = text;
}

function setImplementationText(target: any, text: string): void {
    target.Implementation = target.Implementation || {};
    const existing = target.Implementation.ST;
    if (typeof existing === 'string') {
        target.Implementation.ST = text;
        return;
    }
    if (existing && typeof existing === 'object' && '_' in existing) {
        existing._ = text;
        return;
    }
    target.Implementation.ST = text;
}

function normalizeFragmentType(fragmentType: string): FragmentCategory {
    if (fragmentType === 'propertyget' || fragmentType === 'propertyset' || fragmentType === 'property') {
        return 'property';
    }
    if (fragmentType === 'action') return 'action';
    if (fragmentType === 'transition') return 'transition';
    return 'method';
}

function getElementKey(type: FragmentCategory): 'Method' | 'Property' | 'Action' | 'Transition' {
    switch (type) {
        case 'method':
            return 'Method';
        case 'property':
            return 'Property';
        case 'action':
            return 'Action';
        case 'transition':
            return 'Transition';
    }
}

function findFragmentRecursively(node: any, type: FragmentCategory, name: string): any {
    if (!node) return undefined;

    const key = getElementKey(type);
    const candidates = toArray(node[key]);
    for (const candidate of candidates) {
        if ((candidate?.Name || '').toString() === name) {
            return candidate;
        }
    }

    for (const folder of toArray(node.Folder)) {
        const found = findFragmentRecursively(folder, type, name);
        if (found) return found;
    }

    return undefined;
}

function getImplementationText(element: any): string {
    const implementation = element?.Implementation;
    if (!implementation) return '';
    if (typeof implementation === 'string') return implementation;
    return getTextContent(implementation.ST);
}

function splitDeclarationAndImplementation(
    lines: string[],
    kind: 'METHOD' | 'ACTION' | 'TRANSITION' | 'GET' | 'SET'
): { declaration: string; implementation: string } {
    let start = 0;
    while (start < lines.length && !lines[start].trim()) start++;
    if (start >= lines.length) {
        return { declaration: kind, implementation: '' };
    }

    let declarationEnd = start;
    let index = start + 1;
    let inVarBlock = false;

    while (index < lines.length) {
        const text = lines[index].trim();

        if (VAR_BLOCK_START_RX.test(text)) {
            inVarBlock = true;
            declarationEnd = index;
            index++;
            continue;
        }

        if (inVarBlock) {
            declarationEnd = index;
            if (/^END_VAR\b/i.test(text)) {
                inVarBlock = false;
            }
            index++;
            continue;
        }

        if (COMMENT_OR_BLANK_RX.test(text)) {
            declarationEnd = index;
            index++;
            continue;
        }

        break;
    }

    let declaration = lines.slice(start, declarationEnd + 1).join('\n').trim();
    if (!new RegExp(`^${kind}\\b`, 'i').test(lines[start].trim())) {
        declaration = `${kind}\n${declaration}`.trim();
    }

    const implementation = lines.slice(declarationEnd + 1).join('\n').trim();
    return { declaration, implementation };
}

function getStructuredRoot(xmlObj: any): StructuredRoot | undefined {
    const pou = xmlObj.TcPOU ?? xmlObj.TcPlcObject?.POU;
    if (pou) {
        return { node: pou, kind: 'pou' };
    }

    const itf =
        xmlObj.TcITF ??
        xmlObj.TcItf ??
        xmlObj.TcIO ??
        xmlObj.TcPlcObject?.ITF ??
        xmlObj.TcPlcObject?.Itf ??
        xmlObj.TcPlcObject?.TcITF ??
        xmlObj.TcPlcObject?.TcItf ??
        xmlObj.TcPlcObject?.TcIO;
    if (itf) {
        return { node: itf, kind: 'interface' };
    }

    return undefined;
}

function isInterfaceAccessorFragment(rootKind: 'pou' | 'interface', fragmentType: string): boolean {
    return rootKind === 'interface' && (fragmentType === 'propertyget' || fragmentType === 'propertyset');
}

function buildMethodLikeFragment(
    kind: 'METHOD' | 'ACTION' | 'TRANSITION',
    name: string,
    element: any,
    declarationOnly = false
): string {
    const declaration = getTextContent(element?.Declaration).trim();
    const implementation = getImplementationText(element).trim();
    const header = declaration || [kind, name].join(' ');
    if (declarationOnly) {
        return header.trim() + '\n';
    }
    const parts: string[] = [header];
    if (implementation) parts.push(implementation);
    return parts.join('\n\n').trim() + '\n';
}

function buildPropertyAccessor(kind: 'GET' | 'SET', accessor: any): string {
    const resolvedAccessor = firstNode(accessor);
    if (!resolvedAccessor) return '';

    const declaration = getTextContent(resolvedAccessor?.Declaration).trim();
    const implementation = getImplementationText(resolvedAccessor).trim();
    if (!declaration && !implementation) return '';

    const header = declaration
        ? (new RegExp(`^${kind}\\b`, 'i').test(declaration) ? declaration : `${kind}\n${declaration}`)
        : kind;
    const parts: string[] = [header.trim()];
    if (implementation) parts.push(implementation);
    return parts.join('\n\n').trim();
}

function buildPropertyFragment(name: string, element: any): string {
    const declaration = getTextContent(element?.Declaration).trim();
    const header = declaration && /\bPROPERTY\b/i.test(declaration) ? declaration : `PROPERTY ${name}`;
    return header.trim() + '\n';
}

function buildSinglePropertyAccessorFragment(name: string, element: any, kind: 'GET' | 'SET', rootKind: 'pou' | 'interface'): string {
    const accessor = kind === 'GET' ? element?.Get : element?.Set;
    const accessorSection = buildPropertyAccessor(kind, accessor);
    if (!accessorSection) return `${kind}\n`;
    if (rootKind === 'interface') {
        return accessorSection.trim() + '\n';
    }

    const declaration = getTextContent(element?.Declaration).trim();
    const header = declaration && /\bPROPERTY\b/i.test(declaration) ? declaration : `PROPERTY ${name}`;
    return [header, accessorSection, 'END_PROPERTY'].join('\n\n').trim() + '\n';
}

function buildFragmentST(type: string, name: string, element: any, rootKind: 'pou' | 'interface'): string {
    switch (type) {
        case 'method':
            return buildMethodLikeFragment('METHOD', name, element, rootKind === 'interface');
        case 'action':
            return buildMethodLikeFragment('ACTION', name, element);
        case 'transition':
            return buildMethodLikeFragment('TRANSITION', name, element);
        case 'propertyget':
            return buildSinglePropertyAccessorFragment(name, element, 'GET', rootKind);
        case 'propertyset':
            return buildSinglePropertyAccessorFragment(name, element, 'SET', rootKind);
        case 'property':
            return buildPropertyFragment(name, element);
        default:
            return buildMethodLikeFragment('METHOD', name, element, rootKind === 'interface');
    }
}

function applyMethodLikeSt(
    kind: 'METHOD' | 'ACTION' | 'TRANSITION',
    element: any,
    stCode: string,
    declarationOnly = false
): void {
    const lines = stCode.replace(/\r/g, '').split('\n');
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.every(line => !line.trim())) return;

    const split = splitDeclarationAndImplementation(lines, kind);
    setTextField(element, 'Declaration', split.declaration);

    if (!declarationOnly && (split.implementation || element?.Implementation)) {
        setImplementationText(element, split.implementation);
    }
}

function applyPropertySectionsFromLines(element: any, lines: string[], onlyKind?: 'GET' | 'SET'): void {
    const findIndex = (rx: RegExp, from: number) => {
        for (let i = from; i < lines.length; i++) {
            if (rx.test(lines[i].trim())) return i;
        }
        return -1;
    };
    const getIndex = findIndex(/^GET\b/i, 0);
    const setIndex = findIndex(/^SET\b/i, 0);
    const endIndex = findIndex(/^END_PROPERTY\b/i, 0);
    const endBound = endIndex >= 0 ? endIndex : lines.length;

    const applyAccessor = (kind: 'GET' | 'SET', start: number, stop: number) => {
        const accessor = kind === 'GET'
            ? (element.Get = element.Get || {})
            : (element.Set = element.Set || {});
        const split = splitDeclarationAndImplementation(lines.slice(start, stop), kind);
        setTextField(accessor, 'Declaration', split.declaration);
        if (split.implementation || accessor?.Implementation) {
            setImplementationText(accessor, split.implementation);
        }
    };

    if ((!onlyKind || onlyKind === 'GET') && getIndex >= 0) {
        const stop = [setIndex, endBound].filter(v => v >= 0 && v > getIndex).sort((a, b) => a - b)[0] ?? endBound;
        applyAccessor('GET', getIndex, stop);
    }
    if ((!onlyKind || onlyKind === 'SET') && setIndex >= 0) {
        const stop = [endBound].filter(v => v >= 0 && v > setIndex)[0] ?? lines.length;
        applyAccessor('SET', setIndex, stop);
    }
}

function applyPropertySt(element: any, stCode: string): void {
    const declaration = stCode.replace(/\r/g, '').trim();
    if (!declaration) {
        return;
    }

    setTextField(element, 'Declaration', declaration);
}

function applySinglePropertyAccessorSt(kind: 'GET' | 'SET', element: any, stCode: string, rootKind: 'pou' | 'interface'): void {
    const lines = stCode.replace(/\r/g, '').split('\n');
    let index = 0;
    while (index < lines.length && !lines[index].trim()) index++;

    if (rootKind === 'pou' && index < lines.length && /^PROPERTY\b/i.test(lines[index].trim())) {
        setTextField(element, 'Declaration', lines[index].trim());
        index++;
    }
    applyPropertySectionsFromLines(element, lines.slice(index), kind);

    if (rootKind === 'interface') {
        const accessor = kind === 'GET' ? element?.Get : element?.Set;
        if (accessor?.Implementation) {
            setImplementationText(accessor, '');
        }
    }
}

function applyStToFragmentElement(fragmentType: string, element: any, stCode: string, rootKind: 'pou' | 'interface'): void {
    switch (fragmentType) {
        case 'method':
            applyMethodLikeSt('METHOD', element, stCode, rootKind === 'interface');
            break;
        case 'action':
            applyMethodLikeSt('ACTION', element, stCode);
            break;
        case 'transition':
            applyMethodLikeSt('TRANSITION', element, stCode);
            break;
        case 'property':
            applyPropertySt(element, stCode);
            break;
        case 'propertyget':
            applySinglePropertyAccessorSt('GET', element, stCode, rootKind);
            break;
        case 'propertyset':
            applySinglePropertyAccessorSt('SET', element, stCode, rootKind);
            break;
        default:
            applyMethodLikeSt('METHOD', element, stCode, rootKind === 'interface');
            break;
    }
}

export async function extractFragmentSTFromXml(xmlString: string, fragment: string): Promise<string> {
    const [rawType, ...nameParts] = fragment.split(':');
    const fragmentType = rawType?.toLowerCase();
    const fragmentName = nameParts.join(':').trim();

    if (!fragmentType || !fragmentName) {
        return '// Invalid fragment identifier.\n';
    }

    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    const xmlObj = await parser.parseStringPromise(xmlString);
    const root = getStructuredRoot(xmlObj);
    if (!root) return '// Fragment view is only supported for POU and interface files.\n';

    const normalizedType = normalizeFragmentType(fragmentType);
    if (isInterfaceAccessorFragment(root.kind, fragmentType)) {
        return '// Interface property GET/SET entries are tree-only and cannot be opened.\n';
    }

    const element = findFragmentRecursively(root.node, normalizedType, fragmentName);
    if (!element) return `// Fragment not found: ${rawType}:${fragmentName}\n`;
    return buildFragmentST(fragmentType, fragmentName, element, root.kind);
}

export async function applyFragmentSTToXml(xmlString: string, fragment: string, stCode: string): Promise<string> {
    const [rawType, ...nameParts] = fragment.split(':');
    const fragmentType = (rawType || '').toLowerCase();
    const fragmentName = nameParts.join(':').trim();
    if (!fragmentType || !fragmentName) {
        throw new Error('Invalid fragment identifier.');
    }

    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    const builder = new xml2js.Builder({
        headless: true,
        cdata: true,
        renderOpts: { pretty: true, indent: '  ', newline: '\n' }
    });
    const xmlObj = await parser.parseStringPromise(xmlString);
    const root = getStructuredRoot(xmlObj);
    if (!root) throw new Error('Fragment save is only supported for POU and interface files.');

    if (isInterfaceAccessorFragment(root.kind, fragmentType)) {
        throw new Error('Interface property GET/SET entries are tree-only and cannot be edited.');
    }

    const normalizedType = normalizeFragmentType(fragmentType);
    const element = findFragmentRecursively(root.node, normalizedType, fragmentName);
    if (!element) throw new Error(`Fragment not found: ${rawType}:${fragmentName}`);

    applyStToFragmentElement(fragmentType, element, stCode, root.kind);
    const rebuilt = builder.buildObject(xmlObj);
    const withPreservedCData = preserveOriginalCDataWrappers(rebuilt, xmlString);
    return prependOriginalXmlDeclaration(withPreservedCData, xmlString);
}

function prependOriginalXmlDeclaration(xml: string, originalXml: string): string {
    const match = originalXml.match(/^\uFEFF?\s*(<\?xml[\s\S]*?\?>)/i);
    if (!match) {
        return xml;
    }

    const declaration = match[1].trim();
    const body = xml.replace(/^\uFEFF?\s*/, '');
    return `${declaration}\n${body}`;
}

function preserveOriginalCDataWrappers(xml: string, originalXml: string): string {
    let output = xml;
    for (const tagName of ['Declaration', 'ST']) {
        if (!originalUsesCDataForTag(originalXml, tagName)) {
            continue;
        }
        output = forceTagContentToCData(output, tagName);
    }
    return output;
}

function originalUsesCDataForTag(xml: string, tagName: string): boolean {
    const pattern = new RegExp(`<${tagName}\\b[^>]*>\\s*<!\\[CDATA\\[`, 'i');
    return pattern.test(xml);
}

function forceTagContentToCData(xml: string, tagName: string): string {
    const pattern = new RegExp(`<${tagName}(\\b[^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'g');
    return xml.replace(pattern, (full: string, attrs: string, inner: string) => {
        if (inner.trimStart().startsWith('<![CDATA[')) {
            return full;
        }
        if (/<[A-Za-z_]/.test(inner)) {
            return full;
        }

        const decoded = decodeXmlEntities(inner);
        const safe = decoded.replace(/]]>/g, ']]]]><![CDATA[>');
        return `<${tagName}${attrs}><![CDATA[${safe}]]></${tagName}>`;
    });
}

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&amp;/g, '&');
}

