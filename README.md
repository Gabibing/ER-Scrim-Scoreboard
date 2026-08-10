# 이터널리턴 스크림 점수판

인게임 결과 CSV(GameResult_.csv)를 업로드해 라운드별 점수를 자동 집계하는 비공개 스크림 점수판입니다.

- 팀당 `tournament total score`를 한 번씩만 합산
- 팀명이 판마다 바뀌어도 닉네임 2명 이상 일치로 같은 팀 인식
- 추측 불가능한 전용 URL, 검색엔진 비노출
- 관리 PIN으로만 업로드·패널티·팀명 수정 가능
- 디스코드에 링크를 올리면 현재 순위가 임베드로 표시

## 배포 방법 (Vercel + Upstash Redis, 무료)

### 1. GitHub에 올리기

```bash
cd er-scrim-board
git init
git add .
git commit -m "scrim board"
```

GitHub에서 새 저장소를 만든 뒤(비공개 권장):

```bash
git remote add origin https://github.com/내아이디/er-scrim-board.git
git branch -M main
git push -u origin main
```

### 2. Vercel에 배포

1. https://vercel.com 에 GitHub 계정으로 로그인
2. **Add New → Project** → 방금 올린 저장소 **Import**
3. 설정은 그대로 두고 **Deploy** (이 시점엔 DB가 없어 페이지가 오류나도 정상)

### 3. Upstash Redis 연결

1. Vercel 프로젝트 → **Storage** 탭 → **Create Database** → **Upstash for Redis** 선택
2. 무료 플랜으로 생성하고 프로젝트에 **Connect**
3. 환경 변수(`KV_REST_API_URL`, `KV_REST_API_TOKEN` 등)가 자동 주입됩니다
4. **Deployments** 탭에서 최신 배포의 ⋯ 메뉴 → **Redeploy**

### 4. 사용

1. `https://프로젝트명.vercel.app` 접속 → 스크림 이름 + 관리 PIN 입력 → 점수판 생성
2. 발급된 `/b/무작위코드` 링크를 디스코드에 공유
3. 매 라운드가 끝나면 CSV를 드래그해서 업로드

## 로컬 개발

`.env.local` 파일에 Upstash 콘솔의 REST 정보 입력:

```
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

```bash
npm install
npm run dev
```
