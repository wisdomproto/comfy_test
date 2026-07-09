// 테스트벤치 서버: 정적 서빙 + ComfyUI 오케스트레이션 + 잡/히스토리 관리
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import busboy from 'busboy';
import * as comfy from './lib/comfy.mjs';
import { buildFluxT2I, buildWanI2V, LORA_TRIGGERS } from './lib/workflows.mjs';

const PORT = 3333;
const ROOT = import.meta.dirname;
const OUTPUTS_DIR = path.join(ROOT, 'outputs');
const DATA_DIR = path.join(ROOT, 'data');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');

fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RUNS_FILE)) fs.writeFileSync(RUNS_FILE, '[]');

const readRuns = () => JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
function appendRun(run) {
  const runs = readRuns();
  runs.push(run);
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
}

// 랜덤 seed는 제출 전에 확정 — "같은 설정으로 재생성" 재현성 보장 (스펙)
// crypto.randomInt는 max-min ≤ 2^48-1 제약 — 2**48이면 RangeError
const resolveSeed = (seed) => (Number.isInteger(seed) ? seed : crypto.randomInt(0, 2 ** 48 - 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jobs = new Map();

function createJob(type, params, sourceRunId = null) {
  const job = {
    id: crypto.randomUUID(), type, params, sourceRunId,
    status: 'queued', progress: 0, error: null, outputFile: null, startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

async function runJob(job, workflow) {
  const clientId = crypto.randomUUID();
  let closeWs = () => {};
  try {
    const { prompt_id: promptId } = await comfy.submit(workflow, clientId);
    job.status = 'running';
    closeWs = comfy.trackProgress(promptId, clientId, ({ value, max }) => {
      job.progress = Math.round((value / max) * 100);
    });
    // 완료 판정은 히스토리 폴링 — WS 끊김/브라우저 종료와 무관하게 완주.
    // 단, ComfyUI 자체가 죽으면 2분(연속 24회 실패) 후 잡을 error로 마감
    let failures = 0;
    for (;;) {
      await sleep(5000);
      let history = null;
      try {
        history = await comfy.fetchHistory(promptId);
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= 24) throw new Error('ComfyUI unreachable for 2 minutes during job');
      }
      const entry = history?.[promptId];
      if (!entry?.status) continue;
      if (entry.status.status_str === 'error') {
        const errs = (entry.status.messages ?? []).filter(([t]) => t === 'execution_error');
        throw new Error(`execution error: ${JSON.stringify(errs.at(-1) ?? 'unknown')}`);
      }
      if (entry.status.completed) {
        const files = comfy.extractOutputs(entry);
        if (!files.length) throw new Error('completed but no output files in history');
        const ext = path.extname(files[0].filename) || (job.type === 'video' ? '.mp4' : '.png');
        const outName = `${job.id}${ext}`;
        await comfy.downloadOutput(files[0], path.join(OUTPUTS_DIR, outName));
        job.outputFile = `outputs/${outName}`;
        job.status = 'done';
        break;
      }
    }
  } catch (err) {
    job.status = 'error';
    job.error = String(err?.message ?? err);
  } finally {
    closeWs();
    // 실패한 조합도 테스트 데이터 — 성공/실패 모두 기록 (스펙)
    appendRun({
      id: job.id, type: job.type,
      createdAt: new Date(job.startedAt).toISOString(),
      params: job.params, sourceRunId: job.sourceRunId,
      status: job.status === 'done' ? 'done' : 'error',
      error: job.error, outputFile: job.outputFile,
      durationSec: Math.round((Date.now() - job.startedAt) / 1000),
    });
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/outputs', express.static(OUTPUTS_DIR));

app.get('/api/status', async (req, res) => {
  const alive = await comfy.isAlive();
  let loras = [];
  if (alive) {
    try { loras = await comfy.getLoras(); } catch { /* 목록 실패해도 상태는 응답 */ }
  }
  res.json({ alive, loras, loraTriggers: LORA_TRIGGERS });
});

app.post('/api/comfy/start', async (req, res) => {
  if (await comfy.isAlive()) return res.json({ started: false, reason: 'already running' });
  spawn('cmd.exe', ['/c', 'start', 'ComfyUI', comfy.COMFY_START_BAT], {
    cwd: comfy.COMFY_ROOT, detached: true, stdio: 'ignore',
  }).unref();
  res.json({ started: true }); // 기동 완료까지 ~60초 — 프론트가 /api/status 폴링으로 확인
});

app.post('/api/generate/image', async (req, res) => {
  if (!(await comfy.isAlive())) return res.status(503).json({ error: 'ComfyUI is not running' });
  const p = req.body;
  const params = {
    prompt: p.prompt, negative: p.negative || '',
    lora: p.lora || null, loraStrength: p.loraStrength ?? 1.0,
    width: p.width ?? 1024, height: p.height ?? 1024,
    steps: p.steps ?? 25, guidance: p.guidance ?? 3.5,
    seed: resolveSeed(p.seed),
  };
  let workflow;
  try { workflow = buildFluxT2I(params); } catch (err) { return res.status(400).json({ error: err.message }); }
  const job = createJob('image', params);
  runJob(job, workflow);
  res.json({ jobId: job.id });
});

app.post('/api/generate/video', async (req, res) => {
  if (!(await comfy.isAlive())) return res.status(503).json({ error: 'ComfyUI is not running' });
  const p = req.body;
  let imageName = p.uploadName ?? null;
  if (p.sourceRunId) {
    const run = readRuns().find((r) => r.id === p.sourceRunId);
    if (!run?.outputFile) return res.status(400).json({ error: 'source run not found or has no output' });
    // 히스토리 결과물을 ComfyUI input/으로 복사 (스펙: 히스토리 → 영상 소스)
    imageName = comfy.uploadInput(
      path.join(ROOT, run.outputFile),
      `src_${run.id}${path.extname(run.outputFile)}`,
    );
  }
  const params = {
    imageName, motionPrompt: p.motionPrompt,
    width: p.width ?? 832, height: p.height ?? 480,
    frames: p.frames ?? 81, steps: p.steps ?? 25,
    seed: resolveSeed(p.seed),
  };
  let workflow;
  try { workflow = buildWanI2V(params); } catch (err) { return res.status(400).json({ error: err.message }); }
  const job = createJob('video', params, p.sourceRunId ?? null);
  runJob(job, workflow);
  res.json({ jobId: job.id });
});

app.post('/api/upload', (req, res) => {
  const bb = busboy({ headers: req.headers });
  let done = null; // 파일 flush 완료까지 기다렸다가 응답 (부분 쓰기 방지)
  bb.on('file', (name, file, info) => {
    const destName = `upload_${Date.now()}${path.extname(info.filename) || '.png'}`;
    const out = fs.createWriteStream(path.join(comfy.COMFY_INPUT_DIR, destName));
    file.pipe(out);
    done = new Promise((resolve, reject) => {
      out.on('finish', () => resolve(destName));
      out.on('error', reject);
    });
  });
  bb.on('close', async () => {
    if (!done) return res.status(400).json({ error: 'no file' });
    try {
      res.json({ uploadName: await done });
    } catch (err) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
  req.pipe(bb);
});

app.get('/api/jobs', (req, res) => {
  res.json([...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running'));
});
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});
app.get('/api/runs', (req, res) => res.json(readRuns().reverse()));

app.listen(PORT, () => console.log(`comfy-testbench: http://localhost:${PORT}`));
