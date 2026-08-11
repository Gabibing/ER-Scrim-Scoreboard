"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [pin, setPin] = useState("");
  const [mode, setMode] = useState("scrim");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const exampleTitle = new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
  }).format(new Date());

  const create = async () => {
    setErr(null);
    if (!title.trim() || pin.length < 4) {
      setErr("이름과 4자리 이상 관리 PIN을 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, pin, mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "생성에 실패했습니다.");
      try {
        sessionStorage.setItem(`er-pin:${data.slug}`, pin); // 만든 사람은 바로 관리자
      } catch {}
      router.push(`/b/${data.slug}`);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="setupWrap">
        <div className="eyebrow">ETERNAL RETURN</div>
        <h1 className="setupTitle">점수판 만들기</h1>
        <p className="setupDesc">
          생성하면 추측할 수 없는 전용 URL이 발급됩니다. 그 링크를 아는 사람만 점수판을 볼 수
          있고, 관리(업로드·패널티)는 PIN을 아는 사람만 할 수 있어요. 생성 후에는 링크를 꼭
          기억해 두세요. 링크를 잊어버리면 점수판을 다시 열 수 없어요.
        </p>
        <label className="label">종류</label>
        <div className="modePick">
          <button
            className={`modeCard ${mode === "scrim" ? "on" : ""}`}
            onClick={() => setMode("scrim")}
          >
            <b>스크림</b>
            <span>
              라운드 CSV 업로드로 점수를 집계하는 가벼운 점수판. 디스코드 공유·패널티 기능
              포함.
            </span>
          </button>
          <button
            className={`modeCard ${mode === "tourney" ? "on" : ""}`}
            onClick={() => setMode("tourney")}
          >
            <b>대회</b>
            <span>
              기본 점수판, 실시간 점수 입력, 스크린샷 TS 인식, OBS 오버레이, 결과 그래픽.
            </span>
          </button>
        </div>
        <label className="label">이름</label>
        <input
          className="input"
          style={{ marginBottom: 16 }}
          placeholder={`예) ${exampleTitle} ${mode === "tourney" ? "자낳대" : "자율 스크림"}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="label">관리 PIN (4자리 이상)</label>
        <input
          className="input"
          style={{ marginBottom: 16 }}
          type="password"
          placeholder="관리자만 아는 번호"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <button className="primaryBtn" onClick={create} disabled={busy}>
          {busy ? "생성 중…" : mode === "tourney" ? "대회 점수판 생성" : "스크림 점수판 생성"}
        </button>
        {err && <div className="errMsg" style={{ marginTop: 14 }}>{err}</div>}
      </div>
    </div>
  );
}
