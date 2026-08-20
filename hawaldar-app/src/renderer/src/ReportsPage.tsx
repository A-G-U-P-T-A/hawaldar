import { useEffect, useMemo, useState } from 'react';
import type { ReportDTO } from '../../preload/api';
import { ReportsIcon } from './navIcons';
import { restoreRedactedAddresses } from './keepAddresses';
import { useI18n } from './i18n';
import { fuzzyMatch } from './sessionGroups';

interface Props {
	onOpenReport: (id: string, title: string) => void;
}

export default function ReportsPage({ onOpenReport }: Props) {
	const { t } = useI18n();
	const [rows, setRows] = useState<ReportDTO[]>([]);
	const [query, setQuery] = useState('');
	const [error, setError] = useState('');
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const list = await window.hawaldar.listReports();
				if (!cancelled) {
					setRows(list);
					setError('');
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
			} finally {
				if (!cancelled) {
					setLoaded(true);
				}
			}
		};
		void load();
		const off = window.hawaldar.onReportsChanged(() => void load());
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	const visible = useMemo(
		() => rows.filter((row) => fuzzyMatch(query, `${row.title} ${row.target} ${row.chatTitle} ${row.sessionId} ${row.id}`)),
		[rows, query],
	);

	return (
		<div className="reports-page">
			<div className="findings-toolbar">
				<div className="graph-toolbar-lead">
					<ReportsIcon size={14} />
					<span>{t('reports.title')}</span>
					{loaded && <span className="graph-meta">{t('reports.meta', { total: rows.length })}</span>}
				</div>
			</div>
			<div className="right-search reports-search">
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t('reports.search')}
					aria-label={t('reports.search')}
				/>
			</div>
			{error && <div className="graph-error">{error}</div>}
			<div className="findings-list">
				{loaded && rows.length === 0 && (
					<div className="findings-empty">
						<ReportsIcon size={28} />
						<p>{t('reports.empty')}</p>
						<p className="findings-empty-hint">{t('reports.emptyHint')}</p>
					</div>
				)}
				{loaded && rows.length > 0 && visible.length === 0 && (
					<div className="empty-rail">{t('reports.noMatch')}</div>
				)}
				{visible.map((row) => (
					<button
						key={row.id}
						type="button"
						className="report-card"
						onClick={() => onOpenReport(row.id, row.title)}
					>
						<span className="finding-title">{row.title}</span>
						<span className="finding-meta">
							{restoreRedactedAddresses(row.target) || t('reports.noTarget')}
							{row.chatTitle ? ` · ${row.chatTitle}` : ''}
							{row.sessionId ? ` · ${row.sessionId.slice(0, 8)}` : ''}
							{` · ${row.id}`}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
