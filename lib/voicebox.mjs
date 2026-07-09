// Voicebox TTS HTTP 클라이언트 (http://127.0.0.1:17493)
import fs from 'node:fs';
import path from 'node:path';

export const BASE = 'http://127.0.0.1:17493';

export async function isAlive() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// 프로필을 name 기준으로 idempotent하게 보장. 없으면 생성 후 레퍼런스 샘플 업로드.
export async function ensureProfile({ name, refAudioPath, refText, language = 'ko', engine = 'qwen' }) {
  // 1. 기존 프로필 조회 — 이름 일치 시 재사용
  const listRes = await fetch(`${BASE}/profiles`);
  if (!listRes.ok) throw new Error(`voicebox list profiles failed: HTTP ${listRes.status} ${await listRes.text()}`);
  const profiles = await listRes.json();
  const existing = Array.isArray(profiles) ? profiles.find((p) => p.name === name) : null;
  if (existing) return existing.id;

  // 2. 신규 프로필 생성
  const createRes = await fetch(`${BASE}/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, language, voice_type: 'cloned', default_engine: engine }),
  });
  if (!createRes.ok) throw new Error(`voicebox create profile failed: HTTP ${createRes.status} ${await createRes.text()}`);
  const profile = await createRes.json();
  const id = profile.id;

  // 3. 레퍼런스 샘플 업로드 (multipart — Content-Type은 fetch가 boundary와 함께 설정)
  const buf = fs.readFileSync(refAudioPath);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), path.basename(refAudioPath));
  fd.append('reference_text', refText);
  const sampleRes = await fetch(`${BASE}/profiles/${id}/samples`, { method: 'POST', body: fd });
  if (!sampleRes.ok) throw new Error(`voicebox upload sample failed: HTTP ${sampleRes.status} ${await sampleRes.text()}`);

  return id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 모델 선다운로드 보장 — /generate/stream은 미다운로드 모델을 자동으로 받지 않음.
// engine=qwen → 'qwen-tts-1.7B', engine=qwen_custom_voice → 'qwen-custom-voice-1.7B'.
export async function ensureModel({ modelName }) {
  const check = async () => {
    const r = await fetch(`${BASE}/models/status`).catch(() => null);
    if (!r?.ok) return false;
    const { models } = await r.json();
    return !!models?.find((m) => m.model_name === modelName)?.downloaded;
  };
  if (await check()) return true;
  await fetch(`${BASE}/models/download`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_name: modelName }),
  });
  for (let i = 0; i < 240; i++) { // 최대 ~20분
    await sleep(5000);
    if (await check()) return true;
  }
  throw new Error(`voicebox model ${modelName} download timeout`);
}

// 참조 오디오 대본 자동 추출 (Whisper). 모델 다운로드 중이면 대기 후 재시도. best-effort.
export async function transcribe(audioPath, { model = 'large', language = 'ko' } = {}) {
  for (let i = 0; i < 120; i++) {
    const buf = fs.readFileSync(audioPath);
    const fd = new FormData();
    fd.append('file', new Blob([buf]), path.basename(audioPath));
    fd.append('model', model);
    fd.append('language', language);
    const res = await fetch(`${BASE}/transcribe`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (data?.detail?.downloading) { await sleep(10000); continue; }
    const text = data.text ?? data.transcription ?? data.transcript;
    if (text) return text;
    throw new Error(`voicebox transcribe: unexpected response ${JSON.stringify(data).slice(0, 200)}`);
  }
  throw new Error('voicebox transcribe: whisper download timeout');
}

// 텍스트를 WAV로 합성해 destWavPath에 기록. (모델은 ensureModel로 미리 받아둘 것)
export async function generate({ profileId, text, language = 'ko', engine = 'qwen', modelSize = '1.7B' }, destWavPath) {
  const res = await fetch(`${BASE}/generate/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_id: profileId, text, language, engine, model_size: modelSize }),
  });
  if (!res.ok) throw new Error(`voicebox generate failed: HTTP ${res.status} ${await res.text()}`);
  fs.writeFileSync(destWavPath, Buffer.from(await res.arrayBuffer()));
  return destWavPath;
}
