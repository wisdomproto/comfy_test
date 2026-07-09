// ComfyUI 워크플로우 러너 — 기존 클라이언트(comfy.mjs)를 얇게 감싼다.
// 잡 제출 → 진행률 WS → 히스토리 폴링으로 완료 판정 → 첫 출력물 다운로드.
import crypto from 'node:crypto';
import * as comfy from './comfy.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 워크플로우를 실행하고 첫 출력물을 destPath에 저장. onProgress는 { value, max }를 그대로 받는다.
export async function runComfyWorkflow(workflow, { destPath, onProgress = () => {} }) {
  const clientId = crypto.randomUUID();
  const { prompt_id: promptId } = await comfy.submit(workflow, clientId);
  // 진행률은 best-effort — WS가 끊겨도 히스토리 폴링으로 완주 판정.
  const closeWs = comfy.trackProgress(promptId, clientId, ({ value, max }) => {
    onProgress({ value, max });
  });
  try {
    // 완료 판정은 히스토리 폴링. ComfyUI가 죽으면 2분(연속 24회 실패) 후 throw.
    let failures = 0;
    for (;;) {
      await sleep(5000);
      let history = null;
      try {
        history = await comfy.fetchHistory(promptId);
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= 24) throw new Error('ComfyUI unreachable for 2 minutes');
      }
      const entry = history?.[promptId];
      if (!entry?.status) continue;
      if (entry.status.status_str === 'error') {
        const errs = (entry.status.messages ?? []).filter(([t]) => t === 'execution_error');
        throw new Error(`execution error: ${JSON.stringify(errs.at(-1) ?? 'unknown')}`);
      }
      if (entry.status.completed) {
        const files = comfy.extractOutputs(entry);
        if (!files.length) throw new Error('completed but no output files');
        await comfy.downloadOutput(files[0], destPath);
        break;
      }
    }
  } finally {
    closeWs();
  }
  return { destPath, promptId };
}
