"use client";

/* OBS 브라우저 소스용 오버레이.
   - 배경 투명 (OBS에서 그대로 얹으면 됨)
   - 기본 5초마다 자동 갱신 (?poll= 로 1~30초 조절 가능), 진행 중(live) 점수 포함
   - 순위가 바뀌면 행이 부드럽게 자리를 바꾸는 애니메이션 + ▲▼ 표시
   - 라운드 탈락(Terminate) 팀은 음영 처리
   - URL 옵션: ?rows=8 (표시 팀 수) &scale=1.2 (배율) &title=0 (ROUND 표시줄 숨김) &rounds=1 (라운드별 점수 표시) &poll=5 (갱신 주기 초)
   권장 소스 크기: 320 × 400 (8팀, scale 1 기준 실측 304×378 + 여백.
   ?rounds=1이면 라운드당 +30px 폭, scale 값에 비례해 확대) */

import { useState, useEffect, useRef } from "react";
import { computeStandings, withLive } from "@/lib/score";

const ROW_H = 38;

export default function ObsClient({ slug }) {
  const [board, setBoard] = useState(null);
  const [opts, setOpts] = useState({
    rows: 99,
    scale: 1,
    title: true,
    rounds: false,
    poll: 5,
  });
  const [moves, setMoves] = useState({}); // teamId -> "up" | "down"
  const [flashes, setFlashes] = useState({}); // teamId -> true (점수 변동)
  const prevRanks = useRef(new Map());
  const prevTotals = useRef(new Map());
  const clearTimer = useRef(null);

  useEffect(() => {
    let pollSec = 5;
    try {
      const q = new URLSearchParams(window.location.search);
      pollSec = Math.min(30, Math.max(1, parseFloat(q.get("poll")) || 5));
      setOpts({
        rows: parseInt(q.get("rows"), 10) || 99,
        scale: parseFloat(q.get("scale")) || 1,
        title: q.get("title") !== "0",
        rounds: q.get("rounds") === "1",
        poll: pollSec,
      });
    } catch {}
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/board/${slug}`, { cache: "no-store" });
        if (res.ok && alive) setBoard((await res.json()).board);
      } catch {}
    };
    load();
    const iv = setInterval(load, pollSec * 1000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [slug]);

  const isTourney = board?.mode === "tourney";
  const view = board && isTourney ? withLive(board) : null;
  const standings = view ? computeStandings(view).slice(0, opts.rows) : [];
  const rounds = view?.rounds || [];
  const liveActive = !!board?.live;

  /* 순위·점수 변동 감지 → ▲▼ 표시와 하이라이트 (몇 초 후 사라짐)
     주의: 훅 순서 유지를 위해 조기 return보다 앞에 있어야 함 */
  useEffect(() => {
    if (!board || board.mode !== "tourney") return;
    const st = computeStandings(withLive(board)).slice(0, opts.rows);
    const newMoves = {};
    const newFlashes = {};
    st.forEach((s, i) => {
      const pr = prevRanks.current.get(s.team.id);
      if (pr !== undefined && pr !== i) newMoves[s.team.id] = pr > i ? "up" : "down";
      const pt = prevTotals.current.get(s.team.id);
      if (pt !== undefined && pt !== s.total) newFlashes[s.team.id] = true;
    });
    prevRanks.current = new Map(st.map((s, i) => [s.team.id, i]));
    prevTotals.current = new Map(st.map((s) => [s.team.id, s.total]));
    if (Object.keys(newMoves).length || Object.keys(newFlashes).length) {
      setMoves(newMoves);
      setFlashes(newFlashes);
      clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => {
        setMoves({});
        setFlashes({});
      }, 4000);
    }
  }, [board, opts.rows]);

  /* DOM 순서를 팀 기준으로 고정하고 top 좌표만 바꿔서
     행 이동이 CSS 트랜지션으로 부드럽게 보이게 한다 */
  const liveRound = rounds.find((r) => r.isLive);
  const stableRows = [...standings]
    .map((s) => ({
      s,
      rank: standings.indexOf(s),
      dead: !!liveRound?.results.find((x) => x.teamId === s.team.id)?.out,
    }))
    .sort((a, b) => (a.s.team.id < b.s.team.id ? -1 : 1));

  if (board && !isTourney)
    return (
      <div className="obsRoot">
        <div className="obsPanel">
          <div className="obsEmpty">OBS 오버레이는 대회 점수판 전용 기능입니다.</div>
        </div>
      </div>
    );

  return (
    <div className="obsRoot" style={{ transform: `scale(${opts.scale})` }}>
      <style>{`
        html, body { background: transparent !important; }
      `}</style>
      {view && (
        <div
          className="obsPanel"
          style={{ minWidth: 280 + (opts.rounds ? rounds.length * 30 : 0) }}
        >
          {opts.title && (
            <div className="obsHeader">
              <span className="obsRoundInfo">
                {rounds.length > 0 ? `ROUND ${rounds.length}` : "READY"}
                {liveActive && <span className="obsLive">● LIVE</span>}
              </span>
            </div>
          )}
          <div className="obsRows obsRowsAnim" style={{ height: standings.length * ROW_H }}>
            {stableRows.map(({ s, rank, dead }) => (
              <div
                key={s.team.id}
                className={[
                  "obsRow",
                  "obsRowAbs",
                  rank < 3 ? `obsTop${rank}` : "",
                  rank >= 3 && rank % 2 === 1 ? "obsAlt" : "",
                  flashes[s.team.id] ? "obsChanged" : "",
                  dead ? "obsDead" : "",
                ].join(" ")}
                style={{ top: rank * ROW_H, height: ROW_H }}
              >
                <span className="obsRank">{rank + 1}</span>
                <span
                  className={`obsMove ${moves[s.team.id] || ""}`}
                  aria-hidden={!moves[s.team.id]}
                >
                  {moves[s.team.id] === "up" ? "▲" : moves[s.team.id] === "down" ? "▼" : ""}
                </span>
                <span className="obsTeam">{s.team.name}</span>
                {dead && (
                  <span className="obsTermStamp" aria-hidden>
                    <span className="obsTermLine left" />
                    <span className="obsTermText">TERMINATED</span>
                    <span className="obsTermLine right" />
                  </span>
                )}
                {opts.rounds &&
                  s.perRound.map((v, ri) => (
                    <span
                      key={ri}
                      className={`obsCell ${rounds[ri]?.isLive ? "obsCellLive" : ""}`}
                    >
                      {v === null ? "–" : v}
                    </span>
                  ))}
                <span className={`obsTotal ${flashes[s.team.id] ? "flash" : ""}`}>
                  {s.total}
                </span>
              </div>
            ))}
            {standings.length === 0 && <div className="obsEmpty">대기 중…</div>}
          </div>
        </div>
      )}
    </div>
  );
}
