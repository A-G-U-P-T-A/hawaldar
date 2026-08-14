import type { ReactNode } from 'react';

interface Props {
	title: string;
	actions?: ReactNode;
	children: ReactNode;
}

export default function PageShell({ title, actions, children }: Props) {
	return (
		<div className="page-shell">
			<div className="page-head">
				<h1 className="page-title">{title}</h1>
				{actions && <div className="title-actions">{actions}</div>}
			</div>
			<div className="page-body">
				{children}
			</div>
		</div>
	);
}
