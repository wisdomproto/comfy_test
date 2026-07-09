// 페이지별 파이프라인(runPage)과 책 전체 루프(runBook) 오케스트레이션.
// 모든 side-effect는 deps로 주입받아 순수 로직만 여기 남긴다(단위 테스트 가능).
// deps = { generateIllustration, generateVideo, generateNarration,
//          composeClip, concatClips, uploadInput, freeMemory }
import path from 'node:path';

// 페이지 한 장 처리: 일러스트 → 영상 → VRAM 해제 → 나레이션 → 합성.
export async function runPage(page, ctx, deps) {
  page.status = 'running';
  const bookDir = ctx?.bookDir ?? '.';

  // 1) 일러스트: 생성 or 업로드본 사용.
  let illustration = null;
  if (page.illustrationSource === 'generate') {
    illustration = await deps.generateIllustration(page, ctx);
    page.illustrationFile = illustration;
  } else if (page.illustrationSource === 'upload') {
    illustration = page.illustrationFile ?? null;
  }

  // 2) 영상: 생성 시 일러스트가 반드시 있어야 하고, ComfyUI input으로 에셋을 hop 후 생성.
  let video = null;
  if (page.videoSource === 'generate') {
    if (!illustration) {
      throw new Error(`runPage(${page.id}): illustration required to generate video`);
    }
    // 캐릭터 레퍼런스 hop(설정된 경우).
    if (ctx?.characterRef) {
      deps.uploadInput(ctx.characterRef, `${page.id}_ref.png`);
    }
    // 일러스트 이미지 hop → LoadImage용 input 이름.
    const illustrationInputName = deps.uploadInput(illustration, `${page.id}_illu.png`);
    video = await deps.generateVideo(page, ctx, illustrationInputName);
    page.videoFile = video;
  } else if (page.videoSource === 'upload') {
    video = page.videoFile ?? null;
  }

  // 3) VRAM 해제: ComfyUI 단계(일러스트/영상)와 나레이션 사이에서 항상 호출.
  await deps.freeMemory();

  // 4) 나레이션: 생성 / 업로드 / 없음.
  let audio = null;
  if (page.audioSource === 'generate') {
    audio = await deps.generateNarration(page, ctx);
    page.audioFile = audio;
  } else if (page.audioSource === 'upload') {
    audio = page.audioFile ?? null;
  } else {
    audio = null; // 'none'
  }

  // 5) 합성: 오디오 없으면 audio=null.
  const dest = path.join(bookDir, `${page.id}.mp4`);
  const clip = await deps.composeClip({ video, audio, dest });
  page.clipFile = clip;

  page.status = 'done';
  return page;
}

// 책 전체: 페이지를 순차 처리하고 페이지별 에러를 격리. 전부 성공 시에만 최종 concat.
export async function runBook(book, opts, deps) {
  const ctx = opts?.ctx ?? { characterRef: book.characterRef ?? null, bookDir: book.dir ?? '.' };
  const persist = () => opts?.persist?.(book);

  for (const page of book.pages) {
    try {
      await runPage(page, ctx, deps);
    } catch (err) {
      page.status = 'error';
      page.error = String(err?.message ?? err);
    }
    persist(); // 페이지 상태 변화마다 진행 상황 기록.
  }

  const allDone = book.pages.every((p) => p.status === 'done');
  if (allDone) {
    const clipPaths = book.pages.map((p) => p.clipFile);
    const finalDest = opts?.finalDest ?? path.join(ctx.bookDir ?? '.', 'final.mp4');
    await deps.concatClips(clipPaths, finalDest);
    book.status = 'done';
  } else {
    book.status = 'error';
  }
  persist();
  return book;
}
