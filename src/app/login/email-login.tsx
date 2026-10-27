"use client";
import { useState, useTransition } from "react";
import { Button, Field, Input } from "@/components/ui";
import { adminKeyLoginAction, requestCodeAction, verifyCodeAction } from "./actions";

/** Вход по коду, который приходит с почты комиссии; аварийный вход администратора по ключу. */
export function EmailLogin({ sender, next = "/" }: { sender: string; next?: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [key, setKey] = useState("");
  const [step, setStep] = useState<"email" | "code" | "key">("email");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const go = (fn: () => Promise<{ ok: boolean; error?: string }>, onOk: () => void) =>
    start(async () => {
      setError(null);
      try {
        const r = await fn();
        if (r.ok) onOk();
        else setError(r.error ?? "Не получилось");
      } catch {
        setError("Нет связи с сервером. Повторите.");
      }
    });

  if (step === "key")
    return (
      <form onSubmit={(e) => { e.preventDefault(); go(() => adminKeyLoginAction(email, key), () => (window.location.href = next)); }} className="mt-4 space-y-4">
        <p className="text-[13.5px] text-ink-2">Аварийный вход технического администратора, если почта комиссии ещё не подключена.</p>
        <Field label="Адрес администратора"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Ключ развёртывания" hint="Значение CRON_SECRET из настроек Vercel"><Input type="password" required value={key} onChange={(e) => setKey(e.target.value)} /></Field>
        {error && <p className="text-[13px] text-bad">{error}</p>}
        <Button className="w-full" disabled={pending}>{pending ? "Проверяем…" : "Войти"}</Button>
        <button type="button" onClick={() => { setStep("email"); setError(null); }} className="w-full text-[13px] text-petrol hover:underline">Вход по коду из письма</button>
      </form>
    );

  return step === "email" ? (
    <form onSubmit={(e) => { e.preventDefault(); go(() => requestCodeAction(email), () => setStep("code")); }} className="mt-4 space-y-4">
      <Field label="Электронная почта" hint="Адрес, подтверждённый в составе комиссии">
        <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.kz" />
      </Field>
      {error && <p className="text-[13px] text-bad">{error}</p>}
      <Button className="w-full" disabled={pending}>{pending ? "Отправляем код…" : "Получить код"}</Button>
      <button type="button" onClick={() => { setStep("key"); setError(null); }} className="w-full text-[12.5px] text-ink-3 hover:text-petrol">Вход администратора по ключу</button>
    </form>
  ) : (
    <form onSubmit={(e) => { e.preventDefault(); go(() => verifyCodeAction(email, code), () => (window.location.href = next)); }} className="mt-4 space-y-4">
      <p className="text-[13.5px] text-ink-2">Если адрес есть в составе комиссии, на {email} придёт письмо от {sender} с кодом. Код действует 10 минут.</p>
      <Field label="Код из письма">
        <Input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} maxLength={6} className="tracking-[0.3em] tnum" />
      </Field>
      {error && <p className="text-[13px] text-bad">{error}</p>}
      <Button className="w-full" disabled={pending || code.length !== 6}>{pending ? "Проверяем…" : "Войти"}</Button>
      <button type="button" onClick={() => { setStep("email"); setCode(""); setError(null); }} className="w-full text-[13px] text-petrol hover:underline">Изменить адрес или запросить новый код</button>
    </form>
  );
}
