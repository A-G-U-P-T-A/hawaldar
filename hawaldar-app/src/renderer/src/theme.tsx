import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import Icon from './Icon';
import { useI18n } from './i18n';

export const THEMES = ['dark', 'light'] as const;
export type ThemeName = (typeof THEMES)[number];

export function isTheme(value: unknown): value is ThemeName {
	return value === 'dark' || value === 'light';
}

export function applyTheme(theme: ThemeName): void {
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
}

type ThemeValue = {
	theme: ThemeName;
	setTheme: (next: ThemeName) => void;
	toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<ThemeName>('dark');

	useEffect(() => {
		applyTheme('dark');
		void window.hawaldar?.getSettings()
			.then((settings) => {
				const next = isTheme(settings.theme) ? settings.theme : 'dark';
				setThemeState(next);
				applyTheme(next);
			})
			.catch(() => undefined);
	}, []);

	const setTheme = useCallback((next: ThemeName) => {
		setThemeState(next);
		applyTheme(next);
		void window.hawaldar?.saveSettings({ theme: next }).catch(() => undefined);
	}, []);

	const toggleTheme = useCallback(() => {
		setTheme(theme === 'dark' ? 'light' : 'dark');
	}, [setTheme, theme]);

	const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [setTheme, theme, toggleTheme]);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
	const ctx = useContext(ThemeContext);
	if (!ctx) {
		throw new Error('useTheme must be used within ThemeProvider');
	}
	return ctx;
}

export function ThemeToggle({ className = 'icon-tool' }: { className?: string }) {
	const { theme, toggleTheme } = useTheme();
	const { t } = useI18n();
	const next = theme === 'dark' ? 'light' : 'dark';
	const label = t('theme.toggle', { mode: t(`theme.${next}`) });
	return (
		<button
			type="button"
			className={className}
			title={label}
			aria-label={label}
			onClick={toggleTheme}
		>
			<Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} />
		</button>
	);
}

export function ThemePicker({ id = 'hawaldar-theme' }: { id?: string }) {
	const { theme, setTheme } = useTheme();
	const { t } = useI18n();
	return (
		<label className="language-picker">
			<span className="language-picker-label">{t('theme.label')}</span>
			<select
				id={id}
				aria-label={t('theme.label')}
				value={theme}
				onChange={(event) => {
					if (isTheme(event.target.value)) {
						setTheme(event.target.value);
					}
				}}
			>
				<option value="dark">{t('theme.dark')}</option>
				<option value="light">{t('theme.light')}</option>
			</select>
		</label>
	);
}
