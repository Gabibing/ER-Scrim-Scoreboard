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
  if (!title || pin.length < 4) {
    return Response.json(
      { error: "스크림 이름과 4자리 이상 PIN이 필요합니다." },
      { status: 400 }
    );
  }
  const slug = crypto.randomBytes(8).toString("base64url"); // 추측 불가 URL
  const board = {
    title,
    pinHash: sha(pin),
    createdAt: Date.now(),
    teams: [],
    rounds: [],
    penalties: [],
  };
  await redis.set(boardKey(slug), board);
  return Response.json({ slug });
}
