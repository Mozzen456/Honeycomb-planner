/**
 * The PEG ADDER: upload a model, pick cells, get it back with pegs on it.
 *
 * All the geometry is in `src/core/pegAdder.ts` and tested without a browser.
 * This is the shell, and it has one job of its own worth stating: **every cell
 * is clickable.** The lattice is the only hard constraint — a peg has to sit on
 * a cell centre — and how well the part backs a cell is ADVICE, drawn as a
 * colour and said in the notes. Cells past the part's own edge are offered too.
 *
 * This was a gate once, and refusing the click was wrong: no rule here can know
 * about a part it has never seen — a boss the raster reads as an intrusion, a
 * cell somebody means to bridge with their own filler, a peg deliberately off
 * the silhouette. The tool's job is a straight answer about what you just did,
 * not a veto.
 *
 * The camera starts BEHIND the part, looking at the face that meets the wall.
 * That is the face the cells are on, and the one nobody can aim at from the
 * front.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { PEG, PEG_RADIUS } from '../core/constants';
import { hexKey } from '../core/hex';
import { toBinaryStl } from '../core/honeycomb';
import { isModelFile, MODEL_ACCEPT, parseModelFile } from '../core/modelFile';
import {
  bestFace,
  buildPeggedMesh,
  candidateCells,
  cellPointMm,
  DEFAULT_ORIENTATION,
  faceTowardWall,
  orientForPegs,
  pegLayoutNote,
  reviewPegs,
  type Candidate,
  type OrientedPart,
  type Orientation,
  type PegPlan,
} from '../core/pegAdder';
import { buildPegSolid } from '../core/pegMesh';
import type { MeshData } from '../core/stl';
import type { Hex } from '../core/types';
import { Icon } from './Icon';
import { wallFrameGeometry } from './meshLibrary';

import './BinBuilder.css';

export interface PegAdderProps {
  /** Put the pegged part in the library and in this project. */
  onAddToProject: (
    mesh: { positions: Float64Array; triangleCount: number },
    cells: Hex[],
    offsets: { xMm: number; yMm: number },
    name: string,
    notes: string[],
  ) => void;
  say: (text: string, kind: 'error' | 'warn' | 'ok') => void;
}

const FACES: { label: string; axis: Orientation['wallFaceAxis']; end: 'low' | 'high' }[] = [
  { label: '−X', axis: 'x', end: 'low' },
  { label: '+X', axis: 'x', end: 'high' },
  { label: '−Y', axis: 'y', end: 'low' },
  { label: '+Y', axis: 'y', end: 'high' },
  { label: '−Z', axis: 'z', end: 'low' },
  { label: '+Z', axis: 'z', end: 'high' },
];

/** How far one press of a nudge button slides the lattice. */
const NUDGE_MM = 2;

export function PegAdder({ onAddToProject, say }: PegAdderProps): JSX.Element {
  const [file, setFile] = useState<{ name: string; mesh: MeshData } | null>(null);
  const [busy, setBusy] = useState(false);
  const [orientation, setOrientation] = useState<Orientation>(DEFAULT_ORIENTATION);
  /** null means "wherever the part's centre is" — see `latticeOffset`. */
  const [nudge, setNudge] = useState<{ x: number; y: number } | null>(null);
  const [cells, setCells] = useState<Hex[]>([]);
  /**
   * Armed: the next click on the model names the face that meets the wall.
   *
   * A MODE, because the stage already has a click and it means "peg this cell".
   * The pads cover the part on purpose — they are the thing you aim at — so
   * asking for a face without turning them off would be asking somebody to hit
   * the gaps between them.
   */
  const [picking, setPicking] = useState(false);

  const part = useMemo(
    () => (file === null ? null : orientForPegs(file.mesh, orientation)),
    [file, orientation],
  );

  /**
   * Where the lattice sits. A cell centred on the part until somebody moves it.
   *
   * Centred is not just tidy: `onAddToProject` has to correct for the part's
   * bounding-box centre against the pegs' (D73), and that correction is clamped
   * at 40 mm on read. Starting centred means a symmetric choice of cells needs
   * no correction at all.
   */
  const latticeOffset = useMemo(
    () => nudge ?? { x: 0, y: (part?.sizeMm[2] ?? 0) / 2 },
    [nudge, part],
  );

  const candidates = useMemo(
    () => (part === null ? [] : candidateCells(part, latticeOffset)),
    [part, latticeOffset],
  );

  const plan: PegPlan = useMemo(
    () => ({ ...orientation, latticeOffset, cells }),
    [orientation, latticeOffset, cells],
  );

  const review = useMemo(
    () => (part === null ? null : reviewPegs(part, plan)),
    [part, plan],
  );

  const load = useCallback(
    (chosen: File) => {
      if (!isModelFile(chosen.name)) {
        say(`${chosen.name} is not a model (.stl or .3mf)`, 'error');
        return;
      }
      setBusy(true);
      chosen
        .arrayBuffer()
        .then((buffer) => parseModelFile(chosen.name, buffer))
        .then(({ mesh, warnings }) => {
          setFile({ name: chosen.name, mesh });
          // Open on the face with the most cells on it, rather than on whichever
          // axis the modeller happened to use.
          setOrientation(bestFace(mesh));
          // A new model's cells mean nothing — they were picked on another part.
          setCells([]);
          setNudge(null);
          setPicking(false);
          if (warnings.length > 0) say(warnings[0]!, 'warn');
        })
        .catch((err: unknown) => say(`Could not read ${chosen.name}: ${(err as Error).message}`, 'error'))
        .finally(() => setBusy(false));
    },
    [say],
  );

  /** Turning the part invalidates every pick: they were cells on another face. */
  const reorient = useCallback((next: Orientation) => {
    setOrientation(next);
    setCells([]);
    setNudge(null);
  }, []);

  /**
   * A face was clicked. `normal` is in the ORIENTED frame, which is the frame
   * the stage draws in — `faceTowardWall` snaps it to one of the six and hands
   * back the orientation that lays it on the wall.
   */
  const pickFace = useCallback(
    (normal: [number, number, number]) => {
      setPicking(false);
      // Through `reorient`, like the six buttons — it clears the cells, which
      // were picked on a face that is no longer the one against the wall. NOT
      // inside a `setOrientation` updater: React runs an updater during render,
      // and a `setCells` in there is a state update from inside a render.
      reorient(faceTowardWall(orientation, normal));
    },
    [orientation, reorient],
  );

  /** Escape leaves the mode without choosing, like every other armed tool. */
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPicking(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picking]);

  const toggle = useCallback((cell: Hex) => {
    setCells((prev) =>
      prev.some((c) => hexKey(c) === hexKey(cell))
        ? prev.filter((c) => hexKey(c) !== hexKey(cell))
        : [...prev, cell],
    );
  }, []);

  /*
   * With no pegs this is a plain conversion, so the name is the model's own —
   * `box-0peg.stl` would be an odd thing to hand somebody who asked for an STL.
   */
  const name = useMemo(
    () =>
      file === null
        ? 'pegged'
        : cells.length === 0
          ? file.name.replace(/\.[^.]*$/, '')
          : `${file.name.replace(/\.[^.]*$/, '')}-${cells.length}peg`,
    [file, cells.length],
  );

  const download = useCallback(() => {
    if (part === null || review === null || review.errors.length > 0) return;
    const mesh = buildPeggedMesh(part, plan);
    const url = URL.createObjectURL(
      new Blob([toBinaryStl(mesh, name)], { type: 'model/stl' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.stl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(
      cells.length === 0
        ? `${name}.stl — ${file?.mesh.format === '3mf' ? 'converted from 3MF' : 'converted'}, no pegs added`
        : `${name}.stl — your model with ${cells.length} peg${cells.length === 1 ? '' : 's'}`,
      'ok',
    );
  }, [part, plan, review, name, cells.length, file, say]);

  const add = useCallback(() => {
    if (part === null || review === null || review.errors.length > 0) return;
    /*
     * The correction D73 asks for, computed rather than guessed.
     *
     * `orient` centres a part on its wall-plane bounding box and the wall draws
     * that centre on the box centre of its CELLS. Here the mesh's centre is
     * (0, height/2) — across is centred and up starts at the bed — and the pegs'
     * centre is wherever they were picked, so this is the difference.
     */
    const points = cells.map((c) => cellPointMm(c, latticeOffset));
    const cx = (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2;
    const cy = (Math.min(...points.map((p) => p.y)) + Math.max(...points.map((p) => p.y))) / 2;
    onAddToProject(
      buildPeggedMesh(part, plan),
      cells,
      { xMm: -cx, yMm: part.sizeMm[2] / 2 - cy },
      name,
      [
        `${file?.name ?? 'an upload'} with ${cells.length} peg${cells.length === 1 ? '' : 's'} added`,
        'the footprint is the cells the pegs were welded into, not a bounding-box bound',
      ],
    );
  }, [part, plan, review, cells, latticeOffset, name, file, onAddToProject]);

  const solid = candidates.filter((c) => c.backing === 'solid').length;

  return (
    <div
      className="builder"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const dropped = e.dataTransfer.files[0];
        if (!dropped) return;
        // Stop it here: the shell's own window listener would send it to the
        // IMPORT flow, which is a different thing to do with the same file.
        e.preventDefault();
        e.stopPropagation();
        load(dropped);
      }}
    >
      <PegStage
        part={part}
        candidates={candidates}
        chosen={cells}
        latticeOffset={latticeOffset}
        onToggle={toggle}
        picking={picking}
        onPickFace={pickFace}
      />

      <aside className="builder__rail">
        <header className="builder__intro">
          <h2 className="builder__title">Add pegs</h2>
          <p className="builder__blurb">
            Drop an STL or 3MF anywhere here. It comes back as an <strong>STL</strong> either
            way, so this doubles as a 3MF converter — take the download without picking anything.
            To hang it on the wall, turn it so the face that meets the wall is toward you and
            click the cells you want pegs in. Any cell will take one; the colour says how well the
            part is backing it.
          </p>
        </header>

        <div className="builder__controls">
          <div className="builder__row">
            <span className="builder__label">Model</span>
            <label className="button button--subtle builder__file">
              <Icon name="import" />
              {file === null ? 'Choose a file' : 'Replace'}
              <input
                type="file"
                accept={MODEL_ACCEPT}
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  if (chosen) load(chosen);
                  e.target.value = '';
                }}
              />
            </label>
          </div>

          {file !== null && (
            <>
              <div className="builder__row">
                <span className="builder__label">Wall face</span>
                <div className="builder__faces">
                  {FACES.map((f) => (
                    <button
                      key={f.label}
                      type="button"
                      className="button button--ghost"
                      aria-pressed={
                        orientation.wallFaceAxis === f.axis && orientation.matingEnd === f.end
                      }
                      title={`Put the ${f.label} face of the file against the wall`}
                      onClick={() =>
                        reorient({ ...orientation, wallFaceAxis: f.axis, matingEnd: f.end })}
                    >
                      {f.label}
                    </button>
                  ))}
                  {/*
                    The seventh way to answer the same question, and usually the
                    only usable one: "−Y" says nothing about a headset holder.
                    Point at the face on screen and it turns to meet the wall.
                  */}
                  <button
                    type="button"
                    className="button button--subtle builder__pick"
                    aria-pressed={picking}
                    title={
                      picking
                        ? 'Click the face on the model that meets the wall — Esc to stop'
                        : 'Choose the wall face by clicking it on the model'
                    }
                    onClick={() => setPicking((was) => !was)}
                  >
                    <Icon name="target" />
                    {picking ? 'Click a face…' : 'Pick on model'}
                  </button>
                </div>
              </div>

              <div className="builder__row">
                <span className="builder__label">Turn</span>
                <div className="builder__faces">
                  <button
                    type="button"
                    className="button button--ghost"
                    title="Quarter turn, so the part stands up the way you want it"
                    onClick={() =>
                      reorient({ ...orientation, quarterTurns: orientation.quarterTurns + 1 })}
                  >
                    ↻ 90°
                  </button>
                  <span className="builder__aside tabular-nums">
                    {(orientation.quarterTurns % 4) * 90}°
                  </span>
                </div>
              </div>

              {/*
                * Sliding the lattice cannot take the pegs off it — a rigid
                * translation moves them all together — so this is free
                * millimetres, and it is what you reach for when the cells land
                * just off the solid part of the face.
                */}
              <div className="builder__row">
                <span className="builder__label">Lattice</span>
                <div className="builder__faces">
                  <button type="button" className="button button--ghost" title="Slide the lattice left"
                    onClick={() => setNudge({ x: latticeOffset.x - NUDGE_MM, y: latticeOffset.y })}>←</button>
                  <button type="button" className="button button--ghost" title="Slide the lattice right"
                    onClick={() => setNudge({ x: latticeOffset.x + NUDGE_MM, y: latticeOffset.y })}>→</button>
                  <button type="button" className="button button--ghost" title="Slide the lattice down"
                    onClick={() => setNudge({ x: latticeOffset.x, y: latticeOffset.y - NUDGE_MM })}>↓</button>
                  <button type="button" className="button button--ghost" title="Slide the lattice up"
                    onClick={() => setNudge({ x: latticeOffset.x, y: latticeOffset.y + NUDGE_MM })}>↑</button>
                  <button type="button" className="button button--ghost" title="Back to a cell on the part's centre"
                    onClick={() => setNudge(null)}>Centre</button>
                </div>
              </div>
            </>
          )}
        </div>

        {file !== null && part !== null && review !== null && (
          <dl className="builder__facts">
            <div>
              <dt>Model</dt>
              <dd>
                {file.name}
                <span className="builder__aside tabular-nums">
                  {' '}— {part.sizeMm[1].toFixed(1)} across × {part.sizeMm[2].toFixed(1)} up ×{' '}
                  {part.sizeMm[0].toFixed(1)} out
                </span>
              </dd>
            </div>
            <div>
              <dt>Cells</dt>
              <dd className="tabular-nums">
                {candidates.length} on the lattice, {solid} with solid part behind them
                {solid === 0 && ' — another face or a nudge may find some'}
              </dd>
            </div>
            <div>
              <dt>Pegs</dt>
              <dd>{pegLayoutNote(plan)}</dd>
            </div>
            <div>
              <dt>Download</dt>
              <dd>
                {file.mesh.format === '3mf' ? '3MF → STL' : 'STL → STL'}
                <span className="builder__aside">
                  {cells.length === 0
                    ? ' — a straight conversion, in the orientation on screen'
                    : `, with ${cells.length} peg${cells.length === 1 ? '' : 's'} welded in`}
                </span>
              </dd>
            </div>
            {cells.length > 0 && (
              <div>
                <dt>Needs</dt>
                <dd>
                  {cells.length} × <strong>insert-empty</strong>, one in each cell you picked
                </dd>
              </div>
            )}
            {/* Only once there are pegs. With none, "every peg sits its flat on
                the bed" is true and says nothing. */}
            {cells.length > 0 && (
              <div>
                <dt>Printing</dt>
                <dd>
                  {review.bridging === 0
                    ? 'Every peg sits its flat on the bed. Print as it comes out.'
                    : `${review.onBed} on the bed, ${review.bridging} bridging ${PEG.lengthMm} mm.` +
                      ' Print with part cooling on.'}
                </dd>
              </div>
            )}
          </dl>
        )}

        {review !== null && (review.errors.length > 0 || review.warnings.length > 0) && (
          <ul className="builder__issues">
            {review.errors.map((text) => (
              <li key={text} className="builder__issue builder__issue--error">
                <Icon name="alert" />
                {text}
              </li>
            ))}
            {review.warnings.map((text) => (
              <li key={text} className="builder__issue">
                <Icon name="info" />
                {text}
              </li>
            ))}
          </ul>
        )}

        <div className="builder__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={download}
            disabled={busy || review === null || review.errors.length > 0}
          >
            <Icon name="download" />
            {busy ? 'Reading…' : cells.length === 0 ? 'Download as STL' : 'Download STL'}
          </button>
          <button
            type="button"
            className="button button--subtle"
            onClick={add}
            // The one thing that genuinely needs a peg: a part goes on the WALL
            // by its cells, and a part with none has no footprint to place.
            disabled={busy || review === null || cells.length === 0}
            title={cells.length === 0 ? 'Pick at least one cell first — the wall places a part by its pegs' : undefined}
          >
            <Icon name="plus" />
            Add to project
          </button>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/** Looking at the wall face, from the wall's side. */
const HOME = { az: Math.PI, el: 0.22 } as const;

/**
 * A flat hexagon marking a cell, in the scene's own (X across, Y up).
 *
 * FILLED, and that is not a style choice. It was a ring, and a ring's middle is
 * a hole: the raycast went straight through it, so a cell could only be picked
 * by hitting the few millimetres of rim — and the middle is exactly where
 * anybody aims. The pad is the hit target and it is the whole cell.
 */
function cellGeometry(): THREE.ShapeGeometry {
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * 60 * k;
    pts.push(new THREE.Vector2(PEG_RADIUS * Math.cos(a), PEG_RADIUS * Math.sin(a)));
  }
  return new THREE.ShapeGeometry(new THREE.Shape(pts));
}

function PegStage({
  part,
  candidates,
  chosen,
  latticeOffset,
  onToggle,
  picking,
  onPickFace,
}: {
  part: OrientedPart | null;
  candidates: Candidate[];
  chosen: Hex[];
  latticeOffset: { x: number; y: number };
  onToggle: (cell: Hex) => void;
  /** Armed: a click names the wall face instead of pegging a cell. */
  picking: boolean;
  /** The clicked face's normal, in the ORIENTED frame (out, across, up). */
  onPickFace: (normal: [number, number, number]) => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    scene: THREE.Scene;
    stage: THREE.Group;
    key: THREE.DirectionalLight;
    picks: THREE.Object3D[];
    /** The part itself, which is what a FACE pick raycasts against. */
    partMesh: THREE.Mesh | null;
    /**
     * Put the camera where the orbit says it is, NOW.
     *
     * The render loop does this once a frame, which is not good enough for a
     * raycast: a click arriving between the last pointer move and the next
     * frame would be cast from where the camera USED to be. Measured — a drag
     * that turned the model 180° followed by an immediate click read the face
     * that had been in front before the turn, because `camera.matrixWorld` was
     * still the old one. So both the pointer handler and the loop go through
     * here, and it ends with `updateMatrixWorld` because `lookAt` does not:
     * `Raycaster.setFromCamera` reads the matrix, not the position.
     */
    place: () => void;
    orbit: { az: number; el: number; zoom: number; target: THREE.Vector3 };
    fitted: number;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 1, 12000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-1, -0.4, 0.6);
    scene.add(fill);

    const stage = new THREE.Group();
    scene.add(stage);

    const state = {
      renderer,
      camera,
      scene,
      stage,
      key,
      picks: [] as THREE.Object3D[],
      partMesh: null as THREE.Mesh | null,
      place: () => {},
      orbit: { ...HOME, zoom: 1, target: new THREE.Vector3() },
      fitted: 200,
    };
    stateRef.current = state;

    state.place = (): void => {
      const { az, el, zoom, target } = state.orbit;
      const dist = zoom * state.fitted;
      camera.position.set(
        target.x + dist * Math.cos(el) * Math.sin(az),
        target.y + dist * Math.sin(el),
        target.z + dist * Math.cos(el) * Math.cos(az),
      );
      camera.lookAt(target);
      camera.updateMatrixWorld();
    };

    let raf = 0;
    const tick = (): void => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      state.place();
      key.position.copy(camera.position);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();
    setReady(true);

    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });


    /*
     * The wheel, as a NON-PASSIVE native listener rather than React's `onWheel`.
     *
     * React attaches wheel handlers passively, so `preventDefault` inside one
     * does nothing — and the page scrolls out from under the model while it
     * zooms. Invisible on a wide window, where nothing scrolls; obvious on a
     * narrow one, where the rail is stacked below the stage.
     */
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      state.orbit.zoom = Math.max(0.15, Math.min(4, state.orbit.zoom * (1 + e.deltaY * 0.001)));
    };
    host.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      mo.disconnect();
      host.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(raf);
      renderer.dispose();
      host.removeChild(renderer.domElement);
      stateRef.current = null;
      setReady(false);
    };
  }, []);

  const readTheme = useCallback(() => {
    const host = hostRef.current;
    const css = host ? getComputedStyle(host) : null;
    const probe = document.createElement('canvas').getContext('2d');
    const colour = (nameOf: string, fallback: string): THREE.Color => {
      const raw = (css?.getPropertyValue(nameOf) || '').trim();
      if (raw && probe) {
        probe.fillStyle = '#000000';
        probe.fillStyle = raw;
        const normalised = probe.fillStyle;
        if (typeof normalised === 'string' && normalised !== '#000000') {
          return new THREE.Color(normalised);
        }
      }
      return new THREE.Color(raw || fallback);
    };
    return {
      part: colour('--canvas-panel-tint', '#c8ced6'),
      peg: colour('--accent', '#3d7ea6'),
      partial: colour('--warning-fg', '#d99a3a'),
      bare: colour('--canvas-grid', '#6b7784'),
    };
  }, []);

  // -- the part --------------------------------------------------------------
  useEffect(() => {
    const s = stateRef.current;
    if (s === null || !ready || part === null) return;
    const geometry = wallFrameGeometry(part.positions, 0, 0, 0);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ color: readTheme().part }),
    );
    s.stage.add(mesh);
    s.partMesh = mesh;
    const box = new THREE.Box3().setFromObject(mesh);
    s.orbit.target.copy(box.getCenter(new THREE.Vector3()));
    s.fitted = Math.max(90, box.getSize(new THREE.Vector3()).length() * 1.3);
    return () => {
      s.stage.remove(mesh);
      s.partMesh = null;
      geometry.dispose();
      mesh.material.dispose();
    };
  }, [part, ready, readTheme, themeTick]);

  // -- the cells, and the pegs in them ---------------------------------------
  useEffect(() => {
    const s = stateRef.current;
    if (s === null || !ready || part === null) return;
    /*
     * While a face is being chosen the pads come off entirely. They are drawn
     * over the part on purpose — they are what you aim at the rest of the time —
     * so leaving them up would mean asking somebody to hit the gaps between
     * them, and the pegs among them would be about to be cleared anyway.
     */
    if (picking) return;
    const theme = readTheme();
    const added: THREE.Object3D[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    const picks: THREE.Object3D[] = [];
    const taken = new Set(chosen.map(hexKey));

    for (const c of candidates) {
      if (taken.has(hexKey(c.cell))) continue;
      const geometry = cellGeometry();
      geometries.push(geometry);
      /*
       * Three tones, and EVERY one of them is clickable.
       *
       * The colour is advice about how well the part backs the cell — accent for
       * solid, amber for partly on, grey for bare — and nothing more. There is
       * no rule here that can know about a part it has never seen, and a cell
       * you cannot press is a conversation the tool refused to have.
       */
      const tone =
        c.backing === 'solid' ? theme.peg : c.backing === 'partial' ? theme.partial : theme.bare;
      const ring = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: tone,
          transparent: true,
          opacity: c.backing === 'bare' ? 0.16 : 0.42,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      // Scene frame: X across, Y up, Z out of the wall. The face is at Z = 0, so
      // the marker sits a hair in front of it, on the side the camera is on.
      ring.position.set(c.atMm.x, c.atMm.y, -0.4);
      ring.userData['cell'] = c.cell;
      picks.push(ring);
      s.stage.add(ring);
      added.push(ring);
    }

    const grade = new Map(candidates.map((c) => [hexKey(c.cell), c.backing]));
    for (const cell of chosen) {
      const at = cellPointMm(cell, latticeOffset);
      const peg = buildPegSolid({ a: at.x, u: at.y });
      const geometry = wallFrameGeometry(Float64Array.from(peg.positions), 0, 0, 0);
      geometries.push(geometry);
      // A placed peg keeps the colour its cell had, so "this one is only half
      // on the part" survives being chosen rather than turning uniformly blue.
      const backing = grade.get(hexKey(cell)) ?? 'bare';
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshLambertMaterial({
          color: backing === 'solid' ? theme.peg : backing === 'partial' ? theme.partial : theme.bare,
        }),
      );
      mesh.userData['cell'] = cell;
      s.stage.add(mesh);
      added.push(mesh);
      picks.push(mesh);
    }

    s.picks = picks;
    return () => {
      for (const o of added) s.stage.remove(o);
      for (const g of geometries) g.dispose();
      for (const o of added) {
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
      }
      s.picks = [];
    };
  }, [part, candidates, chosen, latticeOffset, ready, readTheme, themeTick, picking]);

  // -- pointer ---------------------------------------------------------------
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const onDown = (e: React.PointerEvent): void => {
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    const s = stateRef.current;
    if (d === null || s === null) return;
    d.moved += Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y);
    s.orbit.az -= (e.clientX - d.x) * 0.008;
    s.orbit.el = Math.max(-1.3, Math.min(1.3, s.orbit.el + (e.clientY - d.y) * 0.006));
    drag.current = { x: e.clientX, y: e.clientY, moved: d.moved };
  };
  const onUp = (e: React.PointerEvent): void => {
    const d = drag.current;
    drag.current = null;
    const s = stateRef.current;
    // A turn is not a click. Four pixels of slop, because a deliberate tap on a
    // cell always carries a pixel or two of hand movement with it.
    if (d === null || s === null || d.moved > 4) return;
    const host = hostRef.current;
    if (host === null) return;
    const rect = host.getBoundingClientRect();
    // Before the ray, not after: see `place`.
    s.place();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      s.camera,
    );
    if (picking) {
      const hit = s.partMesh === null ? undefined : ray.intersectObject(s.partMesh, false)[0];
      if (hit?.face) {
        /*
         * The normal is computed here from the three vertices rather than read
         * off `hit.face.normal`, so it cannot depend on what a three.js version
         * chooses to fill in — and it is the same statement the test makes.
         * The material is front-sided, so the triangle we hit is one facing the
         * camera: the face you can SEE is the face you picked.
         */
        const pos = (s.partMesh!.geometry as THREE.BufferGeometry).getAttribute('position');
        const a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a);
        const b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b);
        const c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
        const n = new THREE.Vector3()
          .subVectors(b, a)
          .cross(new THREE.Vector3().subVectors(c, a))
          .normalize();
        /*
         * Scene to the oriented frame. `wallFrameGeometry` writes scene
         * (x, y, z) = (across, up, out), and `OrientedPart` is ordered
         * (out, across, up) — so this is that permutation, undone, in the one
         * place that knows both. Cyclic, therefore a rotation and not a mirror.
         */
        onPickFace([n.z, n.x, n.y]);
        // Home again, so the face that was chosen is the face now in view: the
        // whole point of the gesture is watching it come round to the wall.
        s.orbit.az = HOME.az;
        s.orbit.el = HOME.el;
      }
      return;
    }
    const hit = ray.intersectObjects(s.picks, false)[0];
    const cell = hit?.object.userData['cell'] as Hex | undefined;
    if (cell) onToggle(cell);
  };

  return (
    <div
      className="builder__stage"
      ref={hostRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => { drag.current = null; }}
    >
      {part === null && (
        <p className="builder__empty">Drop an STL or 3MF here</p>
      )}
      <p className="builder__hint">
        {picking
          ? 'click the face that meets the wall · Esc to stop'
          : 'click a cell to peg it · drag to turn · wheel to zoom'}
      </p>
    </div>
  );
}
