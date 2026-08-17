import * as fs from 'node:fs';
import * as path from 'node:path';
import { hawaldarHome } from './sandbox/workspace';

export interface DataHome {
	home: string;
	notesDir: string;
	knowledgeDir: string;
	lanceDir: string;
	notesDb: string;
	tasksDb: string;
	hawaldarDb: string;
	mastraDb: string;
	findingsDb: string;
	approvalsDb: string;
}

const SLUG_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function dataHomePaths(home = hawaldarHome()): DataHome {
	return {
		home,
		notesDir: path.join(home, 'notes'),
		knowledgeDir: path.join(home, 'knowledge'),
		lanceDir: path.join(home, 'lancedb'),
		notesDb: path.join(home, 'notes.db'),
		tasksDb: path.join(home, 'tasks.db'),
		hawaldarDb: path.join(home, 'hawaldar.db'),
		mastraDb: path.join(home, 'mastra.db'),
		findingsDb: path.join(home, 'findings.db'),
		approvalsDb: path.join(home, 'approvals.db'),
	};
}

/** Create ~/.hawaldar and notes/ if missing. SQLite files are created by their stores. */
export function ensureDataHome(home = hawaldarHome()): DataHome {
	const paths = dataHomePaths(home);
	fs.mkdirSync(paths.home, { recursive: true });
	fs.mkdirSync(paths.notesDir, { recursive: true });
	fs.mkdirSync(paths.knowledgeDir, { recursive: true });
	fs.mkdirSync(paths.lanceDir, { recursive: true });
	return paths;
}

export function sqliteFileUrl(filePath: string): string {
	return `file:${path.resolve(filePath).replace(/\\/g, '/')}`;
}

export function slugifyName(name: string, fallback: string): string {
	const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return SLUG_RE.test(slug) ? slug : fallback;
}

export function uniqueSlug(base: string, taken: string[]): string {
	if (!taken.includes(base) && SLUG_RE.test(base)) {
		return base;
	}
	let i = 2;
	while (taken.includes(`${base}-${i}`)) {
		i += 1;
	}
	return `${base}-${i}`;
}
