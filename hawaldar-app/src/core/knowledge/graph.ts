import type { NotesStore } from '../notes-store';
import type { SessionMetaStore } from '../session-meta';
import { clipSnippet } from '../session-meta';
import type { TaskStore } from '../tasks-store';
import { colorForKind, type GraphLinkDTO, type GraphNodeDTO, type KnowledgeGraphDTO } from './types';
import type { KnowledgeStore } from './store';

export async function buildKnowledgeGraph(input: {
	notes: NotesStore;
	tasks: TaskStore;
	sessions: SessionMetaStore;
	knowledge: KnowledgeStore;
	memory?: any;
}): Promise<KnowledgeGraphDTO> {
	const [notes, tasks, sessions, docs, chunks, edges, status] = await Promise.all([
		input.notes.list(),
		input.tasks.list(),
		input.sessions.list(),
		input.knowledge.listDocs(),
		input.knowledge.listChunks(500),
		input.knowledge.listEdges(),
		input.knowledge.snapshot(),
	]);

	const nodes = new Map<string, GraphNodeDTO>();
	const links: GraphLinkDTO[] = [];
	const addNode = (node: GraphNodeDTO) => {
		if (!nodes.has(node.id)) {
			nodes.set(node.id, node);
		}
	};
	const addLink = (source: string, target: string, kind: string) => {
		if (!source || !target || source === target) {
			return;
		}
		links.push({ source, target, kind });
	};

	for (const note of notes) {
		addNode({
			id: `note:${note.id}`,
			kind: 'note',
			title: note.title,
			snippet: note.path,
			source: note.path,
			color: colorForKind('note'),
			val: 3,
		});
	}
	for (const task of tasks) {
		addNode({
			id: `task:${task.id}`,
			kind: 'task',
			title: task.title,
			snippet: clipSnippet(`${task.listTitle || task.status} ${task.notes}`, 180),
			source: task.id,
			color: colorForKind('task'),
			val: 3,
		});
	}
	for (const session of sessions) {
		addNode({
			id: `chat:${session.id}`,
			kind: 'chat',
			title: session.title || 'Untitled',
			snippet: session.snippet,
			source: session.id,
			color: colorForKind('chat'),
			val: 3,
		});
	}

	if (input.memory) {
		for (const session of sessions.slice(0, 40)) {
			const wm = await readWorkingMemory(input.memory, session.id);
			if (!wm) {
				continue;
			}
			const id = `memory:${session.id}`;
			addNode({
				id,
				kind: 'memory',
				title: `Working memory · ${session.title || 'thread'}`,
				snippet: clipSnippet(wm, 240),
				source: session.id,
				color: colorForKind('memory'),
				val: 2,
			});
			addLink(`chat:${session.id}`, id, 'working-memory');
		}
	}

	for (const doc of docs) {
		if (doc.kind === 'note' || doc.kind === 'task' || doc.kind === 'chat') {
			continue;
		}
		addNode({
			id: doc.id,
			kind: doc.kind === 'doc' ? 'knowledge' : doc.kind,
			title: doc.title,
			snippet: doc.snippet,
			source: doc.sourceId,
			color: colorForKind(doc.kind === 'doc' ? 'knowledge' : doc.kind),
			val: 2,
		});
	}

	for (const chunk of chunks) {
		const parent = parentId(chunk.kind, chunk.sourceId, chunk.docId);
		if (chunk.index > 0) {
			continue;
		}
		if (parent && nodes.has(parent)) {
			addLink(parent, chunk.docId === parent ? parent : chunk.docId, 'contains');
		}
	}

	for (const edge of edges) {
		if (!nodes.has(edge.source)) {
			addNode({
				id: edge.source,
				kind: kindFromId(edge.source),
				title: labelFromId(edge.source),
				snippet: edge.kind,
				color: colorForKind(kindFromId(edge.source)),
				val: 1,
			});
		}
		if (!nodes.has(edge.target)) {
			addNode({
				id: edge.target,
				kind: kindFromId(edge.target),
				title: labelFromId(edge.target),
				snippet: edge.kind,
				color: colorForKind(kindFromId(edge.target)),
				val: 1,
			});
		}
		addLink(edge.source, edge.target, edge.kind);
		if (edge.kind === 'retrieved') {
			const ragId = `rag:${edge.id}`;
			addNode({
				id: ragId,
				kind: 'rag',
				title: 'RAG hit',
				snippet: `${labelFromId(edge.source)} → ${labelFromId(edge.target)}`,
				color: colorForKind('rag'),
				val: 1,
			});
			addLink(edge.source, ragId, 'rag');
			addLink(ragId, edge.target, 'rag');
		}
	}

	return {
		nodes: [...nodes.values()],
		links,
		status,
	};
}

async function readWorkingMemory(memory: any, threadId: string): Promise<string> {
	try {
		if (typeof memory.getWorkingMemory === 'function') {
			const value = await memory.getWorkingMemory({ threadId, resourceId: 'hawaldar' });
			if (typeof value === 'string' && value.trim()) {
				return value;
			}
			if (value && typeof value === 'object' && typeof value.workingMemory === 'string') {
				return value.workingMemory;
			}
		}
		if (typeof memory.getThreadById === 'function') {
			const thread = await memory.getThreadById({ threadId });
			const wm = thread?.metadata?.workingMemory;
			if (typeof wm === 'string') {
				return wm;
			}
		}
	} catch {
		/* optional */
	}
	return '';
}

function parentId(kind: string, sourceId: string, docId: string): string {
	if (kind === 'note' || kind === 'task' || kind === 'chat') {
		return `${kind}:${sourceId}`;
	}
	return docId;
}

function kindFromId(id: string): GraphNodeDTO['kind'] {
	const prefix = id.split(':')[0];
	if (prefix === 'note' || prefix === 'task' || prefix === 'chat' || prefix === 'memory' || prefix === 'rag') {
		return prefix;
	}
	if (prefix === 'playbook' || prefix === 'rule' || prefix === 'doc') {
		return prefix === 'doc' ? 'knowledge' : prefix;
	}
	return 'chunk';
}

function labelFromId(id: string): string {
	const parts = id.split(':');
	return parts.slice(1).join(':') || id;
}
