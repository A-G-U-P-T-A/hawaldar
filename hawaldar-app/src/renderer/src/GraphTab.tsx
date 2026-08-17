import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GraphNodeDTO, KnowledgeGraphDTO } from '../../preload/api';
import GraphScene from './GraphScene';
import { GraphIcon } from './navIcons';

const KINDS = ['note', 'task', 'chat', 'memory', 'knowledge', 'playbook', 'rule', 'rag'] as const;

export default function GraphTab() {
	const [data, setData] = useState<KnowledgeGraphDTO | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState('');
	const [kinds, setKinds] = useState<Set<string>>(() => new Set(KINDS));
	const [selected, setSelected] = useState<GraphNodeDTO | null>(null);
	const [webgl, setWebgl] = useState(true);
	const [webglReason, setWebglReason] = useState('');

	const load = useCallback(async () => {
		setError('');
		try {
			setData(await window.hawaldar.knowledgeGraph());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const filtered = useMemo(() => {
		if (!data) {
			return { nodes: [] as GraphNodeDTO[], links: [] };
		}
		const q = query.trim().toLowerCase();
		const nodes = data.nodes.filter((node) => {
			if (!kinds.has(normalizeKind(node.kind))) {
				return false;
			}
			if (!q) {
				return true;
			}
			return `${node.title} ${node.snippet} ${node.kind}`.toLowerCase().includes(q);
		});
		const ids = new Set(nodes.map((node) => node.id));
		const links = data.links.filter((link) => ids.has(String(link.source)) && ids.has(String(link.target)));
		return { nodes, links };
	}, [data, kinds, query]);

	const toggleKind = (kind: string) => {
		setKinds((prev) => {
			const next = new Set(prev);
			if (next.has(kind)) {
				next.delete(kind);
			} else {
				next.add(kind);
			}
			return next;
		});
	};

	const reindex = async () => {
		setBusy(true);
		setError('');
		try {
			await window.hawaldar.knowledgeReindex();
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const status = data?.status;

	return (
		<div className="graph-page">
			<div className="graph-toolbar">
				<div className="graph-toolbar-lead">
					<GraphIcon size={14} />
					<span>Memory · Knowledge · RAG</span>
					{status && (
						<span className="graph-meta">
							{status.mode}
							{status.vector ? ' · Lance' : ''}
							{` · ${status.docs} docs`}
						</span>
					)}
				</div>
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Filter nodes"
					aria-label="Filter graph nodes"
				/>
				<button type="button" className="btn" onClick={() => void load()} disabled={busy}>Refresh</button>
				<button type="button" className="btn" onClick={() => void reindex()} disabled={busy}>
					{busy ? 'Indexing…' : 'Reindex'}
				</button>
			</div>
			<div className="graph-filters" role="group" aria-label="Node types">
				{KINDS.map((kind) => (
					<button
						key={kind}
						type="button"
						className={`graph-chip${kinds.has(kind) ? ' on' : ''}`}
						onClick={() => toggleKind(kind)}
					>
						{kind}
					</button>
				))}
			</div>
			{error && <div className="graph-error">{error}</div>}
			<div className="graph-body">
				{webgl ? (
					<GraphScene
						nodes={filtered.nodes}
						links={filtered.links}
						onSelect={setSelected}
						onReady={(ok, reason) => {
							setWebgl(ok);
							setWebglReason(reason || '');
						}}
					/>
				) : (
					<div className="graph-stage">
						{webglReason && <div className="graph-fallback-note">{webglReason}</div>}
						<ul className="graph-fallback">
							{filtered.nodes.length === 0 && (
								<li className="graph-fallback-empty">No matching documents.</li>
							)}
							{filtered.nodes.map((node) => (
								<li key={node.id}>
									<button type="button" onClick={() => setSelected(node)}>
										<span className="graph-dot" style={{ background: node.color }} />
										<span className="graph-fallback-copy">
											<span className="graph-fallback-title">{node.title}</span>
											<span className="graph-fallback-kind">{node.kind}</span>
										</span>
									</button>
								</li>
							))}
						</ul>
					</div>
				)}
				<aside className="graph-detail">
					{selected ? (
						<>
							<div className="graph-detail-kind">{selected.kind}</div>
							<h2>{selected.title}</h2>
							<p>{selected.snippet || 'No snippet.'}</p>
							{selected.source && <div className="graph-detail-source">{selected.source}</div>}
						</>
					) : (
						<p className="graph-detail-empty">Click a node for title, snippet, and source.</p>
					)}
				</aside>
			</div>
		</div>
	);
}

function normalizeKind(kind: string): string {
	if (kind === 'doc') {
		return 'knowledge';
	}
	return kind;
}
