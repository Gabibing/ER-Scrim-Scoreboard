import "./globals.css";

export const metadata = {
  title: "이터널리턴 스크림 점수판",
  robots: { index: false, follow: false }, // 검색엔진 비노출 (URL 아는 사람만)
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
