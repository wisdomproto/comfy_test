// 테스트벤치 서버: 정적 서빙 + ComfyUI 오케스트레이션 + 잡/히스토리 관리
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';
import busboy from 'busboy';
import * as comfy from './lib/comfy.mjs';
import * as voicebox from './lib/voicebox.mjs';
import { buildFluxT2I, buildWanI2V, LORA_TRIGGERS } from './lib/workflows.mjs';
import { resolveSeed } from './lib/seed.mjs';

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

// 스토리북("book") 저장소 — runs.json과 동일한 JSON 파일 패턴
const BOOKS_FILE = path.join(DATA_DIR, 'books.json');
if (!fs.existsSync(BOOKS_FILE)) fs.writeFileSync(BOOKS_FILE, '[]');
const readBooks = () => JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8'));
function writeBooks(books) {
  fs.writeFileSync(BOOKS_FILE, JSON.stringify(books, null, 2));
}
// 북 에셋 디렉터리 — outputs/ 아래라 express.static으로 웹 서빙됨
const bookDir = (id) => path.join(OUTPUTS_DIR, 'books', id);

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
  const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
  let done = null; // 파일 flush 완료까지 기다렸다가 응답 (부분 쓰기 방지)
  let out = null;
  bb.on('file', (name, file, info) => {
    const destName = `upload_${Date.now()}${path.extname(info.filename) || '.png'}`;
    const destPath = path.join(comfy.COMFY_INPUT_DIR, destName);
    out = fs.createWriteStream(destPath);
    file.pipe(out);
    done = new Promise((resolve, reject) => {
      file.on('limit', () => { // 20MB 초과 — 부분 파일 폐기
        out.destroy();
        fs.rm(destPath, { force: true }, () => {});
        reject(new Error('file too large'));
      });
      out.on('finish', () => resolve(destName));
      out.on('error', reject);
    });
    done.catch(() => {}); // close 미도달 시 unhandled rejection 방지 (실제 처리는 close 핸들러)
  });
  bb.on('close', async () => {
    if (res.headersSent) return;
    if (!done) return res.status(400).json({ error: 'no file' });
    try {
      res.json({ uploadName: await done });
    } catch (err) {
      const msg = String(err?.message ?? err);
      res.status(msg === 'file too large' ? 400 : 500).json({ error: msg });
    }
  });
  bb.on('error', (err) => {
    out?.destroy();
    if (!res.headersSent) res.status(400).json({ error: String(err?.message ?? err) });
  });
  req.on('aborted', () => { // 클라이언트 끊김 — 스트림 정리로 요청 방치 방지
    out?.destroy();
    bb.destroy();
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

// ── 스토리북(book) CRUD + 에셋 업로드 ────────────────────────────────

// PUT에서 페이지 정규화: id 보장 + source/status/file 기본값 채움 (기존 값은 보존)
function normalizePage(p) {
  return {
    ...p,
    id: p.id ?? crypto.randomUUID(),
    illustrationSource: p.illustrationSource ?? 'generate',
    videoSource: p.videoSource ?? 'generate',
    audioSource: p.audioSource ?? 'generate',
    status: p.status ?? 'draft',
    illustrationFile: p.illustrationFile ?? null,
    videoFile: p.videoFile ?? null,
    audioFile: p.audioFile ?? null,
    clipFile: p.clipFile ?? null,
    error: p.error ?? null,
  };
}

app.get('/api/books', (req, res) => res.json(readBooks()));

app.post('/api/books', (req, res) => {
  const book = {
    id: crypto.randomUUID(),
    title: req.body.title ?? 'Untitled',
    characterRef: null,
    style: req.body.style ?? null,
    createdAt: new Date().toISOString(),
    pages: [],
    status: 'draft',
  };
  fs.mkdirSync(bookDir(book.id), { recursive: true });
  const books = readBooks();
  books.push(book);
  writeBooks(books);
  res.json(book);
});

app.get('/api/books/:id', (req, res) => {
  const book = readBooks().find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: 'book not found' });
  res.json(book);
});

app.put('/api/books/:id', (req, res) => {
  const books = readBooks();
  const book = books.find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: 'book not found' });
  if (req.body.title !== undefined) book.title = req.body.title;
  if (req.body.style !== undefined) book.style = req.body.style;
  if (req.body.pages !== undefined) {
    book.pages = (req.body.pages ?? []).map(normalizePage);
  }
  writeBooks(books);
  res.json(book);
});

app.delete('/api/books/:id', (req, res) => {
  const books = readBooks().filter((b) => b.id !== req.params.id);
  writeBooks(books); // 파일은 그대로 둠 (best-effort)
  res.json({ deleted: true });
});

// 캐릭터 레퍼런스 업로드 (multipart 단일 파일) — /api/upload와 동일 패턴
app.post('/api/books/:id/character', (req, res) => {
  const books = readBooks();
  const book = books.find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: 'book not found' });
  fs.mkdirSync(bookDir(book.id), { recursive: true });

  const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
  let done = null;
  let out = null;
  bb.on('file', (name, file, info) => {
    const ext = path.extname(info.filename) || '.png';
    const destPath = path.join(bookDir(book.id), `char${ext}`);
    out = fs.createWriteStream(destPath);
    file.pipe(out);
    done = new Promise((resolve, reject) => {
      file.on('limit', () => {
        out.destroy();
        fs.rm(destPath, { force: true }, () => {});
        reject(new Error('file too large'));
      });
      out.on('finish', () => resolve(`outputs/books/${book.id}/char${ext}`));
      out.on('error', reject);
    });
    done.catch(() => {});
  });
  bb.on('close', async () => {
    if (res.headersSent) return;
    if (!done) return res.status(400).json({ error: 'no file' });
    try {
      const characterRef = await done;
      book.characterRef = characterRef;
      writeBooks(books);
      res.json({ characterRef });
    } catch (err) {
      const msg = String(err?.message ?? err);
      res.status(msg === 'file too large' ? 400 : 500).json({ error: msg });
    }
  });
  bb.on('error', (err) => {
    out?.destroy();
    if (!res.headersSent) res.status(400).json({ error: String(err?.message ?? err) });
  });
  req.on('aborted', () => { out?.destroy(); bb.destroy(); });
  req.pipe(bb);
});

// 페이지 에셋 업로드 (illustration|video|audio) — 스트리밍 중 바이트 카운트로 크기 제한
const KIND_CAPS = { illustration: 20 * 1024 * 1024, audio: 20 * 1024 * 1024, video: 500 * 1024 * 1024 };
app.post('/api/books/:id/pages/:pid/upload', (req, res) => {
  const books = readBooks();
  const book = books.find((b) => b.id === req.params.id);
  if (!book) return res.status(404).json({ error: 'book not found' });
  const page = book.pages.find((p) => p.id === req.params.pid);
  if (!page) return res.status(404).json({ error: 'page not found' });
  fs.mkdirSync(bookDir(book.id), { recursive: true });

  let kind = req.query.kind; // 폼 필드가 없으면 쿼리에서
  const bb = busboy({ headers: req.headers });
  let done = null;
  let out = null;
  bb.on('field', (name, val) => { if (name === 'kind') kind = val; });
  bb.on('file', (name, file, info) => {
    if (!KIND_CAPS[kind]) { // 유효하지 않은 kind — 파일 폐기 후 400
      file.resume();
      done = Promise.reject(new Error('invalid kind'));
      done.catch(() => {});
      return;
    }
    const cap = KIND_CAPS[kind];
    const ext = path.extname(info.filename) || '';
    const fileName = `${req.params.pid}-${kind}${ext}`;
    const destPath = path.join(bookDir(book.id), fileName);
    out = fs.createWriteStream(destPath);
    let bytes = 0;
    let tooBig = false;
    done = new Promise((resolve, reject) => {
      file.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > cap && !tooBig) { // 캡 초과 — 스트림 파기, 부분 파일 삭제
          tooBig = true;
          file.destroy();
          out.destroy();
          fs.rm(destPath, { force: true }, () => {});
          reject(new Error('file too large'));
        }
      });
      out.on('finish', () => { if (!tooBig) resolve({ file: `outputs/books/${book.id}/${fileName}`, kind }); });
      out.on('error', (e) => { if (!tooBig) reject(e); });
    });
    done.catch(() => {});
    file.pipe(out);
  });
  bb.on('close', async () => {
    if (res.headersSent) return;
    if (!done) return res.status(400).json({ error: 'no file' });
    try {
      const { file, kind: k } = await done;
      page[`${k}File`] = file;
      page[`${k}Source`] = 'upload';
      writeBooks(books);
      res.json({ file, source: 'upload' });
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg === 'invalid kind') return res.status(400).json({ error: 'invalid kind' });
      res.status(msg === 'file too large' ? 400 : 500).json({ error: msg });
    }
  });
  bb.on('error', (err) => {
    out?.destroy();
    if (!res.headersSent) res.status(400).json({ error: String(err?.message ?? err) });
  });
  req.on('aborted', () => { out?.destroy(); bb.destroy(); });
  req.pipe(bb);
});

// 스토리북 파이프라인 의존성 상태 (ComfyUI / Voicebox / ffmpeg / 모델)
app.get('/api/storybook/status', async (req, res) => {
  const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  const models = fs.existsSync(
    'C:/ComfyUI_windows_portable/ComfyUI/models/diffusion_models/krea2_turbo_fp8_scaled.safetensors',
  );
  res.json({
    comfy: await comfy.isAlive(),
    voicebox: await voicebox.isAlive(),
    ffmpeg,
    models,
  });
});

// Voicebox TTS 백엔드 기동
app.post('/api/voicebox/start', async (req, res) => {
  if (await voicebox.isAlive()) return res.json({ started: false, reason: 'already running' });
  spawn(
    'C:\\projects\\voicebox\\backend\\venv\\Scripts\\python.exe',
    ['-m', 'uvicorn', 'backend.main:app', '--port', '17493'],
    { cwd: 'C:\\projects\\voicebox', detached: true, stdio: 'ignore' },
  ).unref();
  res.json({ started: true });
});

app.listen(PORT, () => console.log(`comfy-testbench: http://localhost:${PORT}`));
