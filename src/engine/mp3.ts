/** Audio transcoding to MP3 (decode with WebCodecs, encode with LAME/WASM). Engine-only: keeps LAME out of content scripts. */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  Conversion,
  Input,
  Mp3OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

let registered = false;

export async function convertToMp3(
  source: Blob,
  sink?: WritableStream<StreamTargetChunk>,
  signal?: AbortSignal,
): Promise<{ ext: 'mp3'; buffer?: ArrayBuffer }> {
  if (!registered && !(await canEncodeAudio('mp3'))) registerMp3Encoder();
  registered = true;
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  try {
    const target = sink ? new StreamTarget(sink, { chunked: true }) : new BufferTarget();
    const output = new Output({ format: new Mp3OutputFormat(), target });
    const conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
      audio: { codec: 'mp3', bitrate: 192_000 },
      showWarnings: false,
    });
    if (!conversion.isValid)
      throw new Error(`MP3 conversion not possible: ${conversion.discardedTracks.map((d) => d.reason).join(', ')}`);
    const onAbort = () => void conversion.cancel();
    signal?.addEventListener('abort', onAbort);
    try {
      await conversion.execute();
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    return { ext: 'mp3', buffer: target instanceof BufferTarget ? target.buffer! : undefined };
  } finally {
    input.dispose();
  }
}
