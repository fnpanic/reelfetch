/** Remux downloaded elementary streams (TS, fMP4, WebM, ADTS...) into one file, no transcoding. */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MkvOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
  type OutputFormat,
  type StreamTargetChunk,
} from 'mediabunny';

export interface RemuxOptions {
  audioOnly?: boolean;
  preferMkv?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

interface Choice {
  format: OutputFormat;
  ext: string;
}

function chooseFormat(codecs: string[], hasVideo: boolean, preferMkv?: boolean): Choice {
  const fits = (f: OutputFormat) => codecs.every((c) => (f.getSupportedCodecs() as string[]).includes(c));
  // Order = preference: WebM for VP8/VP9/AV1/Opus (what those codecs are usually shipped in), MP4 for H.264/AAC.
  const cands: Choice[] = hasVideo
    ? [
        ...(preferMkv ? [] : [{ format: new WebMOutputFormat(), ext: 'webm' }, { format: new Mp4OutputFormat(), ext: 'mp4' }]),
        { format: new MkvOutputFormat(), ext: 'mkv' },
      ]
    : [
        { format: new Mp3OutputFormat(), ext: 'mp3' },
        { format: new OggOutputFormat(), ext: 'ogg' },
        { format: new Mp4OutputFormat(), ext: 'm4a' },
        { format: new WebMOutputFormat(), ext: 'weba' },
        { format: new MkvOutputFormat(), ext: 'mka' },
      ];
  const hit = cands.find((c) => fits(c.format));
  if (!hit) throw new Error(`No container supports codecs ${codecs.join(', ')}`);
  return hit;
}

/**
 * Combine the primary video track (from the first source that has one) and the primary audio
 * track (preferring a separate audio source) into a single container.
 * Returns the extension; data goes to `sink`, or is returned as a buffer when no sink is given.
 */
export async function remux(
  sources: Blob[],
  opts: RemuxOptions,
  sink?: WritableStream<StreamTargetChunk>,
): Promise<{ ext: string; buffer?: ArrayBuffer }> {
  const inputs = sources.map((b) => new Input({ source: new BlobSource(b), formats: ALL_FORMATS }));
  try {
    let video: InputVideoTrack | null = null;
    let audio: InputAudioTrack | null = null;
    if (!opts.audioOnly) {
      for (const i of inputs) if (!video) video = await i.getPrimaryVideoTrack();
    }
    // Prefer audio from an input other than the video's (separate DASH/HLS audio rendition).
    for (const i of [...inputs].reverse()) if (!audio) audio = await i.getPrimaryAudioTrack();
    if (!video && !audio) throw new Error('No audio or video track found');
    if (video && !video.codec) throw new Error('Unsupported video codec');
    if (audio && !audio.codec) audio = null;

    const tracks: (InputVideoTrack | InputAudioTrack)[] = [video, audio].filter((t): t is InputVideoTrack | InputAudioTrack => !!t);
    const choice = chooseFormat(tracks.map((t) => t.codec as string), !!video, opts.preferMkv);
    const target = sink ? new StreamTarget(sink, { chunked: true }) : new BufferTarget();
    const output = new Output({ format: choice.format, target });

    const vSrc = video ? new EncodedVideoPacketSource(video.codec!) : null;
    const aSrc = audio ? new EncodedAudioPacketSource(audio.codec!) : null;
    if (vSrc && video) output.addVideoTrack(vSrc, { rotation: video.rotation });
    if (aSrc && audio) output.addAudioTrack(aSrc, { languageCode: audio.languageCode });
    await output.start();

    const starts = await Promise.all(tracks.map((t) => t.getFirstTimestamp().catch(() => 0)));
    const offset = Math.min(...starts);
    const totalBytes = sources.reduce((s, b) => s + b.size, 0) || 1;
    let done = 0;
    let lastReport = 0;

    const lanes = await Promise.all(
      tracks.map(async (t) => {
        const it = new EncodedPacketSink(t).packets();
        const first = await it.next();
        return {
          track: t,
          it,
          cur: first.done ? null : first.value,
          src: (t === video ? vSrc : aSrc)!,
          meta: { decoderConfig: (await t.getDecoderConfig()) ?? undefined } as Record<string, unknown> | undefined,
        };
      }),
    );

    // Interleave by timestamp so the muxer never buffers a whole track.
    for (;;) {
      opts.signal?.throwIfAborted();
      let lane = null as (typeof lanes)[number] | null;
      for (const l of lanes) if (l.cur && (!lane || l.cur.timestamp < lane.cur!.timestamp)) lane = l;
      if (!lane) break;
      const p: EncodedPacket = lane.cur!;
      const pkt = p.clone({ timestamp: Math.max(0, p.timestamp - offset) });
      await (lane.src as EncodedVideoPacketSource).add(pkt, lane.meta as never);
      lane.meta = undefined;
      done += p.byteLength;
      const n = await lane.it.next();
      lane.cur = n.done ? null : n.value;
      if (opts.onProgress && done - lastReport > totalBytes / 100) {
        lastReport = done;
        opts.onProgress(Math.min(1, done / totalBytes));
      }
    }
    await output.finalize();
    return { ext: choice.ext, buffer: target instanceof BufferTarget ? target.buffer! : undefined };
  } finally {
    for (const i of inputs) i.dispose();
  }
}
