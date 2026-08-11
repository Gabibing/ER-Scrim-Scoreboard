"use client";

/* 공유/송출용으로 디자인된 결과 점수표.
   - OBS 오버레이(/obs)와 별개의 풀 디자인 그래픽 (1600×900)
   - PNG로 저장 버튼 (html2canvas — 프론트엔드에서만 처리)
   - 화면 크기에 맞춰 자동 축소 표시 */

import { useState, useEffect, useRef, useCallback } from "react";
import { computeStandings, withLive } from "@/lib/score";

const STAGE_W = 1600;
const STAGE_H = 900;

function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    s.onload = () => resolve(window.html2canvas);
    s.onerror = () => reject(new Error("이미지 저장 라이브러리를 불러오지 못했습니다."));
    document.head.appendChild(s);
  });
}

export default function GraphicClient({ slug }) {
  const [board, setBoard] = useState(undefined);
  const [scale, setScale] = useState(0.5);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const stageRef = useRef(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/board/${slug}`, { cache: "no-store" });
        setBoard(res.ok ? (await res.json()).board : null);
      } catch {
        setBoard(null);
      }
    };
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [slug]);

  useEffect(() => {
    const fit = () =>
      setScale(
        Math.min(1, (window.innerWidth - 32) / STAGE_W, (window.innerHeight - 120) / STAGE_H)
      );
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const savePng = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      const h2c = await loadHtml2Canvas();
      const canvas = await h2c(stageRef.current, {
        backgroundColor: "#0b111c",
        scale: 2,
        useCORS: true,
        logging: false,
      });
      const a = document.createElement("a");
      a.download = `${(board?.title || "scrim").replace(/[\\/:*?"<>|]/g, "_")}_결과.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    } catch (e) {
      setErr(e.message || "PNG 저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }, [board]);

  if (board === undefined)
    return (
      <div className="page">
        <div className="loading">결과를 불러오는 중…</div>
      </div>
    );
  if (board === null)
    return (
      <div className="page">
        <div className="setupWrap" style={{ textAlign: "center" }}>
          <h1 className="setupTitle">점수판을 찾을 수 없습니다</h1>
        </div>
      </div>
    );
  if (board.mode !== "tourney")
    return (
      <div className="page">
        <div className="setupWrap" style={{ textAlign: "center" }}>
          <h1 className="setupTitle">대회 점수판 전용 기능입니다</h1>
          <p className="setupDesc">결과 그래픽은 대회 모드에서만 제공됩니다.</p>
        </div>
      </div>
    );

  const view = withLive(board);
  const standings = computeStandings(view);
  const rounds = view.rounds || [];
  const liveActive = !!board.live;
  const top3 = standings.slice(0, 3);
  const rest = standings.slice(3);
  const dateStr = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(board.createdAt || Date.now()));
  /* 시상대 배치: 2위 · 1위 · 3위 */
  const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean);

  return (
    <div className="gfxPage">
      <div className="gfxToolbar">
        <button className="primarySmBtn" onClick={savePng} disabled={saving}>
          {saving ? "저장 중…" : "PNG로 저장"}
        </button>
        <span className="hint" style={{ margin: 0 }}>
          1600×900 (저장 시 3200×1800) · 15초마다 자동 갱신
          {liveActive ? " · 진행 중 점수 포함" : ""}
        </span>
        {err && <span className="errMsg" style={{ margin: 0, padding: "4px 10px" }}>{err}</span>}
      </div>

      <div
        className="gfxStageWrap"
        style={{ width: STAGE_W * scale, height: STAGE_H * scale }}
      >
        <div
          ref={stageRef}
          className="gfxStage"
          style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
        >
          <div className="gfxGlow" />
          <div className="gfxHeader">
            <div className="gfxEyebrow">ETERNAL RETURN · TOURNAMENT RESULT</div>
            <h1 className="gfxTitle">{board.title}</h1>
            <div className="gfxMeta">
              {dateStr} · {rounds.length}라운드
              {liveActive && <span className="gfxLiveTag">LIVE 진행 중</span>}
            </div>
          </div>

          <div className="gfxPodium">
            {podiumOrder.map((s) => {
              const place = standings.indexOf(s);
              return (
                <div key={s.team.id} className={`gfxCard gfxPlace${place}`}>
                  <div className="gfxPlaceNum">
                    {place === 0 ? "1ST" : place === 1 ? "2ND" : "3RD"}
                  </div>
                  <div className="gfxCardTeam">{s.team.name}</div>
                  <div className="gfxCardScore">
                    {s.total}
                    <span className="gfxPt">PT</span>
                  </div>
                  <div className="gfxCardKs">
                    TOTAL KS <b>{s.ks}</b>
                  </div>
                  <div className="gfxCardRounds">
                    {s.perRound.map((v, ri) => (
                      <span key={ri} className={rounds[ri]?.isLive ? "gfxRLive" : ""}>
                        {v === null ? "–" : v}
                      </span>
                    ))}
                  </div>
                  {s.penalty > 0 && <div className="gfxCardPen">패널티 -{s.penalty}</div>}
                </div>
              );
            })}
          </div>

          {rest.length > 0 && (
            <div className="gfxTable">
              <div className="gfxTableHead">
                <span className="gfxColRank">#</span>
                <span className="gfxColTeam">TEAM</span>
                {rounds.map((r) => (
                  <span key={r.round} className="gfxColR">
                    R{r.round}
                    {r.isLive ? "•" : ""}
                  </span>
                ))}
                <span className="gfxColKs">TOTAL KS</span>
                <span className="gfxColPen">PENALTY</span>
                <span className="gfxColTotal">TOTAL POINTS</span>
              </div>
              {rest.map((s, i) => (
                <div key={s.team.id} className="gfxTableRow">
                  <span className="gfxColRank">{i + 4}</span>
                  <span className="gfxColTeam">{s.team.name}</span>
                  {s.perRound.map((v, ri) => (
                    <span key={ri} className={`gfxColR ${rounds[ri]?.isLive ? "gfxRLive" : ""}`}>
                      {v === null ? "–" : v}
                    </span>
                  ))}
                  <span className="gfxColKs">{s.ks > 0 ? s.ks : "–"}</span>
                  <span className="gfxColPen">{s.penalty > 0 ? `-${s.penalty}` : "–"}</span>
                  <span className="gfxColTotal">{s.total}</span>
                </div>
              ))}
            </div>
          )}

          {standings.length === 0 && (
            <div className="gfxEmpty">아직 집계된 라운드가 없습니다</div>
          )}
        </div>
      </div>
    </div>
  );
}
