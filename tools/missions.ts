// The waypoint editor's missions (src/script/mission/flightPlan.ts), kept on the
// dev server as one JSON file each under data/missions/ - not assets/, whose
// watcher repacks the mods on every write. The published game has no server,
// so there the editor can neither list nor save.
//
//   GET    /api/missions        [{ id, name, area, flights, updated }]
//   GET    /api/missions/:id    the mission
//   POST   /api/missions        save; the id is the name slugged, returned as { id }
//   DELETE /api/missions/:id

import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { MISSION_ID_RE, Mission, missionId, validateMission } from '../src/script/mission/flightPlan';

export const MISSIONS_DIR = path.join(path.dirname(__dirname), 'data', 'missions');

function fileOf(dir: string, id: string): string | undefined {
    return MISSION_ID_RE.test(id) ? path.join(dir, `${id}.json`) : undefined;
}

export function listMissions(dir = MISSIONS_DIR): Array<{
    id: string; name: string; area?: string; flights: number; updated: string;
}> {
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => {
        const file = path.join(dir, f);
        try {
            const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Mission;
            return [{
                id: f.slice(0, -5), name: m.name, area: m.area, flights: m.flights.length,
                updated: fs.statSync(file).mtime.toISOString(),
            }];
        } catch {
            return [];
        }
    }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Writes a valid mission and returns its id; throws with the validator's errors otherwise. */
export function saveMission(m: unknown, dir = MISSIONS_DIR): string {
    const errors = validateMission(m);
    if (errors.length) {
        throw new Error(errors.join('; '));
    }
    const id = missionId((m as Mission).name);
    fs.mkdirSync(dir, { recursive: true });
    // Through a temporary file, so a crash mid-write never leaves half a mission.
    const file = fileOf(dir, id)!;
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(m, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
    return id;
}

export function missionsHandler(_req: Request, res: Response): void {
    res.json(listMissions());
}

export function getMissionHandler(req: Request<{ id: string }>, res: Response): void {
    const file = fileOf(MISSIONS_DIR, req.params.id);
    if (!file || !fs.existsSync(file)) {
        res.status(404).json({ error: 'no such mission' });
        return;
    }
    res.type('json').send(fs.readFileSync(file, 'utf8'));
}

export function saveMissionHandler(req: Request, res: Response): void {
    try {
        res.json({ id: saveMission(req.body) });
    } catch (err) {
        res.status(400).json({ error: (err as Error).message });
    }
}

export function deleteMissionHandler(req: Request<{ id: string }>, res: Response): void {
    const file = fileOf(MISSIONS_DIR, req.params.id);
    if (!file || !fs.existsSync(file)) {
        res.status(404).json({ error: 'no such mission' });
        return;
    }
    fs.unlinkSync(file);
    res.json({ ok: true });
}
