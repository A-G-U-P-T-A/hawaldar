/** Keep paths in sync with hawaldar-app/resources/brand/hawaldar.svg */
interface Props {
	size?: number;
	className?: string;
}

export default function BrandMark({ size = 24, className }: Props) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 32 32"
			fill="none"
			aria-hidden="true"
			focusable="false"
		>
			<path fill="#c9a227" d="M6 4h20v14L16 28 6 18V4z" />
			<path fill="#edc85a" d="M22 4h4v4h-4z" />
			<path fill="#f3efe4" d="M10 12l6 6 6-6-2-2-4 4-4-4z" />
		</svg>
	);
}
