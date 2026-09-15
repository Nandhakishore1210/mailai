"use client";
import { useEffect } from "react";
import { useUIStore } from "@/store/uiStore";
import { clsx } from "clsx";
import { X } from "lucide-react";

export default function Notifications() {
  const { notifications, removeNotification } = useUIStore();

  return (
    <div className="fixed top-4 right-4 z-[100] space-y-2">
      {notifications.map((n) => (
        <div
          key={n.id}
          className={clsx(
            "flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm text-white min-w-[240px]",
            n.level === "success" && "bg-green-500",
            n.level === "error" && "bg-red-500",
            n.level === "info" && "bg-brand-600"
          )}
        >
          <span className="flex-1">{n.message}</span>
          <button onClick={() => removeNotification(n.id)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
