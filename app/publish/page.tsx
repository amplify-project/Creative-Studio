import PublishClient from "./PublishClient";

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const identity    = (params?.identity    as string) ?? "student";
  const displayName = (params?.name        as string) ?? identity;

  return <PublishClient identity={identity} displayName={displayName} />;
}