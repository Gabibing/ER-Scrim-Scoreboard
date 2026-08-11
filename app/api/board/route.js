import crypto from "crypto";
import { redis, boardKey } from "@/lib/redis";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }
  const title = (body.title || "").trim();
  const pin = String(body.pin || "");
  /* scrim: CSV 업로드 중심의 가벼운 점수판 (기존 기능)
     tourney: 실시간 점수·스크린샷 인식·OBS 오버레이·결과 그래픽 포함 */
  const mode = body.mode === "tourney" ? "tourney" : "scrim";
  if (!title || pin.length < 4) {
    return Response.json(
      { error: "이름과 4자리 이상 PIN이 필요합니다." },
      { status: 400 }
    );
  }
  const slug = crypto.randomBytes(8).toString("base64url"); // 추측 불가 URL
  const board = {
    title,
    mode,
    pinHash: sha(pin),
    createdAt: Date.now(),
    /* 대회는 8팀 고정 — Team 1~8을 미리 만들어 두고 이름만 바꿔 쓴다 */
    teams:
      mode === "tourney"
        ? Array.from({ length: 8 }, (_, i) => ({
            id: crypto.randomBytes(4).toString("hex"),
            name: `Team ${i + 1}`,
            nicknames: [],
          }))
        : [],
    rounds: [],
    penalties: [],
    live: null,
  };
  await redis.set(boardKey(slug), board);
  return Response.json({ slug });
}
