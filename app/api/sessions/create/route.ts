import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { prisma } from "../../../dbbackend/prisma";

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.redirect(new URL("/signin", req.url));
  if (!["admin", "controller"].includes(String(token.globalRole))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const formData = await req.formData();
  const spaceId = String(formData.get("spaceId"));
  const name = String(formData.get("name"));
  const startAtStr = formData.get("startAt") as string | null;
  const startAt = startAtStr ? new Date(startAtStr) : null;

  await prisma.session.create({
    data: { spaceId, name, startAt: startAt ?? undefined },
  });

  return NextResponse.redirect(new URL(`/spaces/${spaceId}/sessions`, req.url));
}
