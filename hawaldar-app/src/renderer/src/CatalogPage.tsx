import type { CatalogItem } from '../../preload/api';
import PageShell from './PageShell';

const TITLES: Record<string, string> = {
	agents: 'Agents',
	tools: 'Tools',
	workflows: 'Workflows',
	providers: 'Providers',
	traces: 'Traces',
	logs: 'Logs',
};

const COLUMNS: Record<string, [string, string]> = {
	agents: ['Agent', 'Role'],
	tools: ['Tool', 'Source'],
	workflows: ['Workflow', 'Id'],
	providers: ['Provider', 'Detail'],
	traces: ['Trace', 'Detail'],
	logs: ['Level', 'Message'],
};

interface CatalogProps {
	view: string;
	items: CatalogItem[];
	onClose: () => void;
	onSelect?: (item: CatalogItem) => void;
}

export default function CatalogPage({ view, items, onClose, onSelect }: CatalogProps) {
	const title = TITLES[view] || view;
	const [nameCol, detailCol] = COLUMNS[view] || ['Name', 'Detail'];
	const selectable = Boolean(onSelect);

	return (
		<PageShell
			title={title}
			actions={<button type="button" className="btn" onClick={onClose}>Back to chat</button>}
		>
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">{title}</h2>
				</div>
				<div className="table-wrap">
					<table className="data-table">
						<colgroup>
							<col className="col-tool" />
							<col />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">{nameCol}</th>
								<th scope="col">{detailCol}</th>
							</tr>
						</thead>
						<tbody>
							{items.length === 0 && (
								<tr>
									<td colSpan={2} className="table-empty">Nothing here yet.</td>
								</tr>
							)}
							{items.map((item) => (
								<tr
									key={item.id}
									className={selectable ? 'clickable' : undefined}
									onClick={selectable ? () => onSelect?.(item) : undefined}
								>
									<td className="col-nowrap" title={item.label}>{item.label}</td>
									<td className="mono" title={item.detail}>{item.detail || '—'}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
		</PageShell>
	);
}

function formatCell(value: unknown): string {
	if (value == null) return '—';
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	if (typeof value === 'number') {
		if (value > 1e12) return new Date(value).toLocaleString();
		return String(value);
	}
	if (typeof value === 'string') return value || '—';
	if (Array.isArray(value)) {
		if (value.length === 0) return '—';
		if (value.every((item) => typeof item === 'string' || typeof item === 'number')) {
			return value.map(String).join(', ');
		}
		return `${value.length} items`;
	}
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

function isObjectArray(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value)
		&& value.length > 0
		&& value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
}

const PREFERRED_COLS = ['id', 'label', 'name', 'ok', 'enabled', 'source', 'agentId', 'role', 'key', 'type', 'level', 'detail', 'message', 'reason'];

function columnsFor(rows: Record<string, unknown>[]): string[] {
	const keys = new Set<string>();
	for (const row of rows.slice(0, 8)) {
		for (const key of Object.keys(row)) keys.add(key);
	}
	const ordered = PREFERRED_COLS.filter((key) => keys.has(key));
	for (const key of keys) {
		if (!ordered.includes(key) && ordered.length < 5) ordered.push(key);
	}
	return ordered.slice(0, 5);
}

interface StatusProps {
	status: Record<string, unknown> | null;
	onClose: () => void;
}

export function StatusPage({ status, onClose }: StatusProps) {
	const entries = Object.entries(status || {});
	const scalars = entries.filter(([, value]) => !isObjectArray(value));
	const tables = entries.filter(([, value]) => isObjectArray(value)) as Array<[string, Record<string, unknown>[]]>;

	return (
		<PageShell
			title="Status"
			actions={<button type="button" className="btn" onClick={onClose}>Back to chat</button>}
		>
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Overview</h2>
				</div>
				<div className="table-wrap">
					<table className="data-table">
						<colgroup>
							<col className="col-tool" />
							<col />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">Key</th>
								<th scope="col">Value</th>
							</tr>
						</thead>
						<tbody>
							{!status && (
								<tr>
									<td colSpan={2} className="table-empty">Loading status…</td>
								</tr>
							)}
							{status && scalars.length === 0 && (
								<tr>
									<td colSpan={2} className="table-empty">No status yet.</td>
								</tr>
							)}
							{scalars.map(([key, value]) => (
								<tr key={key}>
									<td className="col-nowrap">{key}</td>
									<td className="mono" title={formatCell(value)}>{formatCell(value)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
			{tables.map(([name, rows]) => {
				const cols = columnsFor(rows);
				return (
					<section key={name} className="widget">
						<div className="widget-head">
							<h2 className="widget-title">{name}</h2>
						</div>
						<div className="table-wrap">
							<table className="data-table">
								<thead>
									<tr>
										{cols.map((col) => (
											<th key={col} scope="col">{col}</th>
										))}
									</tr>
								</thead>
								<tbody>
									{rows.map((row, index) => (
										<tr key={String(row.id ?? row.name ?? index)}>
											{cols.map((col) => {
												const text = formatCell(row[col]);
												return (
													<td key={col} className="col-nowrap" title={text}>{text}</td>
												);
											})}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>
				);
			})}
		</PageShell>
	);
}
