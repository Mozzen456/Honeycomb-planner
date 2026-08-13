/**
 * Pick a part's mounting face by looking at it, then put it exactly where it goes.
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
 * Picking the face is the coarse answer — which way round the part goes. On top
 * of it sit all SIX degrees of freedom of a rigid body: slide across the wall,
 * up it and out of it; spin about the normal, and tilt about each of the wall's
 * two in-plane axes. Those are what make this an alignment tool rather than a
 * face picker: a part drawn a few degrees off, or whose mating peg is not
 * centred in its own bounding box, cannot be seated by naming a face and a
 * depth. Every one of them is typeable, because "about right" is not a position
 * and a person matching a part to a photograph is counting.
 *
 * The transform itself lives in `mountingTransform.ts`, shared with
 * `meshLibrary`, so what this previews is what the wall draws.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { CELL, INSERT, PANEL_DEPTH, PITCH } from '../core/constants';
import { hexCorners, hexKey, hexNeighbours, hexToMm } from '../core/hex';
import { AXES, detect } from '../core/detect';
import {
  MAX_OFFSET_MM, MAX_TILT_DEG, socketsOf, type MountingOverride,
} from '../core/overrides';
import type { Catalog, CatalogPart, Hex, InsertRequirement } from '../core/types';
import { FootprintEditor } from './FootprintEditor';
import { thumbnailFor } from './partThumbnails';
import { loadRawMesh } from './meshLibrary';
import { fileToScene, mountingMatrixInFileFrame } from './mountingTransform';
import './PartInspector.css';

export interface PartInspectorProps {
  part: CatalogPart;
  /** Everything else, so the part can be told which fastener it hangs on. */
  catalog: Catalog;
  /** What is saved for this part now, if anything. */
  current?: MountingOverride;
  onSave: (
    mounting: MountingOverride,
    footprint: readonly Hex[],
    sockets: readonly Hex[],
    requires: readonly InsertRequirement[],
  ) => void;
  onClear: () => void;
  onClose: () => void;
}

type Axis = 'x' | 'y' | 'z';
type End = 'low' | 'high';
type Seat = 'wall' | 'insert';

/**
 * A footprint the editor can work on: the anchor is always a member, and no
 * cell appears twice.
 *
 * `partCells` puts the anchor under the cursor, so a footprint with nothing at
 * the origin has no cell to drag the part by. `applyOverrides` enforces the
 * same two rules on the way back in, which is what makes the round trip stable.
 */
function normaliseCells(cells: readonly Hex[] | undefined): Hex[] {
  const seen = new Set<string>(['0,0']);
  const out: Hex[] = [{ q: 0, r: 0 }];
  for (const c of cells ?? []) {
    if (typeof c?.q !== 'number' || typeof c?.r !== 'number') continue;
    const key = hexKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ q: c.q, r: c.r });
  }
  return out;
}

const sameCells = (a: readonly Hex[], b: readonly Hex[]): boolean => {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(hexKey));
  return b.every((c) => keys.has(hexKey(c)));
};

/** Two requirement lists, compared as the BOM would read them. */
const sameRequires = (
  a: readonly InsertRequirement[], b: readonly InsertRequirement[],
): boolean => {
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.partId === b[i]?.partId && r.count === b[i]?.count);
};

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

/** A seating number as it is stored: a tenth of its unit, within its bound. */
const trim = (value: number, limit: number): number => {
  const tenths = Math.sign(value) * Math.round(Math.abs(value) * 10);
  const clamped = Math.max(-limit, Math.min(limit, tenths / 10));
  return clamped === 0 ? 0 : clamped;
};

const fmt = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/**
 * One degree of freedom: a label, a step either way, and a field to type into.
 *
 * The field is the point. Buttons are for nudging while you watch, and nudging
 * is hopeless for "3.2 mm out and 7° round" — which is what matching a part to a
 * measurement or a photograph actually asks for. So the number is editable, and
 * the buttons move it by a sensible step.
 *
 * The text is held locally while the field has focus and re-synced from the
 * value when it does not. A controlled numeric input without that cannot be
 * typed into: clearing it to type `-3` yields an empty string, which parses to
 * nothing, and the old value is written straight back under the cursor.
 */
function Nudge(props: {
  label: string;
  title: string;
  unit: string;
  step: number;
  limit: number;
  value: number;
  onChange: (value: number) => void;
}): JSX.Element {
  const { label, title, unit, step, limit, value, onChange } = props;
  const [text, setText] = useState(() => fmt(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(fmt(value)); }, [value, editing]);

  return (
    <div className="inspector__dofrow">
      <span className="inspector__doflabel" title={title}>{label}</span>
      <button
        type="button"
        className="button"
        onClick={() => onChange(trim(value - step, limit))}
        aria-label={`${label}: less ${step} ${unit}`}
      >
        −
      </button>
      <input
        type="number"
        className="inspector__dofinput"
        step={step}
        min={-limit}
        max={limit}
        value={text}
        aria-label={`${label}, ${unit}`}
        onFocus={() => setEditing(true)}
        onBlur={() => { setEditing(false); setText(fmt(value)); }}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = Number.parseFloat(event.target.value);
          if (Number.isFinite(parsed)) onChange(trim(parsed, limit));
        }}
      />
      <button
        type="button"
        className="button"
        onClick={() => onChange(trim(value + step, limit))}
        aria-label={`${label}: more ${step} ${unit}`}
      >
        +
      </button>
      <button
        type="button"
        className="button"
        onClick={() => onChange(0)}
        disabled={value === 0}
        aria-label={`Reset ${label}`}
      >
        0
      </button>
    </div>
  );
}

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
  const { part, catalog, current, onSave, onClear, onClose } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [axis, setAxis] = useState<Axis>((current?.wallFaceAxis as Axis) ?? 'z');
  const [end, setEnd] = useState<End>(current?.matingEnd ?? 'low');
  // The six seating numbers, in wall coordinates: +X across, +Y up, +Z out.
  const [spin, setSpin] = useState<number>(current?.spinSteps ?? 0);
  const [spinDeg, setSpinDeg] = useState<number>(current?.spinDeg ?? 0);
  const [tiltX, setTiltX] = useState<number>(current?.tiltXDeg ?? 0);
  const [tiltY, setTiltY] = useState<number>(current?.tiltYDeg ?? 0);
  const [slideX, setSlideX] = useState<number>(current?.offsetXMm ?? 0);
  const [slideY, setSlideY] = useState<number>(current?.offsetYMm ?? 0);
  const [offset, setOffset] = useState<number>(current?.offsetMm ?? 0);
  /** What depth is measured from: the wall's face, or the inserts holding it. */
  const [seat, setSeat] = useState<Seat>(current?.seat ?? 'wall');
  /**
   * How much wall the part takes.
   *
   * Seeded from the catalogue, which for an insert-fed part means the bounding
   * box laid over the lattice — the bound PARKED P1 describes, and exactly the
   * thing a person is here to replace.
   */
  const [cells, setCells] = useState<readonly Hex[]>(() => normaliseCells(part.footprint));
  /**
   * The cells of THIS part that something else can be installed into.
   *
   * `insert-for-countersunk-hole-3` is the case: four cells, one wall screw and
   * three open sockets. Until the planner knew which was which it refused
   * everything in all four, which treats a mounting position as solid material.
   */
  const [sockets, setSockets] = useState<readonly Hex[]>(() => socketsOf(part));
  /**
   * Which fastener holds this part on, and how many of them.
   *
   * The catalogue's own answer is a guess for most parts: `tools/scan.py` reads
   * bolt bores and cannot see a peg, so it ordered one insert per bore, or none
   * at all, or `insert-empty × cells` (PARKED P1, `overrides.json`). A person
   * looking at the model and at the insert family can just say which one.
   */
  const [fastenerId, setFastenerId] = useState<string>(() => part.requires?.[0]?.partId ?? '');
  const [fastenerCount, setFastenerCount] = useState<number>(
    () => Math.max(1, Math.round(part.requires?.[0]?.count ?? 1)),
  );
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
    /**
     * Everything that belongs to the WALL, turned so the wall's up is the
     * scene's up. See the rotation effect below — it is what makes "up" up.
     */
    stage: THREE.Group;
    key: THREE.DirectionalLight;
    part: THREE.Mesh | null;
    plate: THREE.Group | null;
    size: number;
    /** Half the part's own bounding box, per FILE axis. The tilt hinges on it. */
    half: THREE.Vector3;
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

    /*
     * Lighting for INSPECTION, which is a different job from looking pretty.
     *
     * It was ambient 0.75 plus one fixed key, and that is why the part read as a
     * flat blue silhouette: at that much ambient every face receives nearly the
     * same light, so a slot, a fillet and a flat panel all come out the same
     * tone. Detail in a 3D view IS the tonal difference between faces, and
     * ambient is precisely what destroys it.
     *
     * So: enough ambient to keep shadowed faces readable, and a KEY THAT FOLLOWS
     * THE CAMERA. A fixed key is fine for a fixed view and useless here — the
     * whole point is turning the part round, and half the orbit put the face you
     * were looking at in shadow. The headlight is updated each frame in the
     * render loop below.
     */
    root.add(new THREE.AmbientLight(0xffffff, 0.38));
    const key = new THREE.DirectionalLight(0xffffff, 0.72);
    root.add(key);
    // A fixed fill from below-left, so a face square to the headlight still has
    // some gradient across it rather than reading as one flat wash.
    const fill = new THREE.DirectionalLight(0xffffff, 0.26);
    fill.position.set(-1, -0.6, 0.5);
    root.add(fill);

    const stage = new THREE.Group();
    root.add(stage);

    const state = {
      renderer, camera, root, stage, key,
      part: null as THREE.Mesh | null,
      plate: null as THREE.Group | null,
      size: 50,
      half: new THREE.Vector3(25, 25, 25),
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
      // The headlight rides the camera, so whatever you have turned toward you
      // is the thing that is lit.
      key.position.copy(camera.position);
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
        // Phong, not Lambert. Lambert has no specular term at all, so a curved
        // surface and a flat one at the same angle are indistinguishable. The
        // highlight is what makes a fillet look like a fillet.
        new THREE.MeshPhongMaterial({ color: 0x6ea8fe, shininess: 24, specular: 0x2a3a4a }),
      );

      /*
       * Edges over the surface.
       *
       * This is the single biggest thing for reading a part. Shading alone
       * cannot separate two coplanar-ish faces meeting at a shallow angle, and
       * these models are full of them — the slots in a card holder, the lip on a
       * shelf, the step between a flange and a body. `EdgesGeometry`'s threshold
       * keeps it to genuine creases rather than drawing every triangle.
       *
       * Parented to the body so it inherits the spin and depth transforms — an
       * outline that did not follow the part would be worse than none.
       */
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 24),
        new THREE.LineBasicMaterial({ color: 0x14202c, transparent: true, opacity: 0.55 }),
      );
      // The transform is written into the matrix directly, from one shared
      // helper — so three.js must not recompute it from position/rotation.
      body.matrixAutoUpdate = false;
      body.add(edges);
      s.stage.add(body);
      s.part = body;
      s.size = Math.max(size.x, size.y, size.z);
      s.half.set(size.x / 2, size.y / 2, size.z / 2);

      const detection = detect(mesh);
      setDetected({ wallFaceAxis: detection.wallFaceAxis, matingEnd: detection.matingEnd });
      // Nothing saved yet: start from the detector's answer, so the dialog opens
      // showing what the app is doing NOW rather than an arbitrary default.
      const known = current !== undefined
        ? { axis: current.wallFaceAxis as Axis, end: current.matingEnd }
        : detection.wallFaceAxis !== 'n/a'
          ? { axis: detection.wallFaceAxis as Axis, end: detection.matingEnd }
          : null;
      if (current === undefined && known !== null) {
        setAxis(known.axis);
        setEnd(known.end);
      }
      /*
       * Open looking at the part from the ROOM, not from inside the wall.
       *
       * The camera used to start at a fixed front view, which for a part
       * mounting on its top face put the plate between the eye and the part —
       * and now that the plate is flush against the mating face, that is not a
       * poor angle, it is a part you cannot see at all. The room side is
       * whichever end the mating face is NOT on.
       */
      if (known !== null) setView({ axis: known.axis, end: known.end === 'high' ? 'low' : 'high' });
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

  /*
   * UP THE WALL IS UP ON SCREEN.
   *
   * The part is modelled in the FILE's frame, because the question this dialog
   * asks is "which axis of this STL faces the wall" and a click has to land on
   * an axis of the STL. But nobody hangs a shelf in the file's frame: the thing
   * a person is judging is how it will sit on a WALL, and that judgement is
   * impossible while "up the wall" is whichever way the modeller happened to
   * draw. A green arrow was the workaround; being able to read the arrow is not
   * the same as the part standing up.
   *
   * So the whole stage is turned instead of the part. `wallBasis` maps wall
   * coordinates to file ones, so its transpose maps file to wall; then one fixed
   * map puts wall coordinates into the scene:
   *
   *     wall +X (across) -> scene +X      right on screen
   *     wall +Y (up)     -> scene +Z      up on screen, and the orbit's pole
   *     wall +Z (out)    -> scene −Y      toward the default camera
   *
   * Its determinant is +1, so it is a rotation and never a mirror. Nothing
   * inside the stage moves: the part keeps its file coordinates, which is why
   * the raycast still names a file axis — `face.normal` is local, and a parent
   * rotation does not touch it.
   */
  useEffect(() => {
    const s = scene.current;
    if (s === null) return;
    s.stage.setRotationFromMatrix(fileToScene(axis, end));
  }, [axis, end, status]);

  /*
   * The camera looks from the ROOM, a little above, and that is now the only
   * view worth defaulting to: with the stage turned, every mounting face points
   * the same way, so there is nothing left for a per-face camera rule to say.
   * The drag goes wherever you want from there.
   */
  useEffect(() => {
    const s = scene.current;
    if (s === null || s.part === null) return;
    // Three-quarter, not dead-on: exactly along the wall normal a part collapses
    // to its own silhouette and you cannot see how far it stands out. Off in
    // azimuth and elevation only — the roll stays put, so up stays up.
    orbit.current.az = -Math.PI / 2 + 0.42;
    orbit.current.el = 0.32;
    orbit.current.dist = s.size * 2.4 * zoom;
    applyCamera();
  }, [view, zoom, status, applyCamera]);

  // --- the wall plate, against the chosen face ------------------------------

  useEffect(() => {
    const s = scene.current;
    if (s === null || s.part === null) return;
    if (s.plate) {
      const old = s.plate.userData['arrow'];
      if (old instanceof THREE.Object3D) s.stage.remove(old);
      s.stage.remove(s.plate);
      s.plate.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }

    const group = new THREE.Group();
    /*
     * The patch is the part's OWN cells, plus a ring to see them against.
     *
     * It was a fixed centre-and-six, which is right for a one-cell hook and
     * wrong for everything else: a four-cell shelf spilled off the plate, and
     * the one question the plate exists to answer — does this part cover the
     * cells it claims — could not be asked at all. Now the chosen cells are
     * drawn as chosen, their neighbours as context, and the slab is sized to
     * hold both.
     */
    const patch = new Map<string, Hex>();
    for (const c of cells) {
      patch.set(hexKey(c), c);
      for (const n of hexNeighbours(c)) patch.set(hexKey(n), n);
    }

    /*
     * The BLOCK's centre, not cell (0, 0).
     *
     * `meshLibrary.orient` centres a part on its own wall-plane bounding box and
     * this dialog centres the mesh on its bbox too, so the cells have to be
     * centred on the block or the two are offset by however far the anchor sits
     * from the middle. On a four-cell diamond that is 20 mm — the part drawn
     * beside its own holes rather than in them.
     */
    const mid = { x: 0, y: 0 };
    for (const c of cells) {
      const m = hexToMm(c);
      mid.x += m.x / cells.length;
      mid.y += m.y / cells.length;
    }
    const at = (c: Hex): { x: number; y: number } => {
      const m = hexToMm(c);
      return { x: m.x - mid.x, y: m.y - mid.y };
    };

    let reach = PITCH;
    for (const c of patch.values()) {
      const m = at(c);
      reach = Math.max(reach, Math.abs(m.x) + PITCH * 0.75, Math.abs(m.y) + PITCH * 0.75);
    }
    const plateSize = reach * 2;

    /*
     * A plate with HOLES in it, not a slab with plugs in it.
     *
     * This is what made every insert disappear. The cells were drawn as solid
     * hexagonal prisms filling each hole, which is fine behind an accessory that
     * stands proud of the wall and fatal for a part that goes INTO the cells:
     * `insert-for-countersunk-hole-3` sat exactly inside four opaque prisms and
     * could not be seen at all. A cell is a hole. Drawing it as material was the
     * bug, and the wall view had already got this right — `buildPanelGeometry`
     * extrudes one outline with a hole per cell for the same reason.
     */
    const half = plateSize / 2;
    /** The plate with a hexagon of `acrossFlats` taken out of every patch cell. */
    const perforated = (acrossFlats: number): THREE.Shape => {
      const shape = new THREE.Shape([
        new THREE.Vector2(-half, -half), new THREE.Vector2(half, -half),
        new THREE.Vector2(half, half), new THREE.Vector2(-half, half),
      ]);
      for (const c of patch.values()) {
        // Clockwise, so it reads as a hole against the counter-clockwise outline.
        const corners = hexCorners(c, acrossFlats);
        const pts: THREE.Vector2[] = [];
        for (let k = corners.length - 1; k >= 0; k--) {
          pts.push(new THREE.Vector2(corners[k]!.x - mid.x, corners[k]!.y - mid.y));
        }
        shape.holes.push(new THREE.Path(pts));
      }
      return shape;
    };

    const layer = (acrossFlats: number, thickness: number, farFace: number): THREE.Mesh => {
      const g = new THREE.ExtrudeGeometry([perforated(acrossFlats)], {
        depth: thickness, bevelEnabled: false, curveSegments: 1,
      });
      g.translate(0, 0, farFace);
      g.computeVertexNormals();
      return new THREE.Mesh(
        g,
        // Faint as well as perforated. Pressing a face button can put the plate
        // between the camera and the part, so it has to be something you can see
        // THROUGH — or choosing a face hides the thing you are choosing it for.
        new THREE.MeshLambertMaterial({
          color: 0x9aa4b2, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
        }),
      );
    };

    /**
     * A hexagonal prism on the FLAT-TOP lattice.
     *
     * The half-face turn is `cellPrism`'s in `WallView3D`, and it is compulsory:
     * `CylinderGeometry(…, 6)` lands its corners on a POINTY-top cell and this
     * wall is flat-top (D35). Never inline a bare cylinder for anything that has
     * to sit in a cell.
     */
    const prism = (acrossFlats: number, height: number): THREE.CylinderGeometry => {
      const g = new THREE.CylinderGeometry(
        acrossFlats / Math.sqrt(3), acrossFlats / Math.sqrt(3), height, 6,
      );
      g.rotateX(Math.PI / 2);
      g.rotateZ(Math.PI / 6);
      return g;
    };

    /*
     * The cells do NOT turn. The wall does not turn.
     *
     * The spin used to be applied here, and that is backwards: pressing the spin
     * control rotated the HOLE while the part sat still, which is the opposite of
     * what is being decided. A cell is a fixture of the wall — it is the thing
     * the part has to line up WITH — so it stays put and the part moves against
     * it, which is also what `meshLibrary` does when it saves the result.
     */
    /*
     * Which cells the part claims, as a RING round the hole rather than a plug
     * in it — for the same reason the plate is perforated. Blue for a cell the
     * part covers, gold for one it offers as a socket, nothing at all for the
     * neighbours that are only there for context.
     */
    const claimedMat = new THREE.MeshBasicMaterial({ color: 0x2f5d8a, side: THREE.DoubleSide });
    const socketMat = new THREE.MeshBasicMaterial({ color: 0xc9a227, side: THREE.DoubleSide });
    const open = new Set(sockets.map(hexKey));
    const ring = (cell: Hex): THREE.ExtrudeGeometry => {
      // 0.6 mm each side, so the marker sits ON the web without swallowing it:
      // the web is 1.6 mm and it is now drawn at its real width.
      const outer = hexCorners(cell, CELL.mouthAcrossFlats + 1.2)
        .map((p) => new THREE.Vector2(p.x - mid.x, p.y - mid.y));
      const innerPts = hexCorners(cell, CELL.mouthAcrossFlats)
        .map((p) => new THREE.Vector2(p.x - mid.x, p.y - mid.y))
        .reverse();
      const s = new THREE.Shape(outer);
      s.holes.push(new THREE.Path(innerPts));
      const g = new THREE.ExtrudeGeometry([s], {
        depth: 0.8, bevelEnabled: false, curveSegments: 1,
      });
      g.computeVertexNormals();
      return g;
    };

    /*
     * The inserts, when the part is seated on them.
     *
     * HSW is two-level (HSW-SPEC §5): the insert clips into the cell and the
     * accessory pegs into the insert. Its 22.5 mm flange cannot enter the
     * 22.0 mm mouth, so it stands proud by `INSERT.flangeThickness` and the part
     * rests on THAT, not on the wall. Drawn only when the seat says so, so the
     * control has a visible consequence rather than being 2.5 mm of arithmetic.
     *
     * Which way is proud is not assumed: the plate is turned to face the chosen
     * axis, so the direction back toward the part is taken from the group's own
     * rotation rather than from a sign somebody has to keep true by hand.
     */
    const i = AXIS_INDEX[axis];
    if (axis === 'x') group.rotation.y = Math.PI / 2;
    if (axis === 'y') group.rotation.x = Math.PI / 2;
    const towardPart = new THREE.Vector3()
      .setComponent(i, end === 'high' ? -1 : 1)
      .applyQuaternion(group.quaternion.clone().invert());
    const face = Math.sign(towardPart.z) || 1;

    /*
     * THE CELL IS THE REAL CELL, not a straight 22 mm hole.
     *
     * A wall cell is stepped: a 22.0 mm mouth 2.0 mm deep, then the 20.0 mm
     * throat that actually retains an insert (HSW-SPEC §3, `CELL`). Drawing one
     * straight bore at the mouth made every cell in this dialog read wider than
     * the same cell on the wall — the tool and the wall disagreeing about the
     * size of the honeycomb, which is the one thing a person is here to judge.
     * Two layers, exactly as `buildPanelGeometry` builds the wall itself, and
     * the mouth goes on the side the PART is on.
     */
    group.add(layer(CELL.mouthAcrossFlats, CELL.mouthDepth, face > 0
      ? PANEL_DEPTH / 2 - CELL.mouthDepth
      : -PANEL_DEPTH / 2));
    group.add(layer(CELL.throatAcrossFlats, PANEL_DEPTH - CELL.mouthDepth, face > 0
      ? -PANEL_DEPTH / 2
      : -PANEL_DEPTH / 2 + CELL.mouthDepth));

    // The rings sit on the face the part is on, so they are never behind it.
    for (const c of cells) {
      const key = hexKey(c);
      const mark = new THREE.Mesh(ring(c), open.has(key) ? socketMat : claimedMat);
      mark.position.z = face * (PANEL_DEPTH / 2 - 0.4);
      group.add(mark);
    }

    if (seat === 'insert') {
      const insertMat = new THREE.MeshPhongMaterial({ color: 0xc9a227, shininess: 16 });
      for (const c of cells) {
        const flange = new THREE.Mesh(
          prism(INSERT.flangeAcrossFlats, INSERT.flangeThickness),
          insertMat,
        );
        const m = at(c);
        flange.position.set(
          m.x, m.y, face * (PANEL_DEPTH / 2 + INSERT.flangeThickness / 2),
        );
        group.add(flange);
      }
    }

    /*
     * The plate goes FLUSH against the chosen face, not near it.
     *
     * It used to stand off by half the part's LARGEST dimension plus a 4% gap,
     * which for anything that is not a cube left the part hanging in mid air —
     * so zero depth looked wrong and every reading of the depth control was
     * relative to a gap nobody chose. On the wall, zero means the mating face is
     * ON the wall surface (`orient` puts it at z = 0), and that is now what zero
     * looks like here: the plate's inner face is the mating plane, and the six
     * seating numbers move the part against it.
     *
     * `standOff`, NOT `offset`. It was called `offset` and shadowed the depth
     * state of the same name, so the part was positioned at the plate's fixed
     * stand-off distance and never moved when the depth changed — the number on
     * screen went up and down and nothing happened, which is the one thing this
     * preview exists to show.
     */
    const standOff = s.half.getComponent(i) + PANEL_DEPTH / 2;
    const pos = new THREE.Vector3();
    pos.setComponent(i, end === 'high' ? standOff : -standOff);
    group.position.copy(pos);

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
    s.stage.add(arrow);

    s.stage.add(group);
    s.plate = group;
    // The arrow belongs to the plate's lifetime — parented so the one disposal
    // path below clears it too.
    group.userData['arrow'] = arrow;
  }, [axis, end, cells, sockets, seat, status]);

  // --- the six seating numbers ----------------------------------------------

  /**
   * What would be saved if you pressed the button now.
   *
   * One object, used for the preview AND for the save, so the two cannot come
   * apart. Zeroes are left OUT rather than written as `0`: what this produces is
   * committed into `overrides.json` by hand, and six zeroes per part is a diff
   * nobody reads.
   */
  const mounting = useMemo<MountingOverride>(() => {
    const out: MountingOverride = { wallFaceAxis: axis, matingEnd: end };
    if (spin !== 0) out.spinSteps = spin;
    if (spinDeg !== 0) out.spinDeg = spinDeg;
    if (tiltX !== 0) out.tiltXDeg = tiltX;
    if (tiltY !== 0) out.tiltYDeg = tiltY;
    if (offset !== 0) out.offsetMm = offset;
    if (slideX !== 0) out.offsetXMm = slideX;
    if (slideY !== 0) out.offsetYMm = slideY;
    if (seat !== 'wall') out.seat = seat;
    return out;
  }, [axis, end, spin, spinDeg, tiltX, tiltY, offset, slideX, slideY, seat]);

  /*
   * The PART moves, the plate does not: the plate is the wall, and the wall does
   * not move.
   *
   * Every sign and every axis mapping comes from `mountingMatrixInFileFrame` —
   * the same helper `meshLibrary` bakes into the wall's own geometry, conjugated
   * into the file's frame because that is the frame this dialog draws in. That
   * shared transform is the whole point: the previous version reimplemented the
   * spin and the depth here, with their own sign rules, and a discrepancy would
   * only show up as a part lined up in the dialog and wrong on the wall.
   */
  useEffect(() => {
    const s = scene.current;
    if (s === null || s.part === null) return;
    s.part.matrix.copy(
      mountingMatrixInFileFrame(mounting, axis, end, s.half.getComponent(AXIS_INDEX[axis])),
    );
    // Set by hand rather than by three.js, which will not recompute a world
    // matrix nobody told it had changed — and the raycast that picks a face
    // reads exactly that.
    s.part.updateMatrixWorld(true);
  }, [mounting, axis, end, status]);

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
   * sitting right against the plate; the camera has the drag and the six face
   * buttons, which is plenty for looking.
   *
   *   ← →           spin about the wall normal, 30° a press
   *   ↑ ↓           OUT of the wall and INTO it, 0.5 mm a press
   *   shift ← → ↑ ↓ slide across the wall and up it, 0.5 mm a press
   *   alt   ← →     tilt about the up axis, 1° a press
   *   alt   ↑ ↓     tilt about the across axis, 1° a press
   *   + −           zoom
   *
   * The two unmodified pairs are the ones that were here before a part could be
   * moved in six directions, and they still do the same thing — the common
   * adjustments should not move because four more became possible. The modifiers
   * follow the same geometry as the bare keys: left and right stay the across
   * axis whatever they are doing to it, up and down stay the up axis.
   *
   * A drag is fine for a coarse look and hopeless for a small adjustment, so
   * these are fixed steps: repeatable, and countable when you are matching a
   * part to a photograph. For a number you already know, type it into the field.
   */
  const onStageKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const slide = event.shiftKey;
    const tilt = event.altKey;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        if (slide) setSlideX((v) => trim(v - 0.5, MAX_OFFSET_MM));
        else if (tilt) setTiltY((v) => trim(v - 1, MAX_TILT_DEG));
        else setSpin((v) => (v + 11) % 12);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (slide) setSlideX((v) => trim(v + 0.5, MAX_OFFSET_MM));
        else if (tilt) setTiltY((v) => trim(v + 1, MAX_TILT_DEG));
        else setSpin((v) => (v + 1) % 12);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (slide) setSlideY((v) => trim(v + 0.5, MAX_OFFSET_MM));
        else if (tilt) setTiltX((v) => trim(v + 1, MAX_TILT_DEG));
        else setOffset((v) => trim(v + 0.5, MAX_OFFSET_MM));
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (slide) setSlideY((v) => trim(v - 0.5, MAX_OFFSET_MM));
        else if (tilt) setTiltX((v) => trim(v - 1, MAX_TILT_DEG));
        else setOffset((v) => trim(v - 0.5, MAX_OFFSET_MM));
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

  /** What the parts list will order for this part, as the override stores it. */
  const requires: InsertRequirement[] = fastenerId === ''
    ? []
    : [{ partId: fastenerId, count: Math.max(1, Math.round(fastenerCount)) }];

  const key = `${axis}:${end}`;
  /*
   * Dirty against what is SAVED, field by field, with an absent field reading as
   * zero — an override written before the part could be moved sideways carries
   * no `offsetXMm`, and that is the same document as one carrying `0`.
   */
  const dirty =
    current === undefined ||
    current.wallFaceAxis !== axis ||
    current.matingEnd !== end ||
    (current.spinSteps ?? 0) !== spin ||
    (current.spinDeg ?? 0) !== spinDeg ||
    (current.tiltXDeg ?? 0) !== tiltX ||
    (current.tiltYDeg ?? 0) !== tiltY ||
    (current.offsetMm ?? 0) !== offset ||
    (current.offsetXMm ?? 0) !== slideX ||
    (current.offsetYMm ?? 0) !== slideY ||
    (current.seat ?? 'wall') !== seat ||
    // The cells compare against the CATALOGUE's, which already has any saved
    // correction folded in — so a drawn footprint reads as clean once saved.
    !sameCells(cells, normaliseCells(part.footprint)) ||
    !sameCells(sockets, socketsOf(part)) ||
    !sameRequires(requires, part.requires ?? []);

  const seated = spin === 0 && spinDeg === 0 && tiltX === 0 && tiltY === 0
    && offset === 0 && slideX === 0 && slideY === 0;

  /*
   * The insert family, with a picture of each.
   *
   * A picture and not a dropdown of ids because that is the only way to tell
   * `insert-hollow-tre` from `insert-hollow-for` without opening the STL: the
   * names differ by three letters and the parts differ by a cell. The thumbnails
   * are the same renders the catalogue tiles use, cached per part id, so showing
   * them here costs nothing the app was not already paying.
   */
  const fasteners = useMemo(
    () => catalog.parts
      .filter((p) => p.type === 'insert' || p.type === 'fastener')
      .sort((a, b) => a.footprint.length - b.footprint.length || a.name.localeCompare(b.name)),
    [catalog],
  );
  const [shots, setShots] = useState<ReadonlyMap<string, string | null>>(new Map());

  useEffect(() => {
    let live = true;
    void (async () => {
      const got = new Map<string, string | null>();
      for (const f of fasteners) {
        const url = await thumbnailFor(f);
        if (!live) return;
        got.set(f.id, url);
        setShots(new Map(got));
      }
    })();
    return () => { live = false; };
  }, [fasteners]);

  /** Read structurally: `needsReview` is not part of the `CatalogPart` contract. */
  const reviewing = (part as unknown as { needsReview?: unknown }).needsReview === true;
  /*
   * What the parts list orders to hold this part up, named here so nobody reads
   * the cell count as a shopping list. They are different facts: cells are how
   * much wall it covers, `requires` is the pegs measured on its wall face — and
   * conflating them is what had a 7-cell shelf with two pegs ordering seven
   * inserts (CLAUDE.md, HSW-SPEC §5).
   */
  const requiresText = (part.requires ?? [])
    .filter((r) => r && r.count > 0)
    .map((r) => `${r.count} × ${r.partId}`)
    .join(', ');

  /*
   * The spin reads as ONE angle and stores as two.
   *
   * `spinSteps` are the turns the hex lattice itself has and `spinDeg` is the
   * trim between them, but nobody thinks in "two steps and four degrees" — they
   * think in 64°. So the field is the total, and it is split on the way in.
   */
  const spinTotal = trim(spin * 30 + spinDeg, 360);
  const setSpinTotal = (deg: number): void => {
    const total = ((trim(deg, 360) % 360) + 360) % 360;
    const steps = Math.floor(total / 30) % 12;
    setSpin(steps);
    setSpinDeg(trim(total - steps * 30, MAX_TILT_DEG));
  };

  const resetSeating = (): void => {
    setSpin(0); setSpinDeg(0); setTiltX(0); setTiltY(0);
    setOffset(0); setSlideX(0); setSlideY(0);
  };

  /**
   * One click cycles a cell: empty → covered → a socket → empty again.
   *
   * Three states on one gesture rather than a mode switch, because they are
   * three answers to one question — what is this cell to this part — and a
   * person marking up a four-cell junction insert is going round all four of
   * them in one pass.
   *
   * The anchor cycles between covered and socket and is never removed:
   * `partCells` hangs the whole footprint off it, so a part without one has no
   * cell under the cursor to drag by. `ImportDialog` and `applyOverrides` keep
   * the same rule.
   */
  const toggleCell = (cell: Hex): void => {
    const key = hexKey(cell);
    const anchor = cell.q === 0 && cell.r === 0;
    const covered = cells.some((c) => hexKey(c) === key);
    const open = sockets.some((c) => hexKey(c) === key);

    if (!covered) {
      setCells((prev) => [...prev, cell]);
      return;
    }
    if (!open) {
      setSockets((prev) => [...prev, cell]);
      return;
    }
    setSockets((prev) => prev.filter((c) => hexKey(c) !== key));
    if (!anchor) setCells((prev) => prev.filter((c) => hexKey(c) !== key));
  };

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
          the buttons below. The plate moves to the face you pick, and it is the wall — zero
          everywhere means the part sits flat on it. Drag to turn the view. On the stage the arrow
          keys move the PART: <kbd>←</kbd><kbd>→</kbd> spin, <kbd>↑</kbd><kbd>↓</kbd> out and in,
          <kbd>shift</kbd> slide it across the wall and up it, <kbd>alt</kbd> tilt it.
          <kbd>+</kbd><kbd>−</kbd> zoom. Type into any field for an exact figure.
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
          aria-label="Model — arrow keys spin it and set its depth, shift slides it, alt tilts it, plus and minus zoom"
        />
        {status ? <p className="inspector__status">{status}</p> : null}

        <div className="inspector__faces">
          <span className="inspector__faceslabel">Mounting face</span>
          {(['x', 'y', 'z'] as Axis[]).flatMap((a) =>
            (['low', 'high'] as End[]).map((e) => (
              <button
                key={`${a}:${e}`}
                type="button"
                className="button"
                data-active={axis === a && end === e ? 'true' : undefined}
                onClick={() => {
                  setAxis(a);
                  setEnd(e);
                  // Look from the room at the face you just chose — the plate is
                  // flush against it, so looking AT it is looking at the plate.
                  setView({ axis: a, end: e === 'high' ? 'low' : 'high' });
                }}
                title={`Mount on the ${FACE_LABEL[`${a}:${e}`]} face, and look at it from the room`}
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
            <dt>Wall up</dt>
            <dd>
              <span className="inspector__upkey" aria-hidden="true" /> {UP_LABEL[
                `${AXES[axis][1]}:${end === 'high' ? 'neg' : 'pos'}`
              ] ?? '—'}
            </dd>
          </div>
        </dl>

        {/*
          The six degrees of freedom the face does not fix, in wall coordinates.

          Three that MOVE and three that TURN, in two columns rather than one
          list of six: they are two different questions — is it in the right
          place, is it square — and a person answers them in that order. The unit
          is on the group, so each row is a name and a number.
        */}
        <div className="inspector__dof">
          <fieldset className="inspector__dofgroup">
            <legend className="inspector__doflegend">Move · mm</legend>
            <Nudge
              label="Across" title="Slide along the wall, positive to the right"
              unit="mm" step={0.5} limit={MAX_OFFSET_MM} value={slideX} onChange={setSlideX}
            />
            <Nudge
              label="Up" title="Slide up the wall, positive upward"
              unit="mm" step={0.5} limit={MAX_OFFSET_MM} value={slideY} onChange={setSlideY}
            />
            <Nudge
              label="Depth" title="Out of the wall (positive) or into it (negative)"
              unit="mm" step={0.5} limit={MAX_OFFSET_MM} value={offset} onChange={setOffset}
            />
          </fieldset>
          <fieldset className="inspector__dofgroup">
            <legend className="inspector__doflegend">Turn · degrees</legend>
            <Nudge
              label="Spin" title="Turn about the wall normal. The lattice repeats every 60°"
              unit="degrees" step={1} limit={360} value={spinTotal} onChange={setSpinTotal}
            />
            <Nudge
              label="Tilt across"
              title="Turn about the across-wall axis: the top swings out of the wall"
              unit="degrees" step={1} limit={MAX_TILT_DEG} value={tiltX} onChange={setTiltX}
            />
            <Nudge
              label="Tilt up"
              title="Turn about the up-the-wall axis: the right edge swings into the wall"
              unit="degrees" step={1} limit={MAX_TILT_DEG} value={tiltY} onChange={setTiltY}
            />
          </fieldset>
        </div>

        <div className="inspector__spin">
          {/* The lattice's own turns, kept as buttons: 30° is the step that means
              something here, and counting twelve presses of +1° to reach it is
              not how anyone lines a hexagon up. */}
          <button
            type="button" className="button"
            onClick={() => setSpin((v) => (v + 11) % 12)} aria-label="Spin back 30 degrees"
          >
            ↺ 30°
          </button>
          <button
            type="button" className="button"
            onClick={() => setSpin((v) => (v + 1) % 12)} aria-label="Spin on 30 degrees"
          >
            ↻ 30°
          </button>
          <button type="button" className="button" onClick={resetSeating} disabled={seated}>
            Sit it flat on the wall
          </button>
        </div>

        {/*
          How much wall the part takes, and what holds it there.

          These two belong together and neither is measurable. `detect()` gives a
          footprint for every part, but for one with no wall interface it is the
          bounding box laid over the lattice — a bound, not a measurement — and
          which cells an installer uses is a CHOICE (PARKED P1). The seat is the
          same kind of fact: geometry can measure the insert's flange, but only a
          person knows whether this part rests on inserts or on the wall itself.
        */}
        <div className="inspector__wall">
          <div className="inspector__wallcol">
            <span className="inspector__faceslabel">Space on the wall</span>
            <FootprintEditor
              cells={cells}
              onToggle={toggleCell}
              showInserts={seat === 'insert'}
              sockets={sockets}
              label={`Cells ${part.name} covers`}
            />
          </div>

          <div className="inspector__wallcol">
            <p className="inspector__hint">
              Click a cell to cycle it: <strong>empty</strong> → <strong>covered</strong> →
              {' '}<strong>a socket</strong> → empty. Covered is the wall this part occupies and
              what the planner checks when you drop it. A socket is a cell you can install
              something else INTO — three of the four on a junction insert are open holes, and
              marking them is what lets another part go in there. The centre cell is the one
              under your cursor while dragging, so it always belongs to the part.
            </p>
            <p className="inspector__count tabular-nums">
              {cells.length} cell{cells.length === 1 ? '' : 's'}
              {sockets.length > 0 ? `, ${sockets.length} of them ${sockets.length === 1 ? 'a socket' : 'sockets'}` : ''}
              {reviewing ? ' · measured as a bound, not a measurement' : ''}
            </p>

            <span className="inspector__faceslabel">Sits on</span>
            <div className="inspector__seat">
              <button
                type="button" className="button"
                data-active={seat === 'wall' ? 'true' : undefined}
                onClick={() => setSeat('wall')}
                title="The mating face goes flat against the wall"
              >
                The wall face
              </button>
              <button
                type="button" className="button"
                data-active={seat === 'insert' ? 'true' : undefined}
                onClick={() => setSeat('insert')}
                title="The part rests on the flanges of the inserts that fasten it"
              >
                Its inserts · +{INSERT.flangeThickness.toFixed(1)} mm
              </button>
            </div>
            <p className="inspector__hint">
              An insert clips into a cell and the part pegs into the insert, so a part that is
              fastened sits on the insert&apos;s flange — {INSERT.flangeThickness.toFixed(1)} mm
              proud of the wall, measured, not typed. The depth above is counted from whichever
              of the two you pick.
              {requiresText ? ` The catalogue orders ${requiresText} for this part.` : ''}
            </p>
          </div>
        </div>

        {/*
          Which fastener holds this part on — with a picture of each, because the
          names do not distinguish them. `insert-hollow-tre` and
          `insert-hollow-for` differ by three letters and by one cell, and the
          catalogue's own answer is a guess for most parts: the scanner reads
          bolt bores and cannot see a peg, so it ordered one insert per bore, or
          none at all (PARKED P1). A person looking at the model can just say.
        */}
        <div className="inspector__fasten">
          <div className="inspector__fastenhead">
            <span className="inspector__faceslabel">Fastened with</span>
            <span className="inspector__count tabular-nums">
              {fastenerId === ''
                ? 'nothing — this part needs no insert'
                : `${fastenerCount} × ${fasteners.find((f) => f.id === fastenerId)?.name ?? fastenerId}`}
            </span>
          </div>

          <div className="inspector__fastengrid" role="group" aria-label="Fastener for this part">
            <button
              type="button"
              className="inspector__fastentile"
              data-active={fastenerId === '' ? 'true' : undefined}
              onClick={() => setFastenerId('')}
              title="This part needs no insert of its own"
            >
              <span className="inspector__fastenshot" aria-hidden="true">—</span>
              <span className="inspector__fastenname">None</span>
            </button>
            {fasteners.map((f) => (
              <button
                key={f.id}
                type="button"
                className="inspector__fastentile"
                data-active={fastenerId === f.id ? 'true' : undefined}
                onClick={() => setFastenerId(f.id)}
                title={`${f.name} — ${f.footprint.length} cell${f.footprint.length === 1 ? '' : 's'}${
                  f.hardware?.length ? `, takes ${f.hardware.map((h) => `${h.count} × ${h.item}`).join(', ')}` : ''
                }`}
              >
                <span className="inspector__fastenshot">
                  {shots.get(f.id) ? <img src={shots.get(f.id)!} alt="" draggable={false} /> : null}
                </span>
                <span className="inspector__fastenname">{f.name}</span>
                <span className="inspector__fastencells tabular-nums">
                  {f.footprint.length} cell{f.footprint.length === 1 ? '' : 's'}
                </span>
              </button>
            ))}
          </div>

          <div className="inspector__fastencount">
            <Nudge
              label="How many" title="How many of that fastener this one part takes"
              unit="off" step={1} limit={24}
              value={fastenerCount}
              onChange={(v) => setFastenerCount(Math.max(1, Math.round(v)))}
            />
            <p className="inspector__hint">
              This is what the parts list orders for each one you place. It is the number of
              PEGS on the part, not the number of cells it covers — a seven-cell shelf with two
              pegs takes two.
            </p>
          </div>
        </div>

        <footer className="inspector__actions">
          {/* The very object the preview was drawn from, so what is saved is
              what is on screen rather than a second reading of the same state. */}
          <button
            type="button"
            className="button button--primary"
            disabled={!dirty}
            onClick={() => onSave(mounting, cells, sockets, requires)}
          >
            Save mounting
          </button>
          <button type="button" className="button" onClick={onClear} disabled={current === undefined}>
            Clear correction
          </button>
        </footer>
      </div>
    </div>
  );
}
