import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildAstAnalysis } from '../iecStAst';
import { isKnownIecBuiltinIdentifier, isKnownIecBuiltinType } from '../iecStBuiltins';
import { iecStKeywordSet } from '../iecStKeywords';
import { applyFragmentSTToXml, extractFragmentSTFromXml } from '../tcViewFragmentCodec';
import { TwinCATXmlConverter } from '../tcViewXmlConverter';

function isCaseLabel(line: string): boolean {
    return /^\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*|\d+)(\s*\.\.\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*|\d+))?(\s*,\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*|\d+)(\s*\.\.\s*([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*|\d+))?)*\s*:\s*(\/\/.*)?$/i.test(line);
}

function inferPrimitive(expr: string): string {
    const value = expr.trim();
    if (/^(TRUE|FALSE)$/i.test(value)) return 'BOOL';
    if (/^'.*'$/.test(value)) return 'STRING';
    if (/^".*"$/.test(value)) return 'WSTRING';
    if (/^(T|TIME)#/i.test(value)) return 'TIME';
    if (/^[+-]?\d+$/.test(value)) return 'INT';
    if (/^[+-]?\d+\.\d+([eE][+-]?\d+)?$/.test(value)) return 'REAL';
    return 'UNKNOWN';
}

export async function runLanguageFeatureUtilityTests(): Promise<void> {
    assert.ok(isCaseLabel('1:'));
    assert.ok(isCaseLabel('1, 2, 3:'));
    assert.ok(isCaseLabel('10..20:'));
    assert.ok(isCaseLabel('StateA, StateB:'));
    assert.ok(isCaseLabel('E_DeviceMode.Manual:'));
    assert.ok(isCaseLabel('E_DeviceMode.Manual, E_DeviceMode.Auto:'));

    assert.strictEqual(inferPrimitive('TRUE'), 'BOOL');
    assert.strictEqual(inferPrimitive('123'), 'INT');
    assert.strictEqual(inferPrimitive('12.5'), 'REAL');
    assert.strictEqual(inferPrimitive("T#100ms"), 'TIME');
    assert.strictEqual(inferPrimitive("'abc'"), 'STRING');
    assert.strictEqual(inferPrimitive('"abc"'), 'WSTRING');

    const headerSample = [
        'FUNCTION_BLOCK FB_MotorDigital',
        'PROPERTY SpeedCommand : REAL',
        'GET',
        'END_GET',
        'SET',
        'END_SET',
        'METHOD Reset : BOOL',
        'END_METHOD',
        'END_FUNCTION_BLOCK'
    ].join('\n');
    const headerAst = buildAstAnalysis(headerSample);
    assert.strictEqual(
        headerAst.missingSemicolons.length,
        0,
        'Header/declaration lines must not produce semicolon diagnostics'
    );

    const controlHeaderSample = [
        'IF bReady THEN',
        'ELSIF bFallback THEN',
        'ELSE',
        'END_IF',
        'CASE eMode OF',
        '    E_Mode.Auto:',
        'END_CASE',
        'FOR i := 0 TO 10 DO',
        'END_FOR',
        'WHILE bRun DO',
        'END_WHILE',
        'REPEAT',
        'UNTIL bDone',
        'END_REPEAT'
    ].join('\n');
    const controlHeaderAst = buildAstAnalysis(controlHeaderSample);
    assert.strictEqual(
        controlHeaderAst.missingSemicolons.length,
        0,
        'Control header lines must not produce semicolon diagnostics'
    );

    const namedArgCallSample = [
        'FN_ValueClamp_REAL(',
        '    iValue := value,',
        '    iMinClamp := rMinSpeed,',
        '    iMaxClamp := rMaxSpeed',
        ');'
    ].join('\n');
    const namedArgAst = buildAstAnalysis(namedArgCallSample);
    const usedNames = new Set(namedArgAst.usages.map(u => u.upper));
    assert.ok(!usedNames.has('IVALUE'));
    assert.ok(!usedNames.has('IMINCLAMP'));
    assert.ok(!usedNames.has('IMAXCLAMP'));

    const outputArgCallSample = 'hresult := ConvertAnyToString(value, result => strValue);';
    const outputArgAst = buildAstAnalysis(outputArgCallSample);
    const outputArgNames = new Set(outputArgAst.usages.map(u => u.upper));
    assert.ok(!outputArgNames.has('RESULT'));

    const inlineIfSample = 'IF NOT Reset THEN RETURN; END_IF';
    const inlineIfAst = buildAstAnalysis(inlineIfSample);
    assert.strictEqual(inlineIfAst.blockErrors.length, 0, 'Inline IF block should not create missing END_IF errors');
    assert.strictEqual(inlineIfAst.missingSemicolons.length, 0, 'Inline IF block should not require trailing semicolon');

    const pragmaSample = [
        '{warning disable C0371}',
        'bReady := TRUE;'
    ].join('\n');
    const pragmaAst = buildAstAnalysis(pragmaSample);
    assert.strictEqual(pragmaAst.missingSemicolons.length, 0, 'Pragma lines must not produce semicolon diagnostics');
    assert.ok(!pragmaAst.usages.some(u => u.upper === 'WARNING' || u.upper === 'DISABLE' || u.upper === 'C0371'));

    assert.ok(isKnownIecBuiltinType('ANY'));
    assert.ok(isKnownIecBuiltinIdentifier('_SYSTEM'));
    assert.ok(isKnownIecBuiltinIdentifier('__SYSTEM'));
    assert.ok(isKnownIecBuiltinIdentifier('ADR'));
    assert.ok(isKnownIecBuiltinIdentifier('INT_TO_STRING'));
    assert.ok(isKnownIecBuiltinIdentifier('WORD_TO_STRING'));
    assert.ok(isKnownIecBuiltinIdentifier('TO_UDINT'));
    assert.ok(isKnownIecBuiltinIdentifier('POINTER'));
    [
        'ANDN', 'CAL', 'CALC', 'CALCN', 'JMP', 'JMPC', 'JMPCN', 'LD', 'LDN', 'LTIME',
        'ORN', 'PARAMS', 'R', 'READ_ONLY', 'READ_WRITE', 'RET', 'RETC', 'RETCN', 'S',
        'ST', 'STN', 'XORN'
    ].forEach(keyword => assert.ok(iecStKeywordSet.has(keyword), `Expected keyword ${keyword}`));
    [
        'BIT', 'LDATE', 'LDATE_AND_TIME', 'LDT', 'LTIME', 'LTIME_OF_DAY', 'LTOD',
        'ANY_DATE', 'PVOID', 'XINT', 'UXINT', 'XWORD', '__XINT', '__UXINT', '__XWORD'
    ].forEach(typeName => assert.ok(isKnownIecBuiltinType(typeName), `Expected type ${typeName}`));

    const refAssignmentSample = 'A REF= THIS^;';
    const refAssignmentAst = buildAstAnalysis(refAssignmentSample);
    const refAssignmentNames = new Set(refAssignmentAst.usages.map(u => u.upper));
    assert.ok(!refAssignmentNames.has('REF'));
    assert.ok(!refAssignmentNames.has('__SYSTEM'));

    const fixturePath = path.resolve(process.cwd(), 'src', 'tests', 'fixtures', 'FB_IntegrationSample.TcPOU');
    const fixtureXml = fs.readFileSync(fixturePath, 'utf8');

    const methodFragment = extractFragmentSTFromXml(fixtureXml, 'Method:FB_Init');
    const propertyFragment = extractFragmentSTFromXml(fixtureXml, 'Property:SpeedCommand');

    const [methodSt, propertySt] = await Promise.all([methodFragment, propertyFragment]);
    assert.ok(methodSt.includes('VAR_INPUT'));
    assert.ok(methodSt.includes('// comment in declaration'));
    assert.ok(propertySt.includes('PROPERTY SpeedCommand : REAL'));
    assert.ok(!propertySt.includes('GET'));
    assert.ok(!propertySt.includes('SET'));

    const updatedGetFragment = [
        'PROPERTY SpeedCommand : REAL',
        '',
        'GET',
        'VAR_INPUT',
        '    bUseCached : BOOL;',
        'END_VAR',
        '',
        'SpeedCommand := rSpeedCommand + 1.0;',
        '',
        'END_PROPERTY'
    ].join('\n');

    const xmlAfterGet = await applyFragmentSTToXml(fixtureXml, 'PropertyGet:SpeedCommand', updatedGetFragment);
    assert.ok(xmlAfterGet.includes('bUseCached : BOOL;'));
    assert.ok(xmlAfterGet.includes('SpeedCommand := rSpeedCommand + 1.0;'));
    assert.ok(xmlAfterGet.includes('rSpeedCommand := SpeedCommand;'));

    const updatedMethodFragment = [
        'METHOD FB_Init : BOOL',
        'VAR_INPUT',
        '    bInitRetains : BOOL;',
        'END_VAR',
        '// comment in declaration',
        '',
        'FB_Init := bInitRetains;'
    ].join('\n');
    const xmlAfterMethod = await applyFragmentSTToXml(fixtureXml, 'Method:FB_Init', updatedMethodFragment);
    assert.ok(xmlAfterMethod.includes('bInitRetains : BOOL;'));
    assert.ok(xmlAfterMethod.includes('FB_Init := bInitRetains;'));

    const interfaceFixturePath = path.resolve(process.cwd(), 'src', 'tests', 'fixtures', 'I_IntegrationSample.TcITF');
    const interfaceXml = fs.readFileSync(interfaceFixturePath, 'utf8');
    const interfaceConverter = new TwinCATXmlConverter();

    const [interfaceMethodSt, interfacePropertySt, interfaceGetSt, interfaceFileSt] = await Promise.all([
        extractFragmentSTFromXml(interfaceXml, 'Method:Reset'),
        extractFragmentSTFromXml(interfaceXml, 'Property:Speed'),
        extractFragmentSTFromXml(interfaceXml, 'PropertyGet:Speed'),
        interfaceConverter.convertXmlToST(interfaceXml)
    ]);

    assert.ok(interfaceMethodSt.includes('METHOD Reset : BOOL'));
    assert.ok(interfaceMethodSt.includes('VAR_INPUT'));
    assert.ok(interfacePropertySt.includes('PROPERTY Speed : REAL'));
    assert.ok(!interfacePropertySt.includes('GET'));
    assert.ok(!interfacePropertySt.includes('SET'));
    assert.ok(interfaceGetSt.includes('cannot be opened'));
    assert.strictEqual(interfaceFileSt.trim(), 'INTERFACE I_IntegrationSample');

    await assert.rejects(
        applyFragmentSTToXml(interfaceXml, 'PropertyGet:Speed', 'GET'),
        /tree-only and cannot be edited/i
    );

    const enumDutFixturePath = path.resolve(process.cwd(), 'src', 'tests', 'fixtures', 'E_DeviceMode.TcDUT');
    const structDutFixturePath = path.resolve(process.cwd(), 'src', 'tests', 'fixtures', 'ST_CiA402_Drive_PDO.TcDUT');
    const enumDutXml = fs.readFileSync(enumDutFixturePath, 'utf8');
    const structDutXml = fs.readFileSync(structDutFixturePath, 'utf8');

    const [enumDutSt, structDutSt] = await Promise.all([
        interfaceConverter.convertXmlToST(enumDutXml),
        interfaceConverter.convertXmlToST(structDutXml)
    ]);

    assert.ok(enumDutSt.includes("TYPE E_DeviceMode :"));
    assert.ok(enumDutSt.includes("{attribute 'qualified_only'}"));
    assert.ok(enumDutSt.includes('('));
    assert.ok(!enumDutSt.includes('STRUCT\nTYPE E_DeviceMode :'));
    assert.strictEqual((enumDutSt.match(/\bTYPE\s+E_DeviceMode\b/g) || []).length, 1);

    assert.ok(structDutSt.includes('TYPE ST_CiA402_Drive_PDO :'));
    assert.ok(structDutSt.includes('STRUCT'));
    assert.ok(structDutSt.includes('ControlWord    : WORD;'));
    assert.ok(!structDutSt.includes('STRUCT\nSTRUCT'));
    assert.strictEqual((structDutSt.match(/^STRUCT$/gm) || []).length, 1, 'Expected one STRUCT block header.');

    const updatedEnumDut = [
        'TYPE E_DeviceMode :',
        "{attribute 'qualified_only'}",
        '(',
        '    Auto := 0,',
        '    Manual := 1,',
        '    Service := 2',
        ');',
        'END_TYPE'
    ].join('\n');
    const xmlAfterEnumDutSave = await interfaceConverter.convertSTToXml(updatedEnumDut, enumDutXml);
    assert.ok(xmlAfterEnumDutSave.includes('Service := 2'));
    assert.ok(!xmlAfterEnumDutSave.includes('STRUCT'));

    const updatedStructDut = [
        'TYPE ST_CiA402_Drive_PDO :',
        'STRUCT',
        '    ControlWord    : WORD;',
        '    VelocityTarget : DINT;',
        '    StatusWord     : WORD;',
        'END_STRUCT',
        'END_TYPE'
    ].join('\n');
    const xmlAfterStructDutSave = await interfaceConverter.convertSTToXml(updatedStructDut, structDutXml);
    assert.ok(xmlAfterStructDutSave.includes('VelocityTarget : DINT;'));
    assert.ok(!xmlAfterStructDutSave.includes('STRUCT\nSTRUCT'));
}

if (require.main === module) {
    Promise.resolve(runLanguageFeatureUtilityTests()).then(() => {
        console.log('Language feature utility tests passed.');
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
