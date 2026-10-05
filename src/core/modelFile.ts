/**
 * A file of bytes becomes a mesh — whichever of the two formats it is.
 *
 * The app reads STL and 3MF. Everything downstream of here — `measureMesh`,
 * `detect`, `meshLibrary`, the print estimate — takes a `MeshData` and neither
 * knows nor cares which it came from, which is the point: adding 3MF changed
 * one function's input, not the pipeline.
 *
 * **The extension is a hint, the bytes are the evidence.** A file called
 * `hook.stl` that is really a 3MF is common — slicers and model sites rename
 * freely — and sniffing costs four bytes. A ZIP always begins `PK\x03\x04`,
 * and no STL can: a binary STL's first four bytes are part of an 80-byte
 * header, and an ASCII one starts with whitespace or `solid`. So the sniff is
 * decisive where it fires, and the extension only breaks ties.
 *
 * Async because it has to be. Inflating a ZIP entry goes through
 * `DecompressionStream`, and there is no synchronous inflate in a browser.
 * That asynchrony stops here: `parseStl` stays synchronous for everything that
 * already used it.
 */

import { parseStl, type MeshData } from './stl';
import { parse3mf } from './threemf';

/** ZIP local file header, which is how every 3MF begins. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export interface ParsedModel {
  mesh: MeshData;
  /** Anything the reader wants the person to know. Empty for a plain STL. */
  warnings: string[];
}

/** Is this name one we offer to read? Used by the file inputs and the drop handler. */
export const isModelFile = (name: string): boolean => /\.(stl|3mf)$/i.test(name);

/**
 * What the file inputs put in their `accept`: NOTHING, deliberately.
 *
 * It was `.stl,.3mf,model/stl,model/3mf`, and on macOS that made a 3MF
 * unpickable. A file dialog filters by the system's idea of a TYPE, and this
 * Mac has no idea what a `.3mf` is — `mdls` on one reports
 * `dyn.ah62d4rv4ge8xg5pg`, the placeholder macOS mints for an extension nothing
 * has claimed. Neither MIME type is registered with the OS either. So the
 * filter greyed out the very file somebody opened the dialog to choose, while
 * the same file dropped onto the window worked perfectly — which is what "I can
 * only drag it in" means.
 *
 * A filter that hides what you came for is worse than no filter, and it was
 * never doing any real work: `isModelFile` checks the name and
 * `parseModelFile` checks the BYTES, so a wrong pick already comes back as a
 * sentence rather than as a broken part. Undefined rather than an empty string,
 * because React omits the attribute for one and sets `accept=""` for the other.
 */
export const MODEL_ACCEPT: string | undefined = undefined;

export function looksLikeZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const head = new Uint8Array(buffer, 0, 4);
  return ZIP_MAGIC.every((b, i) => head[i] === b);
}

/**
 * Read a model file. Throws only if the bytes are neither format.
 *
 * A 3MF's warnings are real findings — the file was drawn in inches, or it
 * holds six objects — and they travel with the mesh rather than being logged,
 * because the import dialog already has a place to show exactly this and a
 * warning nobody sees is not a warning.
 */
export async function parseModelFile(fileName: string, buffer: ArrayBuffer): Promise<ParsedModel> {
  const zip = looksLikeZip(buffer);
  const named3mf = /\.3mf$/i.test(fileName);

  if (zip || named3mf) {
    const result = await parse3mf(buffer);
    const warnings = [...result.warnings];
    if (zip && !named3mf) {
      warnings.push(`${fileName} is named as an STL but is really a 3MF; it has been read as one.`);
    }
    if (result.itemCount > 1) {
      /*
       * Merged, and said so. A 3MF may hold a whole build PLATE, and this app's
       * unit is one part — so the merge is right for a part assembled from
       * components and wrong for a plate of six unrelated models. Which of the
       * two it is cannot be told from the file, but the person who exported it
       * knows instantly.
       */
      warnings.push(
        `This 3MF holds ${result.itemCount} placed objects, and they have been merged into one ` +
          'part. If it was a whole build plate, export the single model you want instead.',
      );
    }
    return { mesh: result.mesh, warnings };
  }

  // Not a ZIP and not named 3MF, so it is an STL or it is nothing.
  // `parseStl` already refuses with a sentence saying why.
  return { mesh: parseStl(buffer), warnings: [] };
}
