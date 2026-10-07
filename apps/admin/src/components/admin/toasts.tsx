"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@mandatepay/ui/components/button";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type Notification = { title: string; message?: string; tone?: "success" | "error" | "info" };
const Context = createContext<((value: Notification) => void) | null>(null);
export function useAdminToast() {
  const notify = useContext(Context);
  if (!notify) throw new Error("AdminToastProvider is required.");
  return notify;
}
export function AdminToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<(Notification & { id: string })[]>([]);
  function notify(value: Notification) {
    setItems((current) => [...current.slice(-2), { ...value, id: crypto.randomUUID() }]);
  }
  return (
    <Context.Provider value={notify}>
      {children}
      <section
        aria-label="Notifications"
        aria-live="polite"
        aria-relevant="additions text"
        className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[calc(100%_-_2rem)] max-w-sm flex-col gap-3"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            className="pointer-events-auto flex items-start gap-3 rounded-xl bg-card p-4 shadow-lg"
          >
            {item.tone === "error" ? (
              <AlertCircle
                size={19}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-admin-danger-foreground"
              />
            ) : item.tone === "success" ? (
              <CheckCircle2
                size={19}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-admin-success-foreground"
              />
            ) : (
              <Info
                size={19}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-admin-info-foreground"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{item.title}</p>
              {item.message && (
                <p className="mt-1 break-words text-sm text-muted-foreground">{item.message}</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Dismiss ${item.title}`}
              onClick={() => setItems((current) => current.filter((v) => v.id !== item.id))}
            >
              <X size={17} aria-hidden="true" />
            </Button>
          </div>
        ))}
      </section>
    </Context.Provider>
  );
}
