/* 관전 화면 스크린샷에서 팀별 TS 점수를 추출 — 전부 브라우저(프론트엔드)에서 처리.
   서버로는 아무것도 전송하지 않고, 인식 결과만 관리자가 검토 후 반영한다.

   전략:
   - 왼쪽부터 1팀 → 8팀 순서로 가정하고 TS 숫자만 읽는다 (팀명·KS 무시).
   - 슬롯(팀 카드)별로 세로로 넉넉한 영역을 잘라 OCR — 관전 중 선택된 팀의
     카드가 위로 올라가 있어도 같은 영역 안에 들어오므로 위치를 따로 맞출 필요가 없다.
   - "TS" 글자를 앵커로 찾아 그 오른쪽 숫자를 읽는다. TS가 T5/75/15 등으로
     오인식되거나 숫자와 붙어버려도("TS6.0"→"156.0") KS 글자 바로 앞의 숫자를
     역추적하는 등 여러 규칙으로 복원한다. 소수점(N.N)도 그대로 처리.
   - 숫자 전용 화이트리스트 + 블록 모드(PSM 6)로 정확도를 높이고,
     기본 임계값에서 못 읽은 칸은 밝기 임계값을 바꿔 재시도한다. */

const TESSERACT_CDN =
  "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

/* 인게임 관전 UI(16:9) 기준 팀 카드 8칸의 상대 좌표 (화면 크기 대비 비율).
   x 실측(2560×1440, 제보 기반): 팀 카드 경계 10, 247, 486, 722, 958 …
   → 팀당 정확히 237px 등간격, 8팀 경계는 10 + 237×i (마지막 1906).
   세로 밴드는 넉넉하게 — 올라간(선택된) 카드와 기본 카드의 TS 줄을 모두 포함.
   (좁은 밴드는 글줄이 크롭 가장자리에 걸리면 인식률이 떨어져 넓은 쪽이 안정적) */
const GEO = {
  slots: 8,
  x0: 0.00391, // = 10/2560 (첫 카드 왼쪽)
  pitch: 0.09258, // = 237/2560 (카드 간격)
  w: 0.09258, // = 237/2560 (카드 폭 — 카드가 서로 붙어 있어 간격과 동일)
  y0: 0.695, // = 1000.8/1440, 실측 카드 상단(1000)과 일치
  h: 0.08, // 스캔 영역 높이 (기본 위치 TS 줄 + 이름 줄 일부 포함)
};

const SCALE = 5;
/* 실측 팔레트(제보 기반, 전부 무채색 R=G=B):
   - 점수판 배경 (46,46,46) / TS·KS 라벨 111~132 / 점수 숫자 194~255
   "bands" = 이 대역만 글자로 인정하는 정밀 마스크 (배경이 뭐든 무관)
   "auto"/숫자 = 기존 임계값 방식 (게임 패치로 색이 바뀔 때의 안전망) */
const BAND = { chromaMax: 30, digitMin: 175, labelMin: 100, labelMax: 145 };
const THRESHOLDS = ["bands", "auto", 140, 170, 110];

let tesseractPromise = null;
export function loadTesseract() {
  if (typeof window === "undefined") return Promise.reject(new Error("클라이언트 전용"));
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT_CDN;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => {
        tesseractPromise = null;
        reject(new Error("OCR 라이브러리를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요."));
      };
      document.head.appendChild(s);
    });
  }
  return tesseractPromise;
}

export function loadImageFromFile(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 열 수 없습니다."));
    };
    img.src = url;
  });
}

/* Otsu 이진화 임계값: 밝기 히스토그램에서 클래스 간 분산이 최대인 지점 */
function otsuThreshold(lums) {
  const hist = new Array(256).fill(0);
  for (const l of lums) hist[l | 0]++;
  const total = lums.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 140, maxVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) {
      maxVar = v;
      best = t;
    }
  }
  /* UI 글자는 밝은 편 — 지나치게 극단적인 값은 보정 */
  return Math.min(200, Math.max(90, best));
}

/* 슬롯 영역을 잘라 확대 + 흑백 반전(밝은 글자 → 어두운 글자).
   source: 이미지·비디오·캔버스 등 CanvasImageSource, srcW/srcH: 원본 픽셀 크기
   threshold: 숫자 또는 "auto"(Otsu 자동)

   TS/KS 글줄은 어두운 배경띠 없이 게임 화면 위에 바로 떠 있어서,
   밝은 수풀 등 밝은 배경에서는 밝기만으로 글자를 분리할 수 없다.
   글자는 흰색/회색(무채색)이고 수풀·팀 컬러는 유채색이므로
   "밝고 + 채도가 낮은" 픽셀만 글자로 인정한다. */
const CHROMA_MAX = 60;

function cropSource(source, srcW, srcH, fx, fy, fw, fh, threshold) {
  const sx = Math.round(srcW * fx);
  const sy = Math.round(srcH * fy);
  const sw = Math.max(1, Math.round(srcW * fw));
  const sh = Math.max(1, Math.round(srcH * fh));
  const bw = sw * SCALE;
  const bh = sh * SCALE;
  const c = document.createElement("canvas");
  c.width = bw;
  c.height = bh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, bw, bh);
  const data = ctx.getImageData(0, 0, bw, bh);
  const px = data.data;
  const n = px.length / 4;
  const lums = new Array(n);
  const chroma = new Array(n);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    lums[j] = 0.299 * r + 0.587 * g + 0.114 * b;
    chroma[j] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  let isTextAt;
  if (threshold === "bands") {
    /* 정밀 대역 마스크: 무채색이면서 숫자(≥175) 또는 라벨(100~145) 밝기 대역만 */
    isTextAt = (j) =>
      chroma[j] <= BAND.chromaMax &&
      (lums[j] >= BAND.digitMin ||
        (lums[j] >= BAND.labelMin && lums[j] <= BAND.labelMax));
  } else {
    let th = threshold;
    if (threshold === "auto") {
      /* 임계값 계산도 무채색 픽셀(글자·그림자·회색 배경)만으로 — 유채색 배경에 안 끌려감 */
      const low = [];
      for (let j = 0; j < n; j++) if (chroma[j] <= CHROMA_MAX) low.push(lums[j]);
      th = otsuThreshold(low.length > n * 0.02 ? low : lums);
    }
    isTextAt = (j) => lums[j] >= th && chroma[j] <= CHROMA_MAX;
  }
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = isTextAt(j) ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

/* 디버그용 축소 썸네일 (dataURL) */
function debugThumb(canvas) {
  try {
    const t = document.createElement("canvas");
    const w = 300;
    t.width = w;
    t.height = Math.max(1, Math.round((canvas.height / canvas.width) * w));
    t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
    return t.toDataURL("image/png");
  } catch {
    return null;
  }
}

/* 점수는 반드시 .0 또는 .5로 끝난다(0.5 단위) — 어중간한 값은 오인식이므로
   반올림하지 않고 거부해서 재시도(다른 임계값·다음 프레임)에 맡긴다. 범위 0~30. */
const plaus = (v) => {
  if (!isFinite(v) || v < 0 || v > 30) return null;
  return Math.abs(v * 2 - Math.round(v * 2)) < 1e-9 ? v : null;
};

/* 숫자 토큰 → 점수. 게임은 0을 제외하면 항상 소수점 한 자리("2.0")로 표시하므로:
   - 점 없는 10 이상 정수는 소수점 유실 → 10으로 나눔 ("20"→2.0, "165"→16.5)
   - 점 없는 0으로 시작하는 두 자리("05")는 "0.5"의 점 유실 → 0.5로 복원
   과소 판정이 나더라도 실시간 모드의 단조 증가 규칙이 낮은 값을 무시해 안전하다. */
const valOf = (str) => {
  const s = String(str);
  let v = parseFloat(s);
  if (!s.includes(".")) {
    if (/^0[0-9]$/.test(s)) v = v / 10; // "05" → 0.5
    else if (v >= 10) v = v / 10; // "20" → 2.0
  }
  return plaus(v);
};

/* 한 줄 텍스트에서 TS 값 추출 — TS 앵커 → KS 역추적 → 병합형 → 소수 2개 순.
   anchored: TS/KS 라벨을 실제로 보고 읽었는지 여부.
   라벨 없이 숫자만으로 읽은 값("12.5"의 1이 잘려 "2.5"가 되는 등)은
   형식이 유효해도 틀릴 수 있으므로, 호출부에서 다른 전처리 모드와 교차 검증한다. */
export function tsFromLineDetailed(raw) {
  let t = String(raw || "").replace(/[,]/g, ".").replace(/\s+/g, " ").trim();
  if (!t) return null;
  /* "0.5"의 앞자리 0이 유실된 ".5" 형태 복원 ("TS .5" → "TS 0.5") */
  t = t.replace(/(^|[^0-9])\.([0-9])/g, "$10.$2");
  /* 1) TS 라벨(T5/75 등 오인식 허용) + 구분자 + 숫자 (점 유실 "20"→2.0 복원 포함).
     구분자에 "."를 넣으면 ".5"의 점을 삼켜 5로 오독하므로 공백·콜론만 허용 */
  let m = t.match(/[T7][S5][\s:]+([0-9]{1,3}(?:\.[0-9])?)/);
  if (m) {
    const v = valOf(m[1]);
    if (v !== null) return { v, anchored: true };
  }
  /* 2) KS 라벨 바로 앞의 숫자 = TS 값 (라벨이 숫자와 붙어도 동작) */
  m = t.match(/([0-9]{1,2}\.[0-9])\s*K[S5]/);
  if (m) {
    const v = plaus(parseFloat(m[1]));
    if (v !== null) return { v, anchored: true };
  }
  m = t.match(/([0-9]\.[0-9])\s*K[S5]/);
  if (m) {
    const v = plaus(parseFloat(m[1]));
    if (v !== null) return { v, anchored: true };
  }
  /* 3) TS와 숫자가 한 덩어리로 붙은 경우 ("TS6.0"→"156.0", "TS12.5"→"712.5" 등).
     라벨이 두 글자("71")로 남은 해석과 한 글자("7")만 남은 해석이 모두 가능하므로
     둘 다 만들어 보고, 같은 줄의 KS 값과 모순되지 않는 쪽(TS ≥ KS)을 채택 */
  {
    const cands = [];
    m = t.match(/^[T71][S51][.:]*([0-9]{1,2}\.[0-9])(?:[^0-9]|$)/);
    if (m) {
      const v = plaus(parseFloat(m[1]));
      if (v !== null) cands.push(v);
    }
    m = t.match(/^[T7][.:]*([0-9]{1,2}\.[0-9])(?:[^0-9]|$)/);
    if (m) {
      const v = plaus(parseFloat(m[1]));
      if (v !== null && !cands.includes(v)) cands.push(v);
    }
    if (cands.length > 0) {
      const rest = t.replace(/^[^\s]+/, ""); // 병합 토큰 이후 (KS 쪽)
      const nums = [...rest.matchAll(/([0-9]{1,2}\.[0-9])/g)]
        .map((x) => plaus(parseFloat(x[1])))
        .filter((v) => v !== null);
      const ks = nums.length > 0 ? nums[nums.length - 1] : null;
      const ok = ks !== null ? cands.filter((v) => v >= ks) : cands;
      return { v: (ok.length > 0 ? ok : cands)[0], anchored: true };
    }
  }
  /* 4) 같은 줄에 그럴듯한 소수가 2개 이상(TS KS) → 첫 번째 */
  const all = [...t.matchAll(/([0-9]{1,2}\.[0-9])/g)]
    .map((x) => plaus(parseFloat(x[1])))
    .filter((v) => v !== null);
  if (all.length >= 2) return { v: all[0], anchored: false };
  /* 5) 라벨을 전부 잃고 숫자 2개만 남은 줄 ("0 0", "20 20" 등) — 줄 전체가 숫자 2개일 때만 */
  m = t.match(/^([0-9]{1,3}(?:\.[0-9])?)\s+([0-9]{1,3}(?:\.[0-9])?)$/);
  if (m) {
    const v = valOf(m[1]);
    if (v !== null) return { v, anchored: false };
  }
  return null;
}

/* 하위 호환: 값만 필요한 곳(테스트 등)용 */
export function tsFromLine(raw) {
  const r = tsFromLineDetailed(raw);
  return r ? r.v : null;
}

/* 텍스트 전체에서 첫 유효 값 추출 — 앵커된 줄 우선 */
function extractDetailed(text) {
  let fallback = null;
  for (const line of String(text || "").split("\n")) {
    const r = tsFromLineDetailed(line);
    if (!r) continue;
    if (r.anchored) return r;
    if (!fallback) fallback = r;
  }
  return fallback;
}

function extractFromText(text) {
  const r = extractDetailed(text);
  return r ? r.v : null;
}

/* 메인: 스크린샷 → 슬롯 8개의 { slot, name:"", score } (왼쪽부터 1팀~8팀) */
export async function ocrScoreboard(fileOrBlob, onProgress) {
  const T = await loadTesseract();
  onProgress?.("이미지 여는 중…");
  const { img, url } = await loadImageFromFile(fileOrBlob);
  try {
    const ratio = img.naturalWidth / img.naturalHeight;
    if (ratio < 1.6 || ratio > 1.95)
      throw new Error(
        "16:9 비율의 전체 화면 스크린샷이 필요합니다. (관전 화면을 잘라내지 말고 그대로 캡처해 주세요)"
      );
    onProgress?.("OCR 엔진 준비 중… (최초 1회는 데이터를 내려받아 수십 초 걸릴 수 있어요)");
    const worker = await T.createWorker("eng");
    await worker.setParameters({
      tessedit_char_whitelist: "TSK0123456789. ",
      tessedit_pageseg_mode: "6", // 텍스트 블록 (TS 줄 + 이름 줄)
      user_defined_dpi: "300",
    });
    try {
      const scores = new Array(GEO.slots).fill(null);
      const debug = Array.from({ length: GEO.slots }, () => ({ raw: "", crop: null }));
      for (let i = 0; i < GEO.slots; i++) {
        onProgress?.(`TS 점수 인식 중… (${i + 1}/${GEO.slots})`);
        const x = GEO.x0 + i * GEO.pitch;
        /* 모드별로 읽으며: TS/KS 라벨을 보고 읽은(anchored) 값은 즉시 신뢰,
           라벨 없이 숫자만으로 읽은 값은 다른 모드가 같은 값을 주거나
           anchored 값이 나올 때까지 교차 검증 (숫자 일부가 잘린 오독 방지) */
        let candidate = null;
        for (const mode of THRESHOLDS) {
          const canvas = cropSource(
            img, img.naturalWidth, img.naturalHeight,
            x, GEO.y0, GEO.w, GEO.h, mode
          );
          const { data } = await worker.recognize(canvas);
          const text = data.text;
          const r = extractDetailed(text);
          debug[i] = {
            raw: String(text || "").trim(),
            crop: debugThumb(canvas),
            threshold: String(mode),
          };
          if (!r) continue;
          if (r.anchored) {
            scores[i] = r.v;
            break;
          }
          if (candidate === null) candidate = r.v;
          else if (candidate === r.v) {
            scores[i] = r.v; // 서로 다른 전처리에서 같은 값 → 확정
            break;
          }
        }
        if (scores[i] === null && candidate !== null) scores[i] = candidate;
      }
      return scores.map((score, i) => ({
        slot: i + 1,
        name: "",
        score,
        debug: debug[i],
      }));
    } finally {
      await worker.terminate();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ── 실시간 화면 인식 (getDisplayMedia 캡처용) ── */

/* 재사용 가능한 OCR 워커 생성 — 실시간 모드에서는 워커를 유지한 채 프레임마다 재사용 */
export async function createTsWorker() {
  const T = await loadTesseract();
  const worker = await T.createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "TSK0123456789. ",
    tessedit_pageseg_mode: "6",
    user_defined_dpi: "300",
  });
  return worker;
}

/* 비디오/캔버스 프레임에서 8칸 TS를 한 번 읽는다.
   - 대역 마스크와 자동 임계값 두 전처리로 교차 확인, 불일치 시 세 번째로 다수결
     (한 전처리가 지속적으로 오독하는 6.5↔8.5류 문제 대응)
   - expected[i]와 같은 값이 나오면 재확인을 생략해 평상시 비용을 줄인다
   - only: 지정하면 해당 칸 인덱스만 읽음 (2차 프레임 검증용)
   반환: [score|null] × 8 — 슬롯별로 독립적이라 한 칸의 실패가 다른 칸에 영향 없음. */
export async function readFrameScores(worker, source, srcW, srcH, expected = [], only = null) {
  const scores = [];
  for (let i = 0; i < GEO.slots; i++) {
    if (only && !only.includes(i)) {
      scores.push(null);
      continue;
    }
    const x = GEO.x0 + i * GEO.pitch;
    const read = async (mode) => {
      const canvas = cropSource(source, srcW, srcH, x, GEO.y0, GEO.w, GEO.h, mode);
      const { data } = await worker.recognize(canvas);
      const r = extractDetailed(data.text);
      return r ? r.v : null;
    };
    /* 1차: 정밀 대역 마스크 */
    const v1 = await read("bands");
    /* 현재 점수와 같으면 재확인 생략 — 대부분의 틱에서 비용 절약 */
    if (v1 !== null && v1 === expected[i]) {
      scores.push(v1);
      continue;
    }
    /* 2차: 자동 임계값으로 교차 확인 */
    const v2 = await read("auto");
    if (v1 === null) {
      scores.push(v2); // bands 실패 → auto 단독 (프레임 간 투표가 걸러줌)
      continue;
    }
    if (v2 === null || v1 === v2) {
      scores.push(v1);
      continue;
    }
    /* 두 모드가 다르게 읽음 (6.5 vs 8.5 등) → 세 번째 전처리로 다수결 */
    const v3 = await read(140);
    scores.push(v3 === v1 ? v1 : v3 === v2 ? v2 : null);
  }
  return scores;
}

export const FRAME_RATIO_OK = (w, h) => {
  const r = w / h;
  return r >= 1.6 && r <= 1.95;
};
