export type TcviewLintPragmaState = {
    disabledByLine: Map<number, Set<string>>;
    inlineIgnoresByLine: Map<number, Set<string>>;
};

const tcviewLintRulePattern = '[A-Za-z0-9_-]+';
const tcviewLintDisablePattern = new RegExp(`^\\{\\s*tcview\\s+lint-disable\\s+(${tcviewLintRulePattern})\\s*\\}$`, 'i');
const tcviewLintEnablePattern = new RegExp(`^\\{\\s*tcview\\s+lint-enable\\s+(${tcviewLintRulePattern})\\s*\\}$`, 'i');
const tcviewLintIgnorePattern = new RegExp(`\\/\\/\\s*tcview\\s+lint-ignore\\s+(${tcviewLintRulePattern})`, 'ig');

export function parseTcviewLintPragmas(text: string): TcviewLintPragmaState {
    const disabledByLine = new Map<number, Set<string>>();
    const inlineIgnoresByLine = new Map<number, Set<string>>();
    const activeRules = new Set<string>();
    const lines = text.split(/\r?\n/);

    lines.forEach((line, index) => {
        disabledByLine.set(index, new Set(activeRules));

        const inlineRules = new Set<string>();
        for (const match of line.matchAll(tcviewLintIgnorePattern)) {
            const rule = match[1]?.trim().toLowerCase();
            if (rule) {
                inlineRules.add(rule);
            }
        }
        if (inlineRules.size > 0) {
            inlineIgnoresByLine.set(index, inlineRules);
        }

        const trimmed = line.trim();
        const disableMatch = trimmed.match(tcviewLintDisablePattern);
        if (disableMatch?.[1]) {
            activeRules.add(disableMatch[1].trim().toLowerCase());
        }

        const enableMatch = trimmed.match(tcviewLintEnablePattern);
        if (enableMatch?.[1]) {
            activeRules.delete(enableMatch[1].trim().toLowerCase());
        }
    });

    return {
        disabledByLine,
        inlineIgnoresByLine
    };
}

export function isTcviewLintRuleSuppressed(pragmas: TcviewLintPragmaState, line: number, rule: string): boolean {
    const normalizedRule = rule.trim().toLowerCase();
    return !!pragmas.inlineIgnoresByLine.get(line)?.has(normalizedRule)
        || !!pragmas.disabledByLine.get(line)?.has(normalizedRule);
}
