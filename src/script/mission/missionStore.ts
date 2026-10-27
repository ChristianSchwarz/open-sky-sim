/**
 * The editor's side of the dev server's /api/missions (tools/missions.ts).
 * Only the dev server has it; on the published game every call rejects, and
 * {@link missionsAvailable} says so up front.
 */

import { Mission, validateMission } from './flightPlan';

export interface MissionSummary {
    id: string;
    name: string;
    area?: string;
    flights: number;
    /** ISO time of the last save. */
    updated: string;
}

/** Whether this page was served by a dev server that keeps missions. */
export async function missionsAvailable(): Promise<boolean> {
    try {
        const r = await fetch('/api/health');
        return r.ok && (await r.json()).missions === true;
    } catch {
        return false;
    }
}

export async function listMissions(): Promise<MissionSummary[]> {
    return call<MissionSummary[]>('/api/missions');
}

export async function loadMission(id: string): Promise<Mission> {
    const m = await call<unknown>(`/api/missions/${encodeURIComponent(id)}`);
    const errors = validateMission(m);
    if (errors.length) {
        throw new Error(`mission ${id}: ${errors.join('; ')}`);
    }
    return m as Mission;
}

/** Saves under the mission's name, slugged; resolves to that id. */
export async function saveMission(m: Mission): Promise<string> {
    const errors = validateMission(m);
    if (errors.length) {
        throw new Error(errors.join('; '));
    }
    const { id } = await call<{ id: string }>('/api/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
    });
    return id;
}

export async function deleteMission(id: string): Promise<void> {
    await call(`/api/missions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
    const r = await fetch(url, init);
    const body = await r.json().catch(() => undefined);
    if (!r.ok) {
        throw new Error(body?.error ?? `${url}: HTTP ${r.status}`);
    }
    return body as T;
}
