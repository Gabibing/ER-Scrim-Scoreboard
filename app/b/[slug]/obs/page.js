import ObsClient from "./obs-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "스크림 점수 오버레이",
  robots: { index: false, follow: false },
};

export default async function ObsPage({ params }) {
  const { slug } = await params;
  return <ObsClient slug={slug} />;
}
