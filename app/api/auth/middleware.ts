import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";

const ADMIN_PREFIX = "/admin";
const CONTROLLER_PREFIX = "/spaces";

export async function middleware(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const { pathname, search } = req.nextUrl;

  // require auth
  if (!token) {
    const url = req.nextUrl.clone();
    console.log("Middleware routing")
    url.pathname = "/signin";
    url.search = search; // keep invite/room/spaceId
    return NextResponse.redirect(url);
  }

  // Admin gate
  if (pathname.startsWith(ADMIN_PREFIX) && token.globalRole !== "admin") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // Controller gate
  if (pathname.startsWith(CONTROLLER_PREFIX) && !["admin", "controller"].includes(String(token.globalRole))) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/token/*","/admin/:path*", "/spaces/:path*","/api/auth/*","/host/:path*","/participant/:path*"],
};
