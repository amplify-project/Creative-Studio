
import "server-only";
import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "../dbbackend/prisma";
import { requireAdmin } from "../dbbackend/rbac";
import { revalidatePath } from "next/cache";

async function createSpace(formData: FormData) {
  "use server";
  const session = await requireAdmin();
  const name = String(formData.get("name") || "").trim();
  if (!name) throw new Error("Name is required");
  await prisma.space.create({ data: { name, ownerId: (session as any).uid } });
  revalidatePath("/admin");
}

async function assignHostByEmail(spaceId: string, formData: FormData) {
  "use server";
  await requireAdmin();

  const email = String(formData.get("email") || "").trim().toLowerCase();
  if (!email) throw new Error("Email required");

  // Buscar o crear usuario directamente
  let user = await prisma.user.findUnique({ where: { email }, select: { id: true } });

  if (!user) {
    // Crear usuario automáticamente
    const nameFromEmail = email.split("@")[0];
    user = await prisma.user.create({
      data: {
        email,
        name: nameFromEmail,
        globalRole: "user", // o "host" si prefieres
      },
      select: { id: true },
    });
  }

  // Asignar como host del space
  await prisma.spaceMember.upsert({
    where: { spaceId_userId: { spaceId, userId: user.id } },
    create: { spaceId, userId: user.id, role: "host" },
    update: { role: "host" },
  });

  revalidatePath("/admin");
}

async function removeHost(spaceId: string, userId: string) {
  "use server";
  await requireAdmin();
  await prisma.spaceMember.deleteMany({ where: { spaceId, userId, role: "host" } });
  revalidatePath("/admin");
}

export default async function AdminPage() {
  await requireAdmin();

  const spaces = await prisma.space.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      owner: { select: { email: true } },
      members: { where: { role: "host" }, include: { user: { select: { email: true } } } },
      _count: { select: { sessions: true } },
    },
  });

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <div className="flex gap-2">
          <Link href="/admin/bugs" className="btn">Bug Reports</Link>
          <Link href="/admin/connections" className="btn">Connection Events</Link>
          <Link href="/admin/users" className="btn">Users & Roles</Link>
        </div>
      </header>

      <form action={createSpace} className="flex gap-2 items-end border rounded p-3">
        <div className="flex flex-col">
          <label className="text-sm">New Space name</label>
          <input className="input" name="name" placeholder="e.g. Classroom A" required />
        </div>
        <button className="btn" type="submit">Create Space</button>
      </form>

      <section className="space-y-4">
        {spaces.map(s => (
          <div key={s.id} className="border rounded p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-zinc-500">
                  ID: {s.id} · {s._count.sessions} sessions · Owner: {s.owner?.email ?? "—"}
                </div>
              </div>
              <div className="flex gap-2">
                <Link className="btn" href={`/spaces/${s.id}`}>Open Space</Link>
                <Link className="btn" href={`/spaces/${s.id}/sessions`}>Manage Sessions</Link>
              </div>
            </div>

            <div>
              <div className="font-medium mb-1">Hosts</div>
              <ul className="list-disc ml-5 text-sm">
                {s.members.map(m => (
                  <li key={m.id} className="flex items-center gap-2">
                    {m.user?.email ?? m.userId}
                    <form action={removeHost.bind(null, s.id, m.userId)} className="inline">
                      <button className="link" type="submit">Remove</button>
                    </form>
                  </li>
                ))}
                {s.members.length === 0 && <li className="text-zinc-500">No hosts yet</li>}
              </ul>
            </div>

            <form action={assignHostByEmail.bind(null, s.id)} className="flex gap-2">
              <input className="input" name="email" type="email" placeholder="host@example.com" required />
              <button className="btn" type="submit">Add Host</button>
            </form>
          </div>
        ))}
        {spaces.length === 0 && <div className="text-sm text-zinc-500">No spaces yet.</div>}
      </section>
    </div>
  );
}
