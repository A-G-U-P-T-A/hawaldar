import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import de from './de.json';
import en from './en.json';
import es from './es.json';
import hi from './hi.json';
import ja from './ja.json';

export const LOCALES = ['en', 'es', 'hi', 'de', 'ja'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
	en: 'English',
	es: 'Español',
	hi: 'हिन्दी',
	de: 'Deutsch',
	ja: '日本語',
};

const CATALOGS: Record<Locale, Record<string, string>> = {
	en: en as Record<string, string>,
	es: es as Record<string, string>,
	hi: hi as Record<string, string>,
	de: de as Record<string, string>,
	ja: ja as Record<string, string>,
};

export function isLocale(value: unknown): value is Locale {
	return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
	const table = CATALOGS[locale] || CATALOGS.en;
	let text = table[key] ?? CATALOGS.en[key] ?? key;
	if (vars) {
		text = text.replace(/\{(\w+)\}/g, (_, name: string) => (
			vars[name] != null ? String(vars[name]) : `{${name}}`
		));
	}
	return text;
}

type I18nValue = {
	locale: Locale;
	t: (key: string, vars?: Record<string, string | number>) => string;
	setLocale: (next: Locale) => void;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>('en');

	useEffect(() => {
		void window.hawaldar?.getSettings()
			.then((settings) => {
				if (isLocale(settings.locale)) {
					setLocaleState(settings.locale);
					document.documentElement.lang = settings.locale;
				}
			})
			.catch(() => undefined);
	}, []);

	const setLocale = useCallback((next: Locale) => {
		setLocaleState(next);
		document.documentElement.lang = next;
		void window.hawaldar?.saveSettings({ locale: next }).catch(() => undefined);
	}, []);

	const t = useCallback(
		(key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
		[locale],
	);

	const value = useMemo(() => ({ locale, t, setLocale }), [locale, t, setLocale]);
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	const ctx = useContext(I18nContext);
	if (!ctx) {
		throw new Error('useI18n must be used within I18nProvider');
	}
	return ctx;
}

export function LanguagePicker({ id = 'hawaldar-locale' }: { id?: string }) {
	const { locale, setLocale, t } = useI18n();
	return (
		<label className="language-picker">
			<span className="language-picker-label">{t('settings.language')}</span>
			<select
				id={id}
				aria-label={t('settings.language')}
				value={locale}
				onChange={(event) => {
					const next = event.target.value;
					if (isLocale(next)) {
						setLocale(next);
					}
				}}
			>
				{LOCALES.map((item) => (
					<option key={item} value={item}>{LOCALE_LABELS[item]}</option>
				))}
			</select>
		</label>
	);
}
