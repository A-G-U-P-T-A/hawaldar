import { EXPLOIT_KIT_RE, SECRET_NAME_RE, type KnowledgeStore } from '../knowledge';
import { slugifyName } from '../data-home';

export const KNOWLEDGE_TOOL_IDS = ['knowledge-search', 'knowledge-ingest'] as const;

export function isKnowledgeTool(id: string): boolean {
	return (KNOWLEDGE_TOOL_IDS as readonly string[]).includes(id);
}

export function buildKnowledgeInputSchema(z: any, id: string) {
	if (id === 'knowledge-search') {
		return z.object({
			query: z.string().describe('Search notes, tasks, playbooks, chat summaries, and ingested docs (Lance RAG).'),
			topK: z.number().optional().describe('How many snippets to return (default 8, max 20).'),
		});
	}
	return z.object({
		title: z.string().describe('Short title for the knowledge document.'),
		text: z.string().describe('Recon or documentation text only. No exploit kits, payloads, or .env secrets.'),
		source: z.string().optional().describe('Optional source id or filename (not a secret path).'),
	});
}

export async function runKnowledgeTool(
	store: KnowledgeStore,
	id: string,
	input: { query?: string; topK?: number; title?: string; text?: string; source?: string },
) {
	if (id === 'knowledge-search') {
		const query = String(input.query ?? '').trim();
		if (!query) {
			return { ok: false, stdout: '', stderr: 'query is required.', exitCode: 1 };
		}
		const hits = await store.search(query, { topK: input.topK });
		if (hits.length === 0) {
			return { ok: true, stdout: 'No knowledge hits.', stderr: '', exitCode: 0 };
		}
		const stdout = hits.map((hit, index) => (
			`${index + 1}. [${hit.kind}/${hit.mode}] ${hit.title}\n${hit.text}`
		)).join('\n\n');
		return { ok: true, stdout, stderr: '', exitCode: 0 };
	}
	if (id === 'knowledge-ingest') {
		const title = String(input.title ?? '').trim();
		const text = String(input.text ?? '').trim();
		const source = String(input.source ?? (title || 'doc')).trim();
		if (!title || !text) {
			return { ok: false, stdout: '', stderr: 'title and text are required.', exitCode: 1 };
		}
		if (SECRET_NAME_RE.test(title) || SECRET_NAME_RE.test(source)) {
			return { ok: false, stdout: '', stderr: 'Refused: secret or .env paths are not ingested.', exitCode: 1 };
		}
		if (EXPLOIT_KIT_RE.test(title) || EXPLOIT_KIT_RE.test(text.slice(0, 2000))) {
			return { ok: false, stdout: '', stderr: 'Refused: exploit-kit or payload content is not ingested.', exitCode: 1 };
		}
		const result = await store.ingestText({
			kind: 'doc',
			sourceId: slugifyName(source, 'doc'),
			title,
			text,
		});
		return {
			ok: true,
			stdout: `Ingested “${title}” · ${result.chunks} chunk(s) · ${result.mode}`,
			stderr: '',
			exitCode: 0,
		};
	}
	return { ok: false, stdout: '', stderr: `Unknown tool: ${id}`, exitCode: 1 };
}
