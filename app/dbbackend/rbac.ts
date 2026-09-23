import "server-only";
import { getServerSession } from "next-auth";
import { authOptions } from "../api/auth/auth";
import { redirect } from "next/navigation";
import { prisma } from "./prisma";

export async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/signin");
  const role = (session as any).globalRole ?? "user";
  if (role !== "admin") redirect("/dashboard");
  return session as any; // exposes uid, globalRole
}

export async function requireHostOfSpace(spaceId: string) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/signin");
  const uid = (session as any).uid as string;
  const global = (session as any).globalRole;
  if (global === "admin") return { uid, global };

  const member = await prisma.spaceMember.findFirst({
    where: { spaceId, userId: uid, role: "host" },
    select: { id: true },
  });
  if (!member) redirect("/dashboard");
  return { uid, global };
}
