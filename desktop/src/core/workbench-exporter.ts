export interface TraceEvent {
	id: string;
	name: string;
	type: string;
	detail: string;
	at: number;
}

export interface LogEvent {
	level: string;
	message: string;
	at: number;
}

type ChangeListener = () => void;

/** In-process exporter for sidebar traces/logs (no Mastra Cloud). */
export class WorkbenchExporter {
	traces: TraceEvent[] = [];
	logs: LogEvent[] = [];
	private listeners = new Set<ChangeListener>();

	onChange(listener: ChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	async exportTracingEvent(event: any): Promise<void> {
		const span = event?.span ?? event;
		this.traces.push({
			id: String(span?.id ?? span?.spanId ?? `${Date.now()}`),
			name: String(span?.name ?? span?.type ?? 'span'),
			type: String(span?.type ?? event?.type ?? 'trace'),
			detail: String(span?.attributes?.toolName ?? span?.input ?? span?.output ?? '').slice(0, 200),
			at: Date.now(),
		});
		if (this.traces.length > 200) {
			this.traces = this.traces.slice(-200);
		}
		this.notify();
	}

	async exportEvent(_event: any): Promise<void> {
		// Observability may call this; keep traces via exportTracingEvent.
	}

	pushLog(level: string, message: string): void {
		this.logs.push({ level, message, at: Date.now() });
		if (this.logs.length > 200) {
			this.logs = this.logs.slice(-200);
		}
		this.notify();
	}
}
