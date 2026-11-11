/**
 * Автоматическое распределение исполнителей по очереди (практика Комиссии, лист «Состав Комиссии»).
 * Очередь — участники с отметкой «Участвует в автоматическом распределении» в постоянном порядке
 * (по ФИО). Следующий — тот, кто идёт за исполнителем последнего назначения; если последний
 * исполнитель выбыл из очереди, берётся первый участник после него по порядку ФИО.
 * Это предложение: окончательно исполнителя назначает председатель.
 */
export interface RotationMember {
  id: string;
  fullName: string;
}

export function nextInRotation(queue: RotationMember[], last: RotationMember | null): RotationMember | null {
  if (!queue.length) return null;
  const sorted = [...queue].sort((a, b) => a.fullName.localeCompare(b.fullName, "ru"));
  if (!last) return sorted[0];
  const i = sorted.findIndex((m) => m.id === last.id);
  if (i >= 0) return sorted[(i + 1) % sorted.length];
  const after = sorted.find((m) => m.fullName.localeCompare(last.fullName, "ru") > 0);
  return after ?? sorted[0];
}
