const pesos = new Intl.NumberFormat('es-AR');

export const money = (n) => `$ ${pesos.format(n)}`;
export const area = (m2) => `${pesos.format(Math.round(m2))} m²`;
export const count = (n) => pesos.format(n);
