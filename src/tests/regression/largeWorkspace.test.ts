import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { extractFragmentSTFromXml } from '../../tcViewFragmentCodec';
import { TwinCATXmlConverter } from '../../tcViewXmlConverter';

type LargeWorkspaceGolden = {
    version: 1;
    workload: {
        pouCopies: number;
        interfaceCopies: number;
        structDutCopies: number;
        enumDutCopies: number;
        fragmentChecks: number;
    };
    digest: string;
    totalOutputBytes: number;
    fragmentDigest: string;
    fragmentBytes: number;
};

const fixturesDir = path.resolve(process.cwd(), 'src', 'tests', 'fixtures');
const goldenPath = path.resolve(process.cwd(), 'src', 'tests', 'regression', 'golden', 'perf', 'large-workspace.json');

function ensureParentDir(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readFixture(name: string): Promise<string> {
    return fs.promises.readFile(path.join(fixturesDir, name), 'utf8');
}

function normalizeGolden(data: LargeWorkspaceGolden): LargeWorkspaceGolden {
    return {
        version: 1,
        workload: {
            pouCopies: data.workload.pouCopies,
            interfaceCopies: data.workload.interfaceCopies,
            structDutCopies: data.workload.structDutCopies,
            enumDutCopies: data.workload.enumDutCopies,
            fragmentChecks: data.workload.fragmentChecks
        },
        digest: data.digest,
        totalOutputBytes: data.totalOutputBytes,
        fragmentDigest: data.fragmentDigest,
        fragmentBytes: data.fragmentBytes
    };
}

function compareOrUpdateGolden(actual: LargeWorkspaceGolden, updateGoldens: boolean): void {
    if (updateGoldens || !fs.existsSync(goldenPath)) {
        ensureParentDir(goldenPath);
        fs.writeFileSync(goldenPath, `${JSON.stringify(normalizeGolden(actual), null, 2)}\n`, 'utf8');
        return;
    }

    const expected = normalizeGolden(JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as LargeWorkspaceGolden);
    assert.deepStrictEqual(
        normalizeGolden(actual),
        expected,
        `Large-workspace regression mismatch in ${path.relative(process.cwd(), goldenPath)}`
    );
}

export async function runLargeWorkspaceRegressionTest(options?: { updateGoldens?: boolean }): Promise<void> {
    const updateGoldens = options?.updateGoldens ?? false;
    const converter = new TwinCATXmlConverter();

    const [pouXml, itfXml, structXml, enumXml] = await Promise.all([
        readFixture('FB_IntegrationSample.TcPOU'),
        readFixture('I_IntegrationSample.TcITF'),
        readFixture('ST_CiA402_Drive_PDO.TcDUT'),
        readFixture('E_DeviceMode.TcDUT')
    ]);

    const workload = {
        pouCopies: 220,
        interfaceCopies: 220,
        structDutCopies: 220,
        enumDutCopies: 220,
        fragmentChecks: 160
    };

    const outputHash = crypto.createHash('sha256');
    const fragmentHash = crypto.createHash('sha256');
    let totalOutputBytes = 0;
    let fragmentBytes = 0;
    const started = Date.now();

    const runConversions = async (xml: string, copies: number): Promise<void> => {
        for (let i = 0; i < copies; i++) {
            const st = await converter.convertXmlToST(xml);
            assert.ok(st.length > 0, 'Expected non-empty ST output in large-workspace regression test.');
            outputHash.update(st);
            totalOutputBytes += Buffer.byteLength(st, 'utf8');
        }
    };

    await runConversions(pouXml, workload.pouCopies);
    await runConversions(itfXml, workload.interfaceCopies);
    await runConversions(structXml, workload.structDutCopies);
    await runConversions(enumXml, workload.enumDutCopies);

    for (let i = 0; i < workload.fragmentChecks; i++) {
        if (i % 2 === 0) {
            const fragment = await extractFragmentSTFromXml(pouXml, 'Method:FB_Init');
            assert.ok(fragment.includes('METHOD FB_Init'), 'Expected METHOD fragment output in large-workspace regression test.');
            fragmentHash.update(fragment);
            fragmentBytes += Buffer.byteLength(fragment, 'utf8');
            continue;
        }

        const fragment = await extractFragmentSTFromXml(itfXml, 'Property:Speed');
        assert.ok(fragment.includes('PROPERTY Speed'), 'Expected PROPERTY fragment output in large-workspace regression test.');
        fragmentHash.update(fragment);
        fragmentBytes += Buffer.byteLength(fragment, 'utf8');
    }

    const elapsedMs = Date.now() - started;
    const totalConversions =
        workload.pouCopies +
        workload.interfaceCopies +
        workload.structDutCopies +
        workload.enumDutCopies;

    const maxRuntimeMs = Number.parseInt(process.env.TCVIEW_LARGE_WORKSPACE_MAX_MS ?? '25000', 10);
    assert.ok(
        Number.isFinite(maxRuntimeMs) && elapsedMs <= maxRuntimeMs,
        `Large-workspace regression runtime exceeded limit (${elapsedMs} ms > ${maxRuntimeMs} ms). ` +
        'Set TCVIEW_LARGE_WORKSPACE_MAX_MS to adjust this threshold for constrained environments.'
    );

    compareOrUpdateGolden({
        version: 1,
        workload,
        digest: outputHash.digest('hex'),
        totalOutputBytes,
        fragmentDigest: fragmentHash.digest('hex'),
        fragmentBytes
    }, updateGoldens);

    process.stdout.write(
        `[REGRESSION] Large workspace synthetic workload (${totalConversions} conversions, ${workload.fragmentChecks} fragments) completed in ${elapsedMs} ms\n`
    );
}
