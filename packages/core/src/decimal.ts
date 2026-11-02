// Amounts are decimal strings. They're compared as scaled integers, so money never picks up float errors.
const FRACTION_DIGITS = 30;
const DECIMAL = new RegExp(`^\\d{1,48}(\\.\\d{1,${FRACTION_DIGITS}})?$`);

export function isDecimal(value: string): boolean {
  return DECIMAL.test(value);
}

export function parseDecimal(value: string): bigint {
  if (!isDecimal(value)) throw new Error(`"${value}" is not a decimal amount`);
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(FRACTION_DIGITS) + BigInt(fraction.padEnd(FRACTION_DIGITS, "0"));
}

/** Turns a scaled integer back into the shortest decimal string. */
export function formatDecimal(scaled: bigint): string {
  const unit = 10n ** BigInt(FRACTION_DIGITS);
  const fraction = (scaled % unit).toString().padStart(FRACTION_DIGITS, "0").replace(/0+$/, "");
  return fraction ? `${scaled / unit}.${fraction}` : `${scaled / unit}`;
}
