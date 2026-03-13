import { iecBuiltinFunctions, iecBuiltinNamespaces, iecBuiltinTypes } from './iecStBuiltins';
import { iecStKeywords } from './iecStKeywords';

export interface AstVariableDecl {
    name: string;
    upper: string;
    type: string;
    line: number;
    startCol: number;
    endCol: number;
    scopeKind: string;
}

export interface AstDuplicateDecl {
    name: string;
    line: number;
    startCol: number;
    endCol: number;
}

export interface AstIdentifierOccurrence {
    name: string;
    upper: string;
    line: number;
    startCol: number;
    endCol: number;
    isCall: boolean;
    isMember: boolean;
    isNamedArg: boolean;
}

export interface AstAssignment {
    target: string;
    targetUpper: string;
    expr: string;
    line: number;
    startCol: number;
}

export interface AstDiagnosticItem {
    line: number;
    startCol: number;
    endCol: number;
    message: string;
}

export interface AstAnalysis {
    missingSemicolons: AstDiagnosticItem[];
    blockErrors: AstDiagnosticItem[];
    stringErrors: AstDiagnosticItem[];
    parenthesisErrors: AstDiagnosticItem[];
    declarations: AstVariableDecl[];
    duplicates: AstDuplicateDecl[];
    usages: AstIdentifierOccurrence[];
    assignments: AstAssignment[];
}

interface Token {
    text: string;
    upper: string;
    start: number;
    end: number;
    kind: 'identifier' | 'number' | 'symbol' | 'operator';
}

interface ParsedLine {
    line: number;
    raw: string;
    code: string;
    semicolonCode: string;
    tokens: Token[];
    parenDepthStart: number;
    parenDelta: number;
    firstUpper: string;
}

const KEYWORDS = new Set([
    ...iecStKeywords,
    ...iecBuiltinTypes,
    ...iecBuiltinFunctions,
    ...iecBuiltinNamespaces,
    'ADRINST', 'IS_VALID_REF', 'LOWER_BOUND', 'UPPER_BOUND'
].map(item => item.toUpperCase()));

const BLOCK_OPENERS = new Map<string, string>([
    ['IF', 'END_IF'],
    ['FOR', 'END_FOR'],
    ['WHILE', 'END_WHILE'],
    ['REPEAT', 'END_REPEAT'],
    ['CASE', 'END_CASE'],
    ['VAR', 'END_VAR'],
    ['VAR_INPUT', 'END_VAR'],
    ['VAR_OUTPUT', 'END_VAR'],
    ['VAR_IN_OUT', 'END_VAR'],
    ['VAR_TEMP', 'END_VAR'],
    ['VAR_GLOBAL', 'END_VAR'],
    ['VAR_INST', 'END_VAR'],
    ['VAR_STAT', 'END_VAR']
]);

const VAR_SCOPE_OPENERS = new Set(['VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_GLOBAL', 'VAR_INST', 'VAR_STAT']);

export function buildAstAnalysis(text: string): AstAnalysis {
    const lines = text.replace(/\r/g, '').split('\n');
    const parsedLines: ParsedLine[] = [];
    const missingSemicolons: AstDiagnosticItem[] = [];
    const blockErrors: AstDiagnosticItem[] = [];
    const stringErrors: AstDiagnosticItem[] = [];
    const parenthesisErrors: AstDiagnosticItem[] = [];
    const declarations: AstVariableDecl[] = [];
    const duplicates: AstDuplicateDecl[] = [];
    const usages: AstIdentifierOccurrence[] = [];
    const assignments: AstAssignment[] = [];

    let inBlockComment = false;
    let parenBalance = 0;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const lexed = lexLine(raw, inBlockComment);
        inBlockComment = lexed.inBlockComment;
        if (lexed.unclosedString) {
            stringErrors.push({
                line: i,
                startCol: 0,
                endCol: Math.max(1, raw.length),
                message: lexed.unclosedString === 'single'
                    ? 'Unclosed single-quoted string literal.'
                    : 'Unclosed double-quoted string literal.'
            });
        }
        if (lexed.tokens.length === 0 && !lexed.code.trim()) {
            parsedLines.push({
                line: i,
                raw,
                code: lexed.code,
                semicolonCode: stripLineCommentPreserveStrings(raw),
                tokens: [],
                parenDepthStart: parenBalance,
                parenDelta: 0,
                firstUpper: ''
            });
            continue;
        }

        const parenDepthStart = parenBalance;
        const parenDelta = lexed.tokens.reduce((acc, t) => acc + (t.text === '(' ? 1 : t.text === ')' ? -1 : 0), 0);
        parenBalance += parenDelta;
        if (parenBalance < 0) {
            parenthesisErrors.push({
                line: i,
                startCol: 0,
                endCol: Math.max(1, raw.length),
                message: 'Unmatched closing parenthesis on this line.'
            });
            parenBalance = 0;
        }

        parsedLines.push({
            line: i,
            raw,
            code: lexed.code,
            semicolonCode: stripLineCommentPreserveStrings(raw),
            tokens: lexed.tokens,
            parenDepthStart,
            parenDelta,
            firstUpper: lexed.tokens[0]?.upper || ''
        });
    }

    if (parenBalance > 0) {
        const lastLine = Math.max(0, parsedLines.length - 1);
        parenthesisErrors.push({
            line: lastLine,
            startCol: 0,
            endCol: 0,
            message: `Unmatched parentheses: missing ${parenBalance} closing ')'.`
        });
    }

    const blockStack: Array<{ opener: string; line: number; col: number; expected: string }> = [];
    let inTypeBlock = false;
    let inEnumList = false;
    let varScopeKind: string | undefined;
    let scopeDecls = new Map<string, AstVariableDecl>();

    for (let i = 0; i < parsedLines.length; i++) {
        const pl = parsedLines[i];
        const t0 = pl.firstUpper;
        if (!t0) continue;

        // Type/enum state
        if (t0 === 'TYPE') inTypeBlock = true;
        if (inTypeBlock && pl.code.trim() === '(') inEnumList = true;
        if (inEnumList && /^\)\s*;?\s*$/.test(pl.code.trim())) inEnumList = false;
        if (t0 === 'END_TYPE') {
            inTypeBlock = false;
            inEnumList = false;
        }

        // Block matching
        if (BLOCK_OPENERS.has(t0)) {
            const expected = BLOCK_OPENERS.get(t0)!;
            const closesInline = pl.tokens.some(tok => tok.upper === expected);
            if (!closesInline) {
                const col = pl.tokens[0].start;
                blockStack.push({ opener: t0, expected, line: pl.line, col });
            }
        }
        if (t0.startsWith('END_')) {
            if (t0 === 'END_VAR') {
                // close nearest var scope
                for (let s = blockStack.length - 1; s >= 0; s--) {
                    if (VAR_SCOPE_OPENERS.has(blockStack[s].opener)) {
                        blockStack.splice(s, 1);
                        break;
                    }
                }
            } else {
                for (let s = blockStack.length - 1; s >= 0; s--) {
                    if (blockStack[s].expected === t0) {
                        blockStack.splice(s, 1);
                        break;
                    }
                }
            }
        }

        // Scope handling for declarations
        if (VAR_SCOPE_OPENERS.has(t0)) {
            varScopeKind = t0;
            scopeDecls = new Map<string, AstVariableDecl>();
            continue;
        }
        if (t0 === 'END_VAR') {
            varScopeKind = undefined;
            scopeDecls = new Map<string, AstVariableDecl>();
            continue;
        }

        // parse declarations in var scope
        if (varScopeKind) {
            const decl = parseVarDeclarationLine(pl);
            if (decl) {
                declarations.push({ ...decl, scopeKind: varScopeKind });
                const existing = scopeDecls.get(decl.upper);
                if (existing) {
                    duplicates.push({
                        name: decl.name,
                        line: decl.line,
                        startCol: decl.startCol,
                        endCol: decl.endCol
                    });
                } else {
                    scopeDecls.set(decl.upper, { ...decl, scopeKind: varScopeKind });
                }
            }
            continue;
        }

        // skip declaration-like lines from usage/semicolon where appropriate
        const isHeaderLike = /^(PROGRAM|FUNCTION|FUNCTION_BLOCK|INTERFACE|METHOD|PROPERTY|ACTION|TRANSITION|GET|SET|TYPE|END_TYPE|STRUCT|END_STRUCT|ENUM|END_ENUM)\b/.test(t0);
        if (!isHeaderLike && !inTypeBlock && !inEnumList) {
            collectUsagesAndAssignments(pl, usages, assignments);
        }
    }

    for (const b of blockStack) {
        blockErrors.push({
            line: b.line,
            startCol: b.col,
            endCol: b.col + b.opener.length,
            message: `Missing ${b.expected} for ${b.opener}`
        });
    }

    // semicolon pass (uses parsed lines and contextual lookahead)
    let caseDepth = 0;
    for (let i = 0; i < parsedLines.length; i++) {
        const pl = parsedLines[i];
        if (!pl.code.trim()) continue;
        const trimmed = pl.semicolonCode.trim();
        const t0 = pl.firstUpper;
        if (/\bCASE\b[\s\S]*\bOF\b/i.test(trimmed)) caseDepth++;
        if (/\bEND_CASE\b/i.test(trimmed)) caseDepth = Math.max(0, caseDepth - 1);

        if (shouldSkipSemicolonLine(trimmed, inTypeLikeContext(trimmed), caseDepth)) continue;

        const next = findNextRelevantParsedLine(parsedLines, i + 1);
        if (needsSemicolon(trimmed, next?.semicolonCode || '', caseDepth)) {
            const col = lineEndInsertCol(pl.raw);
            missingSemicolons.push({
                line: pl.line,
                startCol: col,
                endCol: col,
                message: 'Missing semicolon at end of statement'
            });
        }
    }

    return {
        missingSemicolons,
        blockErrors,
        stringErrors,
        parenthesisErrors,
        declarations,
        duplicates,
        usages,
        assignments
    };
}

function inTypeLikeContext(trimmed: string): boolean {
    return /^(TYPE|END_TYPE|STRUCT|END_STRUCT|ENUM|END_ENUM)\b/i.test(trimmed);
}

function parseVarDeclarationLine(pl: ParsedLine): Omit<AstVariableDecl, 'scopeKind'> | undefined {
    const code = pl.semicolonCode.trim();
    const m = code.match(/^([A-Za-z_]\w*)\s*:\s*([^;]+);?$/);
    if (!m) return undefined;
    const name = m[1];
    const start = pl.semicolonCode.indexOf(name);
    return {
        name,
        upper: name.toUpperCase(),
        type: m[2].trim(),
        line: pl.line,
        startCol: Math.max(0, start),
        endCol: Math.max(0, start) + name.length
    };
}

function collectUsagesAndAssignments(pl: ParsedLine, usages: AstIdentifierOccurrence[], assignments: AstAssignment[]): void {
    const toks = pl.tokens;

    const assignIdx = toks.findIndex(t => t.text === ':=');
    if (assignIdx > 0 && toks[assignIdx - 1].kind === 'identifier') {
        const lhs = toks[assignIdx - 1];
        const expr = pl.code.substring(lhs.end).replace(/^.*?:=/, '').trim();
        assignments.push({
            target: lhs.text,
            targetUpper: lhs.upper,
            expr,
            line: pl.line,
            startCol: lhs.start
        });
    }

    let parenDepth = Math.max(0, pl.parenDepthStart);
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.text === '(') {
            parenDepth++;
            continue;
        }
        if (t.text === ')') {
            parenDepth = Math.max(0, parenDepth - 1);
            continue;
        }
        if (t.kind !== 'identifier') continue;
        if (KEYWORDS.has(t.upper)) continue;

        const prev = i > 0 ? toks[i - 1] : undefined;
        const next = i + 1 < toks.length ? toks[i + 1] : undefined;
        const isMember = !!prev && prev.text === '.';
        const isCall = !!next && next.text === '(';
        const isNamedArg = !!next && (next.text === ':=' || next.text === '=>') && parenDepth > 0;
        if (isMember || isNamedArg) continue;

        usages.push({
            name: t.text,
            upper: t.upper,
            line: pl.line,
            startCol: t.start,
            endCol: t.end,
            isCall,
            isMember,
            isNamedArg
        });
    }
}

function shouldSkipSemicolonLine(trimmed: string, typeLike: boolean, caseDepth: number): boolean {
    if (!trimmed) return true;
    if (/^\{.*\}$/.test(trimmed)) return true;
    if (/^(PROGRAM|END_PROGRAM|FUNCTION|END_FUNCTION|FUNCTION_BLOCK|END_FUNCTION_BLOCK|INTERFACE|END_INTERFACE|METHOD|END_METHOD|PROPERTY|END_PROPERTY|ACTION|END_ACTION|TRANSITION|END_TRANSITION|GET|END_GET|SET|END_SET)\b/i.test(trimmed)) return true;
    if (/^(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_GLOBAL|VAR_INST|VAR_STAT|END_VAR)\b/i.test(trimmed)) return true;
    if (/^(VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_TEMP|VAR_GLOBAL|VAR_INST|VAR_STAT)(\s+(CONSTANT|INTERNAL|PUBLIC|PRIVATE|PROTECTED|FINAL|ABSTRACT|RETAIN|PERSISTENT))*\s*$/i.test(trimmed)) return true;
    if (/^(CONSTANT|INTERNAL|PUBLIC|PRIVATE|PROTECTED|FINAL|ABSTRACT|RETAIN|PERSISTENT)(\s+(CONSTANT|INTERNAL|PUBLIC|PRIVATE|PROTECTED|FINAL|ABSTRACT|RETAIN|PERSISTENT))*\s*$/i.test(trimmed)) return true;
    if (/^(IF\b.*\bTHEN|ELSIF\b.*\bTHEN|CASE\b.*\bOF|FOR\b.*\bDO|WHILE\b.*\bDO|REPEAT\b)\s*$/i.test(trimmed)) return true;
    if (/^(IF\b.*\bTHEN[\s\S]*\bEND_IF|FOR\b.*\bDO[\s\S]*\bEND_FOR|WHILE\b.*\bDO[\s\S]*\bEND_WHILE|REPEAT\b[\s\S]*\bEND_REPEAT|CASE\b.*\bOF[\s\S]*\bEND_CASE)\s*;?$/i.test(trimmed)) return true;
    if (/^(THEN|ELSE|ELSIF|OF|DO|UNTIL|END_IF|END_FOR|END_WHILE|END_REPEAT|END_CASE|END_STRUCT|END_INTERFACE|END_METHOD|END_PROPERTY|END_ACTION|END_TRANSITION)\b/i.test(trimmed)) return true;
    if (typeLike) return true;
    if (/^TYPE\s+[A-Za-z_]\w*\s*:\s*$/i.test(trimmed)) return true;
    if (caseDepth > 0 && isCaseLabel(trimmed)) return true;
    return false;
}

function needsSemicolon(trimmed: string, nextTrimmed: string, caseDepth: number): boolean {
    if (trimmed.endsWith(';')) return false;
    if (isLikelyContinuation(trimmed, nextTrimmed)) return false;
    if (caseDepth > 0 && isCaseLabel(trimmed)) return false;
    return true;
}

function isLikelyContinuation(current: string, next: string): boolean {
    const c = current.trim();
    const n = next.trim();
    if (!c) return false;
    if (/[:=]\s*$/.test(c)) return true;
    if (/[+\-*/,(]$/.test(c)) return true;
    if (/\b(AND|OR|XOR|MOD|DIV)\s*$/i.test(c)) return true;
    if (!n) return false;
    if (/^(\)|\]|\+|-|\*|\/|AND\b|OR\b|XOR\b|MOD\b|DIV\b|,)/i.test(n)) return true;
    return false;
}

function isCaseLabel(trimmed: string): boolean {
    if (!trimmed || trimmed.includes(':=')) return false;
    return /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+|16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+)(\s*\.\.\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+|16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+))?(\s*,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+|16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+)(\s*\.\.\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+|16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+))?)*\s*:\s*$/.test(trimmed);
}

function findNextRelevantParsedLine(lines: ParsedLine[], start: number): ParsedLine | undefined {
    for (let i = start; i < lines.length; i++) {
        if (lines[i].code.trim()) return lines[i];
    }
    return undefined;
}

function lineEndInsertCol(raw: string): number {
    const commentIdx = raw.indexOf('//');
    const codePart = commentIdx >= 0 ? raw.substring(0, commentIdx) : raw;
    let p = codePart.length;
    while (p > 0 && /\s/.test(codePart[p - 1])) p--;
    return p;
}

function lexLine(line: string, inBlockCommentStart: boolean): { code: string; tokens: Token[]; inBlockComment: boolean; unclosedString?: 'single' | 'double' } {
    let code = '';
    let inBlockComment = inBlockCommentStart;
    let inSingle = false;
    let inDouble = false;
    const tokens: Token[] = [];

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = i + 1 < line.length ? line[i + 1] : '';

        if (inBlockComment) {
            if (ch === '*' && next === ')') {
                inBlockComment = false;
                i++;
            }
            continue;
        }

        if (!inSingle && !inDouble && ch === '/' && next === '/') {
            break;
        }
        if (!inSingle && !inDouble && ch === '(' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
        }
        if (!inSingle && !inDouble && ch === '{') {
            code += ' ';
            while (i + 1 < line.length && line[i + 1] !== '}') {
                code += ' ';
                i++;
            }
            if (i + 1 < line.length && line[i + 1] === '}') {
                code += ' ';
                i++;
            }
            continue;
        }

        if (!inDouble && ch === '\'') {
            if (inSingle && next === '\'') {
                code += '  ';
                i++;
                continue;
            }
            inSingle = !inSingle;
            code += ' ';
            continue;
        }
        if (!inSingle && ch === '"') {
            if (inDouble && next === '"') {
                code += '  ';
                i++;
                continue;
            }
            inDouble = !inDouble;
            code += ' ';
            continue;
        }

        code += (inSingle || inDouble) ? ' ' : ch;
    }

    tokenizeCode(code, tokens);
    const unclosedString = inSingle ? 'single' : inDouble ? 'double' : undefined;
    return { code, tokens, inBlockComment, unclosedString };
}

function tokenizeCode(code: string, out: Token[]): void {
    // Keep IEC time literals (e.g. T#100ms, TIME#1h30m) as a single token.
    const re = /\s+|:=|=>|<=|>=|<>|[(){}\[\],;:.+\-*/=<>]|(?:T|TIME)#(?:[+-]?\d+(?:\.\d+)?(?:D|H|M|S|MS|US|NS))+|16#[0-9A-Fa-f_]+|2#[01_]+|8#[0-7_]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_]\w*/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
        const text = m[0];
        if (!text || /^\s+$/.test(text)) continue;
        const start = m.index;
        const end = start + text.length;
        let kind: Token['kind'] = 'symbol';
        if (/^[A-Za-z_]\w*$/.test(text)) kind = 'identifier';
        else if (/^(?:T|TIME)#/i.test(text) || /^\d|^(16#|2#|8#)/.test(text)) kind = 'number';
        else if (/^(:=|=>|<=|>=|<>|[=<>+\-*/])$/.test(text)) kind = 'operator';
        out.push({ text, upper: text.toUpperCase(), start, end, kind });
    }
}

function stripLineCommentPreserveStrings(line: string): string {
    let inSingle = false;
    let inDouble = false;
    let out = '';

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = i + 1 < line.length ? line[i + 1] : '';

        if (!inDouble && ch === '\'') {
            if (inSingle && next === '\'') {
                out += ch + next;
                i++;
                continue;
            }
            inSingle = !inSingle;
            out += ch;
            continue;
        }

        if (!inSingle && ch === '"') {
            if (inDouble && next === '"') {
                out += ch + next;
                i++;
                continue;
            }
            inDouble = !inDouble;
            out += ch;
            continue;
        }

        if (!inSingle && !inDouble && ch === '/' && next === '/') {
            return out;
        }

        if (!inSingle && !inDouble && ch === '{') {
            while (i + 1 < line.length && line[i + 1] !== '}') {
                i++;
            }
            if (i + 1 < line.length && line[i + 1] === '}') {
                i++;
            }
            continue;
        }

        out += ch;
    }

    return out;
}
