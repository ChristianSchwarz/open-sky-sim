import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import type { Mission } from '../src/script/mission/flightPlan';
import { listMissions, saveMission } from './missions';

const MISSION: Mission = {
    version: 1,
    name: 'Island hop',
    area: 'Kanaren',
    flights: [{
        name: 'Viper 1',
        aircraftId: 'f16',
        control: 'ai',
        start: { kind: 'runway', airfield: 'GCLP', designator: '03L', lat: 27.93, lon: -15.39 },
        waypoints: [{ lat: 28.1, lon: -15.5, altM: 3000, speedMps: 220 }],
    }],
};

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'missions-'));
}

describe('mission storage', () => {
    it('saves under the slugged name and lists what it saved', () => {
        const dir = tempDir();
        assert.equal(saveMission(MISSION, dir), 'island-hop');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'island-hop.json'), 'utf8')), MISSION);
        const list = listMissions(dir);
        assert.equal(list.length, 1);
        assert.deepEqual({ ...list[0], updated: '' },
            { id: 'island-hop', name: 'Island hop', area: 'Kanaren', flights: 1, updated: '' });
        assert.deepEqual(fs.readdirSync(dir), ['island-hop.json']);
    });

    it('overwrites a mission saved again under the same name', () => {
        const dir = tempDir();
        saveMission(MISSION, dir);
        saveMission({ ...MISSION, flights: [] }, dir);
        assert.equal(listMissions(dir)[0].flights, 0);
    });

    it('refuses an invalid mission without writing anything', () => {
        const dir = tempDir();
        assert.throws(() => saveMission({ ...MISSION, version: 9 }, dir), /version/);
        assert.deepEqual(listMissions(dir), []);
    });

    it('skips files it cannot read and lists nothing for a missing folder', () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'broken.json'), '{');
        assert.deepEqual(listMissions(dir), []);
        assert.deepEqual(listMissions(path.join(dir, 'nope')), []);
    });
});
