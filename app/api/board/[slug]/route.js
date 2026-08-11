import crypto from "crypto";
import { redis, boardKey } from "@/lib/redis";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* 실시간 입력 상태 정리(서버 강제): 숫자만 허용 */
const cleanLive = (live, teams) => {
  if (!live || typeof live !== "object") return null;
  const round = parseInt(live.round, 10);
  if (!round || round < 1 || round > 99) return null;
  const teamIds = new Set((teams || []).map((t) => t.id));
  const byTeam = new Map();
  for (const e of Array.isArray(live.entries) ? live.entries : []) {
    if (!e || !teamIds.has(e.teamId)) continue;
    const score = e.score === "" || e.score === null ? null : parseFloat(e.score);
    byTeam.set(e.teamId, {
      teamId: e.teamId,
      score: score !== null && isFinite(score) ? score : null,
      out: !!e.out, // 라운드 탈락(Terminate)
    });
  }
  return { round, entries: [...byTeam.values()], updatedAt: Date.now() };
};

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
  /* Vercel CDN 캐시: 같은 1초 안에 몰리는 폴링(시청자·OBS 다수)만 엣지 캐시가 흡수.
     stale-while-revalidate는 오래된 응답을 먼저 반환해 체감 지연이 커지므로 쓰지 않는다 —
     캐시 만료 후 첫 요청은 항상 최신 데이터를 받아 신선도 지연이 최대 1초로 고정된다. */
  return Response.json(
    { board: publicView(board) },
    {
      headers: {
        "Cache-Control": "public, s-maxage=1",
      },
    }
  );
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
  const mode = existing.mode === "tourney" ? "tourney" : "scrim"; // 클라이언트가 바꿀 수 없음
  const teams = Array.isArray(incoming.teams) ? incoming.teams : existing.teams;
  if (mode === "tourney" && teams.length > 8)
    return Response.json({ error: "대회 점수판은 최대 8팀까지 등록할 수 있습니다." }, { status: 400 });
  const clean = {
    title: typeof incoming.title === "string" && incoming.title.trim() ? incoming.title.trim() : existing.title,
    mode,
    pinHash: existing.pinHash, // 클라이언트가 바꿀 수 없음
    createdAt: existing.createdAt,
    teams,
    rounds: mergedRounds,
    penalties: Array.isArray(incoming.penalties) ? incoming.penalties : existing.penalties,
    /* 실시간 점수는 대회 모드 전용 */
    live:
      mode !== "tourney"
        ? null
        : "live" in incoming
        ? cleanLive(incoming.live, teams)
        : (existing.live ?? null),
  };
  await redis.set(boardKey(slug), clean);
  return Response.json({ board: adminView(clean) });
}
