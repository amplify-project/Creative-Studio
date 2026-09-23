import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { prisma } from "../../../dbbackend/prisma";
import { RoomServiceClient } from "livekit-server-sdk";

const livekit = new RoomServiceClient(
  process.env.LIVEKIT_URL!,
  process.env.LIVEKIT_API_KEY!,
  process.env.LIVEKIT_API_SECRET!
);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requesterId = (session as any).uid;

  const { sessionId, livekitIdentity } = await req.json();
  const sessionRoles = await prisma.sessionRole.findMany({
    where: { sessionId },
    select: {
      userId: true,
      user: {
        select: {
          name: true, // el nombre que vamos a comparar con identity
        },
      },
    },
  });

  // 2️⃣ Buscar el userId que coincide con el identity
  const matchedRole = sessionRoles.find(
    (r) => r.user.name === livekitIdentity
  );

  const targetUserId = matchedRole?.userId;

  console.log("Target userId:", targetUserId);

  // 1️⃣ comprobar que requester es host
  const requesterRole = await prisma.sessionRole.findUnique({
    where: {
      sessionId_userId: {
        sessionId,
        userId: requesterId,
      },
    },
  });

  if (!requesterRole || requesterRole.role !== "host") {
    return NextResponse.json({ error: "Only host can remove users" }, { status: 403 });
  }

  // 2️⃣ borrar de la sesión
  const deleted = await prisma.sessionRole.deleteMany({
    where: { sessionId, userId: targetUserId },
  });

  console.log("Número de roles eliminados:", deleted.count);

  // 3️⃣ expulsar en tiempo real de LiveKit
  try {
    await livekit.removeParticipant(sessionId, livekitIdentity);
  } catch (e) {
    // si ya estaba desconectado, no pasa nada
    console.warn("LiveKit removeParticipant failed:", e);
  }

  return NextResponse.json({ success: true });
}
