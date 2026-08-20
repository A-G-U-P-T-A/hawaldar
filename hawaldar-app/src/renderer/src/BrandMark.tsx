/** Product mark: `resources/brand/hawaldar.png` (Vite publicDir). Do not replace with a Material glyph. */
interface Props {
	size?: number;
	className?: string;
}

export default function BrandMark({ size = 24, className }: Props) {
	return (
		<img
			className={className}
			src="./hawaldar.png"
			width={size}
			height={size}
			alt=""
			draggable={false}
		/>
	);
}
