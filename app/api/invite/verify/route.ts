import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/auth";
import { prisma } from "../../../dbbackend/prisma";
import { platform } from "os";

export async function GET(req: NextRequest) {
  console.log("🔹 [API] Invite GET handler called");
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  console.log("🔸 Token recibido:", token);

  if (!token) {
    console.warn("⚠️ No se recibió token de invitación");
    return NextResponse.redirect(baseUrl+"/signin?error=MissingInviteToken");
  }

  // 1️⃣ Verificar JWT
  let payload: any;
  try {
    payload = jwt.verify(token, process.env.NEXTAUTH_SECRET!);
    console.log("✅ Token verificado correctamente:", payload);
  } catch (err) {
    console.error("❌ Error al verificar token:", err);
    return NextResponse.redirect(baseUrl+"/signin?error=InvalidInvite");
  }

  // 2️⃣ Obtener sesión actual
  console.log("🔹 Verificando sesión actual...");
  const session = await getServerSession(authOptions);
  if (!session) {
    console.warn("⚠️ No hay sesión activa. Redirigiendo a /signin con token");
    return NextResponse.redirect(`${baseUrl}/signin?invite=${token}`);
  }
  console.log("✅ Sesión activa:", session.user?.email);

  const email = session.user?.email?.toLowerCase();
  const userId = (session as any).uid;
  console.log("🧾 Usuario actual:", { email, userId });

  if (!email || !userId) {
    console.error("❌ No se encontró email o userId en la sesión");
    return NextResponse.redirect(baseUrl+"/signin?error=NoUser");
  }

  // 3️⃣ Comprobar si el usuario ya tiene rol en esa sesión
  console.log(`🔹 Buscando rol existente para sessionId=${payload.sessionId}, userId=${userId}`);
  const existing = await prisma.sessionRole.findUnique({
    where: {
      sessionId_userId: {
        sessionId: payload.sessionId,
        userId,
      },
    },
  });

  if (existing) {
    console.log(`ℹ️ El usuario ${email} ya tiene rol '${existing.role}' en la sesión ${payload.sessionId}`);
    payload.role = existing.role;
  } else {
    // 4️⃣ Si no existe, denegarlo
    console.error("❌ No se encontró email o userId en la sesión");
    return NextResponse.redirect(baseUrl+"/signin?error=NoUser");
    
  }
  await ensureAgentsForRoom (payload.sessionId);
  //  Redirigir según el rol
  if (payload.role === "host") {
   
    console.log(`➡️ Redirigiendo al host dashboard para sesión ${payload.sessionId}`);
    return NextResponse.redirect(`${baseUrl}/host?sessionId=${payload.sessionId}`);
  } else {
    console.log(`➡️ Redirigiendo al participant view para sesión ${payload.sessionId}`);
    return NextResponse.redirect(`${baseUrl}/participant?sessionId=${payload.sessionId}`);
  }
}
async function ensureAgentsForRoom(roomId: string) {
  // 1️⃣ Consultar si ya existen agentes
  const res = await fetch(`${process.env.APP_BASE_URL}/api/listAgents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: roomId }),
  });

  const data = await res.json();

  if (data.success && data.agents.length > 1) {
    console.log(`✅ Agents already exist for room ${roomId}`);
    return data.agents;
  }

  // 2️⃣ Si no existen, lanzarlos
  console.log(`⚙️ No agents found for room ${roomId}, creating...`);
  const createRes = await fetch(`${process.env.APP_BASE_URL}/api/setupAgent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: roomId }),
  });

  const createData = await createRes.json();

  if (!createData.success) {
    throw new Error("Failed to dispatch agents");
  }

  console.log(`✅ Agents launched for room ${roomId}`, createData.agents);
  return createData.agents;
}
