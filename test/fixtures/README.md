# Test fixtures

Small synthetic media generated with ffmpeg (test pattern + sine tone), used by `test/engine.test.ts` and `scripts/e2e.mjs`.

- `hls-ts-aes/`: HLS VOD, MPEG-TS segments, AES-128 encrypted (key `key.bin`, explicit IV)
- `hls-fmp4/`: HLS master with fMP4 video and a separate English audio rendition
- `dash/`: DASH with SegmentTemplate + SegmentTimeline, separate video/audio adaptation sets
- `direct.mp4`: 10 s progressive MP4 (> detection size threshold)
- `mse.webm`: VP9/Opus WebM fed to a MediaSource player in the e2e test
- `drm.m3u8`: playlist with a FairPlay key (must be refused)

Regenerate (bash, ffmpeg with libx264/libvpx/libopus):

```bash
SRC="-f lavfi -i testsrc=size=320x180:rate=25:duration=6 -f lavfi -i sine=frequency=440:duration=6"
ENC="-c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 25 -keyint_min 25 -sc_threshold 0 -b:v 150k -c:a aac -b:a 64k -ac 2"
printf '0123456789abcdef' > hls-ts-aes/key.bin
printf 'key.bin\nhls-ts-aes/key.bin\n00112233445566778899aabbccddeeff\n' > keyinfo.txt
ffmpeg $SRC $ENC -f hls -hls_time 1 -hls_playlist_type vod -hls_key_info_file keyinfo.txt -hls_segment_filename 'hls-ts-aes/seg%03d.ts' hls-ts-aes/index.m3u8
ffmpeg $SRC $ENC -map 0:v -map 1:a -f hls -hls_time 1 -hls_playlist_type vod -hls_segment_type fmp4 -master_pl_name master.m3u8 \
  -var_stream_map "v:0,agroup:aud a:0,agroup:aud,language:en,default:yes" -hls_segment_filename 'hls-fmp4/s%v_%03d.m4s' -hls_fmp4_init_filename 'init_%v.mp4' hls-fmp4/stream_%v.m3u8
ffmpeg $SRC $ENC -map 0:v -map 1:a -f dash -seg_duration 1 -use_timeline 1 -use_template 1 -adaptation_sets "id=0,streams=v id=1,streams=a" dash/manifest.mpd
ffmpeg -f lavfi -i testsrc=size=320x180:rate=25:duration=10 -f lavfi -i sine=frequency=330:duration=10 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 400k -c:a aac -b:a 64k -movflags +faststart direct.mp4
ffmpeg -f lavfi -i testsrc=size=320x180:rate=25:duration=5 -f lavfi -i sine=frequency=550:duration=5 -c:v libvpx-vp9 -b:v 200k -deadline realtime -c:a libopus -b:a 64k mse.webm
```
