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

// 텍스트를 WAV로 합성해 destWavPath에 기록.
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
