// app/spaces/[spaceId]/sessions/page.tsx
import "server-only";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { prisma } from "../../../dbbackend/prisma";
import { requireHostOfSpace } from "../../../dbbackend/rbac";
import { format } from "date-fns";
import jwt from "jsonwebtoken";
import CopyLinkButton from "../../../../components/ui/CopyLinkButton";

type Params = { spaceId: string };
const norm = (v: unknown) => String(v ?? "").trim();
const normEmail = (v: unknown) => norm(v).toLowerCase();

// ---------------- Server Actions ----------------
async function createSession(spaceId: string, formData: FormData) {
  "use server";
  await requireHostOfSpace(spaceId);

  const name = String(formData.get("name") || "").trim();
  const startAtRaw = String(formData.get("startAt") || "").trim();
  const startAt = startAtRaw ? new Date(startAtRaw) : undefined;
  if (!name) throw new Error("Name required");

  const assistantEnabled = formData.get("assistantEnabled") === "on";

  const newSession = await prisma.sessionDomain.create({
    data: { name, spaceId, startAt, assistantEnabled },
  });

  try {
    const res = await fetch(`${process.env.APP_BASE_URL}/api/setupAgent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: newSession.id }),
    });

    const data = await res.json();

    if (!data.success) {
      console.error("⚠️ Error launching agents:", data);
      throw new Error("Failed to dispatch agents");
    }

    console.log(`✅ Agents launched for room ${name}`, data.agents);
  } catch (err) {
    console.error("❌ Error dispatching agents:", err);
  }

  revalidatePath(`/spaces/${spaceId}/sessions`);
}

async function deleteSession(spaceId: string, sessionId: string) {
  "use server";
  await requireHostOfSpace(spaceId);

  // Clear the roles first, or the delete throws and the row stays.
  //
  // `SessionRole.session` is a REQUIRED relation declared with no `onDelete`.
  // This is MongoDB, where Prisma emulates referential actions in the client
  // rather than in the database, and the emulated default for a required
  // relation is `Restrict` — so deleting a session that has anyone assigned
  // failed with P2014. Which is every session anybody actually used: a session
  // with no roles is one nobody was invited to, and that is exactly the one you
  // never need to delete. Hence "Delete works on the empty ones only", which is
  // how this looked from the outside.
  //
  // Done here rather than by adding `onDelete: Cascade` to the schema so the
  // fix does not depend on a `prisma generate` + `db push` reaching every
  // deployment. Transactional: Mongo runs as a replica set (`--replSet rs0`,
  // and the connection string asks for it), so this is atomic — losing the role
  // assignments to a half-done delete would be worse than not deleting.
  await prisma.$transaction([
    prisma.sessionRole.deleteMany({ where: { sessionId } }),
    prisma.sessionDomain.delete({ where: { id: sessionId } }),
  ]);

  // NOTE: Play2Gether's on-disk session data is keyed by this id and is NOT
  // removed here — see the open retention work. Deleting the row orphans it.
  revalidatePath(`/spaces/${spaceId}/sessions`);
}

/**
 * Toggle the assistant on an existing session.
 *
 * There was no way to change this after creation, and it is not a create-time
 * property in any meaningful sense: `/api/token` reads `assistantEnabled` fresh
 * on every token request and decides which agents to dispatch from it, so the
 * value is consulted continuously for the life of the session.
 *
 * It therefore takes effect on the NEXT join. It does not reach into a room
 * that is already running: an agent already dispatched stays, and one not yet
 * dispatched arrives with the next participant to ask for a token.
 */
async function setAssistantEnabled(
  spaceId: string,
  sessionId: string,
  formData: FormData
) {
  "use server";
  await requireHostOfSpace(spaceId);
  await prisma.sessionDomain.update({
    where: { id: sessionId },
    data: { assistantEnabled: formData.get("assistantEnabled") === "on" },
  });
  revalidatePath(`/spaces/${spaceId}/sessions`);
}

async function addRoleByEmail(
  spaceId: string,
  role: "host" | "participant",
  formData: FormData
) {
  "use server";
  await requireHostOfSpace(spaceId);

  const sessionId = norm(formData.get("sessionId"));
  const email = normEmail(formData.get("email"));
  if (!sessionId || !email) throw new Error("sessionId and email required");

  // 🔹 Buscar o crear usuario
  let user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!user) {
    const nameFromEmail = email.split("@")[0];
    user = await prisma.user.create({
      data: {
        email,
        name: nameFromEmail,
        globalRole: "user", // o "participant" si quieres diferenciar
      },
      select: { id: true },
    });
  }

  // 🔹 Asignar el rol en la sesión
  await prisma.sessionRole.upsert({
    where: { sessionId_userId: { sessionId, userId: user.id } },
    create: { sessionId, userId: user.id, role },
    update: { role },
  });

  revalidatePath(`/spaces/${spaceId}/sessions`);
}
/**
 * The link you send someone so they land in this session.
 *
 * Shared by the copy button, the Google Calendar entry and (by the same
 * convention) `/api/sessions/[id]/ics`, so the three cannot drift apart.
 *
 * It is NOT a capability: `/api/invite/verify` looks the visitor up in
 * `sessionRole` and refuses anyone who has not already been assigned — the
 * token only says which session to send them to once signed in. So this is safe
 * to paste into a group chat, and equally it is useless to anyone you have not
 * added first. Do not "fix" that asymmetry without reading the verify route.
 */
function buildInviteUrl(session: any) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const token = jwt.sign(
    { sessionId: session.id, role: "participant" },
    process.env.NEXTAUTH_SECRET!,
    { expiresIn: "30d" }
  );
  return `${baseUrl}/signin?invite=${token}`;
}

function buildGoogleCalendarLink(session: any) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const inviteUrl = buildInviteUrl(session);

  // 🔹 Convertir fechas a formato Google Calendar (UTC)
  const start = session.startAt
    ? format(new Date(session.startAt), "yyyyMMdd'T'HHmmss'Z'")
    : format(new Date(), "yyyyMMdd'T'HHmmss'Z'");
  const end = session.endAt
    ? format(new Date(session.endAt), "yyyyMMdd'T'HHmmss'Z'")
    : format(new Date(session.startAt + 60 * 60 * 1000), "yyyyMMdd'T'HHmmss'Z'");

  // 🔹 Datos base del evento
  const title = encodeURIComponent(session.name);
  const details = encodeURIComponent(`Join the session via ${inviteUrl}`);
  const location = encodeURIComponent(inviteUrl);

  // 🔹 Extraer los emails de los roles asignados
  const emails = session.roles
    ?.map((r: any) => r.user?.email)
    .filter(Boolean);

  // 🔹 Si hay correos, añadirlos al parámetro "add"
  const addParam = emails?.length
    ? `&add=${encodeURIComponent(emails.join(","))}`
    : "";

  // 🔹 Construir la URL final
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${start}/${end}&details=${details}&location=${location}${addParam}`;
}

async function removeRole(spaceId: string, sessionId: string, userId: string) {
  "use server";
  await requireHostOfSpace(spaceId);
  await prisma.sessionRole.delete({
    where: { sessionId_userId: { sessionId, userId } },
  });
  revalidatePath(`/spaces/${spaceId}/sessions`);
}

// ---------------- Page ----------------
export default async function SessionsPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { spaceId } = await params; // Next 15: params es Promise
  await requireHostOfSpace(spaceId);

  // Info del space + sesiones con roles
  const [space, sessions] = await Promise.all([
    prisma.space.findUnique({
      where: { id: spaceId },
      select: { id: true, name: true },
    }),
    prisma.sessionDomain.findMany({
    where: { spaceId },
    orderBy: { createdAt: "desc" },
    include: {
        roles: {
        include: {
            user: { select: { email: true, name: true, id: true } },
        },
        orderBy: { role: "asc" },
        },
    },
    }),
  ]);

  if (!space) return <div className="p-6">Space not found.</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {space.name} — Sessions
        </h1>
        <Link href={`/spaces`} className="link">Back to My Spaces</Link>
      </div>

      {/* Crear sesión */}
      <form action={createSession.bind(null, space.id)} className="flex flex-wrap gap-2 items-end border rounded p-3">
        <div className="flex flex-col">
          <label className="text-sm">Name</label>
          <input className="input" name="name" placeholder="e.g. Lesson 1" required />
        </div>
        <div className="flex flex-col">
          <label className="text-sm">Start at</label>
          <input className="input" type="datetime-local" name="startAt" required />
        </div>
        <div className="flex flex-col">
          <label className="text-sm">AI assistant</label>
          <label className="flex items-center gap-2 text-sm h-[38px]">
            <input type="checkbox" name="assistantEnabled" value="on" />
            <span title="Analyses participant audio to suggest capture-mode and mic fixes. Costs CPU proportional to active participants.">
              Enable
            </span>
          </label>
        </div>
        <button className="btn" type="submit">Create</button>
      </form>

      {/* Lista de sesiones */}
      <ul className="space-y-5">
        {sessions.map((s) => (
          <li key={s.id} className="border rounded p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-zinc-500">
                  ID: {s.id}
                  {s.roles.length ? ` · ${s.roles.length} assigned` : " · no roles yet"}
                </div>
              </div>
              <div className="flex gap-2">
                <Link href={`/host?sessionId=${s.id}`} className="btn">Open Host</Link>
                <Link href={`/participant?sessionId=${s.id}`} className="btn">Open Participant</Link>
                <CopyLinkButton
                  url={buildInviteUrl(s)}
                  title="Copy the join link for this session. Only works for people already assigned a role below."
                />
                <form action={deleteSession.bind(null, space.id, s.id)}>
                  <button className="btn" type="submit">Delete</button>
                </form>
                {/* 🔹 Nuevo botón para exportar el calendario */}
                <Link
                    href={`/api/sessions/${s.id}/ics`}
                    className="btn"
                    target="_blank"
                >
                    📅 Export .ICS
                </Link>
                <Link
                  href={buildGoogleCalendarLink(s)}
                  target="_blank"
                  className="btn"
                >
                  📅 Add to Google Calendar
                </Link>
              </div>
              
            </div>

            {/* Assistant on/off, editable after creation */}
            <form
              action={setAssistantEnabled.bind(null, space.id, s.id)}
              className="flex items-center gap-3 text-sm"
            >
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="assistantEnabled"
                  value="on"
                  defaultChecked={s.assistantEnabled ?? false}
                />
                <span title="Analyses participant audio to suggest capture-mode and mic fixes. Costs CPU proportional to active participants.">
                  AI assistant
                </span>
              </label>
              {/* A real button, not `.link`: this one commits a form and the
                  page's other actions (Delete, Export, Add to Calendar) are
                  all `.btn`, so a bare text label read as decoration. */}
              <button className="btn" type="submit">Save</button>
              <span className="text-xs text-zinc-500">
                Applies to the next person who joins — it does not change a room already running.
              </span>
            </form>

            {/* Roles asignados */}
            <section className="text-sm">
              <div className="font-medium mb-1">Assigned roles</div>
              <ul className="list-disc ml-5 space-y-1">
                {s.roles.map((r) => (
                  <li key={r.userId} className="flex items-center gap-2">
                    {r.user?.email ?? r.userId} — <b>{r.role}</b>
                    <form action={removeRole.bind(null, space.id, s.id, r.userId)} className="inline">
                      <button className="link" type="submit">Remove</button>
                    </form>
                  </li>
                ))}
                {s.roles.length === 0 && <li className="text-zinc-500">Empty</li>}
              </ul>
            </section>

            {/* Añadir CO-HOST por email */}
            <form action={addRoleByEmail.bind(null, space.id, "host")} className="flex gap-2">
              <input type="hidden" name="sessionId" value={s.id} />
              <input className="input" name="email" type="email" placeholder="cohost@example.com" required />
              <button className="btn" type="submit">Add Co-host</button>
            </form>

            {/* Añadir PARTICIPANT por email */}
            <form action={addRoleByEmail.bind(null, space.id, "participant")} className="flex gap-2">
              <input type="hidden" name="sessionId" value={s.id} />
              <input className="input" name="email" type="email" placeholder="participant@example.com" required />
              <button className="btn" type="submit">Add Participant</button>
            </form>
          </li>
        ))}
        {sessions.length === 0 && <li className="text-sm text-zinc-500">No sessions yet. Create one above.</li>}
      </ul>
    </div>
  );
}
