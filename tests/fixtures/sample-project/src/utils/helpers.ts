/**
 * General utility helpers.
 */

export function formatDate(date: Date): string {
  return date.toISOString();
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "-");
}

export const debounce = (fn: Function, delay: number) => {
  let timer: NodeJS.Timeout;
  return (...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

export const API_BASE_URL = "https://api.example.com";
