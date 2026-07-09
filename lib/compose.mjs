// 페이지별 무음 영상 + 나레이션 오디오 → 페이지 클립 합성, 클립들을 최종 영상으로 연결.
// muxArgs/concatArgs는 순수 argv 빌더(ffmpeg 미실행). probe/mux/concat 헬퍼는 실제 spawn.
import { spawn } from 'node:child_process';

// video+audio 합성 argv. audio 유무에 따라 규칙 분기.
// - audio 있음(오디오 우선): 출력 길이를 오디오에 맞춤.
//     videoDur < audioDur → 마지막 프레임 tpad로 패딩 후 오디오 길이로 컷.
//     videoDur > audioDur → -t audioDur 로 트림.
// - audio 없음: 영상 그대로(패딩/트림/오디오 입력 없음).
export function muxArgs({ video, audio, audioDur, videoDur, dest }) {
  // Rule B — 오디오 없음: 영상만 재인코딩해 dest로.
  if (audio == null) {
    return [
      '-y',
      '-i', video,
      '-map', '0:v',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      dest,
    ];
  }

  // Rule A — 오디오 우선.
  const args = ['-y', '-i', video, '-i', audio];

  if (videoDur < audioDur) {
    // 영상이 짧음: 마지막 프레임을 diff만큼 복제해 늘린 뒤 오디오 길이로 컷.
    const diff = Number((audioDur - videoDur).toFixed(3));
    args.push('-vf', `tpad=stop_mode=clone:stop_duration=${diff}`);
    args.push('-t', String(audioDur));
  } else if (videoDur > audioDur) {
    // 영상이 김: 오디오 길이로 트림.
    args.push('-t', String(audioDur));
  }
  // videoDur === audioDur 이면 별도 처리 없음.

  args.push(
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    dest,
  );
  return args;
}

// filter_complex concat 방식으로 클립들을 연결하는 argv. 입력마다 -i 하나씩(임시 리스트 파일 부작용 없음).
export function concatArgs(clipPaths, dest) {
  const args = ['-y'];
  for (const p of clipPaths) args.push('-i', p);
  const n = clipPaths.length;
  const streams = clipPaths.map((_, i) => `[${i}:v][${i}:a]`).join('');
  const filter = `${streams}concat=n=${n}:v=1:a=1[outv][outa]`;
  args.push(
    '-filter_complex', filter,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    dest,
  );
  return args;
}

// ffprobe로 미디어 길이(초, float) 조회.
export function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed (${code}): ${err.trim()}`));
      const dur = parseFloat(out.trim());
      if (!Number.isFinite(dur)) return reject(new Error(`ffprobe: bad duration "${out.trim()}"`));
      resolve(dur);
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed (${code}): ${err.trim().slice(-500)}`));
      resolve();
    });
  });
}

// 페이지 클립 합성: 오디오가 있으면 길이 probe 후 muxArgs로 ffmpeg 실행.
export async function muxPageClip({ video, audio, dest }) {
  let audioDur;
  let videoDur;
  if (audio != null) {
    [videoDur, audioDur] = await Promise.all([probeDuration(video), probeDuration(audio)]);
  }
  await runFfmpeg(muxArgs({ video, audio, audioDur, videoDur, dest }));
  return dest;
}

// 클립들을 최종 영상으로 연결.
export async function concatClips(clipPaths, dest) {
  await runFfmpeg(concatArgs(clipPaths, dest));
  return dest;
}
