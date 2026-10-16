// Colores para distinguir a los jugadores en el mapa: fuertes y oscuros, para que no se confundan con los tonos claros
// de las propiedades libres (casa arena, comercio celeste, supermercado verde agua, hotel lavanda).
const PALETTE = ['#d62828', '#1b7f74', '#e76f51', '#2f4b8f', '#7b2cbf', '#c9184a', '#006d77', '#a0522d', '#4f772d', '#264653', '#e5007a', '#5a189a'];

export function ownerColor(ownerId) {
    return PALETTE[Math.abs(Number(ownerId)) % PALETTE.length];
}
