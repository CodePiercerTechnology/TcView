export type PerfWebviewNode = {
    id: string;
    label: string;
    description?: string;
    tooltip?: string;
    itemType: string;
    collapsible: boolean;
    openable: boolean;
    severity: 'error' | 'warning' | 'none';
    iconClass: string;
    iconColorClass: string;
    errorCount: number;
    warningCount: number;
    scmBadge?: string;
    scmTooltip?: string;
    isCut?: boolean;
    children?: PerfWebviewNode[];
    fileKind?: string;
};

export type SyntheticWebviewPerfResult = {
    elapsedMs: number;
    structureElapsedMs: number;
    stateElapsedMs: number;
    nodeCount: number;
    statePasses: number;
    structureKeyBytes: number;
    stateKeyBytes: number;
};

export function createWebviewStructureKey(nodes: PerfWebviewNode[]): string {
    const encode = (entries: PerfWebviewNode[]): unknown[] => entries.map(node => ({
        id: node.id,
        label: node.label,
        description: node.description,
        tooltip: node.tooltip,
        itemType: node.itemType,
        collapsible: node.collapsible,
        openable: node.openable,
        iconClass: node.iconClass,
        iconColorClass: node.iconColorClass,
        children: node.children ? encode(node.children) : []
    }));
    return JSON.stringify(encode(nodes));
}

export function createWebviewStateKey(nodes: PerfWebviewNode[]): string {
    const encode = (entries: PerfWebviewNode[]): unknown[] => entries.map(node => ({
        id: node.id,
        label: node.label,
        description: node.description,
        tooltip: node.tooltip,
        severity: node.severity,
        errorCount: node.errorCount,
        warningCount: node.warningCount,
        scmBadge: node.scmBadge,
        scmTooltip: node.scmTooltip,
        isCut: node.isCut,
        children: node.children ? encode(node.children) : []
    }));
    return JSON.stringify(encode(nodes));
}

function createSyntheticNode(id: string, depth: number, childIndex: number, maxDepth: number, breadth: number): PerfWebviewNode {
    const severity = childIndex % 11 === 0 ? 'error' : childIndex % 5 === 0 ? 'warning' : 'none';
    const scmBadge = childIndex % 7 === 0 ? 'M' : childIndex % 13 === 0 ? 'U' : undefined;
    const node: PerfWebviewNode = {
        id,
        label: `Node_${depth}_${childIndex}`,
        description: depth % 2 === 0 ? `D${depth}` : undefined,
        tooltip: `Synthetic node ${id}`,
        itemType: depth === 0 ? 'plcProjectFolder' : depth % 3 === 0 ? 'folder' : 'file',
        collapsible: depth < maxDepth,
        openable: depth > 0,
        severity,
        iconClass: depth % 3 === 0 ? 'codicon-folder' : 'codicon-file-code',
        iconColorClass: depth % 3 === 0 ? 'color-folder' : 'color-file',
        errorCount: severity === 'error' ? 1 : 0,
        warningCount: severity === 'warning' ? 1 : 0,
        scmBadge,
        scmTooltip: scmBadge ? `Synthetic SCM ${scmBadge}` : undefined,
        isCut: false,
        fileKind: depth % 4 === 0 ? 'functionBlock' : depth % 4 === 1 ? 'program' : depth % 4 === 2 ? 'gvl' : 'dut'
    };

    if (depth >= maxDepth) {
        return node;
    }

    node.children = [];
    for (let i = 0; i < breadth; i += 1) {
        node.children.push(createSyntheticNode(`${id}/${i}`, depth + 1, i, maxDepth, breadth));
    }
    return node;
}

export function buildSyntheticWebviewTree(rootCount = 3, depth = 4, breadth = 5): PerfWebviewNode[] {
    const roots: PerfWebviewNode[] = [];
    for (let i = 0; i < rootCount; i += 1) {
        roots.push(createSyntheticNode(`root-${i}`, 0, i, depth, breadth));
    }
    return roots;
}

export function countSyntheticNodes(nodes: PerfWebviewNode[]): number {
    return nodes.reduce((count, node) => count + 1 + countSyntheticNodes(node.children || []), 0);
}

function mutateSyntheticState(nodes: PerfWebviewNode[], pass: number): PerfWebviewNode[] {
    return nodes.map((node, index) => {
        const severity = (index + pass) % 9 === 0 ? 'error' : (index + pass) % 4 === 0 ? 'warning' : 'none';
        const scmBadge = (index + pass) % 6 === 0 ? 'M' : (index + pass) % 10 === 0 ? 'U' : undefined;
        return {
            ...node,
            severity,
            errorCount: severity === 'error' ? 1 : 0,
            warningCount: severity === 'warning' ? 1 : 0,
            scmBadge,
            scmTooltip: scmBadge ? `Synthetic SCM ${scmBadge}` : undefined,
            isCut: pass % 8 === 0 && index === 0,
            children: node.children ? mutateSyntheticState(node.children, pass + 1) : undefined
        };
    });
}

export function runSyntheticWebviewExplorerPerf(options?: {
    rootCount?: number;
    depth?: number;
    breadth?: number;
    statePasses?: number;
}): SyntheticWebviewPerfResult {
    const rootCount = options?.rootCount ?? 3;
    const depth = options?.depth ?? 4;
    const breadth = options?.breadth ?? 5;
    const statePasses = options?.statePasses ?? 24;

    const roots = buildSyntheticWebviewTree(rootCount, depth, breadth);
    const started = Date.now();

    const structureStarted = Date.now();
    const structureKey = createWebviewStructureKey(roots);
    const structureElapsedMs = Date.now() - structureStarted;

    let stateKey = '';
    const stateStarted = Date.now();
    for (let pass = 0; pass < statePasses; pass += 1) {
        const mutated = mutateSyntheticState(roots, pass);
        stateKey = createWebviewStateKey(mutated);
    }
    const stateElapsedMs = Date.now() - stateStarted;

    return {
        elapsedMs: Date.now() - started,
        structureElapsedMs,
        stateElapsedMs,
        nodeCount: countSyntheticNodes(roots),
        statePasses,
        structureKeyBytes: Buffer.byteLength(structureKey, 'utf8'),
        stateKeyBytes: Buffer.byteLength(stateKey, 'utf8')
    };
}
