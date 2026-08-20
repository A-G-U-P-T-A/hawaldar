import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { BOOT_TIP_KEYS } from './bootTips';
import { useI18n } from './i18n';
import { ChevronIcon } from './navIcons';

class BootScreenGuard extends Component<{ status: string; children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (this.state.failed) {
			return (
				<div className="hw-boot splash" role="status">
					<h1 className="hw-boot-title">Hawaldar</h1>
					<p className="hw-boot-status">{this.props.status}</p>
				</div>
			);
		}
		return this.props.children;
	}
}

export default function BootScreen({ status }: { status: string }) {
	return (
		<BootScreenGuard status={status}>
			<BootScreenInner status={status} />
		</BootScreenGuard>
	);
}

function BootScreenInner({ status }: { status: string }) {
	const { t } = useI18n();
	const [index, setIndex] = useState(0);
	const count = BOOT_TIP_KEYS.length;
	const tip = t(BOOT_TIP_KEYS[index] ?? BOOT_TIP_KEYS[0]);

	const go = useCallback((dir: number) => {
		setIndex((current) => (current + dir + count) % count);
	}, [count]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'ArrowLeft') {
				event.preventDefault();
				go(-1);
			} else if (event.key === 'ArrowRight') {
				event.preventDefault();
				go(1);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [go]);

	return (
		<div className="hw-boot splash" role="status">
			<h1 className="hw-boot-title">Hawaldar</h1>
			<div className="hw-boot-spinner" aria-hidden="true" />
			<p className="hw-boot-status">{status}</p>
			<div className="hw-boot-tips">
				<button
					type="button"
					className="hw-boot-nav"
					aria-label={t('boot.tipPrev')}
					onClick={() => go(-1)}
				>
					<ChevronIcon direction="left" />
				</button>
				<div className="hw-boot-viewport" aria-hidden="true">
					<div
						className="hw-boot-track"
						style={{ transform: `translateX(${-index * 100}%)` }}
					>
						{BOOT_TIP_KEYS.map((key) => (
							<p key={key} className="hw-boot-tip">{t(key)}</p>
						))}
					</div>
				</div>
				<button
					type="button"
					className="hw-boot-nav"
					aria-label={t('boot.tipNext')}
					onClick={() => go(1)}
				>
					<ChevronIcon direction="right" />
				</button>
			</div>
			<div className="hw-boot-dots" aria-hidden="true">
				{BOOT_TIP_KEYS.map((key, i) => (
					<span key={key} className={`hw-boot-dot${i === index ? ' is-active' : ''}`} />
				))}
			</div>
			<p className="hw-boot-status hw-boot-live" aria-live="polite">
				{t('boot.tipPosition', { current: index + 1, total: count })}: {tip}
			</p>
		</div>
	);
}
