import { isValidElement, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
	text: string;
	className?: string;
	/** Loopback / host-gateway / in-scope addresses that must stay visible if the model redacts them. */
	keepAddresses?: string[];
}

const REDACTED_IP = /\[IP_ADDRESS\]/g;

/** Do not treat loopback or the scanned host-gateway as secrets. */
export function isKeptScanAddress(value: string): boolean {
	const v = value.trim().toLowerCase();
	if (!v) return false;
	if (v === '127.0.0.1' || v === '::1' || v === 'localhost') return true;
	if (v === 'host.containers.internal' || v === 'host.docker.internal') return true;
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	return false;
}

export function restoreRedactedAddresses(text: string, keep: string[] = []): string {
	const addresses = keep.filter((item) => item.trim() && isKeptScanAddress(item));
	if (!addresses.length || !text.includes('[IP_ADDRESS]')) {
		return text;
	}
	let i = 0;
	return text.replace(REDACTED_IP, () => addresses[Math.min(i++, addresses.length - 1)] ?? addresses[0]);
}

function safeHref(href?: string): string {
	const value = (href || '').trim();
	if (!value) return '';
	if (/^(https?:|mailto:)/i.test(value)) return value;
	return '';
}

function openLink(href: string) {
	const api = window.hawaldar;
	if (api?.openExternal) {
		void api.openExternal(href).catch(() => window.open(href, '_blank', 'noopener'));
		return;
	}
	window.open(href, '_blank', 'noopener');
}

function flattenText(node: ReactNode): string {
	if (node == null || typeof node === 'boolean') return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(flattenText).join('');
	if (isValidElement(node)) {
		return flattenText((node.props as { children?: ReactNode }).children);
	}
	return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
	const [copied, setCopied] = useState(false);
	let language = '';
	let code = '';
	if (isValidElement(children)) {
		const props = children.props as { className?: string; children?: ReactNode };
		language = /language-([\w-]+)/.exec(props.className || '')?.[1] ?? '';
		code = flattenText(props.children).replace(/\n$/, '');
	} else {
		code = flattenText(children).replace(/\n$/, '');
	}
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		} catch {
			/* clipboard unavailable */
		}
	};
	return (
		<div className="md-codeblock">
			<div className="md-codeblock-head">
				<span className="md-codeblock-lang">{language || 'text'}</span>
				<button
					type="button"
					className={`md-codeblock-copy${copied ? ' copied' : ''}`}
					onClick={() => void copy()}
				>
					{copied ? 'Copied' : 'Copy'}
				</button>
			</div>
			<pre>
				<code className={language ? `language-${language}` : undefined}>{code}</code>
			</pre>
		</div>
	);
}

export default function MarkdownBody({ text, className = '', keepAddresses = [] }: Props) {
	const body = restoreRedactedAddresses(text, keepAddresses);
	return (
		<div className={`md ${className}`.trim()}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => {
						const safe = safeHref(href);
						if (!safe) {
							return <span className="md-link-dead">{children}</span>;
						}
						return (
							<a
								href={safe}
								title={safe}
								onClick={(event) => {
									event.preventDefault();
									openLink(safe);
								}}
							>
								{children}
							</a>
						);
					},
					pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
					table: ({ children }) => (
						<div className="md-table-wrap">
							<table>{children}</table>
						</div>
					),
					input: ({ checked, type, node: _node, ...rest }) => (
						<input
							{...rest}
							type={type}
							checked={checked}
							disabled
							className="md-checkbox"
							tabIndex={-1}
						/>
					),
				}}
			>
				{body}
			</ReactMarkdown>
		</div>
	);
}
