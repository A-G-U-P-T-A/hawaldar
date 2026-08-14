import { useEffect, useState } from 'react';
import type { TaskDTO, TaskStatus } from '../../preload/api';
import Dropdown from './Dropdown';

const STATUSES: Array<{ value: TaskStatus; label: string }> = [
	{ value: 'open', label: 'open' },
	{ value: 'doing', label: 'doing' },
	{ value: 'done', label: 'done' },
];

export default function TasksSettings() {
	const [rows, setRows] = useState<TaskDTO[]>([]);
	const [draft, setDraft] = useState('');
	const [error, setError] = useState('');
	const [status, setStatus] = useState('');

	const refresh = async () => {
		setRows(await window.hawaldar.listTasks());
	};

	useEffect(() => {
		void refresh();
	}, []);

	const add = async () => {
		setError('');
		try {
			await window.hawaldar.upsertTask({ title: draft, status: 'open' });
			setDraft('');
			setStatus('Added');
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const persist = async (id: string, patch: { title?: string; status?: TaskStatus; notes?: string }) => {
		setError('');
		try {
			await window.hawaldar.upsertTask({ id, ...patch });
			setStatus('Saved');
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const toggleDone = async (row: TaskDTO) => {
		const next: TaskStatus = row.status === 'done' ? 'open' : 'done';
		setError('');
		try {
			await window.hawaldar.setTaskStatus(row.id, next);
			setStatus(next === 'done' ? 'Done' : 'Reopened');
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const remove = async (id: string) => {
		setError('');
		try {
			await window.hawaldar.removeTask(id);
			setStatus('Deleted');
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<section className="widget">
			<div className="widget-head">
				<h2 className="widget-title">Tasks</h2>
			</div>
			<p className="widget-help">
				Stored in <code>~/.hawaldar/tasks.db</code>. Changes save immediately.
			</p>
			<div className="table-wrap">
				<table className="data-table tools-table">
					<colgroup>
						<col className="col-check" />
						<col />
						<col className="col-status" />
						<col className="col-action" />
					</colgroup>
					<thead>
						<tr>
							<th scope="col">Done</th>
							<th scope="col">Title</th>
							<th scope="col">Status</th>
							<th scope="col" />
						</tr>
					</thead>
					<tbody>
						{rows.length === 0 && (
							<tr>
								<td colSpan={4} className="table-empty">No tasks yet.</td>
							</tr>
						)}
						{rows.map((row) => (
							<tr key={row.id}>
								<td className="col-check">
									<input
										type="checkbox"
										checked={row.status === 'done'}
										onChange={() => void toggleDone(row)}
										aria-label={`Mark ${row.title} done`}
									/>
								</td>
								<td>
									<input
										key={`${row.id}:${row.updatedAt}`}
										defaultValue={row.title}
										onBlur={(e) => {
											const next = e.target.value.trim();
											if (!next) {
												void refresh();
												return;
											}
											if (next !== row.title) {
												void persist(row.id, { title: next });
											}
										}}
										aria-label={`Title for ${row.id}`}
									/>
								</td>
								<td className="col-status">
									<Dropdown
										prefer="down"
										ariaLabel={`Status for ${row.title}`}
										value={row.status}
										options={STATUSES}
										onChange={(next) => void persist(row.id, { status: next as TaskStatus })}
									/>
								</td>
								<td className="col-action">
									<button type="button" className="btn" onClick={() => void remove(row.id)}>
										Remove
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<h3 className="widget-sub">Add task</h3>
			<div className="form-grid">
				<div className="field span-2">
					<label htmlFor="task-title">Title</label>
					<input
						id="task-title"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								void add();
							}
						}}
						placeholder="Follow up on scope confirmation"
					/>
				</div>
			</div>
			{error && <p className="widget-help widget-error">{error}</p>}
			<div className="widget-foot">
				<span className="widget-status">{status}</span>
				<button type="button" className="btn btn-primary" onClick={() => void add()}>Add task</button>
			</div>
		</section>
	);
}
