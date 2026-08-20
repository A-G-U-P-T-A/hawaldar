import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
	CatalogItem,
	EngagementRunDTO,
	FindingClass,
	FindingDTO,
	FindingSeverity,
	FindingStatus,
} from '../../preload/api';
import { FindingsIcon, DeleteIcon } from './navIcons';
import { restoreRedactedAddresses } from './keepAddresses';
import { useI18n } from './i18n';
import Dropdown from './Dropdown';
import {
	ALL_CHATS,
	THIS_CHAT,
	canInformFinding,
	canRetestFinding,
	chatIdSlice,
	isUnassignedSession,
	threadLabel,
	toFindingsListFilter,
	useFindingsChatScope,
} from './findingsScope';

const SEVERITIES: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEV_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const STATUS_CHIPS: Array<{ id: FindingStatus | 'all'; labelKey: string }> = [
	{ id: 'all', labelKey: 'findings.all' },
	{ id: 'confirmed', labelKey: 'findings.confirmed' },
	{ id: 'hypothesis', labelKey: 'findings.hypothesis' },
	{ id: 'unconfirmed', labelKey: 'findings.unconfirmed' },
	{ id: 'not-exploitable', labelKey: 'findings.notExploitable' },
	{ id: 'informed', labelKey: 'findings.informed' },
	{ id: 'fixed', labelKey: 'findings.fixed' },
];

const CLASS_CHIPS: FindingClass[] = ['injection', 'xss', 'ssrf', 'auth', 'csrf', 'ssti', 'idor', 'version', 'other'];

const IDLE_STAGES = [
	{ id: 'pre-recon', labelKey: 'findings.stage.pre-recon' },
	{ id: 'recon-surface', labelKey: 'findings.stage.recon-surface' },
	{ id: 'vuln-detect', labelKey: 'findings.stage.vuln-detect' },
	{ id: 'poc-validate', labelKey: 'findings.stage.poc-validate' },
	{ id: 'validate', labelKey: 'findings.stage.validate' },
	{ id: 'report', labelKey: 'findings.stage.report' },
];

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function fmtElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function fmtTime(ts: number): string {
	if (!ts) {
		return '';
	}
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return '';
	}
}

export default function FindingsPage({
	activeSessionId,
	onOpenReport,
}: {
	activeSessionId?: string;
	onOpenReport?: (id: string, title: string) => void;
}) {
	const { t } = useI18n();
	const [findings, setFindings] = useState<FindingDTO[]>([]);
	const [threads, setThreads] = useState<CatalogItem[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [run, setRun] = useState<EngagementRunDTO | null>(null);
	const [error, setError] = useState('');
	const [exportBusy, setExportBusy] = useState(false);
	const [reportNote, setReportNote] = useState('');
	const [confirmClear, setConfirmClear] = useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	const [sevFilter, setSevFilter] = useState<FindingSeverity | null>(null);
	const [statusFilter, setStatusFilter] = useState<FindingStatus | 'all'>('all');
	const [classFilter, setClassFilter] = useState<FindingClass | 'all'>('all');
	const [chatFilter, setChatFilter] = useFindingsChatScope(activeSessionId);
	const [targetQuery, setTargetQuery] = useState('');
	const [busyId, setBusyId] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [now, setNow] = useState(() => Date.now());

	const listFilter = useMemo(
		() => toFindingsListFilter(chatFilter, activeSessionId, targetQuery.trim() || undefined),
		[chatFilter, activeSessionId, targetQuery],
	);

	const refresh = useCallback(async () => {
		try {
			const [rows, chats] = await Promise.all([
				window.hawaldar.listFindings(listFilter),
				window.hawaldar.listThreads().catch(() => [] as CatalogItem[]),
			]);
			setFindings(rows);
			setThreads(chats);
			setError('');
		} catch (err) {
			setError(errText(err));
		} finally {
			setLoaded(true);
		}
	}, [listFilter]);

	useEffect(() => {
		void refresh();
		void window.hawaldar.getEngagementState()
			.then((state) => setRun(state))
			.catch(() => undefined);
		const offFindings = window.hawaldar.onFindingsChanged(() => void refresh());
		const offEngagement = window.hawaldar.onEngagementEvent((next) => setRun(next));
		return () => {
			offFindings();
			offEngagement();
		};
	}, [refresh]);

	const runActive = Boolean(run && !run.finishedAt);
	useEffect(() => {
		if (!runActive) {
			return;
		}
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [runActive]);

	const severityCounts = useMemo(() => {
		const counts = new Map<FindingSeverity, number>();
		for (const finding of findings) {
			counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
		}
		return counts;
	}, [findings]);

	const visible = useMemo(() => {
		const filtered = findings.filter((finding) => {
			if (sevFilter && finding.severity !== sevFilter) {
				return false;
			}
			if (statusFilter !== 'all' && finding.status !== statusFilter) {
				return false;
			}
			if (classFilter !== 'all' && finding.vulnClass !== classFilter) {
				return false;
			}
			return true;
		});
		return [...filtered].sort((a, b) => (
			SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.updatedAt - a.updatedAt
		));
	}, [findings, sevFilter, statusFilter, classFilter]);

	const toggleExpanded = (id: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const exportReport = async () => {
		setExportBusy(true);
		setError('');
		try {
			const result = await window.hawaldar.exportFindingsReport({
				sessionId: listFilter.sessionId || undefined,
				target: listFilter.target,
			});
			setReportNote(t('findings.reportSaved', { path: result.displayPath, count: result.findings }));
			if (result.id) {
				onOpenReport?.(result.id, result.title || t('findings.title'));
			}
		} catch (err) {
			setError(errText(err));
		} finally {
			setExportBusy(false);
		}
	};

	const inform = async (id: string) => {
		setBusyId(id);
		setError('');
		try {
			await window.hawaldar.informFinding(id);
			await refresh();
		} catch (err) {
			setError(errText(err));
		} finally {
			setBusyId(null);
		}
	};

	const retest = async (finding: FindingDTO) => {
		setBusyId(finding.id);
		setError('');
		try {
			const result = await window.hawaldar.retestFinding(finding.id);
			setReportNote(result.reason);
			await refresh();
			if (result.offerReport) {
				setReportNote(`${result.reason} ${t('findings.offerReport')}`);
			}
		} catch (err) {
			setError(errText(err));
		} finally {
			setBusyId(null);
		}
	};

	const exportOne = async (finding: FindingDTO) => {
		setExportBusy(true);
		setError('');
		try {
			const result = await window.hawaldar.exportFindingsReport({
				title: finding.title,
				sessionId: finding.sessionId || undefined,
				target: finding.target || undefined,
			});
			if (result.id) {
				onOpenReport?.(result.id, finding.title);
			}
		} catch (err) {
			setError(errText(err));
		} finally {
			setExportBusy(false);
		}
	};

	const clearAll = async () => {
		if (!confirmClear) {
			setConfirmClear(true);
			return;
		}
		setConfirmClear(false);
		setError('');
		try {
			await window.hawaldar.clearFindings();
			setReportNote('');
			await refresh();
		} catch (err) {
			setError(errText(err));
		}
	};

	const removeFinding = async (id: string) => {
		if (confirmDeleteId !== id) {
			setConfirmDeleteId(id);
			return;
		}
		setConfirmDeleteId(null);
		setError('');
		try {
			await window.hawaldar.removeFinding(id);
			setExpanded((prev) => {
				if (!prev.has(id)) {
					return prev;
				}
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
			await refresh();
		} catch (err) {
			setError(errText(err));
		}
	};

	const confirmedCount = findings.filter((finding) => finding.status === 'confirmed' || finding.status === 'informed').length;
	const filtering = Boolean(sevFilter) || statusFilter !== 'all' || classFilter !== 'all';
	const chatOptions = [
		{ value: THIS_CHAT, label: t('findings.thisChat') },
		{ value: ALL_CHATS, label: t('findings.allChats') },
		...threads.map((item) => ({ value: item.id, label: threadLabel(item) })),
	];
	const threadById = useMemo(() => new Map(threads.map((item) => [item.id, item])), [threads]);

	return (
		<div className="findings-page">
			<div className="findings-toolbar">
				<div className="graph-toolbar-lead">
					<FindingsIcon size={14} />
					<span>{t('findings.title')}</span>
					{loaded && (
						<span className="graph-meta">
							{t('findings.meta', { total: findings.length, confirmed: confirmedCount })}
						</span>
					)}
				</div>
				{run && (
					<span className={`findings-run${runActive ? ' active' : ''}`} title={run.runId}>
						<span className="findings-run-name">{run.workflowName}</span>
						{run.target && <span className="findings-run-target">{run.target}</span>}
						<span className="findings-run-state">
							{runActive
								? `running · ${fmtElapsed(now - run.startedAt)}`
								: run.ok === false
									? `failed · ${fmtElapsed(run.finishedAt - run.startedAt)}`
									: `done · ${fmtElapsed(run.finishedAt - run.startedAt)}`}
						</span>
					</span>
				)}
				<div className="findings-actions">
					<button
						type="button"
						className="btn"
						disabled={exportBusy || findings.length === 0}
						onClick={() => void exportReport()}
					>
						{exportBusy ? t('findings.exporting') : t('findings.export')}
					</button>
					<button
						type="button"
						className={`btn${confirmClear ? ' btn-danger' : ''}`}
						disabled={findings.length === 0}
						onClick={() => void clearAll()}
						onBlur={() => setConfirmClear(false)}
					>
						{confirmClear ? t('findings.confirmClear') : t('findings.clear')}
					</button>
				</div>
			</div>
			<div className="findings-scope">
				<Dropdown
					compact
					value={chatFilter}
					options={chatOptions}
					onChange={setChatFilter}
					ariaLabel={t('findings.filterChat')}
				/>
				<input
					type="search"
					className="findings-target-search"
					value={targetQuery}
					onChange={(event) => setTargetQuery(event.target.value)}
					placeholder={t('findings.filterTarget')}
					aria-label={t('findings.filterTarget')}
				/>
			</div>
			{reportNote && <div className="findings-report-note">{reportNote}</div>}

			<div className="phase-rail" role="list" aria-label="Engagement phases">
				{run
					? (run.phases ?? []).map((phase) => (
						<div
							key={phase.id}
							className={`phase-step is-${phase.status}`}
							role="listitem"
							title={phase.detail || `${phase.label}: ${phase.status}`}
						>
							<span className="phase-dot" aria-hidden="true" />
							<span className="phase-label">{phase.label}</span>
						</div>
					))
					: IDLE_STAGES.map((stage) => (
						<div key={stage.id} className="phase-step is-idle" role="listitem" title={t('findings.idlePhase')}>
							<span className="phase-dot" aria-hidden="true" />
							<span className="phase-label">{t(stage.labelKey)}</span>
						</div>
					))}
			</div>

			{findings.length > 0 && (
				<>
					<div className="findings-filters" role="group" aria-label={t('findings.filterSeverity')}>
						{SEVERITIES.map((sev) => (
							<button
								key={sev}
								type="button"
								className={`finding-chip sev-${sev}${sevFilter === sev ? ' on' : ''}`}
								aria-pressed={sevFilter === sev}
								onClick={() => setSevFilter((current) => (current === sev ? null : sev))}
							>
								<span className="finding-chip-dot" aria-hidden="true" />
								{sev}
								<span className="finding-chip-count">{severityCounts.get(sev) ?? 0}</span>
							</button>
						))}
					</div>
					<div className="findings-filters" role="group" aria-label={t('findings.filterStatus')}>
						{STATUS_CHIPS.map((chip) => (
							<button
								key={chip.id}
								type="button"
								className={`finding-chip${statusFilter === chip.id ? ' on' : ''}`}
								aria-pressed={statusFilter === chip.id}
								onClick={() => setStatusFilter(chip.id)}
							>
								{t(chip.labelKey)}
							</button>
						))}
						<span className="findings-filter-sep" aria-hidden="true" />
						<button
							type="button"
							className={`finding-chip${classFilter === 'all' ? ' on' : ''}`}
							aria-pressed={classFilter === 'all'}
							onClick={() => setClassFilter('all')}
						>
							{t('findings.allClasses')}
						</button>
						{CLASS_CHIPS.map((vulnClass) => (
							<button
								key={vulnClass}
								type="button"
								className={`finding-chip${classFilter === vulnClass ? ' on' : ''}`}
								aria-pressed={classFilter === vulnClass}
								onClick={() => setClassFilter(vulnClass)}
							>
								{vulnClass}
							</button>
						))}
					</div>
				</>
			)}

			{error && <div className="graph-error">{error}</div>}

			<div className="findings-list">
				{!loaded && <div className="empty-rail">{t('findings.loading')}</div>}
				{loaded && findings.length === 0 && (
					<div className="findings-empty">
						<FindingsIcon size={28} />
						<p>{t('findings.empty')}</p>
						<p className="findings-empty-hint">
							{t('findings.emptyHint')}
						</p>
					</div>
				)}
				{loaded && findings.length > 0 && visible.length === 0 && (
					<div className="empty-rail">
						{t('findings.noMatch')}
						{filtering && (
							<button
								type="button"
								className="tasks-filter-clear"
								onClick={() => {
									setSevFilter(null);
									setStatusFilter('all');
									setClassFilter('all');
								}}
							>
								{t('findings.clearFilters')}
							</button>
						)}
					</div>
				)}
				{visible.map((finding) => {
					const open = expanded.has(finding.id);
					return (
						<article key={finding.id} className={`finding-card sev-${finding.severity}${open ? ' open' : ''}`}>
							<div className="finding-card-top">
								<button
									type="button"
									className="finding-card-main"
									aria-expanded={open}
									onClick={() => toggleExpanded(finding.id)}
								>
									<span className="finding-title" title={restoreRedactedAddresses(finding.title)}>{restoreRedactedAddresses(finding.title)}</span>
									<span className="finding-meta" title={restoreRedactedAddresses(finding.target)}>
										{restoreRedactedAddresses(finding.target)}
										{isUnassignedSession(finding.sessionId)
											? ` · ${t('findings.unassignedChat')}`
											: ` · ${threadById.get(finding.sessionId)?.label || t('findings.chat')} ${chatIdSlice(finding.sessionId)}`}
										{finding.reportId ? ` · ${t('findings.reportId')} ${finding.reportId}` : ''}
										{finding.source ? ` · ${finding.source}` : ''}
										{finding.updatedAt ? ` · ${fmtTime(finding.updatedAt)}` : ''}
									</span>
								</button>
								<span className="finding-class-tag">{finding.vulnClass}</span>
								<span className={`finding-status-pill st-${finding.status}`}>
									{finding.status.replace('-', ' ')}
								</span>
								{canInformFinding(finding) && (
									<button
										type="button"
										className="btn finding-action"
										disabled={busyId === finding.id}
										onClick={() => void inform(finding.id)}
									>
										{t('findings.inform')}
									</button>
								)}
								{canRetestFinding(finding) && (
									<button
										type="button"
										className="btn finding-action"
										disabled={busyId === finding.id}
										onClick={() => void retest(finding)}
									>
										{busyId === finding.id ? t('findings.retesting') : t('findings.retest')}
									</button>
								)}
								{finding.status === 'fixed' && (
									<button
										type="button"
										className="btn finding-action"
										disabled={exportBusy}
										onClick={() => void exportOne(finding)}
									>
										{t('findings.generatePdf')}
									</button>
								)}
								<button
									type="button"
									className={`finding-delete${confirmDeleteId === finding.id ? ' confirm' : ''}`}
									title={confirmDeleteId === finding.id ? 'Click again to delete' : 'Delete finding'}
									aria-label={confirmDeleteId === finding.id ? 'Confirm delete' : `Delete ${finding.title}`}
									onClick={() => void removeFinding(finding.id)}
									onBlur={() => setConfirmDeleteId((current) => (current === finding.id ? null : current))}
								>
									{confirmDeleteId === finding.id ? 'Sure?' : <DeleteIcon size={16} />}
								</button>
							</div>
							{open && (
								<div className="finding-detail">
									{finding.description && (
										<section className="finding-section">
											<h3>Description</h3>
											<p>{finding.description}</p>
										</section>
									)}
									{finding.steps.length > 0 && (
										<section className="finding-section">
											<h3>Reproduction (PoC)</h3>
											<ol>
												{finding.steps.map((step, index) => (
													<li key={index}>{restoreRedactedAddresses(step)}</li>
												))}
											</ol>
										</section>
									)}
									{(finding.request?.method || finding.request?.url) && (
										<section className="finding-section">
											<h3>Request</h3>
											<pre className="finding-evidence">{[
												[finding.request.method, restoreRedactedAddresses(finding.request.url || '')].filter(Boolean).join(' '),
												finding.request.status != null ? `status ${finding.request.status}` : '',
												finding.request.body ? `body ${finding.request.body}` : '',
												finding.request.response ? `response ${finding.request.response}` : '',
											].filter(Boolean).join('\n')}</pre>
										</section>
									)}
									{finding.evidence && (
										<section className="finding-section">
											<h3>Evidence</h3>
											<pre className="finding-evidence">{restoreRedactedAddresses(finding.evidence)}</pre>
										</section>
									)}
									{finding.impact && (
										<section className="finding-section">
											<h3>Impact</h3>
											<p>{finding.impact}</p>
										</section>
									)}
									{finding.remediation && (
										<section className="finding-section">
											<h3>Remediation</h3>
											<p>{finding.remediation}</p>
										</section>
									)}
									{finding.references.length > 0 && (
										<section className="finding-section">
											<h3>References</h3>
											<ul className="finding-refs">
												{finding.references.map((ref, index) => (
													<li key={index}>{ref}</li>
												))}
											</ul>
										</section>
									)}
								</div>
							)}
						</article>
					);
				})}
			</div>
		</div>
	);
}
