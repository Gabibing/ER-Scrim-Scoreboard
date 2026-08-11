/* 서버(OG 메타)와 클라이언트가 함께 쓰는 순수 로직 */

/* 진행 중(live) 라운드를 임시 라운드로 합친 보드를 돌려준다.
   live 점수는 확정 전이므로 isLive 플래그가 붙는다. */
export function withLive(board) {
  if (!board?.live || !Array.isArray(board.live.entries)) return board;
  const entries = board.live.entries.filter(
    (e) => e.teamId && e.score !== null && e.score !== "" && !isNaN(parseFloat(e.score))
  );
  if (entries.length === 0) return board;
  const liveRound = {
    round: board.live.round,
    isLive: true,
    at: board.live.updatedAt || 0,
    results: entries.map((e) => ({
      teamId: e.teamId,
      score: parseFloat(e.score),
      rank: null,
      out: !!e.out, // 이번 라운드 탈락(Terminate) 표시
    })),
  };
  /* 같은 번호의 확정 라운드가 있으면 확정본이 우선 */
  const rounds = (board.rounds || []).some((r) => r.round === liveRound.round)
    ? board.rounds
    : [...(board.rounds || []), liveRound].sort((a, z) => a.round - z.round);
  return { ...board, rounds };
}

export function computeStandings(board) {
  const rounds = board?.rounds || [];
  return (board?.teams || [])
    .map((t) => {
      const perRound = rounds.map((r) => {
        const res = r.results.find((x) => x.teamId === t.id);
        return res ? res.score : null;
      });
      /* 라운드별 킬 점수(KS) — CSV로 확정된 라운드에만 존재 */
      const perRoundKs = rounds.map((r) => {
        const res = r.results.find((x) => x.teamId === t.id);
        return res && res.ks != null ? res.ks : null;
      });
      const roundSum = perRound.reduce((a, v) => a + (v || 0), 0);
      const ks = perRoundKs.reduce((a, v) => a + (v || 0), 0);
      const penalty = (board.penalties || [])
        .filter((p) => p.teamId === t.id)
        .reduce((a, p) => a + p.points, 0);
      return { team: t, perRound, perRoundKs, penalty, ks, total: roundSum - penalty };
    })
    .sort((a, z) => z.total - a.total || z.ks - a.ks); // 동점이면 KS 우선
}

/* 닉네임 2명 이상 겹침으로 기존 팀 매칭 */
export function matchTeam(registry, nicknames) {
  let best = null,
    bestOverlap = 0;
  for (const t of registry) {
    const overlap = nicknames.filter((n) => t.nicknames.includes(n)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = t;
    }
  }
  return bestOverlap >= 2 ? best : null;
}

/* 실시간 입력으로 먼저 만들어진(닉네임이 없는) 팀은 팀명으로 매칭 */
export function matchTeamByName(registry, teamName) {
  const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
  return (
    registry.find((t) => (t.nicknames || []).length === 0 && norm(t.name) === norm(teamName)) ||
    null
  );
}

/* Papa.parse 결과 rows → { teams: [{teamName, score(TS), ks, rank, nicknames[]}], gameId } */
export function groupCsvRows(rows) {
  const groups = {};
  let gameId = null;
  for (const row of rows) {
    const teamName = (row["teamname"] || "").trim();
    const nick = (row["nickname"] || "").trim();
    const score = parseFloat(row["tournament total score"]); // TS
    const ksRaw = parseFloat(row["tournament kill score"]); // KS
    const ks = isNaN(ksRaw) ? null : ksRaw;
    const rank = parseInt(row["rank"], 10);
    if (!gameId && row["gameid"]) gameId = String(row["gameid"]).trim();
    if (!teamName || !nick || isNaN(score)) continue;
    if (!groups[teamName]) groups[teamName] = { teamName, score, ks, rank, nicknames: [] };
    groups[teamName].nicknames.push(nick);
  }
  const teams = Object.values(groups);
  if (teams.length === 0)
    throw new Error(
      "CSV에서 팀 데이터를 찾지 못했습니다. 헤더(nickname, teamName, tournament total score)를 확인해 주세요."
    );
  return { teams, gameId };
}

export const medalFor = (i) =>
  i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
