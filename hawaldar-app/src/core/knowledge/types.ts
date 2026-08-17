export type KnowledgeKind =
	| 'note'
	| 'task'
	| 'playbook'
	| 'rule'
	| 'chat'
	| 'memory'
	| 'doc'
	| 'rag'
	| 'chunk';

export interface KnowledgeDoc {
	id: string;
	kind: KnowledgeKind;
	sourceId: string;
	title: string;
	text: string;
	snippet: string;
	updatedAt: number;
}

export interface KnowledgeChunk {
	id: string;
	docId: string;
	kind: KnowledgeKind;
	sourceId: string;
	title: string;
	text: string;
	index: number;
}

export interface KnowledgeHit {
	id: string;
	docId: string;
	kind: KnowledgeKind;
	sourceId: string;
	title: string;
	text: string;
	score: number;
	mode: 'vector' | 'keyword';
}

export interface KnowledgeStatus {
	lanceDir: string;
	vector: boolean;
	embedder: boolean;
	mode: 'vector' | 'keyword';
	docs: number;
	chunks: number;
	dimension: number;
	error?: string;
}

export interface GraphNodeDTO {
	id: string;
	kind: KnowledgeKind | 'note' | 'task' | 'chat' | 'memory' | 'knowledge' | 'rag' | 'playbook' | 'rule' | 'chunk' | 'doc';
	title: string;
	snippet: string;
	source?: string;
	color: string;
	val?: number;
}

export interface GraphLinkDTO {
	source: string;
	target: string;
	kind: string;
}

export interface KnowledgeGraphDTO {
	nodes: GraphNodeDTO[];
	links: GraphLinkDTO[];
	status: KnowledgeStatus;
}

export const GRAPH_KIND_COLORS: Record<string, string> = {
	note: '#7aa2f7',
	task: '#89d185',
	chat: '#c8c8c8',
	memory: '#edc85a',
	knowledge: '#9d7cd8',
	doc: '#9d7cd8',
	rag: '#0078d4',
	playbook: '#ce9178',
	rule: '#c586c0',
	chunk: '#8a8a8a',
};

export function colorForKind(kind: string): string {
	return GRAPH_KIND_COLORS[kind] ?? '#9d9d9d';
}

export const SECRET_NAME_RE = /(?:^|[\\/])(?:\.env(?:\..+)?|credentials(?:\.[a-z0-9]+)?|secrets?(?:\.[a-z0-9]+)?|.*\.(?:pem|key|p12|pfx))$/i;
export const EXPLOIT_KIT_RE = /msfvenom|exploit[/\s-]?kit|payload\s*generator|meterpreter|reverse\s*shell\s*payload/i;
