import type { Cert } from './types';

/** Big-number display of a (possibly fractional) year. */
export function yearParts(y: number): { num: string; era: string } {
  const r = Math.round(y);
  if (r <= 0) return { num: String(Math.max(1, -r)), era: 'до н. э.' };
  if (r < 1000) return { num: String(r), era: 'н. э.' };
  return { num: String(r), era: '' };
}

export function fmtYear(y: number): string {
  const r = Math.round(y);
  if (r <= 0) return `${Math.max(1, -r)} г. до н. э.`;
  if (r < 1000) return `${r} г. н. э.`;
  return `${r} г.`;
}

export const CERT_LABEL: Record<Cert, string> = {
  tradition: 'по преданию',
  scripture: 'по священному тексту',
  approx: 'дата приблизительна',
  disputed: 'датировка спорна',
  faith: 'предмет веры',
};

export const CERT_HINT: Record<Cert, string> = {
  tradition: 'Сведения восходят к религиозной традиции; исторически не подтверждены или подтверждены лишь частично.',
  scripture: 'Событие описано в священном тексте; его историчность и масштаб обсуждаются.',
  approx: 'Точная дата неизвестна; указана приблизительная.',
  disputed: 'Историки называют разные даты.',
  faith: 'Утверждение веры, которое не может быть проверено историческими методами.',
};
