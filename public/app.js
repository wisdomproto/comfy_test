const $ = (sel) => document.querySelector(sel);
const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let statusInfo = { alive: false, loras: [], loraTriggers: {} };
let runs = [];
let selectedSourceRunId = null;
let uploadedName = null;
const watching = new Set();

// ---- 상태 ----
async function refreshStatus() {
  try { statusInfo = await api('/api/status'); } catch { statusInfo.alive = false; }
  const el = $('#comfy-status');
  el.classList.toggle('online', statusInfo.alive);
  el.classList.toggle('offline', !statusInfo.alive);
  $('#status-text').textContent = statusInfo.alive ? 'ComfyUI 연결됨' : 'ComfyUI 꺼짐';
  $('#btn-start-comfy').hidden = statusInfo.alive;
  document.querySelectorAll('button.primary').forEach((b) => (b.disabled = !statusInfo.alive));
  renderLoraOptions();
}

function renderLoraOptions() {
  const sel = document.querySelector('#form-image select[name=lora]');
  if (sel.dataset.filled || !statusInfo.loras.length) return;
  for (const name of statusInfo.loras) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name.replace('.safetensors', '');
    sel.appendChild(opt);
  }
  sel.dataset.filled = '1';
}

$('#btn-start-comfy').addEventListener('click', async () => {
  await api('/api/comfy/start', { method: 'POST' });
  $('#status-text').textContent = 'ComfyUI 시작 중… (~60초)';
});

// LoRA 선택 시 트리거 단어 힌트
document.querySelector('#form-image select[name=lora]').addEventListener('change', (e) => {
  const trigger = statusInfo.loraTriggers[e.target.value];
  const hint = $('#lora-hint');
  hint.hidden = !trigger;
  if (trigger) hint.textContent = `💡 트리거 단어를 프롬프트에 포함하세요: "${trigger}"`;
});

// ---- 탭 ----
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'history') loadRuns();
    if (btn.dataset.tab === 'video') renderVideoSourceGrid();
  });
});

// ---- 잡 추적 ----
function watchJob(jobId) {
  if (watching.has(jobId)) return;
  watching.add(jobId);
  const bar = document.createElement('div');
  bar.className = 'job-bar';
  bar.id = `job-${jobId}`;
  $('#active-jobs').appendChild(bar);
  const timer = setInterval(async () => {
    let job;
    try {
      job = await api(`/api/jobs/${jobId}`);
    } catch (err) {
      // 서버 재시작 등으로 잡이 사라지면(404) 폴링 중단
      if (String(err.message).includes('not found')) {
        clearInterval(timer);
        watching.delete(jobId);
        bar.remove();
      }
      return;
    }
    bar.innerHTML = `<div>${job.type === 'video' ? '🎬 영상' : '🖼 이미지'} 생성 중 — ${job.status} ${job.progress}%</div><progress max="100" value="${job.progress}"></progress>`;
    if (job.status === 'done' || job.status === 'error') {
      clearInterval(timer);
      watching.delete(jobId);
      bar.remove();
      showResult(job);
      loadRuns();
    }
  }, 2000);
}

function showResult(job) {
  const target = $(job.type === 'video' ? '#video-result' : '#image-result');
  if (job.status === 'error') {
    target.innerHTML = `<div class="error">실패: ${esc(job.error)}</div>`;
  } else if (job.type === 'video') {
    target.innerHTML = `<video src="/${job.outputFile}" controls autoplay loop></video>`;
  } else {
    target.innerHTML = `<img src="/${job.outputFile}" alt="result">`;
  }
}

// 새로고침 후에도 진행 중 잡 재발견 (스펙)
async function rediscoverJobs() {
  try { (await api('/api/jobs')).forEach((j) => watchJob(j.id)); } catch { /* 서버 미기동 */ }
}

// ---- 이미지 생성 ----
$('#form-image').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const [width, height] = f.get('size').split('x').map(Number);
  const body = {
    prompt: f.get('prompt'), negative: f.get('negative') ?? '',
    lora: f.get('lora') || null, loraStrength: Number(f.get('loraStrength')),
    width, height, steps: Number(f.get('steps')), guidance: Number(f.get('guidance')),
    seed: f.get('randomSeed') ? null : Number(f.get('seed')),
  };
  try {
    const { jobId } = await api('/api/generate/image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    $('#image-result').innerHTML = '';
    watchJob(jobId);
  } catch (err) { $('#image-result').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
});

// ---- 영상 생성 ----
function renderVideoSourceGrid() {
  const grid = $('#video-source-history');
  const imageRuns = runs.filter((r) => r.type === 'image' && r.status === 'done');
  grid.innerHTML = imageRuns.length ? '' : '<p class="hint">완성된 이미지가 아직 없습니다</p>';
  for (const run of imageRuns) {
    const img = document.createElement('img');
    img.src = `/${run.outputFile}`;
    img.classList.toggle('selected', run.id === selectedSourceRunId);
    img.addEventListener('click', () => selectVideoSource(run.id));
    grid.appendChild(img);
  }
}

function selectVideoSource(runId) {
  selectedSourceRunId = runId;
  uploadedName = null;
  document.querySelector('#form-video input[value=history]').checked = true;
  $('#video-source-selected').textContent = `선택됨: 히스토리 이미지 ${runId.slice(0, 8)}`;
  renderVideoSourceGrid();
}

document.querySelectorAll('#form-video input[name=sourceType]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    // 소스 방식 전환 시 이전 선택 초기화 (stale 업로드로 제출 방지)
    uploadedName = null;
    selectedSourceRunId = null;
    $('#video-source-selected').textContent = '선택된 소스 없음';
    renderVideoSourceGrid();
    if (radio.value === 'upload') $('#video-source-file').click();
  });
});

$('#video-source-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const { uploadName } = await api('/api/upload', { method: 'POST', body: fd });
    uploadedName = uploadName;
    selectedSourceRunId = null;
    $('#video-source-selected').textContent = `선택됨: 업로드 파일 ${file.name}`;
  } catch (err) {
    $('#video-source-selected').textContent = `업로드 실패: ${err.message}`;
  }
});

$('#form-video').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedSourceRunId && !uploadedName) {
    $('#video-result').innerHTML = '<div class="error">소스 이미지를 선택하세요</div>';
    return;
  }
  const f = new FormData(e.target);
  const body = {
    sourceRunId: selectedSourceRunId, uploadName: uploadedName,
    motionPrompt: f.get('motionPrompt'),
    frames: Number(f.get('frames')), steps: Number(f.get('steps')),
    seed: f.get('randomSeed') ? null : Number(f.get('seed')),
  };
  try {
    const { jobId } = await api('/api/generate/video', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    $('#video-result').innerHTML = '';
    watchJob(jobId);
  } catch (err) { $('#video-result').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
});

// ---- 히스토리 ----
async function loadRuns() {
  runs = await api('/api/runs');
  const grid = $('#history-grid');
  grid.innerHTML = runs.length ? '' : '<p class="hint">아직 생성 기록이 없습니다</p>';
  for (const run of runs) grid.appendChild(renderCard(run));
}

function renderCard(run) {
  const card = document.createElement('div');
  card.className = 'card';
  const media = run.status !== 'done' ? ''
    : run.type === 'video'
      ? `<video src="/${run.outputFile}" muted loop onmouseover="this.play()" onmouseout="this.pause()"></video>`
      : `<img src="/${run.outputFile}" loading="lazy">`;
  const prompt = run.params.prompt ?? run.params.motionPrompt ?? '';
  card.innerHTML = `
    ${media}
    <div class="meta">
      <span class="badge ${run.type}">${run.type}</span>
      ${run.status === 'error' ? '<span class="badge error">실패</span>' : ''}
      <span>${new Date(run.createdAt).toLocaleString('ko-KR')} · ${run.durationSec}s</span>
      <p class="prompt">${esc(prompt)}</p>
      <details><summary>파라미터</summary><pre>${esc(JSON.stringify(run.params, null, 2))}${run.error ? `\n\nERROR: ${esc(run.error)}` : ''}</pre></details>
      <div class="actions"></div>
    </div>`;
  const actions = card.querySelector('.actions');
  if (run.type === 'image') {
    const btnRedo = document.createElement('button');
    btnRedo.textContent = '같은 설정으로 재생성';
    btnRedo.addEventListener('click', () => restoreImageParams(run.params));
    actions.appendChild(btnRedo);
    if (run.status === 'done') {
      const btnVideo = document.createElement('button');
      btnVideo.textContent = '이 이미지로 영상 만들기';
      btnVideo.addEventListener('click', () => {
        selectVideoSource(run.id);
        document.querySelector('[data-tab=video]').click();
        selectVideoSource(run.id); // 탭 전환 후 그리드 다시 그려지므로 재적용
      });
      actions.appendChild(btnVideo);
    }
  }
  return card;
}

function restoreImageParams(p) {
  const form = $('#form-image');
  form.prompt.value = p.prompt;
  form.negative.value = p.negative ?? '';
  form.lora.value = p.lora ?? '';
  form.lora.dispatchEvent(new Event('change'));
  form.loraStrength.value = p.loraStrength ?? 1.0;
  form.size.value = `${p.width}x${p.height}`;
  form.steps.value = p.steps;
  form.guidance.value = p.guidance;
  form.seed.value = p.seed;
  form.randomSeed.checked = false; // 확정 seed로 재현
  document.querySelector('[data-tab=image]').click();
}

// ---- init ----
refreshStatus();
setInterval(refreshStatus, 10000);
loadRuns();
rediscoverJobs();
