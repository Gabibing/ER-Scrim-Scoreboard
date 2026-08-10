import crypto from "crypto";
import { redis, boardKey } from "@/lib/redis";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* 일반 열람용: pinHash 제거 + 비공개 라운드의 gameId 제거 (서버 강제) */
const publicView = (board) => {
  const { pinHash, ...rest } = board;
  return {
    ...rest,
    rounds: (rest.rounds || []).map((r) => {
      if (r.gameIdPublic) return { ...r, gameIdPublic: true };
      const { gameId, ...safe } = r;
      return { ...safe, gameIdPublic: false };
    }),
  };
};

/* 관리자용: pinHash만 제거, gameId는 모두 포함 */
const adminView = (board) => {
  const { pinHash, ...rest } = board;
  return rest;
};

export async function GET(req, { params }) {
  const { slug } = await params;
  const board = await redis.get(boardKey(slug));
  if (!board) return Response.json({ error: "점수판을 찾을 수 없습니다." }, { status: 404 });
  return Response.json({ board: publicView(board) });
}

/* PIN 검증 → 성공 시 gameId 포함 전체 보드 반환 */
export async function POST(req, { params }) {
  const { slug } = await params;
  const board = await redis.get(boardKey(slug));
  if (!board) return Response.json({ error: "점수판을 찾을 수 없습니다." }, { status: 404 });
  const { pin } = await req.json().catch(() => ({}));
  if (sha(pin || "") !== board.pinHash)
    return Response.json({ error: "PIN이 일치하지 않습니다." }, { status: 401 });
  return Response.json({ ok: true, board: adminView(board) });
}

/* 전체 상태 저장 (관리자 전용) */
export async function PUT(req, { params }) {
  const { slug } = await params;
  const existing = await redis.get(boardKey(slug));
  if (!existing) return Response.json({ error: "점수판을 찾을 수 없습니다." }, { status: 404 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }
  if (sha(body.pin || "") !== existing.pinHash)
    return Response.json({ error: "PIN이 일치하지 않습니다." }, { status: 401 });

  const incoming = body.board || {};
  const incomingRounds = Array.isArray(incoming.rounds) ? incoming.rounds : existing.rounds;
  /* 클라이언트가 비공개 gameId를 못 받은 상태로 저장해도 서버 기록이 유실되지 않도록 병합 */
  const mergedRounds = incomingRounds.map((r) => {
    if (r.gameId) return r;
    const prev = (existing.rounds || []).find((x) => x.round === r.round);
    return prev?.gameId ? { ...r, gameId: prev.gameId } : r;
  });
  const clean = {
    title: typeof incoming.title === "string" && incoming.title.trim() ? incoming.title.trim() : existing.title,
    pinHash: existing.pinHash, // 클라이언트가 바꿀 수 없음
    createdAt: existing.createdAt,
    teams: Array.isArray(incoming.teams) ? incoming.teams : existing.teams,
    rounds: mergedRounds,
    penalties: Array.isArray(incoming.penalties) ? incoming.penalties : existing.penalties,
  };
  await redis.set(boardKey(slug), clean);
  return Response.json({ board: adminView(clean) });
}
