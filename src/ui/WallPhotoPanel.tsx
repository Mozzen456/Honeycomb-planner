/**
 * The photograph of the real wall: bring one in, and say how it is shown.
 *
 * The reason it exists is one job — putting a blocked zone where the light
 * switch actually is, rather than where a number somebody wrote down says it
 * is. So the panel is arranged around that job: get the picture in, tell it how
 * big things are, and then get out of the way so the zone tools can work over
 * the top of it.
 *
 * Everything that decides WHERE the photo goes lives in `src/core/wallPhoto.ts`
 * and is committed through the store like any other edit, so it undoes and it
 * saves. What is here is the file handling — decode, downscale, store the bytes
 * — plus the controls, which is the same split `ImportDialog` uses for a part's
 * photograph.
 *
 * **The scale is set on the PLAN, not here**, and deliberately: it is two points
 * on the picture and a number, and the two points can only be pointed at where
 * the picture is. This panel says whether it has been set and what it came to.
 */

import { useEffect, useRef, useState } from 'react';

import { formatMm } from '../core/measure';
import { MAX_WALL_MM } from '../core/store';
import { MAX_PHOTO_OPACITY, MIN_PHOTO_OPACITY, photoRectMm } from '../core/wallPhoto';
import type { LayoutDoc, WallPhoto } from '../core/types';
import { NumberField } from './NumberField';
import { attachWallPhoto, wallPhotoImage } from './wallPhotoImage';
import './WallPhotoPanel.css';

export interface WallPhotoPanelProps {
  doc: LayoutDoc;
  onChange: (photo: WallPhoto | undefined) => void;
  /** Something went wrong with the file, in a sentence. */
  onProblem: (message: string) => void;
}

export function WallPhotoPanel({ doc, onChange, onProblem }: WallPhotoPanelProps) {
  const photo = doc.photo;
  /**
   * Three states, not two: loading, here, and NOT ON THIS MACHINE.
   *
   * The third is real and has to be said out loud. The alignment travels in the
   * document and the pixels do not, so a layout opened from a share link — or
   * from a saved file in a different browser — arrives knowing exactly where the
   * photograph goes and unable to show it. Silently drawing nothing would read
   * as the feature being broken.
   */
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [looking, setLooking] = useState(false);
  const busyRef = useRef(false);

  const photoId = photo?.id;
  useEffect(() => {
    if (photoId === undefined) { setImage(null); return; }
    let live = true;
    setLooking(true);
    void wallPhotoImage(photoId).then((img) => {
      if (!live) return;
      setImage(img);
      setLooking(false);
    });
    return () => { live = false; };
  }, [photoId]);

  /** Take a file and make it the wall's photograph, through the one owner. */
  const choose = async (file: File | undefined, keep: WallPhoto | null): Promise<void> => {
    if (!file || busyRef.current) return;
    busyRef.current = true;
    try {
      const { photo: next, refusal } = await attachWallPhoto(file, doc.wall, keep);
      if (next === null) { onProblem(refusal ?? 'That photo could not be used.'); return; }
      onChange(next);
      setImage(await wallPhotoImage(next.id));
    } finally {
      busyRef.current = false;
    }
  };

  const set = (patch: Partial<WallPhoto>): void => {
    if (photo) onChange({ ...photo, ...patch });
  };

  if (!photo) {
    return (
      <section className="wallphoto" aria-label="Photo of the wall">
        <h3 className="wallphoto__title">Photo of the wall</h3>
        <p className="wallphoto__hint">
          Take a picture of the wall, scale it against something you have
          measured, and lay it under the plan. Then a blocked zone goes where the
          switch actually is, instead of where you think it is.
        </p>
        <label className="button button--primary wallphoto__pick">
          Add a photo…
          <input
            type="file"
            accept="image/*"
            onChange={(e) => { void choose(e.target.files?.[0], null); e.target.value = ''; }}
          />
        </label>
      </section>
    );
  }

  const rect = photoRectMm(photo);
  const missing = image === null && !looking;

  return (
    <section className="wallphoto" aria-label="Photo of the wall">
      <h3 className="wallphoto__title">
        Photo of the wall
        {!photo.calibrated && <span className="wallphoto__flag">scale not set</span>}
      </h3>

      {image !== null && (
        <span className="wallphoto__frame">
          <img src={image.src} alt={`Photograph of the wall: ${photo.name}`} />
        </span>
      )}
      {missing && (
        <p className="wallphoto__missing" role="status">
          <strong>{photo.name}</strong> is not stored in this browser — the layout
          remembers where it goes, but not what it looks like. Attach the same
          picture again and the alignment is kept.
        </p>
      )}

      <p className="wallphoto__meta tabular-nums">
        {photo.pixelWidth} × {photo.pixelHeight} px ·{' '}
        {formatMm(rect.widthMm, 0)} × {formatMm(rect.heightMm, 0)} mm on the wall
      </p>
      <p className="wallphoto__meta">
        {photo.calibrated ? (
          <>Scaled by measurement: 1 px = {photo.mmPerPixel.toFixed(3)} mm.</>
        ) : (
          <>
            Fitted across the wall, which is a guess. Pick <strong>Photo</strong> on
            the plan, press <strong>Set scale</strong>, and drag between two points
            whose real distance apart you know.
          </>
        )}
      </p>

      <label className="wallphoto__row">
        <span>Show</span>
        <input
          type="checkbox"
          checked={photo.visible}
          onChange={(e) => set({ visible: e.target.checked })}
        />
      </label>

      <label className="wallphoto__row">
        <span>Opacity</span>
        {/*
          A range, not a number: this is the one control that is adjusted by
          eye. You slide it until the honeycomb and the room are both readable,
          and no value of it is ever written down.
        */}
        <input
          type="range"
          min={MIN_PHOTO_OPACITY}
          max={MAX_PHOTO_OPACITY}
          step={0.05}
          value={photo.opacity}
          onChange={(e) => set({ opacity: Number(e.target.value) })}
          aria-label="Photo opacity"
        />
        <output className="tabular-nums">{Math.round(photo.opacity * 100)}%</output>
      </label>

      <div className="wallphoto__row" role="group" aria-label="Where the photo sits">
        <span>Sits</span>
        <div className="wallphoto__depth">
          {(['behind', 'front'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={photo.depth === d}
              title={
                d === 'behind'
                  ? 'Under the honeycomb — the room shows through the open cells'
                  : 'Over the honeycomb — for checking a plan against the wall'
              }
              onClick={() => set({ depth: d })}
            >
              {d === 'behind' ? 'Behind' : 'In front'}
            </button>
          ))}
        </div>
      </div>

      <div className="wallphoto__fields tabular-nums">
        {([['xMm', 'X'], ['yMm', 'Y']] as const).map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <NumberField
              value={photo[key]}
              step={10}
              min={-MAX_WALL_MM}
              max={MAX_WALL_MM}
              // `confirm`: the photo is redrawn and, in 3D, its plane rebuilt on
              // every commit, and each one is an undo step. Typing `1200` should
              // not cost three of them.
              commitOn="confirm"
              onCommit={(v) => set({ [key]: v })}
              aria-label={`Photo ${label} in millimetres`}
            />
          </label>
        ))}
      </div>

      <div className="wallphoto__actions">
        <label className="button wallphoto__pick">
          {missing ? 'Attach the picture…' : 'Replace…'}
          <input
            type="file"
            accept="image/*"
            onChange={(e) => { void choose(e.target.files?.[0], photo); e.target.value = ''; }}
          />
        </label>
        {/*
          The bytes DO NOT go with it. Removing a photo is an ordinary undoable
          edit, and undo has to give the picture back — deleting the pixels here
          would leave undo restoring a layout that remembers exactly where a
          photograph goes and cannot show it, which is the one state this whole
          feature works to avoid. `pruneWallPhotos` bounds the store at startup.
        */}
        <button type="button" className="button" onClick={() => onChange(undefined)}>
          Remove
        </button>
      </div>
    </section>
  );
}
