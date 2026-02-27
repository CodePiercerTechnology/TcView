import * as xml2js from 'xml2js';

type FragmentCategory = 'method' | 'property' | 'action' | 'transition';

function toArray<T>(value: T | T[] | undefined): T[] {
    return Array.isArray(value) ? value : value ? [value] : [];
}

function getTextContent(value: any): string {
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

function buildMethodLikeFragment(kind: 'METHOD' | 'ACTION' | 'TRANSITION', name: string, element: any): string {
    const declaration = getTextContent(element?.Declaration).trim();
    const implementation = getImplementationText(element).trim();
    const header = declaration || [kind, name].join(' ');
    const parts: string[] = [header];
    if (implementation) parts.push(implementation);
    return parts.join('\n\n').trim() + '\n';
}

function buildPropertyAccessor(kind: 'GET' | 'SET', accessor: any): string {
    if (!accessor) return '';
    const declaration = getTextContent(accessor?.Declaration).trim();
    const implementation = getImplementationText(accessor).trim();
    const header = declaration && new RegExp(`\\b${kind}\\b`, 'i').test(declaration) ? declaration : kind;
    const parts: string[] = [header];
    if (implementation) parts.push(implementation);
    return parts.join('\n\n').trim();
}

function buildPropertyFragment(name: string, element: any): string {
    const declaration = getTextContent(element?.Declaration).trim();
    const header = declaration && /\bPROPERTY\b/i.test(declaration) ? declaration : `PROPERTY ${name}`;
    const parts: string[] = [header];
    const getSection = buildPropertyAccessor('GET', element?.Get);
    const setSection = buildPropertyAccessor('SET', element?.Set);
    if (getSection) parts.push(getSection);
    if (setSection) parts.push(setSection);
    if (getSection || setSection) parts.push('END_PROPERTY');
    return parts.join('\n\n').trim() + '\n';
}

function buildSinglePropertyAccessorFragment(name: string, element: any, kind: 'GET' | 'SET'): string {
    const declaration = getTextContent(element?.Declaration).trim();
    const header = declaration && /\bPROPERTY\b/i.test(declaration) ? declaration : `PROPERTY ${name}`;
    const accessor = kind === 'GET' ? element?.Get : element?.Set;
    const accessorSection = buildPropertyAccessor(kind, accessor);
    if (!accessorSection) return `${header}\n\n// ${kind} accessor not found.\n`;
    return [header, accessorSection, 'END_PROPERTY'].join('\n\n').trim() + '\n';
}

function buildFragmentST(type: string, name: string, element: any): string {
    switch (type) {
        case 'method':
            return buildMethodLikeFragment('METHOD', name, element);
        case 'action':
            return buildMethodLikeFragment('ACTION', name, element);
        case 'transition':
            return buildMethodLikeFragment('TRANSITION', name, element);
        case 'propertyget':
            return buildSinglePropertyAccessorFragment(name, element, 'GET');
        case 'propertyset':
            return buildSinglePropertyAccessorFragment(name, element, 'SET');
        case 'property':
            return buildPropertyFragment(name, element);
        default:
            return buildMethodLikeFragment('METHOD', name, element);
    }
}

function applyMethodLikeSt(kind: 'METHOD' | 'ACTION' | 'TRANSITION', element: any, stCode: string): void {
    const lines = stCode.replace(/\r/g, '').split('\n');
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

    let firstNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) {
            firstNonEmpty = i;
            break;
        }
    }
    if (firstNonEmpty < 0) return;

    const headerLine = lines[firstNonEmpty].trim();
    const defaultName = (element?.Name || '').toString().trim();
    const fallbackHeader = `${kind}${defaultName ? ` ${defaultName}` : ''}`;
    const declaration = new RegExp(`^${kind}\\b`, 'i').test(headerLine) ? headerLine : fallbackHeader;
    setTextField(element, 'Declaration', declaration);

    const body = lines.slice(firstNonEmpty + 1).join('\n').trim();
    setImplementationText(element, body);
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
        const declLine = lines[start]?.trim() || kind;
        setTextField(accessor, 'Declaration', new RegExp(`^${kind}\\b`, 'i').test(declLine) ? declLine : kind);
        const impl = lines.slice(start + 1, stop).join('\n').trim();
        setImplementationText(accessor, impl);
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
    const lines = stCode.replace(/\r/g, '').split('\n');
    let index = 0;
    while (index < lines.length && !lines[index].trim()) index++;

    if (index < lines.length && /^PROPERTY\b/i.test(lines[index].trim())) {
        setTextField(element, 'Declaration', lines[index].trim());
        index++;
    }
    applyPropertySectionsFromLines(element, lines.slice(index));
}

function applySinglePropertyAccessorSt(kind: 'GET' | 'SET', element: any, stCode: string): void {
    const lines = stCode.replace(/\r/g, '').split('\n');
    let index = 0;
    while (index < lines.length && !lines[index].trim()) index++;

    if (index < lines.length && /^PROPERTY\b/i.test(lines[index].trim())) {
        setTextField(element, 'Declaration', lines[index].trim());
        index++;
    }
    applyPropertySectionsFromLines(element, lines.slice(index), kind);
}

function applyStToFragmentElement(fragmentType: string, element: any, stCode: string): void {
    switch (fragmentType) {
        case 'method':
            applyMethodLikeSt('METHOD', element, stCode);
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
            applySinglePropertyAccessorSt('GET', element, stCode);
            break;
        case 'propertyset':
            applySinglePropertyAccessorSt('SET', element, stCode);
            break;
        default:
            applyMethodLikeSt('METHOD', element, stCode);
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
    const pou = xmlObj.TcPOU ?? xmlObj.TcPlcObject?.POU;
    if (!pou) return '// Fragment view is only supported for POU files.\n';

    const normalizedType = normalizeFragmentType(fragmentType);
    const element = findFragmentRecursively(pou, normalizedType, fragmentName);
    if (!element) return `// Fragment not found: ${rawType}:${fragmentName}\n`;
    return buildFragmentST(fragmentType, fragmentName, element);
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
        renderOpts: { pretty: true, indent: '  ', newline: '\n' }
    });
    const xmlObj = await parser.parseStringPromise(xmlString);
    const pou = xmlObj.TcPOU ?? xmlObj.TcPlcObject?.POU;
    if (!pou) throw new Error('Fragment save is only supported for POU files.');

    const normalizedType = normalizeFragmentType(fragmentType);
    const element = findFragmentRecursively(pou, normalizedType, fragmentName);
    if (!element) throw new Error(`Fragment not found: ${rawType}:${fragmentName}`);

    applyStToFragmentElement(fragmentType, element, stCode);
    return builder.buildObject(xmlObj);
}

