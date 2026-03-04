import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { extractFragmentSTFromXml } from '../../tcViewFragmentCodec';
import { TwinCATXmlConverter } from '../../tcViewXmlConverter';

type RegressionCase = {
    name: string;
    goldenPath: string;
    produce: () => Promise<string>;
};

const fixturesDir = path.resolve(process.cwd(), 'src', 'tests', 'fixtures');
const goldenDir = path.resolve(process.cwd(), 'src', 'tests', 'regression', 'golden');

function normalizeText(value: string): string {
    return value.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

function ensureParentDir(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function compareOrUpdateGolden(goldenPath: string, actualRaw: string, updateGoldens: boolean): void {
    const actual = normalizeText(actualRaw);
    const exists = fs.existsSync(goldenPath);

    if (updateGoldens || !exists) {
        ensureParentDir(goldenPath);
        fs.writeFileSync(goldenPath, actual, 'utf8');
        return;
    }

    const expected = normalizeText(fs.readFileSync(goldenPath, 'utf8'));
    if (expected === actual) {
        return;
    }

    const expectedLines = expected.split('\n');
    const actualLines = actual.split('\n');
    const maxLines = Math.max(expectedLines.length, actualLines.length);
    for (let i = 0; i < maxLines; i++) {
        const expectedLine = expectedLines[i] ?? '<missing>';
        const actualLine = actualLines[i] ?? '<missing>';
        if (expectedLine !== actualLine) {
            assert.fail(
                `Regression mismatch in ${path.relative(process.cwd(), goldenPath)} at line ${i + 1}\n` +
                `Expected: ${expectedLine}\n` +
                `Actual:   ${actualLine}`
            );
        }
    }
}

function buildRegressionCases(): RegressionCase[] {
    const converter = new TwinCATXmlConverter();
    const readFixture = (name: string) => fs.promises.readFile(path.join(fixturesDir, name), 'utf8');

    return [
        {
            name: 'FB_IntegrationSample full ST',
            goldenPath: path.join(goldenDir, 'converter', 'FB_IntegrationSample.st'),
            produce: async () => converter.convertXmlToST(await readFixture('FB_IntegrationSample.TcPOU'))
        },
        {
            name: 'I_IntegrationSample full ST',
            goldenPath: path.join(goldenDir, 'converter', 'I_IntegrationSample.st'),
            produce: async () => converter.convertXmlToST(await readFixture('I_IntegrationSample.TcITF'))
        },
        {
            name: 'E_DeviceMode full ST',
            goldenPath: path.join(goldenDir, 'converter', 'E_DeviceMode.st'),
            produce: async () => converter.convertXmlToST(await readFixture('E_DeviceMode.TcDUT'))
        },
        {
            name: 'ST_CiA402_Drive_PDO full ST',
            goldenPath: path.join(goldenDir, 'converter', 'ST_CiA402_Drive_PDO.st'),
            produce: async () => converter.convertXmlToST(await readFixture('ST_CiA402_Drive_PDO.TcDUT'))
        },
        {
            name: 'FB_IntegrationSample fragment Method:FB_Init',
            goldenPath: path.join(goldenDir, 'fragments', 'FB_IntegrationSample.Method_FB_Init.st'),
            produce: async () => extractFragmentSTFromXml(await readFixture('FB_IntegrationSample.TcPOU'), 'Method:FB_Init')
        },
        {
            name: 'FB_IntegrationSample fragment Property:SpeedCommand',
            goldenPath: path.join(goldenDir, 'fragments', 'FB_IntegrationSample.Property_SpeedCommand.st'),
            produce: async () => extractFragmentSTFromXml(await readFixture('FB_IntegrationSample.TcPOU'), 'Property:SpeedCommand')
        },
        {
            name: 'I_IntegrationSample fragment Method:Reset',
            goldenPath: path.join(goldenDir, 'fragments', 'I_IntegrationSample.Method_Reset.st'),
            produce: async () => extractFragmentSTFromXml(await readFixture('I_IntegrationSample.TcITF'), 'Method:Reset')
        },
        {
            name: 'I_IntegrationSample fragment Property:Speed',
            goldenPath: path.join(goldenDir, 'fragments', 'I_IntegrationSample.Property_Speed.st'),
            produce: async () => extractFragmentSTFromXml(await readFixture('I_IntegrationSample.TcITF'), 'Property:Speed')
        },
        {
            name: 'I_IntegrationSample fragment PropertyGet:Speed (tree-only)',
            goldenPath: path.join(goldenDir, 'fragments', 'I_IntegrationSample.PropertyGet_Speed.st'),
            produce: async () => extractFragmentSTFromXml(await readFixture('I_IntegrationSample.TcITF'), 'PropertyGet:Speed')
        }
    ];
}

export async function runRegressionTests(options?: { updateGoldens?: boolean }): Promise<void> {
    const updateGoldens = options?.updateGoldens ?? false;
    const cases = buildRegressionCases();
    for (const testCase of cases) {
        const actual = await testCase.produce();
        compareOrUpdateGolden(testCase.goldenPath, actual, updateGoldens);
        process.stdout.write(`[REGRESSION] ${testCase.name}\n`);
    }
}

if (require.main === module) {
    const updateGoldens = process.argv.includes('--update') || process.env.TCVIEW_UPDATE_GOLDENS === '1';
    Promise.resolve(runRegressionTests({ updateGoldens })).then(() => {
        const modeLabel = updateGoldens ? 'updated' : 'verified';
        console.log(`Regression goldens ${modeLabel}.`);
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
