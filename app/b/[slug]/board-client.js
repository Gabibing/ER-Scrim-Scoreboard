"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Papa from "papaparse";
import { computeStandings, matchTeam, groupCsvRows, medalFor } from "@/lib/score";

const uid = () => Math.random().toString(36).slice(2, 9);

function parseGameCsv(text) {
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.replace(/^\uFEFF/, "").trim().toLowerCase(),
  });
  return groupCsvRows(parsed.data);
}

export default function BoardClient({ slug }) {
  const [board, setBoard] = useState(undefined); // undefined=로딩, null=없음
  const [pin, setPin] = useState(null); // 검증된 관리 PIN (메모리)
  const [pinInput, setPinInput] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [msg, setMsg] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [uploadRound, setUploadRound] = useState(1);
  const [penaltyForm, setPenaltyForm] = useState({ teamId: "", points: "", reason: "" });
  const [editingTeam, setEditingTeam] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [copyText, setCopyText] = useState(null);
  const fileRef = useRef(null);
  const isAdmin = pin !== null;

  const flash = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const fetchBoard = useCallback(
    async (adminPin) => {
      const p = adminPin ?? pin;
      const res = p
        ? await fetch(`/api/board/${slug}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin: p }),
            cache: "no-store",
          })
        : await fetch(`/api/board/${slug}`, { cache: "no-store" });
      if (!res.ok) {
        if (!p) setBoard(null);
        return null;
      }
      const data = await res.json();
      setBoard(data.board);
      return data.board;
    },
    [slug, pin]
  );

  /* 최초 로드 + 세션에 저장된 PIN 자동 검증 + 30초 자동 새로고침 */
  useEffect(() => {
    fetchBoard().then((b) => {
      if (b) setUploadRound((b.rounds?.length || 0) + 1);
    });
    try {
      const saved = sessionStorage.getItem(`er-pin:${slug}`);
      if (saved) {
        fetch(`/api/board/${slug}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: saved }),
        }).then(async (r) => {
          if (r.ok) {
            setPin(saved);
            const data = await r.json();
            setBoard(data.board); // gameId 포함 관리자 뷰
          } else sessionStorage.removeItem(`er-pin:${slug}`);
        });
      }
    } catch {}
    const iv = setInterval(() => fetchBoard(), 30000);
    return () => clearInterval(iv);
  }, [slug, fetchBoard]);

  /* 서버 저장: 성공 시 서버가 돌려준 최신 상태로 갱신 */
  const persist = async (next) => {
    const res = await fetch(`/api/board/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, board: next }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "저장에 실패했습니다.");
    setBoard(data.board);
    return data.board;
  };

  const tryLogin = async () => {
    const res = await fetch(`/api/board/${slug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pinInput }),
    });
    if (res.ok) {
      setPin(pinInput);
      try {
        sessionStorage.setItem(`er-pin:${slug}`, pinInput);
      } catch {}
      const data = await res.json();
      setBoard(data.board); // gameId 포함 관리자 뷰
      setShowPin(false);
      setPinInput("");
      flash("ok", "관리자 모드입니다.");
    } else {
      flash("err", "PIN이 일치하지 않습니다.");
    }
  };

  const logout = async () => {
    setPin(null);
    try {
      sessionStorage.removeItem(`er-pin:${slug}`);
    } catch {}
    await fetchBoard(""); // 일반 뷰(비공개 gameId 제거)로 다시 로드
  };

  /* ── CSV 업로드 ── */
  const processFile = (file) => {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) {
      flash("err", "CSV 파일만 업로드할 수 있습니다.");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const { teams: fileTeams, gameId } = parseGameCsv(reader.result);
        const b = structuredClone(board);
        const roundNum = uploadRound;
        const prevRound = b.rounds.find((r) => r.round === roundNum);
        const existed = !!prevRound;
        const results = [];
        for (const ft of fileTeams) {
          let team = matchTeam(b.teams, ft.nicknames);
          if (team) {
            for (const n of ft.nicknames)
              if (!team.nicknames.includes(n)) team.nicknames.push(n);
          } else {
            team = { id: uid(), name: ft.teamName, nicknames: [...ft.nicknames] };
            b.teams.push(team);
          }
          results.push({ teamId: team.id, score: ft.score, rank: ft.rank });
        }
        b.rounds = b.rounds.filter((r) => r.round !== roundNum);
        b.rounds.push({
          round: roundNum,
          results,
          at: Date.now(),
          gameId: gameId || prevRound?.gameId || null,
          gameIdPublic: prevRound?.gameIdPublic || false, // 새 라운드는 기본 비공개
        });
        b.rounds.sort((a, z) => a.round - z.round);
        await persist(b);
        setUploadRound(Math.max(...b.rounds.map((r) => r.round)) + 1);
        flash(
          "ok",
          existed
            ? `${roundNum}라운드 기존 기록을 덮어썼습니다 — 팀 ${results.length}개 반영.`
            : `${roundNum}라운드 집계 완료 — 팀 ${results.length}개 반영.`
        );
      } catch (err) {
        flash("err", err.message || "CSV 처리 중 오류가 발생했습니다.");
      } finally {
        if (fileRef.current) fileRef.current.value = "";
      }
    };
    reader.readAsText(file);
  };

  const handleFile = (e) => processFile(e.target.files?.[0]);
  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    processFile(e.dataTransfer.files?.[0]);
  };

  const deleteRound = async (roundNum) => {
    if (pendingDelete !== roundNum) {
      setPendingDelete(roundNum);
      flash("err", `한 번 더 누르면 ${roundNum}라운드 기록이 삭제됩니다.`);
      setTimeout(() => setPendingDelete((p) => (p === roundNum ? null : p)), 4000);
      return;
    }
    try {
      const b = structuredClone(board);
      b.rounds = b.rounds.filter((r) => r.round !== roundNum);
      await persist(b);
      setPendingDelete(null);
      flash("ok", `${roundNum}라운드를 삭제했습니다.`);
    } catch (e) {
      flash("err", e.message);
    }
  };

  const addPenalty = async () => {
    const pts = parseFloat(penaltyForm.points);
    if (!penaltyForm.teamId || isNaN(pts) || pts <= 0) {
      flash("err", "팀과 차감 점수(양수)를 입력해 주세요.");
      return;
    }
    try {
      const b = structuredClone(board);
      b.penalties.push({
        id: uid(),
        teamId: penaltyForm.teamId,
        points: pts,
        reason: penaltyForm.reason.trim() || "사유 미기재",
        at: Date.now(),
      });
      await persist(b);
      setPenaltyForm({ teamId: "", points: "", reason: "" });
      flash("ok", "패널티가 적용되었습니다.");
    } catch (e) {
      flash("err", e.message);
    }
  };

  const removePenalty = async (id) => {
    try {
      const b = structuredClone(board);
      b.penalties = b.penalties.filter((p) => p.id !== id);
      await persist(b);
      flash("ok", "패널티를 취소했습니다.");
    } catch (e) {
      flash("err", e.message);
    }
  };

  const saveTeamName = async () => {
    if (!editingTeam) return;
    const name = editingTeam.value.trim();
    if (!name) {
      setEditingTeam(null);
      return;
    }
    try {
      const b = structuredClone(board);
      const t = b.teams.find((x) => x.id === editingTeam.id);
      if (t) t.name = name;
      await persist(b);
      setEditingTeam(null);
      flash("ok", "팀 이름을 변경했습니다.");
    } catch (e) {
      flash("err", e.message);
    }
  };

  const refresh = async () => {
    await fetchBoard();
    flash("ok", "최신 기록을 불러왔습니다.");
  };

  const toggleGameId = async (roundNum) => {
    try {
      const b = structuredClone(board);
      const r = b.rounds.find((x) => x.round === roundNum);
      if (!r) return;
      r.gameIdPublic = !r.gameIdPublic;
      await persist(b);
      flash(
        "ok",
        r.gameIdPublic
          ? `R${roundNum} 게임 ID를 공개했습니다. 링크를 아는 모두가 리플레이를 볼 수 있어요.`
          : `R${roundNum} 게임 ID를 비공개로 전환했습니다.`
      );
    } catch (e) {
      flash("err", e.message);
    }
  };

  const copyGameId = async (gid) => {
    try {
      await navigator.clipboard.writeText(String(gid));
      flash("ok", `게임 ID ${gid} 복사됨 — 인게임 리플레이 검색에 붙여넣으세요.`);
    } catch {
      setCopyText(String(gid));
    }
  };

  /* ── 집계/복사 ── */
  const rounds = board?.rounds || [];
  const standings = board ? computeStandings(board) : [];

  const buildDiscordText = () => {
    const boardUrl = typeof window !== "undefined" ? window.location.href : "";
    const lines = [
      `🏆 **${board.title}** — ${rounds.length}라운드 기준`,
      "```",
      ...standings.map((s, i) => {
        const pen = s.penalty > 0 ? ` (패널티 -${s.penalty})` : "";
        return `${medalFor(i)} ${s.team.name.padEnd(12)} ${s.total}점${pen}`;
      }),
      "```",
      boardUrl ? `🔗 링크: [바로 보기](${boardUrl})` : "",
    ];
    return lines.filter(Boolean).join("\n");
  };

  const copyForDiscord = async () => {
    const text = buildDiscordText();
    try {
      await navigator.clipboard.writeText(text);
      flash("ok", "결과가 복사되었습니다. 디스코드에 붙여넣으세요.");
      return;
    } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) {
        flash("ok", "결과가 복사되었습니다. 디스코드에 붙여넣으세요.");
        return;
      }
    } catch {}
    setCopyText(text);
  };

  /* ── 렌더 ── */
  if (board === undefined)
    return (
      <div className="page">
        <div className="loading">기록을 불러오는 중…</div>
      </div>
    );

  if (board === null)
    return (
      <div className="page">
        <div className="setupWrap" style={{ textAlign: "center" }}>
          <h1 className="setupTitle">점수판을 찾을 수 없습니다</h1>
          <p className="setupDesc">링크가 정확한지 확인해 주세요.</p>
        </div>
      </div>
    );

  return (
    <div className="page">
      <div className="wrap">
        <header className="header">
          <div>
            <div className="eyebrow">ETERNAL RETURN · SCRIM</div>
            <h1 className="title">{board.title}</h1>
            <div className="subtitle">
              {rounds.length > 0
                ? `라운드 ${rounds.length}개 집계 · 팀 ${board.teams.length}개`
                : "아직 업로드된 라운드가 없습니다"}
            </div>
          </div>
          <div className="headerBtns">
            <button className="ghostBtn" onClick={refresh}>새로고침</button>
            <button className="ghostBtn" onClick={copyForDiscord}>디스코드용 복사</button>
            {isAdmin ? (
              <button className="ghostBtn" onClick={logout}>관리 종료</button>
            ) : (
              <button className="ghostBtn" onClick={() => setShowPin(!showPin)}>관리자</button>
            )}
          </div>
        </header>

        {showPin && !isAdmin && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input
              className="input"
              style={{ maxWidth: 220 }}
              type="password"
              placeholder="관리 PIN"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && tryLogin()}
            />
            <button className="primarySmBtn" onClick={tryLogin}>확인</button>
          </div>
        )}

        {msg && <div className={msg.type === "ok" ? "okMsg" : "errMsg"}>{msg.text}</div>}

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 52 }}>순위</th>
                <th style={{ textAlign: "left" }}>팀</th>
                {rounds.map((r) => (
                  <th key={r.round}>
                    R{r.round}
                    {isAdmin && (
                      <button
                        className={pendingDelete === r.round ? "tinyDelArmed" : "tinyDel"}
                        title="라운드 삭제"
                        onClick={() => deleteRound(r.round)}
                      >
                        {pendingDelete === r.round ? "삭제!" : "×"}
                      </button>
                    )}
                  </th>
                ))}
                <th>패널티</th>
                <th style={{ color: "var(--gold)" }}>합계</th>
              </tr>
            </thead>
            <tbody>
              {standings.length === 0 && (
                <tr>
                  <td colSpan={4 + rounds.length} className="empty">
                    관리자가 라운드 CSV를 업로드하면 순위가 표시됩니다.
                  </td>
                </tr>
              )}
              {standings.map((s, i) => {
                const teamPens = board.penalties.filter((p) => p.teamId === s.team.id);
                const isOpen = expanded === s.team.id;
                return (
                  <React.Fragment key={s.team.id}>
                    <tr
                      className={`clickable ${i < 3 ? `rank${i}` : ""}`}
                      onClick={() => setExpanded(isOpen ? null : s.team.id)}
                    >
                      <td style={{ fontWeight: 700, fontSize: 15 }}>
                        {i === 0 ? "1st" : i === 1 ? "2nd" : i === 2 ? "3rd" : i + 1}
                      </td>
                      <td style={{ textAlign: "left", fontWeight: 600 }}>
                        {editingTeam?.id === s.team.id ? (
                          <span
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: "inline-flex", gap: 6 }}
                          >
                            <input
                              autoFocus
                              className="inlineInput"
                              value={editingTeam.value}
                              onChange={(e) =>
                                setEditingTeam({ ...editingTeam, value: e.target.value })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveTeamName();
                                if (e.key === "Escape") setEditingTeam(null);
                              }}
                            />
                            <button className="primarySmBtn" onClick={saveTeamName}>저장</button>
                            <button className="ghostSmBtn" onClick={() => setEditingTeam(null)}>취소</button>
                          </span>
                        ) : (
                          <>
                            {s.team.name}
                            {isAdmin && (
                              <button
                                className="tinyEdit"
                                title="팀 이름 수정"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingTeam({ id: s.team.id, value: s.team.name });
                                }}
                              >
                                ✎
                              </button>
                            )}
                          </>
                        )}
                      </td>
                      {s.perRound.map((v, ri) => (
                        <td key={ri} style={{ color: v === null ? "var(--ghost)" : undefined }}>
                          {v === null ? "–" : v}
                        </td>
                      ))}
                      <td style={{ color: s.penalty > 0 ? "var(--red)" : "var(--ghost)" }}>
                        {s.penalty > 0 ? `-${s.penalty}` : "–"}
                      </td>
                      <td style={{ fontWeight: 800, fontSize: 16, color: "var(--gold)" }}>
                        {s.total}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={4 + rounds.length} className="detail">
                          <span className="detailLabel">로스터</span>
                          {s.team.nicknames.join(" · ")}
                          {teamPens.length > 0 && (
                            <div style={{ marginTop: 8 }}>
                              <span className="detailLabel">패널티 내역</span>
                              {teamPens.map((p) => (
                                <span key={p.id} className="penChip">
                                  -{p.points} {p.reason}
                                  {isAdmin && (
                                    <button
                                      className="tinyDel"
                                      title="패널티 취소"
                                      onClick={() => removePenalty(p.id)}
                                    >
                                      ×
                                    </button>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {(() => {
          const replayRounds = rounds.filter((r) => (isAdmin ? r.gameId : r.gameIdPublic && r.gameId));
          if (replayRounds.length === 0) return null;
          return (
            <div className="adminCard" style={{ marginTop: 22 }}>
              <h3 className="adminTitle">리플레이 게임 ID</h3>
              <div className="adminRow">
                {replayRounds.map((r) => (
                  <span key={r.round} className={`gidChip ${r.gameIdPublic ? "" : "private"}`}>
                    <b>R{r.round}</b>
                    <button className="gidCode" title="복사" onClick={() => copyGameId(r.gameId)}>
                      {r.gameId}
                    </button>
                    {isAdmin && (
                      <button
                        className={r.gameIdPublic ? "gidToggle on" : "gidToggle"}
                        title={r.gameIdPublic ? "비공개로 전환" : "공개로 전환"}
                        onClick={() => toggleGameId(r.round)}
                      >
                        {r.gameIdPublic ? "공개중" : "비공개"}
                      </button>
                    )}
                  </span>
                ))}
              </div>
              <p className="hint">
                {isAdmin
                  ? "비공개 ID는 관리자에게만 보이며, 공개로 전환한 라운드만 시청자에게 표시됩니다. 게임 ID로 인게임 리플레이를 볼 수 있으니 신중하게 공개하세요."
                  : "ID를 누르면 복사됩니다. 인게임 리플레이 검색에 붙여넣어 관전할 수 있어요."}
              </p>
            </div>
          );
        })()}

        {isAdmin && (
          <div className="adminWrap">
            <div className="adminCard">
              <h3 className="adminTitle">라운드 CSV 업로드</h3>
              <div className="adminRow" style={{ marginBottom: 12 }}>
                <label className="label" style={{ margin: 0 }}>라운드</label>
                <input
                  className="input"
                  style={{ width: 70, textAlign: "center" }}
                  type="number"
                  min={1}
                  max={20}
                  value={uploadRound}
                  onChange={(e) => setUploadRound(parseInt(e.target.value, 10) || 1)}
                />
                <span className="hint" style={{ margin: 0 }}>이 라운드 번호로 저장됩니다</span>
              </div>
              <div
                className={`dropZone ${dragOver ? "active" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
              >
                <div className="dropIcon">{dragOver ? "⬇" : "📄"}</div>
                <div className="dropMain">
                  {dragOver
                    ? `R${uploadRound}에 놓아서 집계`
                    : "CSV를 여기로 드래그하거나 클릭해서 선택"}
                </div>
                <div className="dropSub">
                  GameResult_.csv 그대로 업로드
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFile}
                  style={{ display: "none" }}
                />
              </div>
            </div>

            <div className="adminCard">
              <h3 className="adminTitle">패널티 부여</h3>
              <div className="adminRow">
                <select
                  className="input"
                  style={{ width: 150 }}
                  value={penaltyForm.teamId}
                  onChange={(e) => setPenaltyForm({ ...penaltyForm, teamId: e.target.value })}
                >
                  <option value="">팀 선택</option>
                  {board.teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <input
                  className="input"
                  style={{ width: 90 }}
                  type="number"
                  min="0"
                  step="0.5"
                  placeholder="차감 점수"
                  value={penaltyForm.points}
                  onChange={(e) => setPenaltyForm({ ...penaltyForm, points: e.target.value })}
                />
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 140 }}
                  placeholder="사유 (예: 시작 지연)"
                  value={penaltyForm.reason}
                  onChange={(e) => setPenaltyForm({ ...penaltyForm, reason: e.target.value })}
                />
                <button className="primarySmBtn" onClick={addPenalty}>적용</button>
              </div>
              <p className="hint">적용된 패널티는 팀 행을 눌러 내역에서 취소할 수 있습니다.</p>
            </div>
          </div>
        )}

        {copyText !== null && (
          <div className="modalOverlay" onClick={() => setCopyText(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3 className="adminTitle">결과 직접 복사</h3>
              <p className="hint" style={{ margin: "0 0 10px" }}>
                자동 복사가 차단된 환경입니다. 아래 내용을 전체 선택 후 복사해서 디스코드에
                붙여넣으세요.
              </p>
              <textarea
                className="copyArea"
                value={copyText}
                readOnly
                autoFocus
                onFocus={(e) => e.target.select()}
              />
              <button className="primaryBtn" style={{ marginTop: 12 }} onClick={() => setCopyText(null)}>
                닫기
              </button>
            </div>
          </div>
        )}

        <footer className="footer">
          팀은 닉네임으로 자동 식별됩니다 · 30초마다 자동으로 최신 기록을 불러옵니다
        </footer>
      </div>
    </div>
  );
}
