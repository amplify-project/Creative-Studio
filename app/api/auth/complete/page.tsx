import { redirect } from "next/navigation";
import { getServerSession, type Session } from "next-auth";
import { authOptions } from "../../auth/auth";
import { prisma } from "../../../dbbackend/prisma";
import jwt from "jsonwebtoken";
import { cookies } from "next/headers"; 

type SearchParams = Record<string, string | string[] | undefined>;
type AppSession = Session & {
  uid?: string;
  globalRole?: string;
  sessionId?: string;
  role?: string;
  inviteEmail?: string;
};

export default async function AuthCompletePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const session = (await getServerSession(authOptions)) as AppSession | null;
  if (!session) redirect("/signin");

  const uid = session.uid!;
  const email = session.user?.email?.toLowerCase();
  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();

  // 🔹 1. Leer el token de la cookie (no de la URL)
  const cookieStore = await cookies();
  const inviteCookie = cookieStore.get("invite_token")?.value;

  // 🔹 2. Decodificar si existe
  let inviteData: any = null;
  if (inviteCookie) {
    try {
      inviteData = jwt.verify(inviteCookie, process.env.NEXTAUTH_SECRET!);
      console.log("✅ inviteData:", inviteData);
    } catch (err) {
      console.warn("⚠️ Invite token inválido:", err);
    }
  }

  // 🔹 3. (Opcional) eliminar cookie una vez usada
  // 👇 No se puede borrar directamente desde server components, 
  // pero puedes hacer que expire con un Set-Cookie desde un route handler 
  // si quieres limpiar el estado.

  // 🔹 4. Lógica de redirección según el token
  if (inviteData?.sessionId && email === adminEmail) {
    const found = await prisma.session.findUnique({
      where: { id: inviteData.sessionId },
    });

    if (found) {
      console.log("✅ Admin accede a su session:", found.id);
      await ensureAgentsForRoom(found.id);
      redirect(`/host?sessionId=${found.id}`);
    }
  }

  if (inviteData?.sessionId && inviteData?.role === "participant") {
    redirect(`/participant?sessionId=${inviteData.sessionId}`);
  }
  console.log(email,adminEmail);
  if (email === adminEmail) session.globalRole = "admin"; 
  redirect("/dashboard");
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
  const createRes = await fetch(`${process.env.APP_BASE_URL}/api/setup-agent`, {
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
