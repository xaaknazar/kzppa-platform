"use client";
import { useEffect, useRef } from "react";

/** Автоматически отправляет форму продолжения заполнения после загрузки страницы. */
export function AutoContinue() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = ref.current?.closest("form");
    const t = setTimeout(() => form?.requestSubmit(), 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <span ref={ref} className="mb-3 block text-[13px] text-petrol" role="status">
      Идёт заполнение…
    </span>
  );
}
