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

/* 인게임 관전 UI(16:9) 기준 팀 카드 8칸의 상대 좌표 (화면 크기 대비 비율) */
const GEO = {
  slots: 8,
  x0: 0.005, // 첫 카드 왼쪽
  pitch: 0.0932, // 카드 간격
  w: 0.0925, // 카드 폭
  y0: 0.695, // 스캔 영역 위 (올라간 카드의 TS 줄 포함)
  h: 0.08, // 스캔 영역 높이 (기본 위치 TS 줄 + 이름 줄 일부 포함)
};

const SCALE = 5;
const THRESHOLDS = [140, 170, 110]; // 기본 → 밝게 → 어둡게 재시도

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

/* 슬롯 영역을 잘라 확대 + 흑백 반전(밝은 글자 → 어두운 글자) */
function cropForOcr(img, fx, fy, fw, fh, threshold) {
  const sx = Math.round(img.naturalWidth * fx);
  const sy = Math.round(img.naturalHeight * fy);
  const sw = Math.max(1, Math.round(img.naturalWidth * fw));
  const sh = Math.max(1, Math.round(img.naturalHeight * fh));
  const c = document.createElement("canvas");
  c.width = sw * SCALE;
  c.height = sh * SCALE;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const v = lum >= threshold ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

/* 점수는 0.5 단위, 현실적인 범위(0~30)만 인정 */
const plaus = (v) => (isFinite(v) && v >= 0 && v <= 30 ? Math.round(v * 2) / 2 : null);

/* 한 줄 텍스트에서 TS 값 추출 — TS 앵커 → KS 역추적 → 병합형 → 소수 2개 순 */
export function tsFromLine(raw) {
  const t = String(raw || "").replace(/[,]/g, ".").replace(/\s+/g, " ").trim();
  if (!t) return null;
  /* 1) TS 라벨(T5/75 등 오인식 허용) + 구분자 + 숫자 */
  let m = t.match(/[T7][S5][\s.:]+([0-9]{1,2}(?:\.[0-9])?)/);
  if (m) {
    const v = plaus(parseFloat(m[1]));
    if (v !== null) return v;
  }
  /* 2) KS 라벨 바로 앞의 숫자 = TS 값 (라벨이 숫자와 붙어도 동작) */
  m = t.match(/([0-9]{1,2}\.[0-9])\s*K[S5]/);
  if (m) {
    const v = plaus(parseFloat(m[1]));
    if (v !== null) return v;
  }
  m = t.match(/([0-9]\.[0-9])\s*K[S5]/);
  if (m) {
    const v = plaus(parseFloat(m[1]));
    if (v !== null) return v;
  }
  /* 3) TS와 숫자가 한 덩어리로 붙은 경우 ("TS6.0"→"156.0" 등) */
  m =
    t.match(/^[T71][S51][.:]*([0-9]\.[0-9])(?:[^0-9]|$)/) ||
    t.match(/^[T71][S51][.:]*([0-9]{2}\.[0-9])(?:[^0-9]|$)/);
  if (m) {
    const v = plaus(parseFloat(m[1]));
    if (v !== null) return v;
  }
  /* 4) 같은 줄에 그럴듯한 소수가 2개 이상(TS KS) → 첫 번째 */
  const all = [...t.matchAll(/([0-9]{1,2}\.[0-9])/g)]
    .map((x) => plaus(parseFloat(x[1])))
    .filter((v) => v !== null);
  if (all.length >= 2) return all[0];
  return null;
}

function extractFromText(text) {
  for (const line of String(text || "").split("\n")) {
    const v = tsFromLine(line);
    if (v !== null) return v;
  }
  return null;
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
      for (let pass = 0; pass < THRESHOLDS.length; pass++) {
        const remaining = scores
          .map((v, i) => (v === null ? i : -1))
          .filter((i) => i !== -1);
        if (remaining.length === 0) break;
        /* 첫 패스가 대부분 성공했다면 남은 칸(TS 미표시 등)만 가볍게 재시도 */
        if (pass > 0 && remaining.length <= 1) break;
        for (const i of remaining) {
          onProgress?.(
            pass === 0
              ? `TS 점수 인식 중… (${i + 1}/${GEO.slots})`
              : `다른 밝기로 재시도 중… (${i + 1}/${GEO.slots})`
          );
          const x = GEO.x0 + i * GEO.pitch;
          const canvas = cropForOcr(img, x, GEO.y0, GEO.w, GEO.h, THRESHOLDS[pass]);
          const { data } = await worker.recognize(canvas);
          scores[i] = extractFromText(data.text);
        }
      }
      return scores.map((score, i) => ({ slot: i + 1, name: "", score }));
    } finally {
      await worker.terminate();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}
