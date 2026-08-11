"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Papa from "papaparse";
import {
  computeStandings,
  matchTeam,
  matchTeamByName,
  groupCsvRows,
  medalFor,
  withLive,
} from "@/lib/score";
import { ocrScoreboard } from "@/lib/ocr";

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
  const [pendingTeamDelete, setPendingTeamDelete] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [copyText, setCopyText] = useState(null);
  const fileRef = useRef(null);
  const isAdmin = pin !== null;

  /* ── 실시간 라운드 상태 ──
     liveDraft는 관리자의 로컬 편집본. [점수 반영] 버튼을 눌러야만
     서버(board.live)로 전송되어 시청자·OBS에 표시된다. */
  const [liveDraft, setLiveDraft] = useState(null); // {round, entries:[{teamId, score}]}
  const [liveUnsaved, setLiveUnsaved] = useState(false); // 반영 안 된 로컬 변경 존재
  const [liveRoundInput, setLiveRoundInput] = useState(1);
  const [liveSaving, setLiveSaving] = useState(false);
  const [pendingLiveAction, setPendingLiveAction] = useState(null); // "finalize" | "cancel"
  const boardRef = useRef(board);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  /* ── OCR 상태 ── */
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [ocrRows, setOcrRows] = useState(null); // [{slot, name, score, use}]
  const [ocrPreview, setOcrPreview] = useState(null);
  const [ocrDragOver, setOcrDragOver] = useState(false);
  const ocrFileRef = useRef(null);

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

  /* 최초 로드 + 세션에 저장된 PIN 자동 검증 + 자동 새로고침 */
  useEffect(() => {
    fetchBoard().then((b) => {
      if (b) {
        const next = (b.rounds?.length || 0) + 1;
        setUploadRound(b.live?.round || next);
        setLiveRoundInput(b.live?.round || next);
      }
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
    const iv = setInterval(() => fetchBoard(), 15000);
    return () => clearInterval(iv);
  }, [slug, fetchBoard]);

  /* 서버의 live 상태를 로컬 초안과 동기화 (반영 안 된 로컬 변경이 없을 때만) */
  useEffect(() => {
    if (!liveUnsaved) setLiveDraft(board?.live ?? null);
  }, [board, liveUnsaved]);

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

  /* ── 실시간 점수 입력 (로컬 편집 → [점수 반영]으로 송출) ── */
  const editLiveDraft = (draft) => {
    setLiveDraft(draft);
    setLiveUnsaved(true);
  };

  const startLive = (withTeams = true) => {
    const round = Math.max(1, parseInt(liveRoundInput, 10) || 1);
    const entries = withTeams
      ? (board.teams || []).map((t) => ({ teamId: t.id, score: 0 }))
      : [];
    editLiveDraft({ round, entries });
    setUploadRound(round);
    flash("ok", `R${round} 집계를 시작했습니다. [점수 반영]을 눌러야 시청자·OBS에 표시됩니다.`);
  };

  /* 시청자·OBS로 송출 (0.5 단위로 스냅해서 저장) */
  const pushLive = async () => {
    if (!liveDraft) return;
    setLiveSaving(true);
    try {
      const snapped = {
        ...liveDraft,
        entries: liveDraft.entries.map((e) => {
          const v = parseFloat(e.score);
          return { ...e, score: isFinite(v) ? snapHalf(v) : e.score };
        }),
      };
      setLiveDraft(snapped);
      await persist({ ...boardRef.current, live: snapped });
      setLiveUnsaved(false);
      flash("ok", `R${liveDraft.round} 점수를 반영했습니다 — 시청자·OBS에 표시됩니다.`);
    } catch (e) {
      flash("err", e.message);
    } finally {
      setLiveSaving(false);
    }
  };

  const setLiveScore = (teamId, value) => {
    editLiveDraft({
      ...liveDraft,
      entries: liveDraft.entries.map((e) =>
        e.teamId === teamId ? { ...e, score: value } : e
      ),
    });
  };

  /* 점수는 0.5점 단위 — 항상 0.5의 배수로 스냅 */
  const snapHalf = (v) => Math.max(0, Math.round(v * 2) / 2);

  const stepLiveScore = (teamId, delta) => {
    const e = liveDraft.entries.find((x) => x.teamId === teamId);
    const cur = parseFloat(e?.score);
    setLiveScore(teamId, snapHalf((isFinite(cur) ? cur : 0) + delta));
  };

  /* 이번 라운드 탈락(Terminate) 토글 — 점수는 유지되고 표시만 바뀐다 */
  const toggleLiveOut = (teamId) => {
    editLiveDraft({
      ...liveDraft,
      entries: liveDraft.entries.map((e) =>
        e.teamId === teamId ? { ...e, out: !e.out } : e
      ),
    });
  };

  /* 이미 등록된 팀을 라이브 초안에 다시 넣기 (제외했던 팀 복귀용) */
  const addLiveTeam = (teamId) => {
    if (!teamId || !liveDraft || liveDraft.entries.some((e) => e.teamId === teamId)) return;
    editLiveDraft({
      ...liveDraft,
      entries: [...liveDraft.entries, { teamId, score: 0 }],
    });
  };


  const armLiveAction = (action) => {
    if (pendingLiveAction !== action) {
      setPendingLiveAction(action);
      flash(
        "err",
        action === "finalize"
          ? "한 번 더 누르면 현재 실시간 점수가 라운드 기록으로 확정됩니다."
          : "한 번 더 누르면 실시간 점수가 저장 없이 종료됩니다."
      );
      setTimeout(() => setPendingLiveAction((p) => (p === action ? null : p)), 4000);
      return false;
    }
    setPendingLiveAction(null);
    return true;
  };

  /* 잘못 등록한 팀 정리 — 라운드 점수·패널티·실시간 점수에서도 함께 제거.
     대회(8팀 고정)에서는 팀을 없애는 대신 그 자리를 새 "Team N"으로 초기화한다. */
  const deleteTeam = async (teamId) => {
    const tourney = boardRef.current?.mode === "tourney";
    if (pendingTeamDelete !== teamId) {
      setPendingTeamDelete(teamId);
      flash(
        "err",
        tourney
          ? "한 번 더 누르면 이 팀이 초기화됩니다. 이름·로스터·라운드 점수·패널티가 모두 지워져요."
          : "한 번 더 누르면 팀이 삭제됩니다. 이 팀의 라운드 점수·패널티도 함께 삭제돼요."
      );
      setTimeout(() => setPendingTeamDelete((p) => (p === teamId ? null : p)), 4000);
      return;
    }
    setPendingTeamDelete(null);
    try {
      const b = structuredClone(boardRef.current);
      const idx = b.teams.findIndex((t) => t.id === teamId);
      const name = b.teams[idx]?.name || "팀";
      if (tourney && idx !== -1) {
        /* 자리 유지 + 새 placeholder로 교체 (슬롯 순서 보존) */
        b.teams[idx] = { id: uid(), name: `Team ${idx + 1}`, nicknames: [] };
      } else {
        b.teams = b.teams.filter((t) => t.id !== teamId);
      }
      b.rounds = b.rounds.map((r) => ({
        ...r,
        results: r.results.filter((x) => x.teamId !== teamId),
      }));
      b.penalties = b.penalties.filter((p) => p.teamId !== teamId);
      if (b.live)
        b.live = { ...b.live, entries: b.live.entries.filter((e) => e.teamId !== teamId) };
      await persist(b);
      setLiveDraft((d) =>
        d ? { ...d, entries: d.entries.filter((e) => e.teamId !== teamId) } : d
      );
      setExpanded(null);
      flash(
        "ok",
        tourney ? `${name} 팀을 초기화했습니다 (Team ${idx + 1}).` : `${name} 팀을 삭제했습니다.`
      );
    } catch (e) {
      flash("err", e.message);
    }
  };

  const finalizeLive = async () => {
    if (!armLiveAction("finalize")) return;
    const entries = (liveDraft.entries || []).filter(
      (e) => e.score !== "" && e.score !== null && isFinite(parseFloat(e.score))
    );
    if (entries.length === 0) {
      flash("err", "확정할 점수가 없습니다.");
      return;
    }
    try {
      const b = structuredClone(boardRef.current);
      const roundNum = liveDraft.round;
      const prev = b.rounds.find((r) => r.round === roundNum);
      b.rounds = b.rounds.filter((r) => r.round !== roundNum);
      b.rounds.push({
        round: roundNum,
        results: entries.map((e) => ({
          teamId: e.teamId,
          score: snapHalf(parseFloat(e.score)),
          rank: null,
        })),
        at: Date.now(),
        gameId: prev?.gameId || null,
        gameIdPublic: prev?.gameIdPublic || false,
        manual: true, // 수기 집계 표시 (CSV로 덮어쓰면 해제)
      });
      b.rounds.sort((a, z) => a.round - z.round);
      b.live = null;
      await persist(b);
      setLiveUnsaved(false);
      setLiveDraft(null);
      setUploadRound(roundNum);
      setLiveRoundInput(roundNum + 1);
      flash(
        "ok",
        `R${roundNum} 수기 점수를 확정했습니다. 라운드 종료 후 같은 라운드 번호로 CSV를 올리면 공식 기록으로 대체됩니다.`
      );
    } catch (e) {
      flash("err", e.message);
    }
  };

  const cancelLive = async () => {
    if (!armLiveAction("cancel")) return;
    try {
      if (boardRef.current?.live) await persist({ ...boardRef.current, live: null });
      setLiveUnsaved(false);
      setLiveDraft(null);
      flash("ok", "실시간 집계를 종료했습니다.");
    } catch (e) {
      flash("err", e.message);
    }
  };

  /* ── OCR ── */
  const openOcr = () => {
    setOcrRows(null);
    setOcrPreview(null);
    setOcrStatus("");
    setOcrOpen(true);
  };

  const runOcr = async (file) => {
    if (!file || !/^image\//.test(file.type)) {
      flash("err", "이미지 파일(스크린샷)만 인식할 수 있습니다.");
      return;
    }
    setOcrBusy(true);
    setOcrRows(null);
    try {
      setOcrPreview(URL.createObjectURL(file));
      const rows = await ocrScoreboard(file, setOcrStatus);
      /* 왼쪽 칸부터 1팀, 2팀… 순서 = 점수판의 팀 순서 (팀 매칭 없이 그대로 반영) */
      setOcrRows(rows.map((r) => ({ ...r, score: r.score === null ? "" : r.score })));
      setOcrStatus("");
    } catch (e) {
      setOcrStatus("");
      flash("err", e.message || "인식에 실패했습니다.");
    } finally {
      setOcrBusy(false);
    }
  };

  /* 모달이 열려 있는 동안 Ctrl+V로 스크린샷 붙여넣기 */
  useEffect(() => {
    if (!ocrOpen) return;
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) =>
        i.type.startsWith("image/")
      );
      if (item) {
        e.preventDefault();
        runOcr(item.getAsFile());
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocrOpen]);

  const applyOcr = () => {
    const teams = boardRef.current?.teams || [];
    /* 칸 순서 그대로: 1번 칸 → 1번 팀, 2번 칸 → 2번 팀 … */
    const usable = (ocrRows || []).filter(
      (r) => r.score !== "" && isFinite(parseFloat(r.score)) && teams[r.slot - 1]
    );
    if (usable.length === 0) {
      flash("err", "반영할 점수가 없습니다. 팀을 먼저 등록했는지, 점수가 채워졌는지 확인해 주세요.");
      return;
    }
    const round = liveDraft?.round || Math.max(1, parseInt(liveRoundInput, 10) || 1);
    const entries = liveDraft ? liveDraft.entries.map((e) => ({ ...e })) : [];
    for (const row of usable) {
      const teamId = teams[row.slot - 1].id;
      const score = snapHalf(parseFloat(row.score));
      const ex = entries.find((e) => e.teamId === teamId);
      if (ex) ex.score = score;
      else entries.push({ teamId, score });
    }
    editLiveDraft({ round, entries });
    setUploadRound(round);
    setOcrOpen(false);
    flash(
      "ok",
      `인식 결과 ${usable.length}개 팀을 R${round} 초안에 넣었습니다. [점수 반영]을 눌러야 시청자에게 표시됩니다.`
    );
  };

  /* ── CSV 업로드 (라운드 확정) ── */
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
          let team =
            matchTeam(b.teams, ft.nicknames) || matchTeamByName(b.teams, ft.teamName);
          /* 대회: 아직 손대지 않은 기본 팀(Team N, 로스터 없음)을 CSV 팀으로 전환 */
          if (!team && b.mode === "tourney") {
            team = b.teams.find(
              (t) => /^Team [1-8]$/.test(t.name) && t.nicknames.length === 0
            );
            if (team) team.name = ft.teamName;
          }
          if (team) {
            for (const n of ft.nicknames)
              if (!team.nicknames.includes(n)) team.nicknames.push(n);
          } else {
            if (b.mode === "tourney")
              throw new Error(
                `'${ft.teamName}' 팀을 기존 8팀과 매칭하지 못했습니다. ` +
                  `팀 이름을 CSV의 팀명과 맞추거나, 잘못된 팀을 초기화한 뒤 다시 업로드해 주세요.`
              );
            team = { id: uid(), name: ft.teamName, nicknames: [...ft.nicknames] };
            b.teams.push(team);
          }
          results.push({ teamId: team.id, score: ft.score, rank: ft.rank, ks: ft.ks });
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
        /* 같은 라운드의 실시간 점수는 CSV가 공식 기록으로 대체 */
        const hadLive = b.live && b.live.round === roundNum;
        if (hadLive) b.live = null;
        await persist(b);
        if (liveDraft?.round === roundNum) {
          setLiveDraft(null);
          setLiveUnsaved(false);
        }
        setUploadRound(Math.max(...b.rounds.map((r) => r.round)) + 1);
        setLiveRoundInput(Math.max(...b.rounds.map((r) => r.round)) + 1);
        flash(
          "ok",
          hadLive
            ? `${roundNum}라운드를 CSV 기준으로 확정했습니다 (실시간 점수 대체) — 팀 ${results.length}개 반영.`
            : existed
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
  const isTourney = board?.mode === "tourney";
  const viewBoard = board ? withLive(board) : board;
  const rounds = viewBoard?.rounds || [];
  const standings = viewBoard ? computeStandings(viewBoard) : [];
  const liveActive = !!board?.live;

  const copyToClipboard = async (text, okMsg) => {
    try {
      await navigator.clipboard.writeText(text);
      flash("ok", okMsg);
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
        flash("ok", okMsg);
        return;
      }
    } catch {}
    setCopyText(text);
  };

  const buildDiscordText = () => {
    const boardUrl = typeof window !== "undefined" ? window.location.href : "";
    const lines = [
      `🏆 **${board.title}** — ${rounds.length}라운드 기준${liveActive ? " (진행중 포함)" : ""}`,
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

  const copyForDiscord = () =>
    copyToClipboard(buildDiscordText(), "결과가 복사되었습니다. 디스코드에 붙여넣으세요.");

  const copyObsUrl = () =>
    copyToClipboard(
      `${window.location.origin}/b/${slug}/obs`,
      "OBS 브라우저 소스 URL이 복사되었습니다. 권장 크기 380×400 (8팀 기준), 배경은 투명입니다."
    );

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

  const liveTeamsAvailable = (board.teams || []).filter(
    (t) => !liveDraft?.entries?.some((e) => e.teamId === t.id)
  );

  return (
    <div className="page">
      <div className="wrap">
        <header className="header">
          <div>
            <div className="eyebrow">
              ETERNAL RETURN · {isTourney ? "TOURNAMENT" : "SCRIM"}
            </div>
            <h1 className="title">{board.title}</h1>
            <div className="subtitle">
              {rounds.length > 0
                ? `라운드 ${rounds.length}개 집계${liveActive ? " (진행중 포함)" : ""} · 팀 ${board.teams.length}개`
                : "아직 집계된 라운드가 없습니다"}
            </div>
          </div>
          <div className="headerBtns">
            <button className="ghostBtn" onClick={refresh}>새로고침</button>
            <button className="ghostBtn" onClick={copyForDiscord}>디스코드용 복사</button>
            {isTourney && (
              <>
                <button
                  className="ghostBtn"
                  onClick={() => window.open(`/b/${slug}/graphic`, "_blank")}
                >
                  결과 그래픽
                </button>
                <button className="ghostBtn" onClick={copyObsUrl}>OBS 소스 복사</button>
              </>
            )}
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
                  <th key={r.round} className={r.isLive ? "liveTh" : undefined}>
                    R{r.round}
                    {r.isLive && <span className="liveDot" title="진행 중 (미확정)" />}
                    {!r.isLive && r.manual && (
                      <span className="manualMark" title="수기 집계 (CSV 미확정)">✎</span>
                    )}
                    {isAdmin && !r.isLive && (
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
                <th title="킬 점수 합계 — CSV를 업로드해야만 업데이트됩니다">KS</th>
                <th>패널티</th>
                <th style={{ color: "var(--gold)" }} title="Tournament Total Score 합계">합계</th>
              </tr>
            </thead>
            <tbody>
              {standings.length === 0 && (
                <tr>
                  <td colSpan={5 + rounds.length} className="empty">
                    {isTourney
                      ? "관리자가 팀을 등록하고 실시간 집계를 시작하거나 CSV를 업로드하면 순위가 표시됩니다."
                      : "관리자가 라운드 CSV를 업로드하면 순위가 표시됩니다."}
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
                      {s.perRound.map((v, ri) => {
                        const liveOut =
                          rounds[ri]?.isLive &&
                          rounds[ri].results.find((x) => x.teamId === s.team.id)?.out;
                        return (
                          <td
                            key={ri}
                            className={rounds[ri]?.isLive ? "liveCell" : undefined}
                            style={{ color: v === null ? "var(--ghost)" : undefined }}
                            title={liveOut ? "이번 라운드 탈락" : undefined}
                          >
                            {liveOut ? "💀 " : ""}
                            {v === null ? "–" : v}
                          </td>
                        );
                      })}
                      <td style={{ color: s.ks > 0 ? "var(--teal)" : "var(--ghost)" }}>
                        {s.ks > 0 ? s.ks : "–"}
                      </td>
                      <td style={{ color: s.penalty > 0 ? "var(--red)" : "var(--ghost)" }}>
                        {s.penalty > 0 ? `-${s.penalty}` : "–"}
                      </td>
                      <td style={{ fontWeight: 800, fontSize: 16, color: "var(--gold)" }}>
                        {s.total}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={5 + rounds.length} className="detail">
                          <span className="detailLabel">로스터</span>
                          {s.team.nicknames.length > 0
                            ? s.team.nicknames.join(" · ")
                            : "아직 CSV로 확인된 로스터가 없습니다"}
                          {isAdmin && (
                            <button
                              className={
                                pendingTeamDelete === s.team.id
                                  ? "dangerSmBtn armed teamDelBtn"
                                  : "dangerSmBtn teamDelBtn"
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteTeam(s.team.id);
                              }}
                            >
                              {pendingTeamDelete === s.team.id
                                ? isTourney
                                  ? "초기화 확인!"
                                  : "삭제 확인!"
                                : isTourney
                                ? "팀 초기화"
                                : "팀 삭제"}
                            </button>
                          )}
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
        {liveActive && (
          <p className="liveNotice">
            <span className="liveDot" /> R{board.live.round} 진행 중 — 실시간 점수는 확정 전이며,
            라운드 종료 후 CSV 업로드로 확정됩니다.
          </p>
        )}

        {(() => {
          const replayRounds = rounds.filter(
            (r) => !r.isLive && (isAdmin ? r.gameId : r.gameIdPublic && r.gameId)
          );
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
            {/* ── 실시간 점수 입력 (대회 전용) ── */}
            {isTourney && (
            <div className={`adminCard ${liveDraft ? "liveCard" : ""}`}>
              <h3 className="adminTitle">
                실시간 점수 (라운드 진행 중)
                {liveDraft && (
                  <span className={`liveBadge ${liveUnsaved ? "unsaved" : ""}`}>
                    <span className="liveDot" /> R{liveDraft.round}{" "}
                    {liveSaving
                      ? "반영 중…"
                      : liveUnsaved
                      ? "미반영 변경 있음"
                      : board?.live
                      ? "송출 중"
                      : "초안"}
                  </span>
                )}
              </h3>
              {!liveDraft ? (
                <>
                  <div className="adminRow">
                    <label className="label" style={{ margin: 0 }}>라운드</label>
                    <input
                      className="input"
                      style={{ width: 70, textAlign: "center" }}
                      type="number"
                      min={1}
                      max={99}
                      value={liveRoundInput}
                      onChange={(e) => setLiveRoundInput(parseInt(e.target.value, 10) || 1)}
                    />
                    <button className="primarySmBtn" onClick={() => startLive(true)}>
                      실시간 집계 시작
                    </button>
                    <button className="ghostSmBtn" onClick={openOcr}>
                      📷 스크린샷으로 인식
                    </button>
                  </div>
                  <p className="hint">
                    CSV가 나오기 전에도 관전 화면을 보며 점수를 직접 올리거나, 관전 화면
                    스크린샷을 인식시켜 채울 수 있습니다. 입력한 점수는{" "}
                    <b>[점수 반영] 버튼을 눌러야</b> 시청자와 OBS 오버레이에 표시됩니다.
                  </p>
                </>
              ) : (
                <>
                  <div className="liveGrid">
                    {liveDraft.entries.map((e) => {
                      const team = board.teams.find((t) => t.id === e.teamId);
                      if (!team) return null;
                      return (
                        <div key={e.teamId} className={`liveRow ${e.out ? "dead" : ""}`}>
                          <span className="liveTeamName" title={team.name}>
                            {e.out && "💀 "}
                            {team.name}
                          </span>
                          <div className="liveCtrls">
                            <button className="stepBtn" onClick={() => stepLiveScore(e.teamId, -0.5)}>−.5</button>
                            <input
                              className="input liveScoreInput"
                              type="number"
                              step="0.5"
                              min="0"
                              value={e.score ?? ""}
                              onChange={(ev) => setLiveScore(e.teamId, ev.target.value)}
                              onBlur={(ev) => {
                                const v = parseFloat(ev.target.value);
                                if (isFinite(v)) setLiveScore(e.teamId, snapHalf(v));
                              }}
                            />
                            <button className="stepBtn" onClick={() => stepLiveScore(e.teamId, +0.5)}>+.5</button>
                            <button
                              className={e.out ? "skullBtn on" : "skullBtn"}
                              title={
                                e.out
                                  ? "탈락 해제"
                                  : "이번 라운드 탈락 표시 (Terminate) — 점수는 그대로 집계됩니다"
                              }
                              onClick={() => toggleLiveOut(e.teamId)}
                            >
                              💀
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {liveDraft.entries.length === 0 && (
                      <p className="hint" style={{ margin: 0 }}>
                        집계 중인 팀이 없습니다. 아래 "집계에서 제외됨" 칩으로 팀을 다시
                        넣거나 스크린샷을 인식시켜 주세요.
                      </p>
                    )}
                  </div>
                  {liveTeamsAvailable.length > 0 && (
                    <div className="adminRow" style={{ marginTop: 10 }}>
                      <span className="hint" style={{ margin: 0 }}>집계에서 제외됨:</span>
                      {liveTeamsAvailable.map((t) => (
                        <button
                          key={t.id}
                          className="ghostSmBtn"
                          title="이 팀을 다시 집계에 넣기"
                          onClick={() => addLiveTeam(t.id)}
                        >
                          + {t.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="adminRow" style={{ marginTop: 12 }}>
                    <button
                      className={`primarySmBtn pushBtn ${liveUnsaved ? "dirty" : ""}`}
                      onClick={pushLive}
                      disabled={liveSaving || !liveUnsaved}
                    >
                      {liveSaving ? "반영 중…" : liveUnsaved ? "▶ 점수 반영" : "반영됨"}
                    </button>
                    <button className="ghostSmBtn" onClick={openOcr}>📷 스크린샷 인식</button>
                    <button
                      className={pendingLiveAction === "finalize" ? "greenSmBtn armed" : "greenSmBtn"}
                      onClick={finalizeLive}
                    >
                      {pendingLiveAction === "finalize" ? "확정 확인!" : "이 점수로 확정"}
                    </button>
                    <button
                      className={pendingLiveAction === "cancel" ? "dangerSmBtn armed" : "dangerSmBtn"}
                      onClick={cancelLive}
                    >
                      {pendingLiveAction === "cancel" ? "종료 확인!" : "저장 없이 종료"}
                    </button>
                  </div>
                  <p className="liveGuide">
                    점수를 고친 뒤 <b>[점수 반영]</b>을 눌러야 시청자·OBS에 표시됩니다.
                    라운드가 끝나면{" "}
                    <span className="guideStrong">CSV를 업로드해 공식 기록으로 확정</span>
                    하세요 — 같은 라운드 번호의 실시간 점수는 CSV로 대체되며, KS(킬 점수)는
                    CSV를 업로드해야만 집계됩니다.
                  </p>
                </>
              )}
            </div>
            )}

            <div className="adminCard">
              <h3 className="adminTitle">
                {isTourney ? "라운드 CSV 업로드 (확정)" : "라운드 CSV 업로드"}
              </h3>
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
                <span className="hint" style={{ margin: 0 }}>이 라운드 번호로 확정됩니다</span>
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
                    ? `R${uploadRound}에 놓아서 확정`
                    : "CSV를 여기로 드래그하거나 클릭해서 선택"}
                </div>
                <div className="dropSub">
                  {isTourney
                    ? "GameResult_.csv 그대로 업로드 · 같은 라운드의 실시간/수기 점수는 CSV 기준으로 대체"
                    : "GameResult_.csv 그대로 업로드"}
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

        {/* ── OCR 모달 ── */}
        {ocrOpen && (
          <div className="modalOverlay" onClick={() => !ocrBusy && setOcrOpen(false)}>
            <div className="modal ocrModal" onClick={(e) => e.stopPropagation()}>
              <h3 className="adminTitle">스크린샷으로 점수 인식</h3>
              {!ocrRows && !ocrBusy && (
                <>
                  <div
                    className={`dropZone ${ocrDragOver ? "active" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setOcrDragOver(true);
                    }}
                    onDragLeave={() => setOcrDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setOcrDragOver(false);
                      runOcr(e.dataTransfer.files?.[0]);
                    }}
                    onClick={() => ocrFileRef.current?.click()}
                  >
                    <div className="dropIcon">📷</div>
                    <div className="dropMain">
                      관전 화면 스크린샷을 드래그 / 클릭해서 선택 / <b>Ctrl+V</b> 붙여넣기
                    </div>
                    <div className="dropSub">
                      하단 팀 카드(TS 점수)가 보이는 16:9 전체 화면 캡처를 그대로 사용하세요.
                      왼쪽 칸부터 1팀 → 8팀 순서로 TS 점수만 읽어 등록된 팀 순서에 그대로
                      반영합니다. 이미지는 서버로 전송되지 않고 이 브라우저 안에서만 처리됩니다.
                    </div>
                    <input
                      ref={ocrFileRef}
                      type="file"
                      accept="image/*"
                      onChange={(e) => runOcr(e.target.files?.[0])}
                      style={{ display: "none" }}
                    />
                  </div>
                </>
              )}
              {ocrBusy && (
                <div className="ocrProgress">
                  <div className="spinner" />
                  <div>{ocrStatus || "인식 중…"}</div>
                </div>
              )}
              {ocrRows && !ocrBusy && (
                <>
                  {ocrPreview && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={ocrPreview} alt="스크린샷 미리보기" className="ocrPreview" />
                  )}
                  <p className="hint" style={{ marginTop: 8 }}>
                    왼쪽 칸부터 1팀 → 8팀 순서 그대로 <b>TS 점수만</b> 반영합니다. 인식하지
                    못한 칸은 <b style={{ color: "var(--gold)" }}>비어 있으니 직접 입력</b>
                    하세요 — 입력한 값도 그대로 반영됩니다. 빈 칸과 등록된 팀이 없는 칸은
                    제외됩니다. 반영 대상 라운드:{" "}
                    <b style={{ color: "var(--gold)" }}>
                      R{liveDraft?.round || liveRoundInput}
                    </b>
                  </p>
                  <div className="ocrTableWrap">
                    <table className="ocrTable">
                      <thead>
                        <tr>
                          <th>칸</th>
                          <th style={{ textAlign: "left" }}>팀</th>
                          <th>TS 점수</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ocrRows.map((r, idx) => {
                          const team = board.teams[r.slot - 1];
                          const needInput = team && r.score === ""; // 인식 실패 → 직접 입력
                          return (
                            <tr
                              key={r.slot}
                              className={!team ? "ocrSkipped" : needInput ? "ocrMissing" : ""}
                            >
                              <td>{r.slot}</td>
                              <td style={{ textAlign: "left", fontWeight: 600 }}>
                                {team ? team.name : "(팀 없음 — 제외)"}
                                {needInput && <span className="ocrMissTag">인식 실패</span>}
                              </td>
                              <td>
                                <input
                                  className={`input ${needInput ? "ocrNeedInput" : ""}`}
                                  style={{ width: 80, textAlign: "center" }}
                                  type="number"
                                  step="0.5"
                                  min="0"
                                  value={r.score}
                                  placeholder={needInput ? "직접 입력" : ""}
                                  disabled={!team}
                                  onChange={(e) =>
                                    setOcrRows(
                                      ocrRows.map((x, i) =>
                                        i === idx ? { ...x, score: e.target.value } : x
                                      )
                                    )
                                  }
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="adminRow" style={{ marginTop: 14 }}>
                    <button className="primarySmBtn" onClick={applyOcr}>
                      초안에 넣기
                    </button>
                    <button className="ghostSmBtn" onClick={() => setOcrRows(null)}>
                      다른 스크린샷
                    </button>
                    <button className="ghostSmBtn" onClick={() => setOcrOpen(false)}>
                      닫기
                    </button>
                  </div>
                </>
              )}
              {!ocrRows && !ocrBusy && (
                <button
                  className="ghostSmBtn"
                  style={{ marginTop: 12 }}
                  onClick={() => setOcrOpen(false)}
                >
                  닫기
                </button>
              )}
            </div>
          </div>
        )}

        {copyText !== null && (
          <div className="modalOverlay" onClick={() => setCopyText(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3 className="adminTitle">직접 복사</h3>
              <p className="hint" style={{ margin: "0 0 10px" }}>
                자동 복사가 차단된 환경입니다. 아래 내용을 전체 선택 후 복사해 주세요.
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
          팀은 닉네임으로 자동 식별됩니다 · 15초마다 자동으로 최신 기록을 불러옵니다
        </footer>
      </div>
    </div>
  );
}
