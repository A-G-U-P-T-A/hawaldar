import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { toDisplayText } from './displayText';
import { I18nProvider } from './i18n';
import { ThemeProvider } from './theme';
import './styles.css';

function hasDesktopApi(): boolean {
	return typeof window.hawaldar?.getLegal === 'function';
}

function BootError({ title, detail }: { title: string; detail: string }) {
	return (
		<div className="boot-error">
			<div className="app-titlebar">
				<div className="product">Hawaldar</div>
			</div>
			<div className="boot-error-body">
				<h1>{title}</h1>
				<p>{detail}</p>
			</div>
		</div>
	);
}

class RendererErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error('[hawaldar] renderer crash', error, info.componentStack);
	}

	render() {
		if (this.state.error) {
			let detail = 'UI error';
			try {
				detail = toDisplayText(this.state.error) || detail;
			} catch {
				detail = this.state.error.message || detail;
			}
			return (
				<BootError
					title="Hawaldar hit a UI error"
					detail={detail}
				/>
			);
		}
		return this.props.children;
	}
}

function Root() {
	if (!hasDesktopApi()) {
		return (
			<BootError
				title="Desktop bridge missing"
				detail="window.hawaldar is not available, so the preload script did not load. Stop this process (Ctrl+C) and run scripts\dev.bat again."
			/>
		);
	}
	return (
		<I18nProvider>
			<ThemeProvider>
				<RendererErrorBoundary>
					<App />
				</RendererErrorBoundary>
			</ThemeProvider>
		</I18nProvider>
	);
}

const rootEl = document.getElementById('root');
if (!rootEl) {
	throw new Error('Hawaldar #root element is missing from index.html');
}

createRoot(rootEl).render(
	<StrictMode>
		<RendererErrorBoundary>
			<Root />
		</RendererErrorBoundary>
	</StrictMode>,
);
