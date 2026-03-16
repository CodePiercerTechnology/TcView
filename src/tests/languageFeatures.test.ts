import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildAstAnalysis } from '../iecStAst';
import { isKnownIecBuiltinIdentifier, isKnownIecBuiltinType } from '../iecStBuiltins';
import { iecStKeywordSet } from '../iecStKeywords';
import { parseTcviewLintPragmas } from '../tcviewLintPragmas';
import { applyFragmentSTToXml, extractFragmentSTFromXml } from '../tcViewFragmentCodec';
import { TwinCATXmlConverter } from '../tcViewXmlConverter';
import { extractQualifiedOnlyUsageInfo } from '../twinCATQualifiedOnly';
import { parseTwinCATTypeDeclarations } from '../twinCATTypeParser';

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

    const multiDeclarationSample = [
        'VAR',
        '    tonDelayOn, tonDelayOff : TON;',
        'END_VAR',
        '',
        'tonDelayOn(IN := TRUE, PT := T#1s);',
        'tonDelayOff(IN := FALSE, PT := T#1s);'
    ].join('\n');
    const multiDeclarationAst = buildAstAnalysis(multiDeclarationSample);
    const declaredNames = new Set(multiDeclarationAst.declarations.map(d => d.upper));
    assert.ok(declaredNames.has('TONDELAYON'));
    assert.ok(declaredNames.has('TONDELAYOFF'));

    const inlineEnumDeclarationSample = [
        'FUNCTION_BLOCK FB_CreateDirs',
        'VAR',
        '    eState : (Idle, CheckPath, Cleanup);',
        'END_VAR',
        '',
        'CASE eState OF',
        '    Idle:',
        '        eState := CheckPath;',
        '    CheckPath:',
        '        eState := Cleanup;',
        'END_CASE'
    ].join('\n');
    const inlineEnumDeclarationAst = buildAstAnalysis(inlineEnumDeclarationSample);
    const inlineEnumUsages = new Set(inlineEnumDeclarationAst.usages.map(u => u.upper));
    assert.ok(inlineEnumUsages.has('IDLE'));
    assert.ok(inlineEnumUsages.has('CHECKPATH'));
    assert.ok(inlineEnumUsages.has('CLEANUP'));

    const multilineInlineEnumDeclarationSample = [
        'FUNCTION_BLOCK FB_FileCopy',
        'VAR',
        '    eState : (Idle, OpenSrcFile, WaitSrcFileOpened, OpenDestFile, WaitDestFileOpened,',
        '              ReadSrcFile, WaitSrcFileRead, WriteDestFile, WaitWritingDestDone,',
        '              CloseDestFile, WaitDestFileClosed, CloseSrcFile, WaitSrcFileClosed, Cleanup);',
        'END_VAR',
        '',
        'CASE eState OF',
        '    Idle:',
        '        eState := OpenSrcFile;',
        'END_CASE'
    ].join('\n');
    const multilineInlineEnumDeclarationAst = buildAstAnalysis(multilineInlineEnumDeclarationSample);
    const multilineEnumDeclaredNames = new Set(multilineInlineEnumDeclarationAst.declarations.map(d => d.upper));
    assert.ok(multilineEnumDeclaredNames.has('ESTATE'));

    const pragmaPrefixedDeclarationSample = [
        'VAR_GLOBAL',
        "    {attribute 'OPC.UA.DA' := '1'} PLCinfo : ST_PLC;",
        'END_VAR'
    ].join('\n');
    const pragmaPrefixedDeclarationAst = buildAstAnalysis(pragmaPrefixedDeclarationSample);
    assert.ok(
        pragmaPrefixedDeclarationAst.declarations.some(d => d.upper === 'PLCINFO' && d.type === 'ST_PLC'),
        'Attribute-prefixed declarations should still be parsed as normal declarations'
    );

    const internalFunctionHeaderSample = [
        'FUNCTION INTERNAL F_Msg_CheckInFaultRange : BOOL',
        'VAR_INPUT',
        '    stMsg : ST_Message;',
        'END_VAR',
        '',
        'F_Msg_CheckInFaultRange := TRUE;'
    ].join('\n');
    const internalFunctionHeaderAst = buildAstAnalysis(internalFunctionHeaderSample);
    assert.strictEqual(
        internalFunctionHeaderAst.missingSemicolons.length,
        0,
        'Function headers with modifiers should not require semicolons'
    );
    assert.ok(
        internalFunctionHeaderAst.declarations.some(d => d.upper === 'F_MSG_CHECKINFAULTRANGE' && d.scopeKind === 'FUNCTION'),
        'Function header should contribute the implicit return variable declaration'
    );
    assert.ok(
        internalFunctionHeaderAst.usages.some(u => u.upper === 'F_MSG_CHECKINFAULTRANGE'),
        'Function body should preserve assignments to the function return variable'
    );

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

    const tcviewLintBlockSample = [
        "{tcview lint-disable unused-instance}",
        "fbMyTest : FB_MyTcUnitTest;",
        "{tcview lint-enable unused-instance}",
        "fbOther : FB_MyTcUnitTest;"
    ].join('\n');
    const tcviewBlockPragmas = parseTcviewLintPragmas(tcviewLintBlockSample);
    assert.ok(tcviewBlockPragmas.disabledByLine.get(1)?.has('unused-instance'));
    assert.ok(!tcviewBlockPragmas.disabledByLine.get(0)?.has('unused-instance'));
    assert.ok(!tcviewBlockPragmas.disabledByLine.get(3)?.has('unused-instance'));

    const tcviewLintInlineSample = "fbMyTest : FB_MyTcUnitTest; // tcview lint-ignore unused-instance";
    const tcviewInlinePragmas = parseTcviewLintPragmas(tcviewLintInlineSample);
    assert.ok(tcviewInlinePragmas.inlineIgnoresByLine.get(0)?.has('unused-instance'));

    const foreignLintSample = "fbMyTest : FB_MyTcUnitTest; // lint-ignore unused-instance";
    const foreignLintPragmas = parseTcviewLintPragmas(foreignLintSample);
    assert.ok(!foreignLintPragmas.inlineIgnoresByLine.get(0)?.has('unused-instance'));

    const multiRuleSample = [
        "{tcview lint-disable undefined-variable, duplicate-declaration}",
        "fbMyTest : FB_MyTcUnitTest;",
        "{tcview lint-enable duplicate-declaration}",
        "fbOther : FB_MyTcUnitTest;"
    ].join('\n');
    const multiRulePragmas = parseTcviewLintPragmas(multiRuleSample);
    assert.ok(multiRulePragmas.disabledByLine.get(1)?.has('undefined-variable'));
    assert.ok(multiRulePragmas.disabledByLine.get(1)?.has('duplicate-declaration'));
    assert.ok(multiRulePragmas.disabledByLine.get(3)?.has('undefined-variable'));
    assert.ok(!multiRulePragmas.disabledByLine.get(3)?.has('duplicate-declaration'));

    const beckhoffAnalysisSample = [
        "{analysis -33}",
        "fbMyTest : FB_MyTcUnitTest;",
        "{analysis +33}",
        "fbOther : FB_MyTcUnitTest;"
    ].join('\n');
    const beckhoffAnalysisPragmas = parseTcviewLintPragmas(beckhoffAnalysisSample);
    assert.ok(beckhoffAnalysisPragmas.disabledByLine.get(1)?.has('unused-instance'));
    assert.ok(!beckhoffAnalysisPragmas.disabledByLine.get(3)?.has('unused-instance'));

    const beckhoffAttributeSample = [
        "{attribute 'analysis' := '-33'}",
        "fbMyTest : FB_MyTcUnitTest;"
    ].join('\n');
    const beckhoffAttributePragmas = parseTcviewLintPragmas(beckhoffAttributeSample);
    assert.ok(beckhoffAttributePragmas.disabledByLine.get(1)?.has('unused-instance'));

    const noAnalysisSample = [
        "{attribute 'no-analysis'}",
        "fbMyTest : FB_MyTcUnitTest;"
    ].join('\n');
    const noAnalysisPragmas = parseTcviewLintPragmas(noAnalysisSample);
    assert.ok(noAnalysisPragmas.disabledByLine.get(1)?.has('*'));

    const qualifiedOnlyGlobalInfo = extractQualifiedOnlyUsageInfo([
        "{attribute 'qualified_only'}",
        'VAR_GLOBAL CONSTANT INTERNAL',
        '    bReady : BOOL;',
        '    nCount : INT;',
        'END_VAR'
    ].join('\n'), 'GVL_Test.TcGVL');
    assert.deepStrictEqual(
        [...(qualifiedOnlyGlobalInfo.globals.get('BREADY') ?? [])],
        ['GVL_Test']
    );
    assert.deepStrictEqual(
        [...(qualifiedOnlyGlobalInfo.globals.get('NCOUNT') ?? [])],
        ['GVL_Test']
    );

    const qualifiedOnlyEnumInfo = extractQualifiedOnlyUsageInfo([
        "TYPE E_DeviceMode : {attribute 'qualified_only'}",
        '(',
        '    Auto := 0,',
        '    Manual := 1',
        ');'
    ].join('\n'));
    assert.deepStrictEqual(
        [...(qualifiedOnlyEnumInfo.enums.get('AUTO') ?? [])],
        ['E_DeviceMode']
    );
    assert.deepStrictEqual(
        [...(qualifiedOnlyEnumInfo.enums.get('MANUAL') ?? [])],
        ['E_DeviceMode']
    );

    const qualifiedOnlyHeaderEnumInfo = extractQualifiedOnlyUsageInfo([
        "{attribute 'qualified_only'}",
        "{attribute 'strict'}",
        'TYPE E_TimeUnit :',
        '(',
        '    milliSeconds,',
        '    seconds',
        ');',
        'END_TYPE'
    ].join('\n'));
    assert.deepStrictEqual(
        [...(qualifiedOnlyHeaderEnumInfo.enums.get('MILLISECONDS') ?? [])],
        ['E_TimeUnit']
    );
    assert.deepStrictEqual(
        [...(qualifiedOnlyHeaderEnumInfo.enums.get('SECONDS') ?? [])],
        ['E_TimeUnit']
    );

    const commentedQualifiedOnlyEnumInfo = extractQualifiedOnlyUsageInfo([
        '// tag::adoc[]',
        "{attribute 'qualified_only'}",
        "{attribute 'strict'}",
        'TYPE E_IsoLikeDateTimeFormat :',
        '(',
        '\t// Date formats',
        '    DATE_ONLY,',
        '    DATE_TIME,',
        '',
        '\t// Time formats',
        '    TIME_ONLY',
        ');',
        'END_TYPE',
        '// end::adoc[]'
    ].join('\n'));
    assert.deepStrictEqual(
        [...(commentedQualifiedOnlyEnumInfo.enums.get('DATE_ONLY') ?? [])],
        ['E_IsoLikeDateTimeFormat']
    );
    assert.deepStrictEqual(
        [...(commentedQualifiedOnlyEnumInfo.enums.get('TIME_ONLY') ?? [])],
        ['E_IsoLikeDateTimeFormat']
    );

    const disabledQualifiedOnlyEnumInfo = extractQualifiedOnlyUsageInfo([
        "// {attribute 'qualified_only'}",
        'TYPE E_IsoLikeDateTimeFormat :',
        '(',
        '    DATE_ONLY,',
        '    DATE_TIME',
        ');',
        'END_TYPE'
    ].join('\n'));
    assert.ok(!disabledQualifiedOnlyEnumInfo.enums.has('DATE_ONLY'));
    assert.ok(!disabledQualifiedOnlyEnumInfo.enums.has('DATE_TIME'));

    const parsedTypeDeclarations = parseTwinCATTypeDeclarations([
        'TYPE ST_AnalogChannelStatus :',
        'STRUCT',
        '    bUnderrange : BOOL;',
        '    bOverrange : BOOL;',
        'END_STRUCT',
        'END_TYPE',
        '',
        "{attribute 'qualified_only'}",
        "{attribute 'strict'}",
        'TYPE E_TimeUnit :',
        '(',
        '    milliSeconds,',
        '    seconds',
        ');',
        'END_TYPE'
    ].join('\n'));
    assert.strictEqual(parsedTypeDeclarations.length, 2);
    assert.strictEqual(parsedTypeDeclarations[0].name, 'ST_AnalogChannelStatus');
    assert.strictEqual(parsedTypeDeclarations[0].kind, 'struct');
    assert.strictEqual(parsedTypeDeclarations[0].members.get('bUnderrange'), 'BOOL');
    assert.strictEqual(parsedTypeDeclarations[0].members.get('bOverrange'), 'BOOL');
    assert.strictEqual(parsedTypeDeclarations[1].name, 'E_TimeUnit');
    assert.strictEqual(parsedTypeDeclarations[1].kind, 'enum');
    assert.ok(parsedTypeDeclarations[1].members.has('milliSeconds'));
    assert.ok(parsedTypeDeclarations[1].members.has('seconds'));

    const commentedEnumDeclarations = parseTwinCATTypeDeclarations([
        'TYPE E_IsoLikeDateTimeFormat :',
        '(',
        '    // Date formats',
        '    DATE_ONLY,',
        '    DATE_TIME,',
        '    // Time formats',
        '    TIME_ONLY',
        ');',
        'END_TYPE'
    ].join('\n'));
    assert.strictEqual(commentedEnumDeclarations.length, 1);
    assert.ok(commentedEnumDeclarations[0].members.has('DATE_ONLY'));
    assert.ok(commentedEnumDeclarations[0].members.has('DATE_TIME'));
    assert.ok(commentedEnumDeclarations[0].members.has('TIME_ONLY'));

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

    const wrappedFunctionXml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<TcPlcObject Version="1.1.0.1">',
        '  <TcPlcObject_POU_Declaration><![CDATA[FUNCTION INTERNAL F_Msg_CheckInFaultRange : BOOL',
        'VAR_INPUT',
        '    bValue : BOOL;',
        'END_VAR]]></TcPlcObject_POU_Declaration>',
        '  <TcPlcObject_POU_Implementation_ST><![CDATA[F_Msg_CheckInFaultRange := bValue;]]></TcPlcObject_POU_Implementation_ST>',
        '</TcPlcObject>'
    ].join('\n');
    const wrappedFunctionSt = await interfaceConverter.convertXmlToST(wrappedFunctionXml);
    assert.ok(wrappedFunctionSt.includes('FUNCTION INTERNAL F_Msg_CheckInFaultRange : BOOL'));
    assert.ok(wrappedFunctionSt.includes('VAR_INPUT'));
    assert.ok(wrappedFunctionSt.includes('F_Msg_CheckInFaultRange := bValue;'));

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
