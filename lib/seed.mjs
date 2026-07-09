import crypto from 'node:crypto';

// 랜덤 seed는 제출 전에 확정 — 재현성 보장. crypto.randomInt는 max-min ≤ 2^48-1 제약.
export const resolveSeed = (seed) => (Number.isInteger(seed) ? seed : crypto.randomInt(0, 2 ** 48 - 1));
