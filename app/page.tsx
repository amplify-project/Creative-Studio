"use client";
import { Suspense, useEffect } from "react";
import { signIn, signOut, getSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import "./globals.css";
function SignInInner() {
  const sp = useSearchParams();
  const q = sp.toString();
  const invite = sp.get("invite");
  const callbackUrl = invite
    ? `/api/invite/verify?token=${invite}`
    : `/api/auth/complete`;
  console.log(callbackUrl);
  // 👇 Cierra sesión automáticamente al entrar en /signin
  useEffect(() => {
    getSession().then((s) => {
      if (s) signOut({ callbackUrl: "/signin" });
    });
  }, []);

  return (
    <div className="min-h-screen grid place-items-center p-6 bg-zinc-50">
      <div className="w-full max-w-md p-6 card shadow-lg rounded-lg space-y-4">
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
                prompt: "select_account",
                state:invite
              })
            }
          >
            Continue with Google
          </button>
	  <button className="btn w-full" onClick={() => signIn("github",{
	  	callbackUrl,
                prompt: "select_account",
                state:invite
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
