import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertCaptureInputs } from './documentation-freshness.mjs';
import { detailMediaNames } from './documentation-detail-media.mjs';
import {
  editGif,
  gifClickRipples,
  readDerivedGif,
  gifFraming,
  readFramedGif,
  readGif,
} from './documentation-gif.mjs';

export function checkDetailMedia(root, imagesOnly) {
  const available = [];
  for (const [kind, names] of Object.entries(detailMediaNames)) {
    const folder = path.join(root, 'docs/images/details');
    const manifest = JSON.parse(
      readFileSync(path.join(folder, `${kind}-capture.json`)),
    );
    if (!imagesOnly) assertCaptureInputs(root, kind, manifest.inputs);
    const expected = names
      .flatMap((name) => [`${name}.gif`, `${name}.png`])
      .sort();
    if (
      JSON.stringify(Object.keys(manifest.media).sort()) !==
      JSON.stringify(expected)
    )
      throw new Error(`${kind} detail media inventory changed`);
    for (const name of expected) {
      const bytes = readFileSync(path.join(folder, name));
      const recorded = manifest.media[name];
      if (createHash('sha256').update(bytes).digest('hex') !== recorded.sha256)
        throw new Error(
          `Detail media does not match capture manifest: ${name}`,
        );
      const gif = name.endsWith('.gif') ? readGif(bytes) : null;
      const info = gif
        ? { ...gif, frames: gif.frames.length }
        : {
            width: bytes.readUInt32BE(16),
            height: bytes.readUInt32BE(20),
          };
      if (
        !name.endsWith('.gif') &&
        !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      )
        throw new Error(`Invalid PNG: ${name}`);
      if (
        info.width !== 720 ||
        info.height !== 440 ||
        recorded.width !== 720 ||
        recorded.height !== 440
      )
        throw new Error(`Detail media must be 720 × 440 pixels: ${name}`);
      if (name.endsWith('.gif')) {
        if (info.loop !== 0 || recorded.loop !== 0)
          throw new Error(`Detail GIF must loop forever: ${name}`);
        if (recorded.edit) {
          for (const [file, fingerprint] of Object.entries(
            recorded.edit.inputs,
          )) {
            if (
              createHash('sha256')
                .update(readFileSync(path.join(root, file)))
                .digest('hex') !== fingerprint
            )
              throw new Error(`GIF edit inputs changed: ${file}`);
          }
          const clip = path.basename(name, '.gif');
          const source = readFileSync(path.join(folder, 'sources', name));
          const origin = JSON.parse(
            readFileSync(path.join(folder, 'sources', `${clip}.json`)),
          );
          if (!imagesOnly) assertCaptureInputs(root, kind, origin.inputs);
          if (
            createHash('sha256').update(source).digest('hex') !==
            origin.media.sha256
          )
            throw new Error(`Saved GIF source changed: ${name}`);
          const recipe = JSON.parse(
            readFileSync(path.join(root, 'scripts/documentation-gifs.json')),
          )[clip];
          if (
            Object.keys({ ...recorded.edit.recipe, ...recipe }).some(
              (key) =>
                JSON.stringify(recorded.edit.recipe[key]) !==
                JSON.stringify(recipe[key]),
            )
          )
            throw new Error(`GIF edit recipe changed: ${name}`);
          const framing = gifFraming(root, source, recipe);
          const framed = framing
            ? readFramedGif(root, clip, origin.framing, framing)
            : source;
          const clicks = gifClickRipples(root, framed, recipe);
          const decorated = clicks
            ? readDerivedGif(root, `${clip}-clicks`, origin.clicks, clicks)
            : framed;
          if (!bytes.equals(editGif(decorated, recipe)))
            throw new Error(
              `GIF edit does not match its saved capture: ${name}`,
            );
        }
        const interaction = recorded.interaction;
        if (name === 'recording-pause.gif' && interaction?.clicks !== 1)
          throw new Error('Recording-pause GIF must show exactly one click');
        if (
          interaction?.cursorFrames !== info.frames ||
          !Number.isInteger(interaction.clicks) ||
          interaction.clicks < (name === 'recording-pause.gif' ? 1 : 2) ||
          !Number.isFinite(interaction.detailWidth) ||
          !Number.isFinite(interaction.endingWidth) ||
          interaction.detailWidth <= 0 ||
          interaction.endingWidth <= 0 ||
          interaction.endingWidth > interaction.detailWidth * 1.25
        )
          throw new Error(
            `Detail GIF must show clicks and a cursor, then loop from the focused result: ${name}`,
          );
        if (
          info.frames < 2 ||
          info.frames !== recorded.frames ||
          !Number.isFinite(recorded.duration) ||
          Math.abs(info.duration - recorded.duration) > 0.011
        )
          throw new Error(`Detail GIF frames or timing changed: ${name}`);
        available.push(`docs/images/details/${name}`);
      }
    }
  }
  return available;
}
