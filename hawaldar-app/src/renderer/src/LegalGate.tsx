import type { LegalDocumentDTO } from '../../preload/api';
import { LanguagePicker, useI18n } from './i18n';
import { ThemePicker } from './theme';
import LegalTerms from './LegalTerms';
import PageShell from './PageShell';

interface Props {
	document: LegalDocumentDTO;
	busy?: boolean;
	error?: string;
	onAccept: () => void;
	onDecline: () => void;
}

export default function LegalGate({ document, busy = false, error, onAccept, onDecline }: Props) {
	const { t } = useI18n();
	return (
		<PageShell title={t('legal.title')} actions={(
			<>
				<ThemePicker id="legal-theme" />
				<LanguagePicker id="legal-locale" />
			</>
		)}>
			<section className="widget legal-widget">
				<div className="widget-head">
					<h2 className="widget-title">{t('legal.agreement')}</h2>
				</div>
				<p className="widget-help">{t('legal.help')}</p>
				<div className="legal-doc">
					<LegalTerms document={document} />
				</div>
				{error && <p className="widget-help widget-error">{error}</p>}
				<div className="widget-foot">
					<button type="button" className="btn" disabled={busy} onClick={onDecline}>
						{t('legal.decline')}
					</button>
					<button type="button" className="btn btn-primary" disabled={busy} onClick={onAccept} autoFocus>
						{busy ? t('legal.saving') : t('legal.accept')}
					</button>
				</div>
			</section>
		</PageShell>
	);
}
