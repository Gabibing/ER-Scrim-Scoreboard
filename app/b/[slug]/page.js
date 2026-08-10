import { redis, boardKey } from "@/lib/redis";
import { computeStandings, medalFor } from "@/lib/score";
import BoardClient from "./board-client";

export const dynamic = "force-dynamic"; // 항상 최신 순위로 OG 생성

export async function generateMetadata({ params }) {
  const { slug } = await params;
  let board = null;
  try {
    board = await redis.get(boardKey(slug));
  } catch {}
  if (!board) return { title: "스크림 점수판" };

  const standings = computeStandings(board);
  const top = standings.slice(0, 5);
  const desc =
    top.length === 0
      ? "아직 집계된 라운드가 없습니다."
      : `${board.rounds.length}라운드 기준 · ` +
        top.map((s, i) => `${medalFor(i)} ${s.team.name} ${s.total}점`).join("  ");

  const title = `🏆 ${board.title}`;
  return {
    title,
    description: desc,
    openGraph: { title, description: desc, type: "website" },
    twitter: { card: "summary", title, description: desc },
    robots: { index: false, follow: false },
  };
}

export default async function BoardPage({ params }) {
  const { slug } = await params;
  return <BoardClient slug={slug} />;
}
