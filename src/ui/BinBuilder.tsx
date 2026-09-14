/**
 * The BUILD tab: type a size, watch the bin, download the file.
 *
 * The whole of the geometry lives in `src/core/binModel.ts` and is tested
 * without a browser. This is the shell round it — sliders, a preview and two
 * buttons — with one idea of its own worth stating.
 *
 * **The preview draws the bin against a real plate.** Not a grid, not a
 * backdrop: `buildHoneycombMesh` on a block of cells that actually contains the
 * peg cells, so what you are looking at is the generator's own honeycomb with
 * the generator's own pegs in it. The claim the tab has to make is "these pegs
 * fit that wall", and the cheapest way to be believed is to show the two things
 * that were built from the same constants sitting inside one another. It is the
 * same argument `PartInspector`'s wall patch makes (D46/D97), for the same
 * reason — a drawn approximation is not evidence.
 *
 * The scene is in WALL coordinates — +X across, +Y up, +Z out — because the
 * plate is already drawn that way and the bin is one cyclic permutation from it.
 * See `toWallFrame`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import {
  buildBinMesh,
  cellsFor,
  DEFAULT_WALL_MM,
  latticeOffsetMm,
  backPanelCells,
  type BinCell,
  MAX_DEPTH_MM,
  MAX_PEGS,
  MAX_WIDTH_MM,
  MIN_DEPTH_MM,
  MIN_PEGS,
  minHeightMm,
  maxHeightMm,
  minWidthMm,
  normaliseBinSpec,
  outerMm,
  previewPatch,
  pegSpacingNote,
  type BinModel,
  type BinSpec,
} from '../core/binModel';
import { INSERT, PANEL_DEPTH, PEG_RADIUS } from '../core/constants';
import type { Hex } from '../core/types';
import { hexKey, hexToMm, panelCells as blockCells } from '../core/hex';
import { buildHoneycombMesh, toBinaryStl } from '../core/honeycomb';
import { Icon } from './Icon';
import { NumberField } from './NumberField';
import { solidToGeometry, wallFrameGeometry } from './meshLibrary';

import './BinBuilder.css';

export interface BinBuilderProps {
  /** Put the generated bin in the library and in this project. */
  onAddToProject: (model: BinModel, name: string) => void;
  say: (text: string, kind: 'error' | 'warn' | 'ok') => void;
}

const DEFAULT_SPEC: BinSpec = normaliseBinSpec({
  pegs: 2,
  innerWidthMm: 80,
  innerHeightMm: 70,
  innerDepthMm: 55,
  wallMm: DEFAULT_WALL_MM,
});

export function BinBuilder({ onAddToProject, say }: BinBuilderProps): JSX.Element {
  const [spec, setSpec] = useState<BinSpec>(DEFAULT_SPEC);
  const model = useMemo(() => buildBinMesh(spec), [spec]);

  /**
   * Change one field and re-clamp the rest.
   *
   * Through `normaliseBinSpec` every time, so raising the peg count widens a bin
   * that would no longer hold its own pegs rather than throwing — the limits are
   * one function and this is not allowed a second opinion.
   */
  const set = useCallback((patch: Partial<BinSpec>) => {
    setSpec((prev) => normaliseBinSpec({ ...prev, ...patch }));
  }, []);

  /**
   * Take the pegs over by hand, seeded from wherever they are now.
   *
   * Seeded, so the first click adds or removes ONE peg rather than throwing the
   * automatic layout away and leaving you with a single peg. And the lattice
   * offset is FROZEN at the same moment: the automatic origin moves with the peg
   * count and the width, and a chosen cell that walked across the panel when the
   * bin was resized would be a peg nobody put there.
   */
  const toggleCell = useCallback((cell: Hex) => {
    setSpec((prev) => {
      const current = cellsFor(prev);
      const has = current.some((c) => hexKey(c) === hexKey(cell));
      return normaliseBinSpec({
        ...prev,
        latticeOffset: prev.latticeOffset ?? latticeOffsetMm(prev),
        cells: has
          ? current.filter((c) => hexKey(c) !== hexKey(cell))
          : [...current, cell],
      });
    });
  }, []);

  /** Back to the layout the numbers describe. */
  const auto = useCallback(() => {
    setSpec((prev) => {
      const { cells: _c, latticeOffset: _o, ...rest } = prev;
      return normaliseBinSpec(rest);
    });
  }, []);

  const byHand = spec.cells !== undefined;

  /**
   * One peg more or fewer, read from the DOCUMENT and not from what was drawn.
   *
   * `set({ pegs: spec.pegs + 1 })` is the same defect D89 records against the
   * printed-count stepper, and it was made again here and caught by clicking it:
   * two clicks before a repaint both read the `spec` their render closed over,
   * so `+ +` from 2 gave 3. The functional updater is the whole fix.
   */
  const bumpPegs = useCallback((delta: number) => {
    setSpec((prev) => normaliseBinSpec({ ...prev, pegs: prev.pegs + delta }));
  }, []);

  /*
   * Named by the INSIDE, because that is what the sliders say and what somebody
   * asked for. The outside is on the panel for the bed check.
   */
  const name = useMemo(
    () =>
      // `model.cells.length`, not `spec.pegs`: the stepper drives the automatic
      // layout, and by hand there is not one — a six-peg bin called `2peg`
      // would be wrong in the one place somebody reads it months later.
      `bin-${model.cells.length}peg-${Math.round(spec.innerWidthMm)}x` +
      `${Math.round(spec.innerDepthMm)}x${Math.round(spec.innerHeightMm)}-inside`,
    [spec, model.cells.length],
  );

  const download = useCallback(() => {
    const stl = toBinaryStl(model.mesh, name);
    const url = URL.createObjectURL(new Blob([stl], { type: 'model/stl' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.stl`;
    a.click();
    // Revoked on a timer, not immediately: the same rule the plate download and
    // the exports follow, because some browsers cancel a download whose blob URL
    // is released in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(
      `${name}.stl — ${model.mesh.triangleCount.toLocaleString()} triangles, ` +
        (model.bridgeMm === 0 ? 'no supports' : 'print with cooling on'),
      'ok',
    );
  }, [model, name, say]);

  const cells = model.cells;
  const outer = outerMm(spec);

  return (
    <div className="builder">
      <BinPreview
        model={model}
        cells={backPanelCells(spec)}
        chosen={model.cells}
        onToggle={toggleCell}
      />

      <aside className="builder__rail">
        <header className="builder__intro">
          <h2 className="builder__title">Bin</h2>
          <p className="builder__blurb">
            An open-top box that pegs straight into the honeycomb. The sizes are the{' '}
            <strong>inside</strong> — what will actually fit in it. The pegs are placed on the
            lattice for you.
          </p>
        </header>

        <div className="builder__controls">
          <div className="builder__row">
            <span className="builder__label" id="builder-pegs">Pegs</span>
            {byHand ? (
              /*
                * By hand, the stepper would be lying: it drives the automatic
                * layout, and there is not one any more. A count and a way back.
                */
              <div className="builder__faces">
                <output className="builder__steppervalue tabular-nums">
                  {model.cells.length}
                </output>
                <span className="builder__aside">placed by hand</span>
                <button type="button" className="button button--ghost" onClick={auto}>
                  Automatic
                </button>
              </div>
            ) : (
            <div className="builder__stepper">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => bumpPegs(-1)}
                disabled={spec.pegs <= MIN_PEGS}
                aria-label="One peg fewer"
              >
                −
              </button>
              <output className="builder__steppervalue tabular-nums">{spec.pegs}</output>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => bumpPegs(1)}
                disabled={spec.pegs >= MAX_PEGS}
                aria-label="One peg more"
              >
                +
              </button>
            </div>
            )}
          </div>

          <Slider
            label="Width"
            value={spec.innerWidthMm}
            min={minWidthMm(spec.pegs, spec.wallMm)}
            max={MAX_WIDTH_MM}
            onChange={(innerWidthMm) => set({ innerWidthMm })}
          />
          <Slider
            label="Depth"
            value={spec.innerDepthMm}
            min={MIN_DEPTH_MM}
            max={MAX_DEPTH_MM}
            onChange={(innerDepthMm) => set({ innerDepthMm })}
          />
          <Slider
            label="Height"
            value={spec.innerHeightMm}
            min={minHeightMm()}
            max={maxHeightMm(spec.pegs)}
            onChange={(innerHeightMm) => set({ innerHeightMm })}
          />
        </div>

        {/*
          * The proof, in words, next to the proof in pictures.
          *
          * `pegSpacingNote` reads the spacing back through `hexToMm` rather than
          * printing the constant, so this line is a measurement of what was
          * built and not a restatement of what was intended.
          */}
        <dl className="builder__facts">
          <div>
            <dt>Pegs</dt>
            <dd>{pegSpacingNote(spec)}</dd>
          </div>
          <div>
            <dt>Cells</dt>
            <dd className="tabular-nums">
              {cells.map((c) => `${c.q},${c.r}`).join(' · ')}
            </dd>
          </div>
          <div>
            <dt>Needs</dt>
            <dd>
              {cells.length} × <strong>insert-empty</strong>, one in each of those cells
            </dd>
          </div>
          {/*
            * Both, and in this order.
            *
            * The sliders set the INSIDE, because that is the question somebody
            * sizing a bin is asking — will the box of screws go in it. The
            * outside is the other question, asked later and just as real: does
            * it fit on the bed, and does it clear the shelf above. Showing only
            * one of them makes the other a subtraction the reader has to do.
            */}
          <div>
            <dt>Inside</dt>
            <dd className="tabular-nums">
              {spec.innerWidthMm.toFixed(1)} × {spec.innerDepthMm.toFixed(1)} ×{' '}
              {spec.innerHeightMm.toFixed(1)} mm
            </dd>
          </div>
          <div>
            <dt>Outside</dt>
            <dd className="tabular-nums">
              {outer.widthMm.toFixed(1)} × {outer.depthMm.toFixed(1)} ×{' '}
              {outer.heightMm.toFixed(1)} mm
              <span className="builder__aside">
                {' '}— {spec.wallMm} mm walls
              </span>
            </dd>
          </div>
          <div>
            <dt>Printing</dt>
            <dd>
              {model.bridgeMm === 0
                ? 'Print as it sits. Nothing overhangs — no supports.'
                : `Print as it sits. The bottom pegs are on the bed; the top row bridges ${model.bridgeMm} mm, which prints cleanly with part cooling on.`}
            </dd>
          </div>
        </dl>

        <div className="builder__actions">
          <button type="button" className="button button--primary" onClick={download}>
            <Icon name="download" />
            Download STL
          </button>
          <button
            type="button"
            className="button button--subtle"
            onClick={() => onAddToProject(model, name)}
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

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}): JSX.Element {
  const id = `builder-${label.toLowerCase()}`;
  return (
    <div className="builder__row">
      <label className="builder__label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="builder__slider"
        type="range"
        min={Math.floor(min)}
        max={max}
        step={1}
        value={Math.round(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {/*
        * Typed entry as well as the slider, because a bin is usually sized to
        * something real — a shelf gap, a drawer, a box of screws — and 1 mm
        * steps of a 400 mm track cannot be aimed. `commitOn: 'type'` is right
        * here: the commit rebuilds one small mesh and there is no undo stack to
        * fill, so watching it resize as you type IS the feature (D67).
        */}
      <NumberField
        value={Number(value.toFixed(1))}
        onCommit={onChange}
        min={min}
        max={max}
        decimals={1}
        className="builder__number"
        aria-label={`${label} in millimetres`}
      />
      <span className="builder__unit">mm</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The cell map
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

/**
 * Where the camera starts, and where `Fit` puts it back.
 *
 * Round to the left and a little above: enough to read the bin as a box with an
 * open top, and enough plate showing past it that the honeycomb is obviously
 * behind rather than printed on.
 */
const HOME = { az: -0.85, el: 0.38 } as const;

/**
 * A flat hexagon marking a cell on the back panel.
 *
 * FILLED, not a ring: a ring's middle is a hole and the raycast goes straight
 * through it, so the cell could only be picked by hitting a few millimetres of
 * rim — which is never where anybody aims. The peg adder learnt this first.
 */
function cellPad(): THREE.ShapeGeometry {
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * 60 * k;
    pts.push(new THREE.Vector2(PEG_RADIUS * Math.cos(a), PEG_RADIUS * Math.sin(a)));
  }
  return new THREE.ShapeGeometry(new THREE.Shape(pts));
}

function BinPreview({
  model,
  cells,
  chosen,
  onToggle,
}: {
  model: BinModel;
  cells: BinCell[];
  chosen: readonly Hex[];
  onToggle: (cell: Hex) => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    scene: THREE.Scene;
    stage: THREE.Group;
    key: THREE.DirectionalLight;
    /**
     * Azimuth, elevation and zoom.
     *
     * The scene is Y-up in world space, exactly as `WallView3D` is and for the
     * same reason — up the wall really is up — so there is no frame mismatch
     * here of the kind that makes `PartInspector` hold its own angles.
     *
     * `zoom` is a RATIO of the framed distance, not a distance. The bin is
     * rebuilt on every slider tick, and a stored distance would either snap the
     * camera back mid-drag or let a 230 mm bin grow straight out of frame with
     * nothing on screen saying how to get it back. As a ratio the bin keeps its
     * apparent size while you change its proportions, which is the thing you are
     * actually looking at, and a zoomed-in view survives the rebuild.
     */
    orbit: { az: number; el: number; zoom: number; target: THREE.Vector3 };
    /** Distance that frames the whole scene. Recomputed with the model. */
    fitted: number;
    picks: THREE.Object3D[];
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 1, 8000);
    camera.up.set(0, 1, 0);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.28);
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
      orbit: { ...HOME, zoom: 1, target: new THREE.Vector3() },
      fitted: 320,
      picks: [] as THREE.Object3D[],
    };
    stateRef.current = state;

    let raf = 0;
    const tick = (): void => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      const { az, el, zoom, target } = state.orbit;
      const dist = zoom * state.fitted;
      camera.position.set(
        target.x + dist * Math.cos(el) * Math.sin(az),
        target.y + dist * Math.sin(el),
        target.z + dist * Math.cos(el) * Math.cos(az),
      );
      camera.lookAt(target);
      // The key rides the camera, so whatever you turn toward you is what is lit.
      key.position.copy(camera.position);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();
    setReady(true);

    // Both canvases repaint off `data-theme`; a theme switch changes no React
    // state, so it has to be watched for.
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

  /*
   * Where the bin's own origin sits in the scene: the vector that takes a point
   * on the bin's back panel to the wall's own millimetres.
   *
   * From the LATTICE, not from `cells[0]`. It used to be
   * `hexToMm(cells[0]) − pegCentres[0]`, which is the same number for every cell
   * — until there are none, and then both halves fall back to different
   * defaults and the whole bin jumps. Taking the offset directly cannot do that,
   * and it is the same quantity said plainly.
   */
  const place = useMemo(() => {
    const zero = hexToMm({ q: 0, r: 0 });
    const offset = latticeOffsetMm(model.spec);
    return { x: zero.x - offset.x, y: zero.y - offset.y };
  }, [model.spec]);

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
      plate: colour('--canvas-panel-tint', '#c8ced6'),
      item: colour('--accent', '#3d7ea6'),
      edge: colour('--warning-fg', '#d99a3a'),
    };
  }, []);

  /*
   * TWO effects, and the split is about cost.
   *
   * The bin is rebuilt on every slider step and costs well under a millisecond.
   * The PLATE is `buildHoneycombMesh` over as many as 323 cells, which is 28 ms
   * — a visible hitch on every step of a drag if it were rebuilt with the bin.
   * It does not need to be: the patch only changes when the peg GRID does (the
   * count, the step, whether there is a top row), which happens a handful of
   * times across a whole drag, so its effect keys on the patch alone and sits
   * still the rest of the time.
   *
   * Order matters and is the declaration order: on a render where both re-run,
   * React runs both cleanups and then both effects, so the plate is back in the
   * stage before the bin's effect measures it for framing.
   */
  const patch = previewPatch(model.spec);
  const patchKey = `${patch.origin.q},${patch.origin.r},${patch.columns},${patch.rows}`;

  useEffect(() => {
    const s = stateRef.current;
    if (s === null || !ready) return;
    const geometry = solidToGeometry(
      buildHoneycombMesh({
        cells: blockCells(patch.origin, patch.columns, patch.rows),
        originAtZero: false,
      }),
    );
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ color: readTheme().plate }),
    );
    s.stage.add(mesh);
    return () => {
      s.stage.remove(mesh);
      // Built here and shared with nothing — unlike `meshLibrary`'s plate cache,
      // which the wall draws from and must never be disposed from a view.
      geometry.dispose();
      mesh.material.dispose();
    };
    // `patchKey` and not `patch`: the object is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchKey, ready, readTheme, themeTick]);

  useEffect(() => {
    const s = stateRef.current;
    if (s === null || !ready) return;

    /*
     * Where the bin goes.
     *
     * Its back panel rests on the flanges of the inserts, which stand
     * `INSERT.flangeThickness` proud of the wall's face — the same datum
     * `seat: 'insert'` names for a placed part. So the bin's own z = 0 sits at
     * PANEL_DEPTH + 2.5 and its pegs run back down into the cells.
     *
     * Peg 0 has to land on cell 0 of the block, and both sides are ASKED for
     * rather than derived here — `pegCentres` for the part, `hexToMm` for the
     * wall — so this cannot become a fifth private copy of the embedding.
     */
    const geometry = wallFrameGeometry(
      model.mesh.positions,
      place.x,
      place.y,
      PANEL_DEPTH + INSERT.flangeThickness,
    );
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ color: readTheme().item }),
    );
    s.stage.add(mesh);

    // Framing. The camera reads `fitted × zoom` every frame, so re-measuring
    // here is all it takes for the bin to keep its apparent size as it changes
    // shape — see the note on `orbit.zoom`.
    const box = new THREE.Box3().setFromObject(s.stage);
    s.orbit.target.copy(box.getCenter(new THREE.Vector3()));
    s.fitted = Math.max(150, box.getSize(new THREE.Vector3()).length() * 1.15);

    return () => {
      s.stage.remove(mesh);
      geometry.dispose();
      mesh.material.dispose();
    };
  }, [model, place, ready, readTheme, themeTick]);

  // -- the cells you can put a peg in ----------------------------------------
  useEffect(() => {
    const s = stateRef.current;
    if (s === null || !ready) return;
    const theme = readTheme();
    const taken = new Set(chosen.map(hexKey));
    const added: THREE.Object3D[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    const picks: THREE.Object3D[] = [];

    for (const c of cells) {
      const geometry = cellPad();
      geometries.push(geometry);
      const on = taken.has(hexKey(c.cell));
      const pad = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          // Amber for a cell whose peg would hang over the panel's flat part.
          // Allowed — the width is a slider away — and worth seeing.
          color: c.whole ? theme.item : theme.edge,
          transparent: true,
          opacity: on ? 0.65 : 0.25,
          side: THREE.DoubleSide,
          /*
           * DRAWN ON TOP, and this is the whole reason the bin can be picked
           * the way an upload is.
           *
           * A bin's back panel faces the WALL, so from the view you actually
           * use it is behind the bin, and from `Behind` it is behind the
           * honeycomb plate. Depth-tested, the pads would be visible only from
           * one angle and you would have to go hunting for it. Off, they are
           * always there to press, and the raycast hits the pad you can see —
           * so what you click is what you get, from any angle.
           */
          depthTest: false,
          depthWrite: false,
        }),
      );
      /*
       * Scene frame: X across, Y up, Z out of the wall. The bin's own z = 0 —
       * its back panel's outer face — is at PANEL_DEPTH + the insert flange,
       * and the pad rides a hair in front of it on the wall side.
       */
      pad.position.set(
        place.x + c.acrossMm,
        place.y + c.upMm,
        PANEL_DEPTH + INSERT.flangeThickness - 0.4,
      );
      pad.renderOrder = 2;
      pad.userData['cell'] = c.cell;
      picks.push(pad);
      s.stage.add(pad);
      added.push(pad);
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
  }, [cells, chosen, place, ready, readTheme, themeTick]);

  // -- turning it ------------------------------------------------------------
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
    const host = hostRef.current;
    // A turn is not a click. Four pixels of slop, because a deliberate tap on a
    // cell always carries a pixel or two of hand movement with it.
    if (d === null || s === null || host === null || d.moved > 4) return;
    const rect = host.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      s.camera,
    );
    const cell = ray.intersectObjects(s.picks, false)[0]?.object.userData['cell'] as
      | Hex
      | undefined;
    if (cell) onToggle(cell);
  };
  const fit = (): void => {
    const s = stateRef.current;
    if (s === null) return;
    s.orbit.zoom = 1;
    s.orbit.az = HOME.az;
    s.orbit.el = HOME.el;
  };
  /*
   * The view that actually proves the thing.
   *
   * From behind the wall you are looking through the cells, and a peg is sitting
   * in the middle of the right ones — five and a half millimetres in, so it
   * never comes out the back. Straight on from the front the bin covers
   * everything it is supposed to be proving, which is why `Front` is not the
   * second button here even though it is on the wall's own view.
   */
  const back = (): void => {
    const s = stateRef.current;
    if (s === null) return;
    s.orbit.az = Math.PI;
    s.orbit.el = 0.14;
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
      {/*
        * `setPointerCapture` is skipped for these two, because the host captures
        * the pointer on `pointerdown` and that swallows the click of any button
        * inside it — the same guard `WallView3D` carries, and the same symptom:
        * a control that works from code and is dead to a mouse.
        */}
      <div className="builder__tools" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={fit} title="Frame the bin and the plate">Fit</button>
        <button type="button" onClick={back} title="Look through the cells from behind the wall — a peg is sitting in each one">Behind</button>
      </div>
      <p className="builder__hint">click a cell to move a peg · drag to turn · wheel to zoom</p>
    </div>
  );
}
