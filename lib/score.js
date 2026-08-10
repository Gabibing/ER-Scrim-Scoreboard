/* 서버(OG 메타)와 클라이언트가 함께 쓰는 순수 로직 */

export function computeStandings(board) {
  const rounds = board?.rounds || [];
  return (board?.teams || [])
    .map((t) => {
      const perRound = rounds.map((r) => {
        const res = r.results.find((x) => x.teamId === t.id);
        return res ? res.score : null;
      });
      const roundSum = perRound.reduce((a, v) => a + (v || 0), 0);
      const penalty = (board.penalties || [])
        .filter((p) => p.teamId === t.id)
        .reduce((a, p) => a + p.points, 0);
      return { team: t, perRound, penalty, total: roundSum - penalty };
    })
    .sort((a, z) => z.total - a.total);
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

/* Papa.parse 결과 rows → { teams: [{teamName, score, rank, nicknames[]}], gameId } */
export function groupCsvRows(rows) {
  const groups = {};
  let gameId = null;
  for (const row of rows) {
    const teamName = (row["teamname"] || "").trim();
    const nick = (row["nickname"] || "").trim();
    const score = parseFloat(row["tournament total score"]);
    const rank = parseInt(row["rank"], 10);
    if (!gameId && row["gameid"]) gameId = String(row["gameid"]).trim();
    if (!teamName || !nick || isNaN(score)) continue;
    if (!groups[teamName]) groups[teamName] = { teamName, score, rank, nicknames: [] };
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
