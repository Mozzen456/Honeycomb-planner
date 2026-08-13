/**
 * Pick a part's mounting face by looking at it.
 *
 * The detector guesses which face of a model goes against the wall, and for 27
 * of the 51 shipped parts it declines to guess at all (PARKED P1). This is where
 * a person answers instead: the part is shown in its OWN coordinates, a wall
 * plate is drawn against whichever face is currently chosen, and clicking any
 * face of the model moves the plate to it.
 *
 * Shown in the file's own frame rather than already oriented, deliberately. The
 * question is "which axis of this STL faces the wall", so the click has to land
 * on an axis of the STL; raycasting an already-turned mesh would mean inverting
 * the permutation and the flip to get back, which is a second transform to keep
 * true against the first.
 *
 * The wall plate carries a hexagonal cell so the spin control has something to
 * read against — the third degree of freedom is the turn about the wall normal,
 * which is the open frame question (DECISIONS D31) until it is settled globally.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import { CELL, PANEL_DEPTH, PITCH } from '../core/constants';
import { detect } from '../core/detect';
import type { MountingOverride } from '../core/overrides';
import type { CatalogPart } from '../core/types';
import { loadRawMesh } from './meshLibrary';
import './PartInspector.css';

export interface PartInspectorProps {
  part: CatalogPart;
  /** What is saved for this part now, if anything. */
  current?: MountingOverride;
  onSave: (mounting: MountingOverride) => void;
  onClear: () => void;
  onClose: () => void;
}

type Axis = 'x' | 'y' | 'z';
type End = 'low' | 'high';

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };
const FACE_LABEL: Record<string, string> = {
  'x:low': 'Left (−X)', 'x:high': 'Right (+X)',
  'y:low': 'Front (−Y)', 'y:high': 'Back (+Y)',
  'z:low': 'Bottom (−Z)', 'z:high': 'Top (+Z)',
};

/** The face a normal points along: the dominant axis, and which way down it. */
function faceOf(normal: THREE.Vector3): { axis: Axis; end: End } {
  const a = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
  const i = a.indexOf(Math.max(...a));
  const axis = (['x', 'y', 'z'] as Axis[])[i]!;
  const signed = [normal.x, normal.y, normal.z][i]!;
  // The face you clicked points AWAY from the part; the end that mates is the
  // one that face is on.
  return { axis, end: signed >= 0 ? 'high' : 'low' };
}

export function PartInspector(props: PartInspectorProps): JSX.Element {
  const { part, current, onSave, onClear, onClose } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [axis, setAxis] = useState<Axis>((current?.wallFaceAxis as Axis) ?? 'z');
  const [end, setEnd] = useState<End>(current?.matingEnd ?? 'low');
  const [spin, setSpin] = useState<number>(current?.spinSteps ?? 0);
  const [status, setStatus] = useState<string>('Loading the model…');
  /**
   * What the detector says, computed here from the same mesh rather than passed
   * in. Shown so a person can see exactly what they are overruling — and so the
   * dialog can never disagree with the detector about what the detector said.
   */
  const [detected, setDetected] = useState<{ wallFaceAxis: string; matingEnd: string } | null>(null);

  const scene = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    root: THREE.Scene;
    part: THREE.Mesh | null;
    plate: THREE.Group | null;
    size: number;
    dispose: () => void;
  } | null>(null);

  // --- the viewport ---------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const root = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    root.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(1, 1, 1);
    root.add(key);

    const state = {
      renderer, camera, root,
      part: null as THREE.Mesh | null,
      plate: null as THREE.Group | null,
      size: 50,
      dispose: () => {
        renderer.dispose();
        host.removeChild(renderer.domElement);
      },
    };
    scene.current = state;

    let raf = 0;
    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const tick = () => {
      resize();
      renderer.render(root, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      state.dispose();
      scene.current = null;
    };
  }, []);

  // --- the model ------------------------------------------------------------

  useEffect(() => {
    let live = true;
    void loadRawMesh(part).then((mesh) => {
      const s = scene.current;
      if (!live || s === null) return;
      if (mesh === null) {
        setStatus('That model could not be loaded, so there is no face to pick.');
        return;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      // Centred on its own box so the camera framing does not depend on where
      // the modeller happened to put the origin.
      const box = geometry.boundingBox!;
      const centre = box.getCenter(new THREE.Vector3());
      geometry.translate(-centre.x, -centre.y, -centre.z);
      const size = box.getSize(new THREE.Vector3());

      const body = new THREE.Mesh(
        geometry,
        new THREE.MeshLambertMaterial({ color: 0x6ea8fe }),
      );
      s.root.add(body);
      s.part = body;
      s.size = Math.max(size.x, size.y, size.z);
      const d = s.size * 2.4;
      s.camera.position.set(d, -d * 0.8, d * 0.7);
      s.camera.lookAt(0, 0, 0);
      s.camera.up.set(0, 0, 1);

      const detection = detect(mesh);
      setDetected({ wallFaceAxis: detection.wallFaceAxis, matingEnd: detection.matingEnd });
      // Nothing saved yet: start from the detector's answer, so the dialog opens
      // showing what the app is doing NOW rather than an arbitrary default.
      if (current === undefined && detection.wallFaceAxis !== 'n/a') {
        setAxis(detection.wallFaceAxis as Axis);
        setEnd(detection.matingEnd);
      }
      setStatus('');
    });
    return () => { live = false; };
  }, [part, current]);

  // --- the wall plate, against the chosen face ------------------------------

  useEffect(() => {
    const s = scene.current;
    if (s === null || s.part === null) return;
    if (s.plate) {
      s.root.remove(s.plate);
      s.plate.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }

    const group = new THREE.Group();
    const half = s.size / 2;
    const plateSize = Math.max(Math.min(s.size * 1.1, PITCH * 3), PITCH * 1.6);

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(plateSize, plateSize, PANEL_DEPTH),
      new THREE.MeshLambertMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.55 }),
    );
    group.add(slab);

    // A cell in the plate, turned by the spin, so the control has something to
    // read against: this is the hexagon the part's peg has to line up with.
    const cell = new THREE.Mesh(
      new THREE.CylinderGeometry(
        CELL.mouthAcrossFlats / Math.sqrt(3), CELL.mouthAcrossFlats / Math.sqrt(3),
        PANEL_DEPTH * 1.05, 6,
      ),
      new THREE.MeshLambertMaterial({ color: 0x1d2430 }),
    );
    cell.geometry.rotateX(Math.PI / 2);
    cell.rotation.z = (Math.PI / 6) * spin;
    group.add(cell);

    // Stand the plate off the chosen face, normal pointing back at the part.
    const i = AXIS_INDEX[axis];
    const offset = half + PANEL_DEPTH / 2 + s.size * 0.04;
    const pos = new THREE.Vector3();
    pos.setComponent(i, end === 'high' ? offset : -offset);
    group.position.copy(pos);
    if (axis === 'x') group.rotation.y = Math.PI / 2;
    if (axis === 'y') group.rotation.x = Math.PI / 2;

    s.root.add(group);
    s.plate = group;
  }, [axis, end, spin, status]);

  // --- picking --------------------------------------------------------------

  /**
   * Drag orbits, a click picks.
   *
   * Orbit is not a nicety here: the camera only ever shows three of the six
   * faces, so without it the back, the underside and one side simply cannot be
   * chosen — and those are exactly the faces a mounting plug tends to be on.
   *
   * The two gestures share a pointer, so they are told apart by distance: a
   * press that travels less than a few pixels was aiming at a face, anything
   * further was turning the model. Deciding on pointerUP rather than on down is
   * what makes that possible.
   */
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { x: event.clientX, y: event.clientY, moved: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const s = scene.current;
    if (d === null || s === null) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    d.x = event.clientX;
    d.y = event.clientY;

    const offset = s.camera.position.clone();
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dx * 0.01;
    // Clamped off the poles: at exactly 0 or π the up vector and the view
    // direction are parallel and the camera's orientation is undefined, which
    // shows up as the model flipping over.
    spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi - dy * 0.01));
    s.camera.position.setFromSpherical(spherical);
    s.camera.lookAt(0, 0, 0);
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d === null || d.moved > 4) return;

    const s = scene.current;
    const host = hostRef.current;
    if (s === null || host === null || s.part === null) return;
    const rect = host.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, s.camera);
    const hit = ray.intersectObject(s.part, false)[0];
    if (!hit || !hit.face) return;
    const picked = faceOf(hit.face.normal.clone());
    setAxis(picked.axis);
    setEnd(picked.end);
  }, []);

  const key = `${axis}:${end}`;
  const dirty =
    current === undefined ||
    current.wallFaceAxis !== axis ||
    current.matingEnd !== end ||
    (current.spinSteps ?? 0) !== spin;

  return (
    <div className="inspector__scrim" role="dialog" aria-modal="true" aria-label={`Mounting face for ${part.name}`}>
      <div className="inspector">
        <header className="inspector__head">
          <h2 className="inspector__title">{part.name}</h2>
          <button type="button" className="inspector__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="inspector__hint">
          Click the face of the model that goes <strong>against the wall</strong> — the plate moves
          to the face you pick. Drag to turn the model round and reach the faces at the back.
        </p>

        <div
          className="inspector__stage"
          ref={hostRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="presentation"
        />
        {status ? <p className="inspector__status">{status}</p> : null}

        <dl className="inspector__facts">
          <div>
            <dt>Mounting face</dt>
            <dd>{FACE_LABEL[key]}</dd>
          </div>
          <div>
            <dt>Detected</dt>
            <dd>
              {detected
                ? (FACE_LABEL[`${detected.wallFaceAxis}:${detected.matingEnd}`] ?? detected.wallFaceAxis)
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Spin</dt>
            <dd>{spin * 30}°</dd>
          </div>
        </dl>

        <div className="inspector__spin">
          <button type="button" onClick={() => setSpin((v) => (v + 11) % 12)} aria-label="Spin back 30 degrees">
            ↺ 30°
          </button>
          <button type="button" onClick={() => setSpin((v) => (v + 1) % 12)} aria-label="Spin on 30 degrees">
            ↻ 30°
          </button>
          <button type="button" onClick={() => setSpin(0)} disabled={spin === 0}>
            Reset spin
          </button>
        </div>

        <footer className="inspector__actions">
          <button
            type="button"
            className="app__primary"
            disabled={!dirty}
            onClick={() => onSave({ wallFaceAxis: axis, matingEnd: end, spinSteps: spin })}
          >
            Save mounting face
          </button>
          <button type="button" onClick={onClear} disabled={current === undefined}>
            Clear correction
          </button>
        </footer>
      </div>
    </div>
  );
}
