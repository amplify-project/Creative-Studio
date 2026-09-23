import { prisma } from "../dbbackend/prisma";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "../api/auth/auth";
import Link from "next/link";

export default async function MySpacesPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/signin");

  const uid = (session as any).uid as string;
  const role = (session as any).globalRole ?? "user";

  // Admin sees everything; Host sees only where he is member; User sees none
  const spaces = role === "admin"
    ? await prisma.space.findMany({
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { sessions: true } } },
      })
    : await prisma.space.findMany({
        where: { members: { some: { userId: uid, role: "host" } } },
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { sessions: true } } },
      });

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">My Spaces</h1>
      <ul className="space-y-3">
        {spaces.map(s => (
          <li key={s.id} className="p-4 rounded-lg border flex items-center justify-between">
            <div>
              <div className="font-medium">{s.name}</div>
              <div className="text-xs text-zinc-500">ID: {s.id} · {s._count.sessions} sessions</div>
            </div>
            <div className="flex gap-2">
              <Link className="btn" href={`/spaces/${s.id}/sessions`}>Manage Sessions</Link>
            </div>
          </li>
        ))}
        {spaces.length === 0 && <li className="text-sm text-zinc-500">No assigned spaces.</li>}
      </ul>
    </div>
  );
}
