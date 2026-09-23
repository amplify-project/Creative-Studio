"use client";

import { Suspense, useEffect, useState } from "react";
import { signIn, signOut, getSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { setCookie, deleteCookie } from "cookies-next";

function SignInInner() {
  const sp = useSearchParams();
  const invite = sp.get("invite") ?? undefined;
  const [loading, setLoading] = useState(false);

  const callbackUrl = invite
    ? `/api/invite/verify?token=${encodeURIComponent(invite)}`
    : `/api/auth/complete`;

  // 🔹 Prepara sesión y cookie antes de iniciar login
  useEffect(() => {
    let mounted = true;

    async function prepareSession() {
      if (!mounted) return;
      setLoading(true);

      if (invite) {
        setCookie("invite_token", invite, { path: "/" });
      } else {
        deleteCookie("invite_token", { path: "/" });
      }

      const sess = await getSession();
      if (sess) {
        await signOut({ redirect: false });
      }

      setLoading(false);
    }

    prepareSession();
    return () => {
      mounted = false;
    };
  }, [invite, callbackUrl]);

  // 🔹 Iniciar sesión con proveedor elegido
  const handleSignIn = (provider: "google" | "github") => {
    setLoading(true);
    signIn(provider, { callbackUrl });
  };

  return (
    <div className="min-h-screen grid place-items-center p-6 bg-zinc-50">
      <div className="w-full max-w-md p-6 card shadow-lg rounded-lg space-y-6">
        <h1 className="text-2xl font-bold text-indigo-600 text-center">
          Creative Studio
        </h1>
        <p className="text-sm text-zinc-600 text-center">
          Choose your account to continue
        </p>
        <div className="space-y-3">
          <button
            className="btn w-full"
            onClick={() =>
              signIn("google", {
                callbackUrl,
                prompt: "select_account"
              })
            }
          >
            Continue with Google
          </button>
          <button className="btn w-full" onClick={() => signIn("github",{
                callbackUrl,
                prompt: "select_account"
          })}>
                Continue with GitHub
          </button>
          </div>

      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <SignInInner />
    </Suspense>
  );
}

