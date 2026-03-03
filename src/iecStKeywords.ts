export const iecStKeywords: string[] = [
    'PROGRAM', 'END_PROGRAM', 'FUNCTION', 'END_FUNCTION', 'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
    'INTERFACE', 'END_INTERFACE', 'METHOD', 'END_METHOD', 'PROPERTY', 'END_PROPERTY',
    'ACTION', 'END_ACTION', 'TRANSITION', 'END_TRANSITION', 'GET', 'SET',
    'VAR', 'END_VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP',
    'VAR_EXTERNAL', 'VAR_ACCESS', 'VAR_CONFIG', 'VAR_STAT', 'VAR_RETAIN', 'VAR_CONSTANT', 'VAR_INST',
    'CONSTANT', 'RETAIN', 'PERSISTENT',

    'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
    'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
    'REAL', 'LREAL', 'TIME', 'LTIME', 'DATE', 'LDATE', 'TIME_OF_DAY', 'TOD', 'LTIME_OF_DAY', 'LTOD',
    'DATE_AND_TIME', 'DT', 'LDATE_AND_TIME', 'LDT',
    'STRING', 'WSTRING', 'ARRAY', 'OF', 'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT', 'ENUM', 'END_ENUM',
    'UNION', 'END_UNION', 'BIT', 'PVOID', 'XINT', 'UXINT', 'XWORD', '__XINT', '__UXINT', '__XWORD',
    'ANY', 'ANY_DERIVED', 'ANY_ELEMENTARY', 'ANY_MAGNITUDE', 'ANY_NUM', 'ANY_REAL',
    'ANY_INT', 'ANY_UNSIGNED', 'ANY_SIGNED', 'ANY_DURATION', 'ANY_BIT', 'ANY_CHARS', 'ANY_STRING', 'ANY_CHAR',
    'ANY_DATE', 'REF_TO', 'POINTER', 'REFERENCE',

    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'EXIT', 'CONTINUE', 'RETURN',

    'AND', 'ANDN', 'OR', 'ORN', 'XOR', 'XORN', 'NOT', 'MOD', 'DIV',
    'EQ', 'NE', 'GE', 'GT', 'LE', 'LT',

    'ABS', 'SQRT', 'LN', 'LOG', 'EXP', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN',
    'EXPT', 'LIMIT', 'MIN', 'MAX', 'SEL', 'MUX', 'SHL', 'SHR', 'ROL', 'ROR',
    'ADD', 'MUL', 'SUB', 'MOVE', 'ADR', 'BITADR', 'SIZEOF', 'INDEXOF', 'TRUNC',

    'READ_ONLY', 'READ_WRITE', 'THIS', 'SUPER', 'AT', 'EXTENDS', 'IMPLEMENTS', 'REF',
    'TRUE', 'FALSE', 'NULL', '_SYSTEM', '__SYSTEM',

    'CAL', 'CALC', 'CALCN', 'JMP', 'JMPC', 'JMPCN', 'LD', 'LDN',
    'PARAMS', 'R', 'RET', 'RETC', 'RETCN', 'S', 'ST', 'STN'
] ;

export const iecStKeywordSet = new Set(iecStKeywords.map(k => k.toUpperCase()));
