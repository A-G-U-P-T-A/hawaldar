import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GraphLinkDTO, GraphNodeDTO } from '../../preload/api';

interface Props {
	nodes: GraphNodeDTO[];
	links: GraphLinkDTO[];
	onSelect: (node: GraphNodeDTO) => void;
	onReady: (ok: boolean, reason?: string) => void;
}

interface SimNode {
	id: string;
	x: number;
	y: number;
	z: number;
	vx: number;
	vy: number;
	vz: number;
	val: number;
	dto: GraphNodeDTO;
	mesh: THREE.Mesh;
	label: THREE.Sprite;
}

const BG = 0x1e1e1e;

export default function GraphScene({ nodes, links, onSelect, onReady }: Props) {
	const hostRef = useRef<HTMLDivElement>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const onSelectRef = useRef(onSelect);
	const onReadyRef = useRef(onReady);
	const nodesRef = useRef(nodes);
	const linksRef = useRef(links);
	const rebuildRef = useRef<() => void>(() => {});
	onSelectRef.current = onSelect;
	onReadyRef.current = onReady;
	nodesRef.current = nodes;
	linksRef.current = links;

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		if (!webglAvailable()) {
			onReadyRef.current(false, 'WebGL is not available in this window.');
			return;
		}

		let renderer: THREE.WebGLRenderer;
		try {
			renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
		} catch (err) {
			onReadyRef.current(false, err instanceof Error ? err.message : String(err));
			return;
		}

		const scene = new THREE.Scene();
		scene.background = new THREE.Color(BG);
		scene.fog = new THREE.Fog(BG, 48, 160);

		const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
		camera.position.set(0, 10, 32);

		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.setClearColor(BG, 1);
		renderer.domElement.style.display = 'block';
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		host.appendChild(renderer.domElement);

		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.autoRotate = true;
		controls.autoRotateSpeed = 0.45;
		controls.minDistance = 8;
		controls.maxDistance = 90;
		controls.enablePan = true;

		scene.add(new THREE.AmbientLight(0xffffff, 0.62));
		const key = new THREE.DirectionalLight(0xffffff, 0.7);
		key.position.set(12, 18, 10);
		scene.add(key);
		const fill = new THREE.PointLight(0x4a6fa5, 0.35, 80);
		fill.position.set(-16, -8, -10);
		scene.add(fill);

		const sphere = new THREE.SphereGeometry(1, 24, 24);
		const sims = new Map<string, SimNode>();
		const materials = new Map<string, THREE.MeshStandardMaterial>();
		let linkLines: THREE.LineSegments | null = null;
		let raf = 0;
		let disposed = false;
		let pointer = { x: 0, y: 0, downX: 0, downY: 0, down: false };
		const raycaster = new THREE.Raycaster();
		const pointerNdc = new THREE.Vector2();
		let hovered: SimNode | null = null;

		const materialFor = (color: string) => {
			let mat = materials.get(color);
			if (!mat) {
				mat = new THREE.MeshStandardMaterial({
					color,
					roughness: 0.38,
					metalness: 0.12,
					emissive: new THREE.Color(color),
					emissiveIntensity: 0.28,
				});
				materials.set(color, mat);
			}
			return mat;
		};

		const applySize = () => {
			const w = Math.max(host.clientWidth, 1);
			const h = Math.max(host.clientHeight, 1);
			renderer.setSize(w, h, false);
			camera.aspect = w / h;
			camera.updateProjectionMatrix();
		};
		applySize();
		const ro = new ResizeObserver(applySize);
		ro.observe(host);

		const rebuild = () => {
			const nextNodes = nodesRef.current;
			const keep = new Set(nextNodes.map((node) => node.id));
			for (const [id, sim] of sims) {
				if (keep.has(id)) {
					continue;
				}
				scene.remove(sim.mesh);
				scene.remove(sim.label);
				disposeSprite(sim.label);
				sims.delete(id);
			}
			const n = Math.max(nextNodes.length, 1);
			nextNodes.forEach((dto, index) => {
				const existing = sims.get(dto.id);
				if (existing) {
					existing.dto = dto;
					existing.val = dto.val ?? 2;
					existing.mesh.material = materialFor(dto.color || '#9d9d9d');
					existing.mesh.scale.setScalar(0.42 + existing.val * 0.16);
					if (existing.label.userData.title !== dto.title) {
						refreshLabel(existing.label, dto.title);
						existing.label.userData.title = dto.title;
					}
					return;
				}
				const pos = fibonacciSphere(index, n, 11);
				const mesh = new THREE.Mesh(sphere, materialFor(dto.color || '#9d9d9d'));
				mesh.scale.setScalar(0.42 + (dto.val ?? 2) * 0.16);
				mesh.position.set(pos.x, pos.y, pos.z);
				mesh.userData.id = dto.id;
				const label = makeLabel(dto.title);
				label.userData.title = dto.title;
				label.position.set(pos.x, pos.y + 1.15, pos.z);
				scene.add(mesh);
				scene.add(label);
				sims.set(dto.id, {
					id: dto.id,
					x: pos.x,
					y: pos.y,
					z: pos.z,
					vx: 0,
					vy: 0,
					vz: 0,
					val: dto.val ?? 2,
					dto,
					mesh,
					label,
				});
			});
			rebuildLinks();
		};

		const rebuildLinks = () => {
			if (linkLines) {
				scene.remove(linkLines);
				linkLines.geometry.dispose();
				(linkLines.material as THREE.Material).dispose();
				linkLines = null;
			}
			const segs: number[] = [];
			for (const link of linksRef.current) {
				const a = sims.get(String(link.source));
				const b = sims.get(String(link.target));
				if (!a || !b) {
					continue;
				}
				segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
			}
			if (segs.length === 0) {
				return;
			}
			const geo = new THREE.BufferGeometry();
			geo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
			linkLines = new THREE.LineSegments(
				geo,
				new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2 }),
			);
			scene.add(linkLines);
		};

		const stepForces = () => {
			const items = [...sims.values()];
			const repulsion = 36;
			const spring = 0.018;
			const rest = 8.5;
			const center = 0.01;
			const damp = 0.88;
			for (let i = 0; i < items.length; i += 1) {
				for (let j = i + 1; j < items.length; j += 1) {
					const a = items[i];
					const b = items[j];
					let dx = a.x - b.x;
					let dy = a.y - b.y;
					let dz = a.z - b.z;
					const dist2 = dx * dx + dy * dy + dz * dz + 0.08;
					const inv = repulsion / dist2;
					const dist = Math.sqrt(dist2);
					dx /= dist;
					dy /= dist;
					dz /= dist;
					a.vx += dx * inv;
					a.vy += dy * inv;
					a.vz += dz * inv;
					b.vx -= dx * inv;
					b.vy -= dy * inv;
					b.vz -= dz * inv;
				}
			}
			for (const link of linksRef.current) {
				const a = sims.get(String(link.source));
				const b = sims.get(String(link.target));
				if (!a || !b) {
					continue;
				}
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const dz = b.z - a.z;
				const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
				const pull = (dist - rest) * spring;
				const fx = (dx / dist) * pull;
				const fy = (dy / dist) * pull;
				const fz = (dz / dist) * pull;
				a.vx += fx;
				a.vy += fy;
				a.vz += fz;
				b.vx -= fx;
				b.vy -= fy;
				b.vz -= fz;
			}
			for (const node of items) {
				node.vx -= node.x * center;
				node.vy -= node.y * center;
				node.vz -= node.z * center;
				node.vx *= damp;
				node.vy *= damp;
				node.vz *= damp;
				node.x += node.vx;
				node.y += node.vy;
				node.z += node.vz;
				node.mesh.position.set(node.x, node.y, node.z);
				node.label.position.set(node.x, node.y + 1.15, node.z);
			}
			if (linkLines) {
				const pos = linkLines.geometry.getAttribute('position') as THREE.BufferAttribute;
				let i = 0;
				for (const link of linksRef.current) {
					const a = sims.get(String(link.source));
					const b = sims.get(String(link.target));
					if (!a || !b) {
						continue;
					}
					pos.setXYZ(i, a.x, a.y, a.z);
					pos.setXYZ(i + 1, b.x, b.y, b.z);
					i += 2;
				}
				pos.needsUpdate = true;
			}
		};

		const pick = (clientX: number, clientY: number): SimNode | null => {
			const rect = renderer.domElement.getBoundingClientRect();
			if (rect.width < 2 || rect.height < 2) {
				return null;
			}
			pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
			pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
			raycaster.setFromCamera(pointerNdc, camera);
			const hits = raycaster.intersectObjects([...sims.values()].map((node) => node.mesh), false);
			const id = hits[0]?.object.userData.id as string | undefined;
			return id ? sims.get(id) ?? null : null;
		};

		const setHover = (node: SimNode | null, clientX: number, clientY: number) => {
			if (hovered && hovered !== node) {
				const mat = hovered.mesh.material as THREE.MeshStandardMaterial;
				mat.emissiveIntensity = 0.28;
			}
			hovered = node;
			const tip = tipRef.current;
			if (node) {
				const mat = node.mesh.material as THREE.MeshStandardMaterial;
				mat.emissiveIntensity = 0.7;
				host.style.cursor = 'pointer';
				if (tip) {
					tip.hidden = false;
					tip.textContent = node.dto.title;
					const rect = host.getBoundingClientRect();
					tip.style.left = `${clientX - rect.left + 12}px`;
					tip.style.top = `${clientY - rect.top + 12}px`;
				}
			} else {
				host.style.cursor = '';
				if (tip) {
					tip.hidden = true;
				}
			}
		};

		const onPointerDown = (event: PointerEvent) => {
			pointer = { ...pointer, down: true, downX: event.clientX, downY: event.clientY };
			controls.autoRotate = false;
		};
		const onPointerMove = (event: PointerEvent) => {
			pointer.x = event.clientX;
			pointer.y = event.clientY;
			setHover(pick(event.clientX, event.clientY), event.clientX, event.clientY);
		};
		const onPointerUp = (event: PointerEvent) => {
			const dx = event.clientX - pointer.downX;
			const dy = event.clientY - pointer.downY;
			pointer.down = false;
			if (dx * dx + dy * dy < 16) {
				const node = pick(event.clientX, event.clientY);
				if (node) {
					onSelectRef.current(node.dto);
				}
			}
		};
		const onPointerLeave = () => setHover(null, 0, 0);

		const onContextLost = (event: Event) => {
			event.preventDefault();
			onReadyRef.current(false, 'WebGL context was lost.');
		};
		renderer.domElement.addEventListener('pointerdown', onPointerDown);
		renderer.domElement.addEventListener('pointermove', onPointerMove);
		renderer.domElement.addEventListener('pointerup', onPointerUp);
		renderer.domElement.addEventListener('pointerleave', onPointerLeave);
		renderer.domElement.addEventListener('webglcontextlost', onContextLost);

		rebuild();
		onReadyRef.current(true);

		const tick = () => {
			if (disposed) {
				return;
			}
			stepForces();
			controls.update();
			renderer.render(scene, camera);
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);

		rebuildRef.current = rebuild;

		return () => {
			disposed = true;
			rebuildRef.current = () => {};
			cancelAnimationFrame(raf);
			ro.disconnect();
			renderer.domElement.removeEventListener('pointerdown', onPointerDown);
			renderer.domElement.removeEventListener('pointermove', onPointerMove);
			renderer.domElement.removeEventListener('pointerup', onPointerUp);
			renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
			renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
			controls.dispose();
			for (const sim of sims.values()) {
				scene.remove(sim.mesh);
				scene.remove(sim.label);
				disposeSprite(sim.label);
			}
			sims.clear();
			if (linkLines) {
				scene.remove(linkLines);
				linkLines.geometry.dispose();
				(linkLines.material as THREE.Material).dispose();
			}
			sphere.dispose();
			for (const mat of materials.values()) {
				mat.dispose();
			}
			renderer.dispose();
			renderer.domElement.remove();
		};
	}, []);

	useEffect(() => {
		nodesRef.current = nodes;
		linksRef.current = links;
		rebuildRef.current();
	}, [nodes, links]);

	return (
		<div className="graph-stage">
			<div ref={hostRef} className="graph-canvas" />
			<div ref={tipRef} className="graph-tip" hidden />
		</div>
	);
}

function webglAvailable(): boolean {
	try {
		const canvas = document.createElement('canvas');
		return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
	} catch {
		return false;
	}
}

function fibonacciSphere(index: number, count: number, radius: number): { x: number; y: number; z: number } {
	const n = Math.max(count, 1);
	const phi = Math.acos(1 - 2 * ((index + 0.5) / n));
	const theta = Math.PI * (1 + Math.sqrt(5)) * (index + 0.5);
	return {
		x: Math.cos(theta) * Math.sin(phi) * radius,
		y: Math.cos(phi) * radius,
		z: Math.sin(theta) * Math.sin(phi) * radius,
	};
}

function makeLabel(title: string): THREE.Sprite {
	const texture = labelTexture(title);
	const material = new THREE.SpriteMaterial({
		map: texture,
		transparent: true,
		depthTest: false,
		depthWrite: false,
	});
	const sprite = new THREE.Sprite(material);
	sprite.scale.set(5.2, 1.3, 1);
	sprite.userData.texture = texture;
	return sprite;
}

function refreshLabel(sprite: THREE.Sprite, title: string) {
	const prev = sprite.userData.texture as THREE.CanvasTexture | undefined;
	const next = labelTexture(title);
	sprite.material.map = next;
	sprite.material.needsUpdate = true;
	sprite.userData.texture = next;
	prev?.dispose();
}

function labelTexture(title: string): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 128;
	const ctx = canvas.getContext('2d');
	if (ctx) {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const text = title.trim() || 'Untitled';
		ctx.font = '600 36px "Segoe UI", system-ui, sans-serif';
		const width = Math.min(ctx.measureText(text).width + 36, 492);
		const x = (canvas.width - width) / 2;
		ctx.fillStyle = 'rgba(18, 18, 18, 0.62)';
		roundRect(ctx, x, 36, width, 56, 16);
		ctx.fill();
		ctx.fillStyle = '#e8e8e8';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(text, canvas.width / 2, 64, width - 28);
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.needsUpdate = true;
	return texture;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

function disposeSprite(sprite: THREE.Sprite) {
	const texture = sprite.userData.texture as THREE.CanvasTexture | undefined;
	texture?.dispose();
	sprite.material.dispose();
}
