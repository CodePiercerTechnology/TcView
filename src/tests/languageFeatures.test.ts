import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildAstAnalysis } from '../iecStAst';
import { applyFragmentSTToXml, extractFragmentSTFromXml } from '../twinCATFragmentCodec';

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

async function run(): Promise<void> {
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

    const inlineIfSample = 'IF NOT Reset THEN RETURN; END_IF';
    const inlineIfAst = buildAstAnalysis(inlineIfSample);
    assert.strictEqual(inlineIfAst.blockErrors.length, 0, 'Inline IF block should not create missing END_IF errors');
    assert.strictEqual(inlineIfAst.missingSemicolons.length, 0, 'Inline IF block should not require trailing semicolon');

    const fixturePath = path.resolve(process.cwd(), 'src', 'tests', 'fixtures', 'FB_IntegrationSample.TcPOU');
    const fixtureXml = fs.readFileSync(fixturePath, 'utf8');

    const methodFragment = extractFragmentSTFromXml(fixtureXml, 'Method:FB_Init');
    const propertyFragment = extractFragmentSTFromXml(fixtureXml, 'Property:SpeedCommand');

    const [methodSt, propertySt] = await Promise.all([methodFragment, propertyFragment]);
    assert.ok(methodSt.includes('VAR_INPUT'));
    assert.ok(methodSt.includes('// comment in declaration'));
    assert.ok(propertySt.includes('GET'));
    assert.ok(propertySt.includes('SET'));

    const updatedGetFragment = [
        'PROPERTY SpeedCommand : REAL',
        '',
        'GET',
        '',
        'SpeedCommand := rSpeedCommand + 1.0;',
        '',
        'END_PROPERTY'
    ].join('\n');

    const xmlAfterGet = await applyFragmentSTToXml(fixtureXml, 'PropertyGet:SpeedCommand', updatedGetFragment);
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
    assert.ok(xmlAfterMethod.includes('FB_Init := bInitRetains;'));
}

Promise.resolve(run()).then(() => {
    console.log('Language feature utility tests passed.');
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
