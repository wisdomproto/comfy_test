// ComfyUI HTTP/WS API 클라이언트 (http://127.0.0.1:8188)
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:8188';
export const COMFY_ROOT = 'C:\\ComfyUI_windows_portable';
export const COMFY_INPUT_DIR = path.join(COMFY_ROOT, 'ComfyUI', 'input');
export const COMFY_START_BAT = path.join(COMFY_ROOT, 'run_nvidia_gpu_fast_fp16_accumulation.bat');

export async function isAlive() {
  try {
    const res = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getLoras() {
  const res = await fetch(`${BASE}/object_info/LoraLoader`);
  const json = await res.json();
  return json.LoraLoader.input.required.lora_name[0];
}

export async function submit(workflow, clientId) {
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) throw new Error(`submit failed: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`submit failed: ${JSON.stringify(json.error)}`);
  return json; // { prompt_id, ... }
}

// KSampler 스텝 진행률을 WS로 수신. 완료 판정은 여기서 하지 않음 —
// 서버가 히스토리 폴링으로 판정하므로 WS가 끊겨도 잡은 완주한다.
export function trackProgress(promptId, clientId, onProgress) {
  const ws = new WebSocket(`ws://127.0.0.1:8188/ws?clientId=${clientId}`);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // 프리뷰 프레임은 무시
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'progress' && msg.data.prompt_id === promptId) {
      onProgress({ value: msg.data.value, max: msg.data.max });
    }
  });
  ws.on('error', () => {}); // 진행률은 best-effort
  return () => { try { ws.close(); } catch {} };
}

export async function fetchHistory(promptId) {
  const res = await fetch(`${BASE}/history/${promptId}`);
  return res.json();
}

// 히스토리 outputs에서 filename 가진 항목을 전부 수집.
// SaveImage는 outputs[n].images, SaveVideo는 필드명이 다를 수 있어 제너릭하게 순회.
export function extractOutputs(historyEntry) {
  const files = [];
  for (const nodeOutput of Object.values(historyEntry.outputs ?? {})) {
    for (const value of Object.values(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item && typeof item === 'object' && item.filename) files.push(item);
      }
    }
  }
  return files;
}

export async function downloadOutput(fileInfo, destPath) {
  const q = new URLSearchParams({
    filename: fileInfo.filename,
    subfolder: fileInfo.subfolder ?? '',
    type: fileInfo.type ?? 'output',
  });
  const res = await fetch(`${BASE}/view?${q}`);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  // 영상은 수 MB — 동기 쓰기로 이벤트 루프를 막지 않도록 비동기 기록
  await fs.promises.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

// LoadImage 노드용 — ComfyUI input/ 폴더로 파일 복사
export function uploadInput(localPath, destName) {
  fs.copyFileSync(localPath, path.join(COMFY_INPUT_DIR, destName));
  return destName;
}

// 단계 전환 시 ComfyUI가 VRAM/모델을 해제하도록 — 크로스 프로세스(예: Voicebox) OOM 방지.
export async function freeMemory({ unloadModels = true, freeMemory = true } = {}) {
  const res = await fetch(`${BASE}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: unloadModels, free_memory: freeMemory }),
  });
  return res.ok;
}
