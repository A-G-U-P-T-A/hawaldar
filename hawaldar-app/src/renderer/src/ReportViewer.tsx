import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useI18n } from './i18n';

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

interface Props {
	reportId: string;
}

type PdfLink = {
	href: string;
	left: number;
	top: number;
	width: number;
	height: number;
};

function toUint8Array(raw: unknown): Uint8Array {
	if (raw instanceof Uint8Array) {
		return raw;
	}
	if (raw instanceof ArrayBuffer) {
		return new Uint8Array(raw);
	}
	if (ArrayBuffer.isView(raw)) {
		return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
	}
	if (raw && typeof raw === 'object' && 'data' in (raw as { data?: unknown })) {
		const data = (raw as { data: unknown }).data;
		if (data instanceof Uint8Array) {
			return data;
		}
		if (Array.isArray(data)) {
			return Uint8Array.from(data as number[]);
		}
	}
	if (Array.isArray(raw)) {
		return Uint8Array.from(raw as number[]);
	}
	return new Uint8Array();
}

function copyBytes(bytes: Uint8Array): Uint8Array {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

function isExternalHref(url: string): boolean {
	return /^(https?:|mailto:)/i.test(String(url || '').trim());
}

function hrefFromEvent(event: { target: EventTarget | null }): string {
	const target = event.target;
	if (!(target instanceof Element)) {
		return '';
	}
	const anchor = target.closest('a');
	return (anchor?.getAttribute('href') || anchor?.href || '').trim();
}

function interceptHttpLink(event: { preventDefault: () => void; stopPropagation: () => void; target: EventTarget | null }): void {
	const href = hrefFromEvent(event);
	if (!isExternalHref(href)) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	openExternal(href);
}

function openExternal(href: string): void {
	const api = window.hawaldar;
	if (api?.openExternal) {
		void api.openExternal(href);
	}
}

function annotationHref(annotation: Record<string, unknown>): string {
	const subtype = String(annotation.subtype || annotation.SubType || '');
	if (subtype.toLowerCase() !== 'link') {
		return '';
	}
	const href = String(annotation.url || annotation.unsafeUrl || '').trim();
	return isExternalHref(href) ? href : '';
}

function linkBoxes(page: PDFPageProxy, viewport: { convertToViewportPoint: (x: number, y: number) => number[] }, annotations: unknown[]): PdfLink[] {
	const links: PdfLink[] = [];
	for (const item of annotations) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const annotation = item as Record<string, unknown>;
		const href = annotationHref(annotation);
		const rect = annotation.rect;
		if (!href || !Array.isArray(rect) || rect.length < 4) {
			continue;
		}
		const [x1, y1] = viewport.convertToViewportPoint(Number(rect[0]), Number(rect[1]));
		const [x2, y2] = viewport.convertToViewportPoint(Number(rect[2]), Number(rect[3]));
		const left = Math.min(x1, x2);
		const top = Math.min(y1, y2);
		links.push({
			href,
			left,
			top,
			width: Math.abs(x2 - x1),
			height: Math.abs(y2 - y1),
		});
	}
	return links;
}

async function paintPage(
	page: PDFPageProxy,
	cssWidth: number,
	cancelled: () => boolean,
): Promise<{ canvas: HTMLCanvasElement; links: PdfLink[]; cssWidth: number; cssHeight: number } | null> {
	const unscaled = page.getViewport({ scale: 1 });
	const cssScale = Math.max(0.5, Math.min(2.4, cssWidth / Math.max(unscaled.width, 1)));
	const cssViewport = page.getViewport({ scale: cssScale });
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const viewport = page.getViewport({ scale: cssScale * dpr });
	const canvas = document.createElement('canvas');
	canvas.width = Math.floor(viewport.width);
	canvas.height = Math.floor(viewport.height);
	canvas.style.width = `${cssViewport.width}px`;
	canvas.style.height = `${cssViewport.height}px`;
	canvas.className = 'report-page-canvas';
	let task: RenderTask | undefined;
	try {
		task = page.render({ canvas, viewport });
		await task.promise;
		if (cancelled()) {
			return null;
		}
		const annotations = await page.getAnnotations({ intent: 'display' });
		if (cancelled()) {
			return null;
		}
		return {
			canvas,
			links: linkBoxes(page, cssViewport, annotations),
			cssWidth: cssViewport.width,
			cssHeight: cssViewport.height,
		};
	} catch (error) {
		task?.cancel();
		throw error;
	}
}

function mountPage(
	host: HTMLElement,
	page: { canvas: HTMLCanvasElement; links: PdfLink[]; cssWidth: number; cssHeight: number },
	title: string,
): void {
	const wrap = document.createElement('div');
	wrap.className = 'report-page';
	wrap.style.width = `${page.cssWidth}px`;
	wrap.style.height = `${page.cssHeight}px`;
	wrap.setAttribute('aria-label', title);
	wrap.appendChild(page.canvas);
	for (const link of page.links) {
		const hit = document.createElement('a');
		hit.className = 'report-page-link';
		hit.href = link.href;
		hit.rel = 'noreferrer';
		hit.target = '_blank';
		hit.style.left = `${link.left}px`;
		hit.style.top = `${link.top}px`;
		hit.style.width = `${link.width}px`;
		hit.style.height = `${link.height}px`;
		hit.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			openExternal(link.href);
		});
		wrap.appendChild(hit);
	}
	host.appendChild(wrap);
}

export default function ReportViewer({ reportId }: Props) {
	const { t } = useI18n();
	const hostRef = useRef<HTMLDivElement>(null);
	const [bytes, setBytes] = useState<Uint8Array | null>(null);
	const [error, setError] = useState('');
	const [width, setWidth] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setBytes(null);
		setError('');
		void (async () => {
			try {
				const loaded = toUint8Array(await window.hawaldar.readReport(reportId));
				if (cancelled) {
					return;
				}
				if (loaded.byteLength === 0) {
					setError(t('reports.readEmpty'));
					return;
				}
				setBytes(copyBytes(loaded));
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [reportId, t]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		const ro = new ResizeObserver((entries) => {
			const next = Math.floor(entries[0]?.contentRect.width || 0);
			setWidth((prev) => (Math.abs(prev - next) < 12 ? prev : next));
		});
		ro.observe(host);
		setWidth(Math.floor(host.clientWidth));
		return () => ro.disconnect();
	}, [bytes]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || !bytes || width < 48) {
			return;
		}
		let cancelled = false;
		let pdf: PDFDocumentProxy | undefined;
		let loadingTask: ReturnType<typeof getDocument> | undefined;
		host.replaceChildren();
		void (async () => {
			try {
				const data = copyBytes(bytes);
				loadingTask = getDocument({
					data,
					disableRange: true,
					disableStream: true,
					disableAutoFetch: true,
					useWasm: false,
				});
				pdf = await loadingTask.promise;
				if (cancelled) {
					return;
				}
				const pageWidth = Math.max(width - 32, 48);
				for (let n = 1; n <= pdf.numPages; n += 1) {
					if (cancelled) {
						return;
					}
					const page = await pdf.getPage(n);
					const painted = await paintPage(page, pageWidth, () => cancelled);
					if (!painted || cancelled) {
						return;
					}
					mountPage(host, painted, `${t('reports.viewer')} ${n}`);
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : t('reports.renderFailed'));
				}
			}
		})();
		return () => {
			cancelled = true;
			host.replaceChildren();
			void loadingTask?.destroy();
		};
	}, [bytes, width, t]);

	if (error) {
		return <div className="graph-error">{error}</div>;
	}
	if (!bytes) {
		return <div className="empty-rail">{t('reports.loading')}</div>;
	}
	return (
		<div
			className="report-viewer"
			onClickCapture={interceptHttpLink}
			onAuxClickCapture={interceptHttpLink}
		>
			<div
				ref={hostRef}
				className="report-pages"
				role="document"
				aria-label={t('reports.viewer')}
			/>
		</div>
	);
}
