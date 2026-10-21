/**
 * DOC-01. Язык поручения и сопроводительного определяется языком исходного обращения.
 * Смешанный язык или неуверенное распознавание → система запрашивает выбор.
 */

import type { Lang } from "./types";

const KK_LETTERS = /[әғқңөұүһі]/gi;
const KK_WORDS =
  /\b(және|бойынша|туралы|өтініш|адвокат(тар|тың|қа)|алқа(сы|сының)|сұраймын|қорғау|құқық|мен|бар|жоқ|үшін|осы|бұл|сол)\b/gi;
const RU_WORDS = /\b(и|в|на|по|что|прошу|адвокат\S*|коллеги\S*|защит\S*|права|не|для|это|от)\b/gi;

export interface LangDetection {
  lang: Lang | null; // null — нужен выбор человека
  confidence: number;
  kkScore: number;
  ruScore: number;
  mixed: boolean;
}

export function detectLanguage(text: string): LangDetection {
  const sample = text.slice(0, 20000);
  const letters = (sample.match(/[а-яёәғқңөұүһі]/gi) ?? []).length || 1;
  const kkLetters = (sample.match(KK_LETTERS) ?? []).length;
  const kkWords = (sample.match(KK_WORDS) ?? []).length;
  const ruWords = (sample.match(RU_WORDS) ?? []).length;

  const kkScore = (kkLetters / letters) * 40 + kkWords;
  const ruScore = ruWords;
  const total = kkScore + ruScore || 1;
  const kkShare = kkScore / total;

  if (letters < 40) return { lang: null, confidence: 0, kkScore, ruScore, mixed: false };
  if (kkShare >= 0.7) return { lang: "kk", confidence: kkShare, kkScore, ruScore, mixed: false };
  if (kkShare <= 0.2) return { lang: "ru", confidence: 1 - kkShare, kkScore, ruScore, mixed: false };
  return { lang: null, confidence: Math.max(kkShare, 1 - kkShare), kkScore, ruScore, mixed: true };
}

export const LANG_LABEL: Record<Lang, string> = { ru: "Русский", kk: "Қазақша" };
