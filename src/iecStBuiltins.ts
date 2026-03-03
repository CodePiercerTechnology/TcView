export const iecBuiltinTypes = [
    'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
    'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
    'REAL', 'LREAL', 'TIME', 'LTIME', 'DATE', 'LDATE', 'TIME_OF_DAY', 'TOD', 'LTIME_OF_DAY', 'LTOD', 'DATE_AND_TIME', 'DT', 'LDATE_AND_TIME', 'LDT',
    'STRING', 'WSTRING',
    'ANY', 'ANY_DERIVED', 'ANY_ELEMENTARY', 'ANY_MAGNITUDE', 'ANY_NUM', 'ANY_REAL',
    'ANY_INT', 'ANY_UNSIGNED', 'ANY_SIGNED', 'ANY_DURATION', 'ANY_BIT', 'ANY_CHARS', 'ANY_DATE',
    'ANY_STRING', 'ANY_CHAR',
    'ARRAY', 'STRUCT', 'END_STRUCT', 'UNION', 'END_UNION',
    'REF_TO', 'POINTER', 'REFERENCE',
    'BIT', 'PVOID', 'XINT', 'UXINT', 'XWORD', '__XINT', '__UXINT', '__XWORD'
] as const;

export const iecBuiltinFunctions = [
    'ABS', 'SQRT', 'LN', 'LOG', 'EXP', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATAN2', 'EXPT',
    'LEN', 'LEFT', 'RIGHT', 'MID', 'CONCAT', 'INSERT', 'DELETE', 'REPLACE', 'FIND',
    'LIMIT', 'SEL', 'MAX', 'MIN', 'MUX',
    'ADR', 'ADRINST', 'SIZEOF', 'BITADR', 'IS_VALID_REF',
    'MOVE', 'SHL', 'SHR', 'ROL', 'ROR', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD',
    'GE', 'LE', 'GT', 'LT', 'EQ', 'NE', 'INDEXOF', 'LOWER_BOUND', 'UPPER_BOUND',
    'TRUNC', 'ROUND', 'CEIL', 'FLOOR', 'BCD_TO_INT', 'INT_TO_BCD'
] as const;

export const iecBuiltinNamespaces = ['_SYSTEM', '__SYSTEM'] as const;

const iecBuiltInTypeSet = new Set(iecBuiltinTypes.map(k => k.toUpperCase()));
const iecBuiltInFunctionSet = new Set(iecBuiltinFunctions.map(k => k.toUpperCase()));
const iecBuiltInNamespaceSet = new Set(iecBuiltinNamespaces.map(k => k.toUpperCase()));

export function isConversionFunctionName(value: string): boolean {
    return /^(?:[A-Z][A-Z0-9]*_TO_[A-Z][A-Z0-9]*|TO_[A-Z][A-Z0-9]*)$/.test(value.toUpperCase());
}

export function isKnownIecBuiltinType(value: string): boolean {
    const upper = value.toUpperCase();
    return iecBuiltInTypeSet.has(upper) || isConversionFunctionName(upper);
}

export function isKnownIecBuiltinFunction(value: string): boolean {
    const upper = value.toUpperCase();
    return iecBuiltInFunctionSet.has(upper) || isConversionFunctionName(upper);
}

export function isKnownIecBuiltinNamespace(value: string): boolean {
    return iecBuiltInNamespaceSet.has(value.toUpperCase());
}

export function isKnownIecBuiltinIdentifier(value: string): boolean {
    return isKnownIecBuiltinType(value) ||
        isKnownIecBuiltinFunction(value) ||
        isKnownIecBuiltinNamespace(value);
}
