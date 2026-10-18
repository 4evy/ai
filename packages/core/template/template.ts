// Replace only source placeholders so inserted values remain literal
export function render(
  source: string,
  values: Readonly<Record<string, string>>,
): string {
  return source.replace(/@([A-Z][A-Z0-9_]*)@/gu, (_, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) throw new Error(`Missing template value: ${name}`);
    return value;
  });
}
