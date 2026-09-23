"use client";

import { ReactNode } from "react";

interface PopupMessageProps {
  message: string;
  icon?: ReactNode;
  type?: "error" | "info" | "success";
  onClose?: () => void;
}

export default function PopupMessage({ message, icon, type = "info", onClose }: PopupMessageProps) {
  // Colores según tipo
  const bgColor = {
    error: "bg-red-600",
    info: "bg-blue-600",
    success: "bg-green-600",
  }[type];

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" style={{"top":"40%","left":"40%"}}>
      <div
        className={`
          max-w-sm w-full ${bgColor} text-white rounded-xl shadow-2xl p-6 flex flex-col items-center gap-4
          transform scale-90 animate-in fade-in-zoom
        `}
      >
        {icon && <div className="text-5xl">{icon}</div>}
        <p className="text-center text-lg font-semibold">{message}</p>
        <button
          onClick={onClose}
          className="
            mt-3 bg-white text-gray-400 font-semibold px-6 py-3 rounded-lg shadow-md
            hover:bg-gray-100 hover:scale-105 transition-all duration-200
          ">
          OK
        </button>
      </div>
    </div>
  );
}
