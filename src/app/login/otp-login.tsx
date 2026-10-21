"use client";
import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { Button, Field, Input } from "@/components/ui";

/** Вход по одноразовому коду из письма (SEC-02). Пароли платформа не хранит. */
export function OtpLogin({ supabaseUrl, anonKey }: { supabaseUrl: string; anonKey: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supa = createBrowserClient(supabaseUrl, anonKey);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supa.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) setError("Не удалось отправить код. Проверьте адрес и повторите через минуту.");
    else setStep("code");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supa.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error) setError("Код неверен или истёк. Запросите новый код.");
    else window.location.href = "/";
  }

  return step === "email" ? (
    <form onSubmit={sendCode} className="mt-4 space-y-4">
      <Field label="Электронная почта" hint="Адрес, подтверждённый в составе комиссии">
        <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.kz" />
      </Field>
      {error && <p className="text-[13px] text-bad">{error}</p>}
      <Button className="w-full" disabled={busy}>
        {busy ? "Отправляем код…" : "Получить код"}
      </Button>
    </form>
  ) : (
    <form onSubmit={verify} className="mt-4 space-y-4">
      <p className="text-[13.5px] text-ink-2">Код отправлен на {email}.</p>
      <Field label="Код из письма">
        <Input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} maxLength={10} className="tracking-[0.3em] tnum" />
      </Field>
      {error && <p className="text-[13px] text-bad">{error}</p>}
      <Button className="w-full" disabled={busy}>
        {busy ? "Проверяем…" : "Войти"}
      </Button>
      <button type="button" onClick={() => setStep("email")} className="w-full text-[13px] text-petrol hover:underline">
        Изменить адрес
      </button>
    </form>
  );
}
