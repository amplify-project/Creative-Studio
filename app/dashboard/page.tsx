// app/dashboard/page.tsx
import "server-only";
import { getServerSession, type Session } from "next-auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authOptions } from "../api/auth/auth";
import SignOutButton from "../../components/ui/signOutButton";

type AppSession = Session & { uid?: string; globalRole?: "admin" | "host" | "user" };

type Capability =
  | "admin_users"
  | "admin_spaces"
  | "host_spaces"
  | "create_session"
  | "join_session";

function capsFor(role: "admin" | "host" | "user"): Capability[] {
  if (role === "admin") return ["admin_users", "admin_spaces", "create_session", "join_session"];
  if (role === "host")  return ["host_spaces", "create_session", "join_session"];
  return ["join_session"];
}

export default async function DashboardPage() {
  const session = (await getServerSession(authOptions)) as AppSession | null;
  if (!session) redirect("/signin");

  const role = (session.globalRole ?? "user") as "admin" | "host" | "user";
  const caps = capsFor(role);

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-zinc-500">
            Signed in as <strong>{session.user?.email}</strong> · Role: <strong>{role}</strong>
          </p>
        </div>
        <SignOutButton />
      </header>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {/* ADMIN */}
        {caps.includes("admin_users") && (
          <Card title="Users & Roles" desc="Manage global roles" href="/admin/users" />
        )}
        {caps.includes("admin_spaces") && (
          <Card title="All Spaces" desc="Create & manage spaces" href="/admin" />
        )}

        {/* HOST */}
        {caps.includes("host_spaces") && (
          <Card title="My Spaces" desc="Browse your spaces & sessions" href="/spaces" />
        )}

        {/* SHARED (Admin & Host) */}
        {caps.includes("create_session") && (
          <Card title="Create Session" desc="Schedule a session in a space" href="/spaces" />
        )}

        {/* EVERYONE */}
        {caps.includes("join_session") && (
          <Card title="Join Session" desc="Enter with your assigned session" href="/participant" />
        )}
      </div>
    </div>
  );
}

function Card({ title, desc, href }: { title: string; desc: string; href: string }) {
  return (
    <Link href={href} className="block rounded-lg border p-4 hover:shadow transition">
      <div className="font-medium">{title}</div>
      <div className="text-sm text-zinc-500">{desc}</div>
    </Link>
  );
}
