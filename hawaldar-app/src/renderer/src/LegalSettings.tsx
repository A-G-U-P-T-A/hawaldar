import { useEffect, useState } from 'react';
import type { LegalStatusDTO } from '../../preload/api';
import { LanguagePicker, useI18n } from './i18n';
import { ThemePicker } from './theme';
import LegalTerms from './LegalTerms';

export default function LegalSettings() {
	const { t } = useI18n();
	const [legal, setLegal] = useState<LegalStatusDTO | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	useEffect(() => {
		void window.hawaldar.getLegal().then(setLegal);
	}, []);

	const accept = async () => {
		setBusy(true);
		setError('');
		try {
			setLegal(await window.hawaldar.acceptLegal());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const acceptedLabel = (status: LegalStatusDTO): string => {
		if (!status.accepted || !status.acceptedAt) {
			return t('legal.notAccepted');
		}
		return t('legal.accepted', {
			when: new Date(status.acceptedAt).toLocaleString(),
			version: status.version,
		});
	};

	if (!legal) {
		return (
			<section className="widget">
				<p className="widget-help">{t('legal.loading')}</p>
			</section>
		);
	}

	return (
		<section className="widget legal-widget">
			<div className="widget-head">
				<h2 className="widget-title">{t('legal.title')}</h2>
			</div>
			<p className="widget-help">{t('settings.languageHelp')}</p>
			<ThemePicker id="settings-legal-theme" />
			<LanguagePicker id="settings-legal-locale" />
			<div className="legal-doc">
				<LegalTerms document={legal.document} />
			</div>
			<p className="widget-help">{acceptedLabel(legal)}</p>
			{error && <p className="widget-help widget-error">{error}</p>}
			{!legal.accepted && (
				<div className="widget-foot">
					<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void accept()}>
						{busy ? t('legal.saving') : t('legal.accept')}
					</button>
				</div>
			)}
		</section>
	);
}
