import { SignJWT, jwtVerify } from "jose";
import { prisma } from "./prisma";

const INVITE_SECRET = new TextEncoder().encode(process.env.INVITE_JWT_SECRET!);

type InvitePayload = {
  sessionId: string;
  role: "host" | "participant" | "cohost" | "viewer";
  endpointTag?: string;
};

export async function signInvite(p: InvitePayload, ttlMinutes = 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlMinutes * 60;
  const jwt = await new SignJWT({ ...p })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(exp)
    .setIssuedAt()
    .sign(INVITE_SECRET);

  await prisma.inviteToken.create({
    data: {
      sessionId: p.sessionId,
      role: p.role,
      endpointTag: p.endpointTag,
      jwt,
      expiresAt: new Date(exp * 1000),
    },
  });

  return jwt;
}

export async function verifyInvite(jwt: string) {
  const { payload } = await jwtVerify(jwt, INVITE_SECRET, { algorithms: ["HS256"] });

  const row = await prisma.inviteToken.findFirst({ where: { jwt } });
  if (!row) throw new Error("Invite not found");
  if (row.consumedAt) throw new Error("Invite already consumed");
  if (row.expiresAt < new Date()) throw new Error("Invite expired");

  return {
    sessionId: String(payload.sessionId),
    role: String(payload.role) as InvitePayload["role"],
    endpointTag: (payload.endpointTag as string) || undefined,
    exp: payload.exp as number,
  };
}

export async function redeemInvite(jwt: string, userId: string) {
  const { sessionId, role, endpointTag } = await verifyInvite(jwt);

  await prisma.sessionRole.upsert({
    where: { userId_sessionId: { userId, sessionId } },
    create: { userId, sessionId, role },
    update: { role },
  });

  // Mark invite consumed (one-time); remove if you want multi-use
  await prisma.inviteToken.update({ where: { jwt }, data: { consumedAt: new Date() } });

  return { ok: true, role, sessionId, endpointTag };
}
