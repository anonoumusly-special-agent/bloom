import { motion, useReducedMotion } from "framer-motion";

export function ClaudeSprite({
	variant = "done",
	size = 56,
	mode = "card"
}: {
	variant?: "done" | "ask";
	size?: number;
	mode?: "card" | "fly";
}) {
	const reducedMotion = useReducedMotion();
	const ask = variant === "ask";
	const fly = mode === "fly";

	return (
		<svg
			viewBox="-2 -2.5 28 17.5"
			width={size}
			height={(size * 15) / 24}
			shapeRendering="crispEdges"
			aria-hidden="true"
		>
			<motion.g
				animate={
					reducedMotion || fly ? undefined : ask ? { x: [-0.5, 0.5, -0.5] } : { y: [0, -1.5, 0] }
				}
				transition={{ duration: ask ? 2 : 0.9, repeat: Infinity, ease: "easeInOut" }}
			>
				<rect x="3" y="0" width="18" height="12" fill="#D97757" />
				<motion.rect
					x="0"
					y="6"
					width="3"
					height="3"
					fill="#D97757"
					style={{
						transformBox: "fill-box",
						transformOrigin: "right center",
						rotate: ask ? 55 : 0
					}}
					animate={
						reducedMotion
							? undefined
							: fly
								? { rotate: [0, 15, 0, -8, 0] }
								: ask
									? { rotate: [55, 63, 47, 55] }
									: undefined
					}
					transition={{ duration: fly ? 0.55 : 2, repeat: Infinity, ease: "easeInOut" }}
				/>
				<motion.rect
					x="21"
					y="6"
					width="3"
					height="3"
					fill="#D97757"
					style={{
						transformBox: "fill-box",
						transformOrigin: "left center",
						rotate: ask ? -55 : 0
					}}
					animate={
						reducedMotion
							? undefined
							: fly
								? { rotate: [0, -15, 0, 8, 0] }
								: ask
									? { rotate: [-55, -47, -63, -55] }
									: { rotate: [0, -35, 10, -35, 0, 0] }
					}
					transition={
						fly
							? { duration: 0.55, repeat: Infinity, ease: "easeInOut" }
							: ask
								? { duration: 2, repeat: Infinity, ease: "easeInOut" }
								: {
										duration: 1.6,
										repeat: Infinity,
										times: [0, 0.2, 0.38, 0.56, 0.75, 1],
										ease: "easeInOut"
									}
					}
				/>
				<motion.g
					style={{ transformBox: "fill-box", transformOrigin: "center center" }}
					animate={reducedMotion || fly ? undefined : { scaleY: [1, 1, 0.1, 1, 1] }}
					transition={{ duration: 2.5, repeat: Infinity, times: [0, 0.84, 0.88, 0.92, 1] }}
				>
					<rect x="6" y="3" width="1" height="3" fill="#000" />
					<rect x="17" y="3" width="1" height="3" fill="#000" />
				</motion.g>
				<motion.g
					animate={reducedMotion || !fly ? undefined : { y: [0, -0.5, 0] }}
					transition={{ duration: 0.25, repeat: Infinity, ease: "linear" }}
				>
					<rect x="4" y="12" width="2" height="3" fill="#D97757" />
					<rect x="15" y="12" width="2" height="3" fill="#D97757" />
				</motion.g>
				<motion.g
					animate={reducedMotion || !fly ? undefined : { y: [-0.5, 0, -0.5] }}
					transition={{ duration: 0.25, repeat: Infinity, ease: "linear" }}
				>
					<rect x="7" y="12" width="2" height="3" fill="#D97757" />
					<rect x="18" y="12" width="2" height="3" fill="#D97757" />
				</motion.g>
			</motion.g>
		</svg>
	);
}
