// app/signin/SignInButtons.tsx
"use client";
import { signIn } from "next-auth/react";

export default function SignInButtons({ callbackUrl }: { callbackUrl: string }) {
  return (
    <div className="min-h-screen grid place-items-center p-6 bg-zinc-50">
      <div className="w-full max-w-md p-6 card shadow-lg rounded-lg">
        <h1 className="text-2xl font-bold text-indigo-600 mb-2 text-center">Portable AMP</h1>
        <p className="text-sm text-zinc-600 mb-4 text-center">Sign in</p>

        <div className="space-y-3">
          <button className="btn w-full" onClick={() => signIn("google", { callbackUrl })}>
            Continue with Google
          </button>
        </div>
      </div>
    </div>
  );
}
