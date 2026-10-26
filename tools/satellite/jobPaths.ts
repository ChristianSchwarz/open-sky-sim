/**
 * The satellite's rule for the files a job names (tools/satellite/satellite.ts):
 * a root name, then plain names - tiles (planet/12/x/y.pdm), a script
 * (pytools/x.py), an extract (pbf/x.osm.pbf), the manifest - so new job kinds
 * need no new exe; no '.' or '..' segment, nothing absolute, no drive, no
 * backslash, nothing that climbs out of the job directory.
 */
export const JOB_PATH = /^[a-z]+(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+)+$/;

export const isJobPath = (rel: string): boolean => JOB_PATH.test(rel);
