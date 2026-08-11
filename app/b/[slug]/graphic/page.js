import GraphicClient from "./graphic-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "대회 결과 그래픽",
  robots: { index: false, follow: false },
};

export default async function GraphicPage({ params }) {
  const { slug } = await params;
  return <GraphicClient slug={slug} />;
}
