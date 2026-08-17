import type { LegalDocumentDTO } from '../../preload/api';
import { useI18n } from './i18n';

interface Props {
	document: LegalDocumentDTO;
}

export default function LegalTerms({ document }: Props) {
	const { t } = useI18n();
	return (
		<>
			<p className="widget-help">
				{t('legal.versionLine', { name: document.licenseName, id: document.licenseId, version: document.version })}
			</p>
			<h3 className="widget-sub">{t('legal.section.license')}</h3>
			{document.summary.map((line) => (
				<p key={line} className="widget-help">{line}</p>
			))}
			<h3 className="widget-sub">{t('legal.section.authorized')}</h3>
			{document.authorizedUse.map((line) => (
				<p key={line} className="widget-help">{line}</p>
			))}
			<h3 className="widget-sub">{t('legal.section.runtime')}</h3>
			{document.runtime.map((line) => (
				<p key={line} className="widget-help">{line}</p>
			))}
			<p className="widget-help">{document.disclaimer}</p>
			<p className="widget-help">{t('legal.translationNote')}</p>
		</>
	);
}
