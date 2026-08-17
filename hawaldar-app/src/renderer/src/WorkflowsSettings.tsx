import { useEffect, useState } from 'react';
import type { CatalogItem, WorkflowDTO, WorkflowStepDTO } from '../../preload/api';
import Dropdown from './Dropdown';

const EMPTY_STEP: WorkflowStepDTO = { kind: 'tool', id: 'quick-scan' };

export default function WorkflowsSettings() {
	const [rows, setRows] = useState<WorkflowDTO[]>([]);
	const [tools, setTools] = useState<CatalogItem[]>([]);
	const [agents, setAgents] = useState<CatalogItem[]>([]);
	const [editing, setEditing] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [steps, setSteps] = useState<WorkflowStepDTO[]>([{ ...EMPTY_STEP }]);
	const [error, setError] = useState('');
	const [status, setStatus] = useState('');

	const refresh = async () => {
		const [workflows, toolList, agentList] = await Promise.all([
			window.hawaldar.listPlaybookWorkflows(),
			window.hawaldar.listTools(),
			window.hawaldar.listAgents(),
		]);
		setRows(workflows);
		setTools(toolList);
		setAgents(agentList);
	};

	useEffect(() => {
		void refresh();
	}, []);

	const startCreate = () => {
		setEditing('__new__');
		setName('');
		setSteps([{ ...EMPTY_STEP }]);
		setError('');
	};

	const startEdit = (row: WorkflowDTO) => {
		setEditing(row.id);
		setName(row.name);
		setSteps(row.steps.length > 0 ? row.steps.map((step) => ({ ...step })) : [{ ...EMPTY_STEP }]);
		setError('');
	};

	const cancelEdit = () => {
		setEditing(null);
		setError('');
	};

	const save = async () => {
		setError('');
		try {
			await window.hawaldar.upsertWorkflow({
				id: editing && editing !== '__new__' ? editing : undefined,
				name,
				steps,
				enabled: editing && editing !== '__new__'
					? rows.find((row) => row.id === editing)?.enabled
					: true,
			});
			setStatus('Saved');
			setEditing(null);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const toolOptions = tools.map((item) => ({
		value: item.id,
		label: item.label,
		detail: item.detail,
	}));
	const agentOptions = agents.map((item) => ({
		value: item.id,
		label: item.label,
		detail: item.detail,
	}));
	const workflowOptions = rows
		.filter((item) => item.id !== editing)
		.map((item) => ({
			value: item.id,
			label: item.name,
			detail: item.id,
		}));
	const optionsFor = (kind: WorkflowStepDTO['kind']) => {
		if (kind === 'agent') {
			return agentOptions;
		}
		if (kind === 'workflow') {
			return workflowOptions;
		}
		return toolOptions;
	};
	const defaultIdFor = (kind: WorkflowStepDTO['kind']) => {
		if (kind === 'agent') {
			return agentOptions[0]?.value || 'nmap';
		}
		if (kind === 'workflow') {
			return workflowOptions[0]?.value || 'pre-recon';
		}
		return toolOptions[0]?.value || 'quick-scan';
	};

	return (
		<section className="widget">
			<div className="widget-head">
				<h2 className="widget-title">Workflows</h2>
			</div>
			<p className="widget-help">
				Stored in <code>~/.hawaldar/hawaldar.db</code>. Tool, agent, or nested workflow steps. Independent tools/agents in a phase run in parallel. Validation and reporting stay sequential. Policy still owns scope; there is no exploit phase.
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
							<th scope="col">Steps</th>
							<th scope="col" />
							<th scope="col" />
						</tr>
					</thead>
					<tbody>
						{rows.length === 0 && (
							<tr>
								<td colSpan={5} className="table-empty">No workflows yet.</td>
							</tr>
						)}
						{rows.map((row) => (
							<tr key={row.id}>
								<td className="col-check">
									<input
										type="checkbox"
										checked={row.enabled}
										onChange={() => void window.hawaldar.setWorkflowEnabled(row.id, !row.enabled).then(refresh)}
										aria-label={`Enable ${row.name}`}
									/>
								</td>
								<td className="col-nowrap" title={row.id}>{row.name}</td>
								<td className="mono" title={row.steps.map((step) => `${step.kind}:${step.id}`).join(' → ')}>
									{row.steps.map((step) => step.id).join(' → ') || '—'}
								</td>
								<td className="col-action">
									<button type="button" className="btn" onClick={() => startEdit(row)}>Edit</button>
								</td>
								<td className="col-action">
									<button
										type="button"
										className="btn"
										disabled={row.builtin}
										onClick={() => void window.hawaldar.removeWorkflow(row.id).then(refresh)}
									>
										Remove
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<h3 className="widget-sub">{editing && editing !== '__new__' ? 'Edit workflow' : 'Add workflow'}</h3>
			{!editing ? (
				<div className="widget-foot">
					<span className="widget-status">{status}</span>
					<button type="button" className="btn" onClick={startCreate}>New workflow</button>
				</div>
			) : (
				<>
					<div className="form-grid">
						<div className="field span-2">
							<label htmlFor="wf-name">Name</label>
							<input
								id="wf-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Authorized recon"
							/>
						</div>
					</div>
					<div className="step-list">
						{steps.map((step, index) => (
							<div key={`${step.kind}-${index}`} className="step-row">
								<Dropdown
									prefer="down"
									ariaLabel={`Step ${index + 1} kind`}
									value={step.kind}
									options={[
										{ value: 'tool', label: 'tool' },
										{ value: 'agent', label: 'agent' },
										{ value: 'workflow', label: 'workflow' },
									]}
									onChange={(kind) => {
										const next = [...steps];
										const nextKind = kind as WorkflowStepDTO['kind'];
										next[index] = {
											kind: nextKind,
											id: defaultIdFor(nextKind),
										};
										setSteps(next);
									}}
								/>
								<Dropdown
									prefer="down"
									searchable
									searchPlaceholder="Search…"
									ariaLabel={`Step ${index + 1} id`}
									value={step.id}
									options={optionsFor(step.kind)}
									onChange={(id) => {
										const next = [...steps];
										next[index] = { ...step, id };
										setSteps(next);
									}}
								/>
								<button
									type="button"
									className="btn"
									disabled={index === 0}
									onClick={() => {
										const next = [...steps];
										[next[index - 1], next[index]] = [next[index], next[index - 1]];
										setSteps(next);
									}}
								>
									Up
								</button>
								<button
									type="button"
									className="btn"
									disabled={index === steps.length - 1}
									onClick={() => {
										const next = [...steps];
										[next[index + 1], next[index]] = [next[index], next[index + 1]];
										setSteps(next);
									}}
								>
									Down
								</button>
								<button
									type="button"
									className="btn"
									disabled={steps.length <= 1}
									onClick={() => setSteps(steps.filter((_, i) => i !== index))}
								>
									Remove
								</button>
							</div>
						))}
					</div>
					{error && <p className="widget-help widget-error">{error}</p>}
					<div className="widget-foot">
						<span className="widget-status">{status}</span>
						<button
							type="button"
							className="btn"
							onClick={() => setSteps([...steps, { ...EMPTY_STEP, id: toolOptions[0]?.value || 'quick-scan' }])}
						>
							Add step
						</button>
						<button type="button" className="btn btn-primary" onClick={() => void save()}>Save workflow</button>
						<button type="button" className="btn" onClick={cancelEdit}>Cancel</button>
					</div>
				</>
			)}
		</section>
	);
}
