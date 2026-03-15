export type TcviewLintPragmaState = {
    disabledByLine: Map<number, Set<string>>;
    inlineIgnoresByLine: Map<number, Set<string>>;
};

const tcviewLintRulesPattern = '([A-Za-z0-9_\\-*,\\s]+)';
const tcviewLintDisablePattern = new RegExp(`^\\{\\s*tcview\\s+lint-disable\\s+${tcviewLintRulesPattern}\\s*\\}$`, 'i');
const tcviewLintEnablePattern = new RegExp(`^\\{\\s*tcview\\s+lint-enable\\s+${tcviewLintRulesPattern}\\s*\\}$`, 'i');
const tcviewLintIgnorePattern = new RegExp(`\\/\\/\\s*tcview\\s+lint-ignore\\s+${tcviewLintRulesPattern}`, 'ig');
const beckhoffAnalysisPragmaPattern = /^\{\s*analysis\s+([^}]+)\}$/i;
const beckhoffAnalysisAttributePattern = /^\{\s*attribute\s+'analysis'\s*:=\s*'([^']+)'\s*\}$/i;
const beckhoffNoAnalysisPattern = /^\{\s*attribute\s+'no-analysis'\s*\}$/i;
const beckhoffWarningPattern = /^\{\s*warning\s+(disable|restore)\s+([A-Z]\d+)\s*\}$/i;
const beckhoffSuppressWarningAttributePattern = /^\{\s*attribute\s+'suppress_wrn_[A-Za-z0-9_]+'\s*\}$/i;
const beckhoffObjectHeaderPattern = /^\s*(FUNCTION_BLOCK|FUNCTION|PROGRAM|METHOD|PROPERTY|ACTION|TRANSITION|INTERFACE|TYPE|VAR_GLOBAL)\b/i;
const nonCodeLinePattern = /^\s*(?:$|\/\/|\/\*|\(\*|\{)/;

const tcviewRuleAliases = new Map<string, string>([
    ['all', '*'],
    ['*', '*'],
    ['unused-variable', 'unused-instance'],
    ['unused-instance', 'unused-instance'],
    ['undefined-variable', 'undefined-variable'],
    ['undefined-symbol', 'undefined-variable'],
    ['qualified-only', 'qualified-only'],
    ['qualified-only-access', 'qualified-only'],
    ['duplicate-declaration', 'duplicate-declaration'],
    ['type-mismatch', 'type-mismatch'],
    ['unknown-type', 'unknown-type'],
    ['unresolved-type', 'unknown-type']
]);

const beckhoffStaticAnalysisRuleMap = new Map<string, string[]>([
    ['33', ['unused-instance']],
    ['35', ['unused-instance']],
    ['36', ['unused-instance']]
]);

function normalizeTcviewRule(rule: string): string | undefined {
    return tcviewRuleAliases.get(rule.trim().toLowerCase());
}

function parseTcviewRuleList(raw: string): string[] {
    return [...new Set(raw
        .split(',')
        .map(part => normalizeTcviewRule(part))
        .filter((value): value is string => !!value))];
}

function parseBeckhoffAnalysisRuleList(raw: string): { disable: string[]; enable: string[] } {
    const disable = new Set<string>();
    const enable = new Set<string>();

    for (const segment of raw.split(',').map(part => part.trim()).filter(Boolean)) {
        const sign = segment[0];
        const token = (sign === '+' || sign === '-') ? segment.slice(1) : segment;
        const normalizedToken = token.toUpperCase().startsWith('SA')
            ? token.slice(2)
            : token;
        const mappedRules = beckhoffStaticAnalysisRuleMap.get(normalizedToken.replace(/^0+/, '') || '0') ?? [];
        for (const rule of mappedRules) {
            if (sign === '+') {
                enable.add(rule);
            } else {
                disable.add(rule);
            }
        }
    }

    return {
        disable: [...disable],
        enable: [...enable]
    };
}

function addRules(target: Set<string>, rules: Iterable<string>) {
    for (const rule of rules) {
        target.add(rule);
    }
}

function removeRules(target: Set<string>, rules: Iterable<string>) {
    for (const rule of rules) {
        target.delete(rule);
    }
}

export function parseTcviewLintPragmas(text: string): TcviewLintPragmaState {
    const disabledByLine = new Map<number, Set<string>>();
    const inlineIgnoresByLine = new Map<number, Set<string>>();
    const activeRules = new Set<string>();
    let pendingAttributeRules: { disable: string[]; enable: string[] } | undefined;
    const lines = text.split(/\r?\n/);

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        const isRelevantCodeLine = !nonCodeLinePattern.test(trimmed);
        const isObjectHeaderLine = beckhoffObjectHeaderPattern.test(trimmed);

        const lineRules = new Set(activeRules);
        if (pendingAttributeRules && isRelevantCodeLine) {
            if (isObjectHeaderLine) {
                addRules(activeRules, pendingAttributeRules.disable);
                removeRules(activeRules, pendingAttributeRules.enable);
                addRules(lineRules, activeRules);
            } else {
                addRules(lineRules, pendingAttributeRules.disable);
                removeRules(lineRules, pendingAttributeRules.enable);
            }
            pendingAttributeRules = undefined;
        }
        disabledByLine.set(index, lineRules);

        const inlineRules = new Set<string>();
        for (const match of line.matchAll(tcviewLintIgnorePattern)) {
            const ruleList = match[1];
            if (ruleList) {
                addRules(inlineRules, parseTcviewRuleList(ruleList));
            }
        }
        if (inlineRules.size > 0) {
            inlineIgnoresByLine.set(index, inlineRules);
        }

        const disableMatch = trimmed.match(tcviewLintDisablePattern);
        if (disableMatch?.[1]) {
            addRules(activeRules, parseTcviewRuleList(disableMatch[1]));
        }

        const enableMatch = trimmed.match(tcviewLintEnablePattern);
        if (enableMatch?.[1]) {
            removeRules(activeRules, parseTcviewRuleList(enableMatch[1]));
        }

        if (beckhoffNoAnalysisPattern.test(trimmed)) {
            activeRules.add('*');
        }

        const analysisMatch = trimmed.match(beckhoffAnalysisPragmaPattern);
        if (analysisMatch?.[1]) {
            const parsed = parseBeckhoffAnalysisRuleList(analysisMatch[1]);
            addRules(activeRules, parsed.disable);
            removeRules(activeRules, parsed.enable);
        }

        const analysisAttributeMatch = trimmed.match(beckhoffAnalysisAttributePattern);
        if (analysisAttributeMatch?.[1]) {
            pendingAttributeRules = parseBeckhoffAnalysisRuleList(analysisAttributeMatch[1]);
        }

        if (beckhoffWarningPattern.test(trimmed) || beckhoffSuppressWarningAttributePattern.test(trimmed)) {
            // Recognized and intentionally no-op for now. TcView currently maps Beckhoff
            // static-analysis suppressions only where they overlap with TcView lint rules.
        }
    });

    return {
        disabledByLine,
        inlineIgnoresByLine
    };
}

export function isTcviewLintRuleSuppressed(pragmas: TcviewLintPragmaState, line: number, rule: string): boolean {
    const normalizedRule = normalizeTcviewRule(rule) ?? rule.trim().toLowerCase();
    return !!pragmas.inlineIgnoresByLine.get(line)?.has(normalizedRule)
        || !!pragmas.disabledByLine.get(line)?.has('*')
        || !!pragmas.disabledByLine.get(line)?.has(normalizedRule);
}
