import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { signInvite } from "../../../dbbackend/invites";

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "controller"].includes(String(token.globalRole))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { sessionId, role, endpointTag, ttlMinutes } = await req.json();
  if (!sessionId || !role) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const jwt = await signInvite({ sessionId, role, endpointTag }, ttlMinutes ?? 240);
  const url = `${process.env.APP_BASE_URL}/signin?invite=${encodeURIComponent(jwt)}`;

  return NextResponse.json({ ok: true, invite: jwt, url });
}