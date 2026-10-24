export const money = (value, incomplete = false) => {
  if (value == null) return "—";
  if (incomplete && !(value > 0)) return "n/a";
  const amount = "$" + value.toFixed(value > 0 && value < .01 ? 4 : 2);
  return incomplete ? "≥ " + amount : amount;
};
