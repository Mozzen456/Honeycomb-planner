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
import { hexToMm } from '../core/hex';
import { AXES, detect } from '../core/detect';
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
/**
 * Which FILE axis ends up pointing up the wall, named so the green arrow is not
 * the only way to read it. `orient` maps `AXES[axis][1]` to the wall's +Y, and
 * the mating flip negates it.
 */
const UP_LABEL: Record<string, string> = {
  '0:pos': '+X of the file', '0:neg': '−X of the file',
  '1:pos': '+Y of the file', '1:neg': '−Y of the file',
  '2:pos': '+Z of the file', '2:neg': '−Z of the file',
};

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
  const [offset, setOffset] = useState<number>(current?.offsetMm ?? 0);
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

  /*
   * The camera looks from wherever `view` says, and every face has a button.
   *
   * Orbiting by hand to find a face was the whole difficulty: you cannot pick a
   * surface you cannot see, the back and underside need a deliberate turn to
   * reach, and a drag that overshoots leaves you re-orienting rather than
   * choosing. So the six faces are buttons — press one and the camera goes
   * there — and the drag is kept for looking around rather than being the only
   * way to work.
   *
   * Offset slightly off-axis so the view is never dead-on. Exactly along an axis
   * a part collapses to a flat outline and you cannot tell which end you are
   * looking at, which is the same reason the catalogue previews are three-quarter.
   */
  const [view, setView] = useState<{ axis: Axis; end: End }>({ axis: 'y', end: 'low' });
  const [zoom, setZoom] = useState(1);

  /*
   * The camera orbit, in the scene's OWN frame.
   *
   * This used `THREE.Spherical`, and that was the bug behind "up and down is
   * side to side, and I cannot rotate 360". `Spherical` is defined with **Y**
   * as the pole; this scene is **Z-up**, because the wall's normal is +Z and the
   * part is shown in wall coordinates. Reading a Z-up camera position into a
   * Y-up spherical and writing it back turned a vertical drag into a rotation
   * about the wrong pole — it came out sideways — and `phi`, clamped to keep it
   * off the Y poles, blocked the drag before it had gone anywhere.
   *
   * So the angles are held here, in the frame the scene actually uses, and the
   * position is built from them rather than round-tripped through a library
   * convention that does not match:
   *
   *     x = d·cos(el)·cos(az)   y = d·cos(el)·sin(az)   z = d·sin(el)
   *
   * Azimuth is unbounded, so it wraps and turns all the way round for as long
   * as you keep dragging. Elevation stops just short of ±90°, because at the
   * pole the view direction and the up vector are parallel and the camera's
   * roll is undefined — that is the flip, not a limit anyone wants.
   */
  const orbit = useRef({ az: -Math.PI / 2, el: 0.45, dist: 120 });

  const applyCamera = useCallback(() => {
    const s = scene.current;
    if (s === null) return;
    const { az, el, dist } = orbit.current;
    const ce = Math.cos(el);
    s.camera.position.set(dist * ce * Math.cos(az), dist * ce * Math.sin(az), dist * Math.sin(el));
    s.camera.up.set(0, 0, 1);
    s.camera.lookAt(0, 0, 0);
  }, []);

  useEffect(() => {
    const s = scene.current;
    if (s === null || s.part === null) return;
    const sign = view.end === 'high' ? 1 : -1;
    // Slightly off-axis: exactly along an axis a part collapses to a flat
    // outline and you cannot tell which end you are looking at.
    const v = new THREE.Vector3();
    if (view.axis === 'x') v.set(sign, -0.35, 0.3);
    else if (view.axis === 'y') v.set(0.35, sign, 0.3);
    else v.set(0.35, -0.35, sign);
    v.normalize();
    orbit.current.az = Math.atan2(v.y, v.x);
    orbit.current.el = Math.asin(v.z);
    orbit.current.dist = s.size * 2.4 * zoom;
    applyCamera();
  }, [view, zoom, status, applyCamera]);

  // --- the wall plate, against the chosen face ------------------------------

  useEffect(() => {
    const s = scene.current;
    if (s === null || s.part === null) return;
    if (s.plate) {
      const old = s.plate.userData['arrow'];
      if (old instanceof THREE.Object3D) s.root.remove(old);
      s.root.remove(s.plate);
      s.plate.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }

    const group = new THREE.Group();
    const half = s.size / 2;
    /*
     * A PATCH of wall, not a single cell.
     *
     * One cell in a small plate tells you the part goes in a hexagon, which you
     * knew. What you cannot judge from it is whether the part sits square to the
     * lattice, how far it spills over its neighbours, or whether a shelf's tray
     * runs along a row or across one — and those are the things a mounting
     * decision is actually about. So the plate carries the cell and its six
     * neighbours, at their real `hexToMm` positions.
     */
    const patch: readonly { q: number; r: number }[] = [
      { q: 0, r: 0 },
      { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
      { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
    ];
    const plateSize = PITCH * 3.4;

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(plateSize, plateSize, PANEL_DEPTH),
      // Faint. Pressing a face button looks straight at that face, which puts
      // the plate between the camera and the part — so it has to be something
      // you can see THROUGH, or choosing a face hides the thing you are
      // choosing it for.
      new THREE.MeshLambertMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.3 }),
    );
    group.add(slab);

    /*
     * The cells do NOT turn. The wall does not turn.
     *
     * The spin used to be applied here, and that is backwards: pressing the spin
     * control rotated the HOLE while the part sat still, which is the opposite of
     * what is being decided. A cell is a fixture of the wall — it is the thing
     * the part has to line up WITH — so it stays put and the part moves against
     * it, which is also what `meshLibrary` does when it saves the result.
     */
    const cellMat = new THREE.MeshLambertMaterial({ color: 0x1d2430 });
    for (const c of patch) {
      const cell = new THREE.Mesh(
        new THREE.CylinderGeometry(
          CELL.mouthAcrossFlats / Math.sqrt(3), CELL.mouthAcrossFlats / Math.sqrt(3),
          PANEL_DEPTH * 1.05, 6,
        ),
        cellMat,
      );
      cell.geometry.rotateX(Math.PI / 2);
      // `cellPrism`'s half-face turn: a raw 6-gon prism lands on a POINTY-top
      // cell and the wall is flat-top (D35).
      cell.geometry.rotateZ(Math.PI / 6);
      const m = hexToMm(c);
      cell.position.set(m.x, m.y, 0);
      group.add(cell);
    }

    // Stand the plate off the chosen face, normal pointing back at the part.
    //
    // `standOff`, NOT `offset`. It was called `offset` and shadowed the depth
    // state of the same name, so the part was positioned at the plate's fixed
    // stand-off distance and never moved when the depth changed — the number on
    // screen went up and down and nothing happened, which is the one thing this
    // preview exists to show.
    const i = AXIS_INDEX[axis];
    const standOff = half + PANEL_DEPTH / 2 + s.size * 0.04;
    const pos = new THREE.Vector3();
    pos.setComponent(i, end === 'high' ? standOff : -standOff);
    group.position.copy(pos);
    if (axis === 'x') group.rotation.y = Math.PI / 2;
    if (axis === 'y') group.rotation.x = Math.PI / 2;

    /*
     * Which way is UP on the wall.
     *
     * The part is shown in the FILE's frame, so "up" is not the screen's up and
     * not any fixed axis — it is whichever file axis `orient` will map to the
     * wall's +Y. That is `AXES[axis][1]`, negated when the mating end is `high`
     * because the flip negates v. Without it you can line a part up against the
     * cells and still hang a shelf sideways, which is the one mistake the
     * geometry cannot catch for you.
     */
    const upIndex = AXES[axis][1];
    const upSign = end === 'high' ? -1 : 1;
    const upDir = new THREE.Vector3();
    upDir.setComponent(upIndex, upSign);
    /*
     * Drawn ON the wall, running up it, and long enough to read.
     *
     * The first attempt was a short arrow floating beside the patch, and it was
     * useless in the common case: with the camera looking at the mounting face,
     * "up the wall" can point nearly away from you, and a short arrow foreshortens
     * to a dot. It now spans most of the patch and starts from the bottom of it,
     * so even heavily foreshortened there is a line with a head on it.
     *
     * Lifted just off the plate along the face normal so it is not buried in the
     * slab, and drawn against the cells rather than beside them — the question it
     * answers is "which way up is this part going to hang", and that is only
     * meaningful against the wall it hangs on.
     */
    const normal = new THREE.Vector3();
    normal.setComponent(i, end === 'high' ? -1 : 1);
    const arrow = new THREE.ArrowHelper(
      upDir,
      upDir.clone().multiplyScalar(-plateSize * 0.46)
        .add(normal.clone().multiplyScalar(PANEL_DEPTH * 0.8))
        .add(pos),
      plateSize * 0.92,
      0x8fd18f,
      plateSize * 0.2,
      plateSize * 0.12,
    );
    s.root.add(arrow);

    s.root.add(group);
    s.plate = group;
    // The arrow belongs to the plate's lifetime — parented so the one disposal
    // path below clears it too.
    group.userData['arrow'] = arrow;
    // The PART carries the depth offset, not the plate: the plate is the wall
    // and the wall does not move.
    //
    // The sign is the whole subtlety. The plate sits on the chosen face, so
    // moving AWAY from it is the direction that face does NOT point: with the
    // mounting face at `low`, the wall is below and out is +, and with it at
    // `high` the wall is above and out is −. Getting this backwards put "+4 mm
    // out" visibly INTO the plate, which is the one thing the preview exists to
    // show you.
    if (s.part) {
      const out = end === 'high' ? -1 : 1;
      s.part.position.set(0, 0, 0);
      s.part.position.setComponent(i, out * offset);

      /*
       * ...and the PART carries the spin, about the wall normal.
       *
       * Same sign as the depth, and for the same reason: the normal points away
       * from the plate, so it is `+axis` at a low mating end and `−axis` at a
       * high one. Matching it here means the preview turns the part the way
       * `meshLibrary.rotateZ` will once the correction is saved — otherwise you
       * would line a part up in this dialog and find it mirrored on the wall.
       */
      const angle = out * (Math.PI / 6) * spin;
      s.part.rotation.set(0, 0, 0);
      if (i === 0) s.part.rotation.x = angle;
      else if (i === 1) s.part.rotation.y = angle;
      else s.part.rotation.z = angle;
    }
  }, [axis, end, spin, offset, status]);

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

    // Drag right turns the model right; drag down brings its top toward you.
    orbit.current.az -= dx * 0.01;
    orbit.current.el = Math.max(-1.5, Math.min(1.5, orbit.current.el + dy * 0.01));
    applyCamera();
  }, []);

  /**
   * Keyboard on the stage: the arrows move the PART, not the camera.
   *
   * The camera is not what anyone is here to adjust. The job is to get the part
   * sitting right against the plate, and the two things that need nudging are
   * the turn about the wall normal and how deep it sits. The camera has the drag
   * and the six face buttons, which is plenty for looking.
   *
   *   ← →   spin about the wall normal, 30° a press
   *   ↑ ↓   OUT of the wall and INTO it, 0.5 mm a press
   *   + −   zoom
   *
   * A drag is fine for a coarse look and hopeless for a small adjustment, so
   * these are fixed steps: repeatable, and countable when you are matching a
   * part to a photograph.
   */
  const onStageKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        setSpin((v) => (v + 11) % 12);
        return;
      case 'ArrowRight':
        event.preventDefault();
        setSpin((v) => (v + 1) % 12);
        return;
      case 'ArrowUp':
        event.preventDefault();
        setOffset((v) => Math.min(40, Math.round((v + 0.5) * 10) / 10));
        return;
      case 'ArrowDown':
        event.preventDefault();
        setOffset((v) => Math.max(-40, Math.round((v - 0.5) * 10) / 10));
        return;
      case '+': case '=': event.preventDefault(); setZoom((z) => Math.max(0.4, z / 1.15)); return;
      case '-': case '_': event.preventDefault(); setZoom((z) => Math.min(3, z * 1.15)); return;
      default:
    }
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
    (current.spinSteps ?? 0) !== spin ||
    (current.offsetMm ?? 0) !== offset;

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
          Click the face of the model that goes <strong>against the wall</strong>, or press one of
          the buttons below. The plate moves to the face you pick. Drag or use the arrow keys to
          turn the view. The arrow keys move the PART: <kbd>←</kbd><kbd>→</kbd> spin it,
          <kbd>↑</kbd><kbd>↓</kbd> move it out of the wall and into it. <kbd>+</kbd>
          <kbd>−</kbd> zoom.
        </p>

        <div
          className="inspector__stage"
          ref={hostRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onStageKeyDown}
          tabIndex={0}
          role="group"
          aria-label="Model — arrow keys turn it, plus and minus zoom"
        />
        {status ? <p className="inspector__status">{status}</p> : null}

        <div className="inspector__faces">
          <span className="inspector__faceslabel">Mounting face</span>
          {(['x', 'y', 'z'] as Axis[]).flatMap((a) =>
            (['low', 'high'] as End[]).map((e) => (
              <button
                key={`${a}:${e}`}
                type="button"
                data-active={axis === a && end === e ? 'true' : undefined}
                onClick={() => { setAxis(a); setEnd(e); setView({ axis: a, end: e }); }}
                title={`Mount on the ${FACE_LABEL[`${a}:${e}`]} face, and look at it`}
              >
                {FACE_LABEL[`${a}:${e}`]}
              </button>
            )))}
        </div>

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
          <div>
            <dt>Wall up</dt>
            <dd>
              <span className="inspector__upkey" aria-hidden="true" /> {UP_LABEL[
                `${AXES[axis][1]}:${end === 'high' ? 'neg' : 'pos'}`
              ] ?? '—'}
            </dd>
          </div>
          <div>
            <dt>Depth</dt>
            <dd>{offset > 0 ? `+${offset.toFixed(1)}` : offset.toFixed(1)} mm</dd>
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
          <button type="button" onClick={() => setOffset((v) => Math.min(40, v + 0.5))}>
            Out 0.5 mm
          </button>
          <button type="button" onClick={() => setOffset((v) => Math.max(-40, v - 0.5))}>
            In 0.5 mm
          </button>
          <button type="button" onClick={() => setOffset(0)} disabled={offset === 0}>
            Reset depth
          </button>
        </div>

        <footer className="inspector__actions">
          <button
            type="button"
            className="app__primary"
            disabled={!dirty}
            onClick={() =>
              onSave({ wallFaceAxis: axis, matingEnd: end, spinSteps: spin, offsetMm: offset })}
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
