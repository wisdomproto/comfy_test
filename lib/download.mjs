// HuggingFace 모델 다운로드 유틸 (resolve URL 생성 + 스트리밍 다운로드)
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const hfResolveUrl = (repo, filePath) =>
  `https://huggingface.co/${repo}/resolve/main/${filePath.split('/').map(encodeURIComponent).join('/')}`;

export async function downloadTo(url, destPath, { minBytes = 0 } = {}) {
  // 이미 받아둔 파일은 스킵(크기 기준이 있으면 그 이상일 때만). minBytes=0이면 존재만으로 스킵.
  if (fs.existsSync(destPath) && fs.statSync(destPath).size >= minBytes) {
    return { skipped: true, destPath };
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);
  const tmp = `${destPath}.part`;
  await pipeline(res.body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, destPath);
  return { skipped: false, destPath };
}
