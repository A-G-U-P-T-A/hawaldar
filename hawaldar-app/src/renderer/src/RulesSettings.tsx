import { useEffect, useState } from 'react';
import type { CatalogItem, RuleDTO, RuleKind, WorkflowDTO } from '../../preload/api';
import Dropdown from './Dropdown';

const KINDS: Array<{ value: RuleKind; label: string }> = [
	{ value: 'require_service', label: 'Require service started' },
	{ value: 'max_timeout', label: 'Max timeout' },
	{ value: 'allowed_tools', label: 'Allowed tools' },
	{ value: 'blocked_tools', label: 'Block tools' },
];

export default function RulesSettings() {
	const [rows, setRows] = useState<RuleDTO[]>([]);
	const [workflows, setWorkflows] = useState<WorkflowDTO[]>([]);
	const [tools, setTools] = useState<CatalogItem[]>([]);
	const [agents, setAgents] = useState<CatalogItem[]>([]);
	const [editing, setEditing] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [kind, setKind] = useState<RuleKind>('require_service');
	const [workflowId, setWorkflowId] = useState('');
	const [serviceId, setServiceId] = useState('');
	const [timeoutMs, setTimeoutMs] = useState('180000');
	const [toolIds, setToolIds] = useState('');
	const [error, setError] = useState('');
	const [status, setStatus] = useState('');

	const refresh = async () => {
		const [rules, wfs, toolList, agentList] = await Promise.all([
			window.hawaldar.listRules(),
			window.hawaldar.listPlaybookWorkflows(),
			window.hawaldar.listTools(),
			window.hawaldar.listAgents(),
		]);
		setRows(rules);
		setWorkflows(wfs);
		setTools(toolList);
		setAgents(agentList.filter((item) => item.id !== 'orchestrator' && item.id !== 'policy'));
	};

	useEffect(() => {
		void refresh();
	}, []);

	const startCreate = () => {
		setEditing('__new__');
		setName('');
		setKind('require_service');
		setWorkflowId('');
		setServiceId(agents[0]?.id || 'nmap');
		setTimeoutMs('180000');
		setToolIds(tools.map((item) => item.id.replace(/ · off$/, '')).join('\n'));
		setError('');
	};

	const startEdit = (row: RuleDTO) => {
		setEditing(row.id);
		setName(row.name);
		setKind(row.kind);
		setWorkflowId(row.definition.workflowId || '');
		setServiceId(row.definition.serviceId || '');
		setTimeoutMs(String(row.definition.timeoutMs || 180_000));
		setToolIds((row.definition.toolIds || []).join('\n'));
		setError('');
	};

	const save = async () => {
		setError('');
		try {
			await window.hawaldar.upsertRule({
				id: editing && editing !== '__new__' ? editing : undefined,
				name,
				kind,
				enabled: editing && editing !== '__new__'
					? rows.find((row) => row.id === editing)?.enabled
					: true,
				definition: {
					workflowId: workflowId || undefined,
					serviceId: kind === 'require_service' ? (serviceId || undefined) : undefined,
					timeoutMs: kind === 'max_timeout' ? Number(timeoutMs) : undefined,
					toolIds: kind === 'allowed_tools' || kind === 'blocked_tools'
						? toolIds.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
						: undefined,
				},
			});
			setStatus('Saved');
			setEditing(null);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const summarize = (row: RuleDTO): string => {
		const scope = row.definition.workflowId ? row.definition.workflowId : 'all workflows';
		if (row.kind === 'require_service') {
			return `${scope} · service ${row.definition.serviceId || '(step agents)'}`;
		}
		if (row.kind === 'max_timeout') {
			return `${scope} · ${row.definition.timeoutMs || 0}ms`;
		}
		if (row.kind === 'blocked_tools') {
			return `${scope} · block ${(row.definition.toolIds || []).length} tools`;
		}
		return `${scope} · allow ${(row.definition.toolIds || []).length} tools`;
	};

	return (
		<section className="widget">
			<div className="widget-head">
				<h2 className="widget-title">Rules</h2>
			</div>
			<p className="widget-help">
				Stored in <code>~/.hawaldar/hawaldar.db</code>. Applied on workflow run and each tool execute. Scope stays in Policy.
			</p>
			<div className="table-wrap">
				<table className="data-table tools-table">
					<colgroup>
						<col className="col-check" />
						<col className="col-tool" />
						<col />
						<col className="col-action" />
						<col className="col-action" />
					</colgroup>
					<thead>
						<tr>
							<th scope="col">On</th>
							<th scope="col">Name</th>
							<th scope="col">Definition</th>
							<th scope="col" />
							<th scope="col" />
						</tr>
					</thead>
					<tbody>
						{rows.length === 0 && (
							<tr>
								<td colSpan={5} className="table-empty">No rules yet.</td>
							</tr>
						)}
						{rows.map((row) => (
							<tr key={row.id}>
								<td className="col-check">
									<input
										type="checkbox"
										checked={row.enabled}
										onChange={() => void window.hawaldar.setRuleEnabled(row.id, !row.enabled).then(refresh)}
										aria-label={`Enable ${row.name}`}
									/>
								</td>
								<td className="col-nowrap" title={row.kind}>{row.name}</td>
								<td className="mono" title={summarize(row)}>{summarize(row)}</td>
								<td className="col-action">
									<button type="button" className="btn" onClick={() => startEdit(row)}>Edit</button>
								</td>
								<td className="col-action">
									<button type="button" className="btn" onClick={() => void window.hawaldar.removeRule(row.id).then(refresh)}>
										Remove
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<h3 className="widget-sub">{editing && editing !== '__new__' ? 'Edit rule' : 'Add rule'}</h3>
			{!editing ? (
				<div className="widget-foot">
					<span className="widget-status">{status}</span>
					<button type="button" className="btn" onClick={startCreate}>New rule</button>
				</div>
			) : (
				<>
					<div className="form-grid">
						<div className="field">
							<label htmlFor="rule-name">Name</label>
							<input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Require nmap started" />
						</div>
						<div className="field">
							<label>Kind</label>
							<Dropdown
								prefer="down"
								ariaLabel="Rule kind"
								value={kind}
								options={KINDS}
								onChange={(next) => setKind(next as RuleKind)}
							/>
						</div>
						<div className="field">
							<label>Applies to</label>
							<Dropdown
								prefer="down"
								ariaLabel="Workflow scope"
								value={workflowId || '__all__'}
								options={[
									{ value: '__all__', label: 'All workflows' },
									...workflows.map((item) => ({ value: item.id, label: item.name, detail: item.id })),
								]}
								onChange={(next) => setWorkflowId(next === '__all__' ? '' : next)}
							/>
						</div>
						{kind === 'require_service' && (
							<div className="field">
								<label>Service</label>
								<Dropdown
									prefer="down"
									searchable
									ariaLabel="Service"
									value={serviceId || '__steps__'}
									options={[
										{ value: '__steps__', label: 'Each step’s agent' },
										...agents.map((item) => ({ value: item.id, label: item.label, detail: item.id })),
									]}
									onChange={(next) => setServiceId(next === '__steps__' ? '' : next)}
								/>
							</div>
						)}
						{kind === 'max_timeout' && (
							<div className="field">
								<label htmlFor="rule-timeout">Timeout (ms)</label>
								<input
									id="rule-timeout"
									className="mono-input"
									value={timeoutMs}
									onChange={(e) => setTimeoutMs(e.target.value)}
								/>
							</div>
						)}
						{(kind === 'allowed_tools' || kind === 'blocked_tools') && (
							<div className="field span-2">
								<label htmlFor="rule-tools">
									{kind === 'blocked_tools' ? 'Blocked tool ids (one per line)' : 'Allowed tool ids (one per line)'}
								</label>
								<textarea
									id="rule-tools"
									className="mono-input"
									rows={6}
									value={toolIds}
									onChange={(e) => setToolIds(e.target.value)}
									spellCheck={false}
								/>
							</div>
						)}
					</div>
					{error && <p className="widget-help widget-error">{error}</p>}
					<div className="widget-foot">
						<span className="widget-status">{status}</span>
						<button type="button" className="btn btn-primary" onClick={() => void save()}>Save rule</button>
						<button type="button" className="btn" onClick={() => { setEditing(null); setError(''); }}>Cancel</button>
					</div>
				</>
			)}
		</section>
	);
}
