import NextAuth, { type NextAuthOptions } from "next-auth";
import Google from "next-auth/providers/google";
import Github from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "../../dbbackend/prisma";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },

  providers: [
    Google({
      clientId: process.env.GOOGLE_ID!,
      clientSecret: process.env.GOOGLE_SECRET!,
      authorization: {
        params: {
          prompt: "select_account",
          access_type: "offline",
          response_type: "code",
        },
      },
    }),
    Github({
      clientId: process.env.GITHUB_ID!,
      clientSecret: process.env.GITHUB_SECRET!,
    }),
  ],

  callbacks: {
    /**
     * 🔹 Vincula automáticamente la cuenta Google
     * si ya existe un usuario con el mismo email en la base de datos.
     */
    async signIn({ user, account }) {
      if (user?.email) {
        const existing = await prisma.user.findUnique({
          where: { email: user.email },
          include: { accounts: true },
        });
        const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
        console.log("signing as...",adminEmail, user.email)
        if (adminEmail === user.email) {
          await prisma.user.upsert({
            where: { email: user.email },
            update: { globalRole: 'admin' },
            create: {
              email: user.email,
              name: user.name,
              globalRole: 'admin',
            },
          });
        }
        if (existing && !existing.accounts.some(a => a.provider === account.provider)) {
          await prisma.account.create({
            data: {
              userId: existing.id,
              provider: account.provider,
              providerAccountId: account.providerAccountId,
              type: account.type,
              access_token: account.access_token,
              token_type: account.token_type,
              scope: account.scope,
              id_token: account.id_token,
              expires_at: account.expires_at,
            },
          });
          console.log(`✅ Linked ${account.provider} account for ${user.email}`);
          return true;
        }
      }
      return true; // permitir login normal
    },

    /** 🔹 Cada vez que se emite o actualiza el JWT */
    async jwt({ token, user }) {
      // Si acaba de iniciar sesión, guardar su id
      if (!token.uid && user) token.uid = (user as any).id;

      // Obtener rol global (admin/controller/user)
      if (token.uid) {
        const u = await prisma.user.findUnique({
          where: { id: token.uid as string },
          select: { globalRole: true },
        });

        token.globalRole = u?.globalRole ?? "user";
      }
      return token;
    },

    /** 🔹 Cada vez que se construye la sesión */
    async session({ session, token }) {
      const uid = token.uid as string | undefined;
      let globalRole = token.globalRole ?? "user";
      console.log(token);
      if (uid) {
        if (globalRole === "user") {
          const hostInSpaces = await prisma.spaceMember.findFirst({
            where: { userId: uid, role: "host" },
          });
          console.log(hostInSpaces);
          if (hostInSpaces) globalRole = "host";
        }
      }

      (session as any).uid = uid;
      (session as any).globalRole = globalRole;
      return session;
    },
  },
};
