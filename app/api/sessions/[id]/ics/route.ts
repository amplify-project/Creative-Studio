import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { prisma } from "../../../../dbbackend/prisma";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params; 
  const s = await prisma.sessionDomain.findUnique({
    where: { id },
    include: {
      roles: { include: { user: { select: { email: true } } } },
    },
  });

  if (!s) return new NextResponse("Session not found", { status: 404 });
  if (!s.startAt) return new NextResponse("No start date", { status: 400 });

  // iCalendar UTC (yyyyMMddTHHmmssZ). Sessions have no end time yet: an hour,
  // not DTEND = DTSTART, which calendars show as a zero-length event.
  const toIcs = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const start = toIcs(s.startAt);
  const end = toIcs(s.endAt ?? new Date(s.startAt.getTime() + 60 * 60 * 1000));
  // When this file was generated, as RFC 5545 means it — not the event start.
  const stamp = toIcs(new Date());

  // Base URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // Generar invitaciones .ics por usuario con rol participant
  const events: string[] = [];

  for (const r of s.roles) {
    if (r.role !== "participant" || !r.user?.email) continue;

    // Crear JWT personalizado
    const jwtToken = jwt.sign(
      {
        sessionId: s.id,
        role: "participant",
        email: r.user.email,
      },
      process.env.NEXTAUTH_SECRET!,
      { expiresIn: "30d" }
    );

    const inviteUrl = `${baseUrl}/signin?invite=${jwtToken}`;

    const ics = [
      "BEGIN:VEVENT",
      `UID:${s.id}-${r.user.email}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${s.name}`,
      `DESCRIPTION:Join via ${inviteUrl}`,
      `URL:${inviteUrl}`,
      "END:VEVENT",
    ].join("\r\n");

    events.push(ics);
  }

  // Combine all into a VCALENDAR
  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Portable AMP//EN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");

  return new NextResponse(icsContent, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${s.name}.ics"`,
    },
  });
}
