import { prisma } from "../../dbbackend/prisma";
import { requireAdmin, requireHostOfSpace } from "../../dbbackend/rbac";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

async function renameSpace(spaceId: string, formData: FormData) {
  "use server";
  await requireHostOfSpace(spaceId);
  const name = String(formData.get("name") || "").trim();
  if (!name) throw new Error("Name required");
  await prisma.space.update({ where: { id: spaceId }, data: { name } });
  revalidatePath(`/spaces/${spaceId}`);
}

async function deleteSpace(spaceId: string) {
  "use server";
  await requireAdmin();
  await prisma.space.delete({ where: { id: spaceId } });
  redirect("/spaces");
}

export default async function SpacePage({
  params,
}: {
  params: Promise<{ spaceId: string }>; // 👈 params es Promise
}) {
  const spaceId = (await params).spaceId;
  await requireHostOfSpace(spaceId);
  const space = await prisma.space.findUnique({
    where: { id:spaceId },
    include: { sessions: { orderBy: { createdAt: "desc" } } },
  });
  if (!space) return <div className="p-6">Space not found.</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{space.name}</h1>
        <form action={deleteSpace.bind(null, space.id)}>
          <button className="btn" type="submit">Delete (admin)</button>
        </form>
      </div>

      <form action={renameSpace.bind(null, space.id)} className="flex gap-2">
        <input name="name" defaultValue={space.name} className="input" />
        <button className="btn" type="submit">Rename</button>
      </form>

      <div>
        <h2 className="font-medium mb-2">Sessions</h2>
        <a className="btn" href={`/spaces/${space.id}/sessions`}>Manage sessions</a>
      </div>
    </div>
  );
}
